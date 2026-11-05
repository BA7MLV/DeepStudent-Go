# videos / folders 写入口盘点

历史盘点，非当前规范；当前入口：[当前架构](../architecture.md)，[历史导航](archive/index.md)。

> 本地P4/P5已关闭，最终归档见 [final-acceptance.md](./final-acceptance.md)；具体门槛见[p4-p5-review.md](./p4-p5-review.md)。完整旧schema/嵌套保全、显式courseFiles映射、实际Blob恢复UI与producer矩阵已通过；下方保留历史记录。Worker continue/retry用任务限定reset替代直接IDB删除，browser-chat命令领取改为executor专有typed stream。QA/artifactEdit公开入口19场景、三交互执行中崩溃reconciliation及完整业务/插件/性能统一冻结均通过。明确领域恢复策略见domain-recovery.md，外部未验单列。

2026-11-04 源码盘点；区分资源身份/文件效果、学习派生结果与静态存储。不把任意records传输改名当作领域化。搜索范围 `apps/web/src` 的videos/folders写、courseFiles引用和生产路由分流；未清除任何旧资料或outbox。

| 入口 | 当前生产路径 / 分类 | 状态 |
| --- | --- | --- |
| ResourceLibrary创建/改名/颜色/移动/移除/回收站 | resourceCommand + resources/resourceTrash query/watch | 已迁移，writable/assertIdle/revision保留 |
| ResourceLibrary / BotWorkspace / ProjectFiles上传 | 原serverClient.uploadProjectFile facade→uploadResource→领域admission→二进制HTTP→hash/receipt/commit | 已迁移，draft保留Blob；丢响应/reload不重传 |
| ResourceLibrary探测duration | recordMediaDuration | 已迁移，SQL业务事实/receipt同事务；不直接写videos |
| Player位置/播完/新一轮观看 | recordPlayback；静态模式才IDB update | 已迁移；不以断网切到本地权威 |
| chatProjects创建项目 | cloud分支createFolder领域command；非cloud分支本地folders.add | 已迁移，静态写保留 |
| ProjectFiles文本/目录/删除 | serverClient facade→resourceCommand，目录query/watch | 已迁移，普通文本原revision/内容保留 |
| markdownFile、wrongbook及无真实文件映射的Markdown | saveMarkdown：真实文件创建/CAS、服务端重索引；courseDocument query/watch | 云UI与Worker均接领域；旧映射迁移保留原Blob，失败不回退本地权威；wrongbook-domain-yygxka实际作答/丢响应/重试去重/reload通过 |
| Library常规云目录及旧单文件入口 | 在LibraryContent挂载前分流ResourceLibrary；只保留明确系统文档分支 | 任意旧`?file=`不再进入服务器模式静态编辑器；系统路径使用显式允许列表 |
| Library云导入及课程偏好 | durable upload→资源索引→setVideoSource/importSubtitles/recordMediaDuration→派生任务；setCoursePinned | 不直接创建云videos；完整导入故障矩阵待补，静态原路径保留 |
| libraryFolders.moveLibraryItems/unpackLibraryItems | moveLibrarySelection整批fresh preflight，SQL索引同事务，文件逆向补偿 | 无效选择整批拒绝；第二rename失败、文件/索引后失败、成功混合移动及undo专项通过；进程死亡/补偿冲突仍uncertain，不拆发 |
| pipelines/folderPlan | organizeCourses；Worker resourceCommand绑定具体plan及consumed许可 | 同名目录复用、unknown ID回报已测；parent/hash/lease仍由Executor边界校验 |
| MaterialReader.lastUnit/htmlView与正文 | recordReadingPosition/setReadingView + courseDocument共享watch | 删除两处5秒刷新；静态本地监听保留；真实文件外部修改WS推送/CAS拒绝旧正文已测 |
| livelink/ops.applyPosition | 云端recordPlayback；clientOpId摘要稳定命令ID | 保留ack/not-found，不对不存在课程put兜底 |
| HandoutPanel.skillOverride | setCourseSkills，明确课程技能偏好 | 不允许任意videos patch |
| store/subtitles、reindex、pipelines/{cover,transcribe,transcribeQueue} | Worker封闭LearningProduct；UI字幕导入/暂停转写分别importSubtitles/pauseTranscription | 无wire table selector；未知producer保留原outbox报错；各任务producer故障矩阵仍需核验 |
| MCP配置、系统目录、Bot审批及任务通知 | systemDocument/systemDirectory/permissions query/watch；TaskList→Zustand投影 | 删除相关5秒/4秒业务轮询与cloud-data/tasks-changed窗口广播；静态UI事件、Worker lease/heartbeat及A仍使用的端点保留 |
| store/migration、cloud/migrate | 用户显式导入/旧资料迁移 | cloud/migrate已改create-only importLibrary快照+importLibraryBlob admission/HTTP binary/receipt；不再逐表bulkPut/files.put。真实设置UI断网/两类commit丢响应/reload、原ID/outbox/Blob不变已验。全表原始快照导出、顶层未知字段上传前拒绝已验；courseFiles外部引用仍阻止自动导入并保留，完整旧schema/引用显式转换未闭合。此项不同于legacy outbox整事务核对/导出/归档。 |

## 已完成的旧事务和权限闭环

- 启动时旧videos/folders outbox按transaction完整隔离，先查receipt，混合files/其他表及Blob字节保留；同IDB事务退出自动writer并进入Activity review。未知副作用不自动执行。见 `preference-commands-Ctjzh5`。
- 实际资源上传丢响应、reload零重传、完整Blob导出；文件CAS丢响应、目标入回收站后的核对/归档；同账户新Runtime/导入JSON拒绝归档已测。
- `domain-account-vMohNz`用两个真实账户cookie/principal，延迟资源原响应后切换runtime/database，原账户draft保留，新账户无资源journal污染。
- `test-client-runtime.mjs`覆盖metadata receipt、非法position/跨owner拒绝、归档/活动execution写权限、路径越界与实际外部未索引文件推送。Darwin新目录竞争已补随订阅释放的目录watcher，不依赖浏览器轮询。
- `domain-account-tXicop`补实际浏览器reading命令提交、云端位置/视图修改、故障时原cache不改与不回退本地；命令响应不替换整course缓存，revision/order仍归committed records投影。最新完整build、正式生成一致性及plain Node Host/codec通过。

## 本轮证据与仍待核验

- `test-client-runtime.mjs`新增Markdown创建/receipt/外部推送/CAS、系统文档外部修改、目录复用/缺失ID及mixed rollback/undo；`test-task-file-permit.mjs`对照真实编辑planner的精确匹配与字面替换、非法正则、创建ID/name/folder/content边界。
- `executor-runtime-ReE6a2`：真实HTTP/codec、任务/lease、具体文件许可、pending receipt返回uncertain、终态取原文件收据；原extraction QA read/edit浏览器链已复验通过（本地模型夹具，无付费请求）。
- `preference-commands-44VFAC`：偏好及资源丢响应/reload/恢复；`domain-account-vrOT6y`：真实双账户晚响应隔离。Worker文件待核对入口已接恢复列表、观察当前正文/错误、导出及归档；新增该分支浏览器矩阵以最新专项结果为准。
- `/cloud/records` POST对账户新写返回410；typed commitRecords仅取旧摘要匹配收据。客户端editLearning限定会话/技能/批注/卡片审核/讲义编辑阅读/增量学习时长；Worker限定实际LearningProduct schema。只读records缓存同步仍保留。
- `learning-products-TRZqsU`覆盖16组producer/product组合，含三类courseDerivation：真实HTTP/codec拒绝错误task kind、跨课程/session、过期lease与取消parent；终态拒绝新写但返回原收据。`executor-runtime-fPcBT7`复验文件许可/lease/丢响应。技能完整事务修复及系统/MCP双尺寸UI证据见baseline.md。
- 后续`wrongbook-domain-yygxka`补真实错题UI文件提交丢响应/显式重试去重，以及资料库binary upload成功丢响应/reload零重传/原Blob与operationId。`learning-products-Ju7sn6`补16组producer的父取消、lease过期、owned-file、已删除课程、消息videoId/session绑定与终态收据。
- 本轮：删除taskProducts/row→product推断桥，producer直接选择封闭产品；cache通用Worker写抛executor_product_command_required。实际extraction QA和cards producer通过，cards提交丢响应以原identity重试且只落一张卡；modelHistory会话缓存键/截断checkpoint改命名会话产品。旧Worker outbox及过期能力产品进入review，不猜副作用。
- 尚缺：全部Worker可达producer回归、产品Blob uncertain实际恢复UI；旧库courseFiles及完整旧schema/嵌套引用保全/显式转换；综合test-cloud-e2e仍停过时设置UI。A/B已完成，无需等待汇合；旧服务器SSE/Web/native消费者已删。当前build/正式生成一致性及性能已通过，具体identity见stage-status.md；不把专项通过等同完整P4验收。
