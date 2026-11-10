# 全应用按需读取：实施证据与契约

计划：`cbe2f806-46c1-40f8-a267-136b3a80c30b`。2026-11-10 接续 `main` 的未提交文件懒加载工作。无提交、推送、部署、清库、真实 IM 或付费模型调用。

## 接手边界

已读取完整六阶段计划、关联 Bot 计划及 `docs/loading-performance.md`。接手时 22 个已修改文件、4 个新增文件；这些均为前序成果，不作回退。仓库及其工作目录内未发现 AGENTS.md。原会话由用户明确停止编辑，继续使用原目录。

## P0 读取依赖审计

| 消费者 | 数据入口与触发 | 当前代价/风险 | 迁移闭环 |
| --- | --- | --- | --- |
| 登录/全局启动 | startCloud → recordsPage → followRecords | 全账号所有 CLOUD_TABLES；每页 200；staging 已每批 200 发布，但总下载仍全量 | 偏好独立；领域/键读取先建立，不能过滤全局游标 |
| 首页问答 | courseChat.bootstrap、unarchivedSessions | 服务端首 50 条元数据＋最多 1 条活动会话、服务端课程计数；正文按会话 40 条 | 启动 Gate 仍等全账号基线；刷新/阅读位置恢复待补 |
| 播放器问答 | ChatPanel、readChatPage、局部 liveQuery | 首次正文分页；订阅仍序列化整个会话；任务进度重复读页 | 复用 session journal；阅读历史必须保留 |
| 最近/归档会话 | useRecentChats、ArchivedSessionsList | 服务端轻量索引，每页 50 条；静态模式才查询 IDB | 双向页、推送失效和失败重试已接入；搜索待迁移 |
| 搜索/导出/分叉/重试 | readChatHistory、conversationProducts | 本地完整镜像；移除镜像会静默截断 | 显式服务端有界遍历；完整操作不得用 UI 窗口替代 |
| Bot | useBotHistory、client-core/bot-history | 已有 50 条、8 会话/16MiB、约 1000 条窗口 | 复用；旧计划 P0/P4/P5 仍未验，不自动勾选 |
| 资料库/废纸篓 | resources/resourceTrash、Library IDB 查询 | 文件系统快照复用已实现；大目录尚未分页 | 路径/筛选独立游标；保留冲突提醒和原稿 |
| 阅读/播放器 | videos/files/frames/segments/subtitleTracks/materialBlocks/materialInk | 本地按课程索引；依赖账号基线；取色 Blob 已按需 | 课程存在性、内容与预览分离，未加载不是删除 |
| 卡片/讲义/讨论/弹幕 | cards/handouts/comments/danmakus | 按课程读取全部集合 | 有界领域页，读位置命令与原稿保护 |
| 学习统计/时长 | studyDays、Study | 客户端完整集合汇总；clear 使用完整 CAS | 聚合与导出分离，clear 必须服务端快照版本 |
| 设置/技能 | preferences、skills/skillRefs | 偏好独立；技能与支持文件仍全量 IDB | 索引和内容分离；保留技能包原子提交 |
| 任务/插件 | tasks/task/catalog/pluginQueries | 已走服务端 Runtime；插件任意 read 可能读大表 | 不增通信栈；查询授权与预算逐项核验 |
| 学习命令确认 | learning.drain → receipt → retireConfirmedCommands | confirmed 原稿要等全局镜像各 key 版本到达才退休 | 精确键读取/收据版本屏障，不能直接删除 journal |
| 历史恢复/注销 | recovery-export、logout、迁移 | 独立私有存储和原稿；flushCloud 有显式调用者 | 不清空 journal/上传；完整导出不能隐式信任局部镜像 |

`CLOUD_TABLES` 全部 20 表已纳入上表：videos/files/folders/courseFiles/covers 为资源元数据与字节引用；segments/subtitleTracks/materialBlocks/frames 为课程内容；materialInk 为批注；handouts/cards/comments/danmakus 为学习产物；chatSessions/chats 为会话；skills/skillRefs 为技能；studyDays 为统计；preferences 已独立。

## ADR：有界读取先于全局镜像退役

1. 复用现有 Runtime `read/watch`，不增加 HTTP/SSE/状态底座。新增读取是只读投影，不提供任意 SQL/写入。
2. 精确键读取最多 100 个键；包含不存在/墓碑的显式 `value:null` 和服务端版本。只返回请求账号的记录。收据读取不能推进全局/领域游标。
3. 集合页使用封闭 table allowlist、显式父作用域、`record_key` 稳定排序和不透明游标。每页最多 50，普通目标 512KiB 正文；允许单条完整大记录（含封装至 16MiB）独占一页，超过该上限显式报错，不截断记录。先读最多 51 个键/字节长度，再按预算读取正文，避免预先载入 51 条大记录。游标绑定账号、表、父作用域、数据库 epoch 和集合版本。
4. 当前 cloud_records 是可变最新值，不是 MVCC 历史；因此分页期间相关写入必须使旧游标显式失效。客户端保留上份快照，重新读取，不能混合不同版本的页。不得将全局 records 高水位当领域游标。
5. 删除/移动时从 OLD 与 NEW 同事务产生作用域失效；墓碑不包含原父 ID，因此不能事后只看 NEW 推导失效范围。
6. 命令收据只证明命令已提交。只有精确读取达到收据版本或显式领域协调刷新后，才能退休本地命令；离线/撤权/配额失败保留原稿。
7. 先增量交付并测试独立协议，再迁移全部读者，最后退役启动全量镜像。中间阶段不把未完成迁移的应用切到“局部镜像”模式。

## 预算与证据约定

环境：本机 macOS、当前 Node、隔离 SQLite；无人工网络延迟的 API 微基准与生产浏览器计时分别记录。规模为 1k/10k/100k 消息；中位数/P95 必须附样本数，查询计划不冒充实际扫描计数，JS heap 不冒充进程 RSS。尚无数据的指标标未测，不使用历史单次样本声称通过。

建议门禁：消息首次 40–50 条、集合页 50 条/512KiB、只读精确键 100 个；附件保持既有 4 并发/128 项/32MiB。前后对照须相同夹具、构建与环境。

## 阶段状态

六阶段尚未完成；仅有可核验的完成项才勾原计划。P0 依赖审计已完成，规模/生产浏览器完整基线待补。P1 协议先实现，尚未退役全量基线。资料库 UI 阻挡已修复并重验；动态取色专项仍未完成。

## 接续回归（2026-11-10）

- `scripts/e2e-server-chat-ui.mjs`：通过 QA 远端正文编辑/删除、新空会话、附件与模型选择、分叉/删除及服务端压缩。证据 `server-chat-ui-X4EnRm`（下述临时目录根）。这是 Vite 源模块装配真实组件，不是生产静态制品性能验收，脚本原有输出中的 production 仅指产品组件。
- `scripts/e2e-chat-session-performance.mjs`：通过流式行局部更新、根/输入区零增量重渲染、手动阅读、前插锚点（≤2px）、延迟分页与 gap baseline 竞争、桌面/窄屏和 A→B→A。证据 `chat-session-performance-2I1Qit`。修复两脚本对旧 textarea 的假定，未删草稿/行为断言。
- `npm run test:client-runtime`：最新整套通过；任务摘要断言改为终态推送且 `result:null`，完整结果仍由 TaskModel 验证。此前一次外部文件监听超时，重跑未复现，不能声称已定位其原因。
- `npm run test:loading:projections`：通过 OLD/NEW 精确父作用域通知（含删除/移动）、其他父作用域零匹配、超大完整记录续页及现有规模/故障项。证据 `record-projections-Qx0Cif`；1k/10k/100k 各 20 次同步微基准，非浏览器性能保证。
- `npm run test:loading`：通过原有全部项目，并新增真实 Chromium+IDB 精确收据故障注入：503、epoch 不同、原生 IDB put 配额异常、未达到收据版本、响应途中 A→B→A。失败均保留 journal、附件原稿和 cursor；恢复只发布涉及键后退休 journal，不推进全局 cursor。证据 `lazy-loading-U4AATB`。配额是注入异常，不代表填满真实磁盘；墓碑和不同账号键隔离已在协议测试覆盖，尚非完整浏览器故障矩阵。
- 最新 `npm run build`、`npm run check:remote` 均通过。原有 CSS 与导入拆包警告仍在。

证据根：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`。`test:loading:production` 已完成下述 Chromium 规模基线（侧栏迁移前制品）；大目录、完整刷新恢复及 WebKit 生产基线仍缺。浏览器 IDB 事务耗时有重叠，不可与网络耗时直接相加；CDP heap 采样峰值不等于实际峰值或进程 RSS；实际 SQLite 扫描量、独立 JSON parse 时间等未测指标明确保留为空。

## 最新增量证据与边界

- 历史生产静态制品 Chromium 基线 `loading-production-B2hvo7`：Apple M4/16GiB、Node v26.3.0、Chromium 153、无人工延迟，每规模冷/热各 3 轮。旧脚本对嵌套响应的无关正文计数有误，其零计数不可信；已由下述修正版 `loading-production-IB4gjJ` 扩展基线取代。100k 约 507 次 recordsPage 暴露的启动全量镜像瓶颈**尚未解决**。
- PWA 入口预缓存改为 Vite manifest 的静态入口依赖，动态分包访问后才缓存。预缓存从 229 项/9982.82KiB 降至 8 项/2206.98KiB，构建门禁 3MiB。运行时缓存仅同源哈希 assets，160 项/30 天；**没有总字节门禁**，这部分预算仍待完善。
- 真实生产 SW：Chromium `pwa-demand-CYmgnM` 通过 `context.setOffline(true)`；WebKit `pwa-demand-fMgvDu` 通过服务端直接断开 assets 连接。两者均验证未访问分包不预取、访问后缓存及网络不可用时读取缓存。WebKit 的 Playwright 离线模拟原测试仍失败，其引擎补丁会在 SW 分发前拒绝 WebProcess load；网络断连测试不冒充该离线模拟通过，也不代表应用离线 UI 已验收。
- `npm run test:loading:projections` 最新 `record-projections-3H2hfo` 通过，补验两个 9MiB 精确键触发聚合字节预算拒绝；其余集合/权限/游标断言保留。
- `npm run test:loading` 最新已通过收据墓碑删除失败回滚、重试原子发布后退休；证据 `lazy-loading-zBIHec`。保留原有配额、版本、账号竞争断言。
- `scripts/e2e-resource-folders.mjs` 最新完整通过：窄屏冲突提醒新增仅当前挂载期的“收起提醒”，不退休命令；真实 IDB 比较确认冲突命令及原始草稿保持不变。桌面/窄屏、封面外部修改、新文件监听、拖放、编辑冲突、返回目录及导入入口均通过。截图 `test-results/resource-folders/`。外部监听此前有间歇超时，增加失败帧诊断；活动 resources 直接监听已授权的当前目录，避免只依赖递归项目 watcher。一次通过不证明所有平台文件监听无丢事件。
- 最新完整 `npm run build`（含边界/i18n/许可证检查）及 `npm run check:remote` 均通过。既有 CSS `:is()` 与静态/动态导入警告未消除。

## 轻量会话索引（侧栏、首页与归档 UI 已增量迁移）

- 新增 `sessionIndex` Runtime read/watch：按课程、归档和“有用户消息”过滤，复合键 `(pinned, activity, createdAt, id)` 逆序，每页 50。只返回固定轻量字段（标题最多 256 字符），不读取正文；游标签名绑定账号、筛选、持久 epoch 与课程作用域版本。内容-only 写入不使列表游标失效。
- `client_session_index` 是派生元数据，不迁移或删除原始 records。首次迁移一次性回填；普通读和数据库重开不重扫全库。消息活动/用户消息存在性由索引查询维护，移动、墓碑、物理删除与回滚同事务更新；OLD/NEW 课程作用域均失效。客户端复用共享 `RuntimeModel` 的保留/释放机制。
- 为避免原 `CloudRecords` 的 DELETE+INSERT 使流式正文临时删除后重建导航事实，改为 SQLite 原子 UPSERT：冲突时将 `excluded.revision` 和 value 同时更新，继续使用 AUTOINCREMENT 分配递增版本。新增 session journal UPDATE 触发器，覆盖编辑、墓碑和跨会话移动。最初缺少该触发器导致 journal 专项失败，已补齐并通过原断言，不将初次失败隐去。
- `scripts/test-session-index.mjs`：`session-index-SKi27g` 通过分页、权限/筛选/跨领域游标、活动/用户标记、移动/删除、内容更新零导航失效、版本单调、回滚、持久重开和真实查询计划。新增 read/watch 的真实 Typert/WS 观察通过 `test:client-runtime`（`client-runtime-9CKOzA`），验证共享实例、无正文泄漏、内容更新版本稳定及重命名推送。
- `scripts/test-session-journal.mjs`：`session-journal-3JyTLn` 通过原有 80 事件突发、编辑/墓碑、实际 WS 重连、游标 gap 完整修复及分页竞争。gap 修复的全量读取**尚未解决**，不能将新增索引等同于正文窗口已全部有界。
- `npm run test:loading` 最新 `lazy-loading-z7gQjL` 通过，并补验通用精确键发布的 503、epoch 不同、配额回滚和重试；仅请求的键进入 IDB，global cursor 和附件原稿不变。`test:cloud:transactions` 10 项此前通过。完整 build 已在首页/归档迁移及 `courseCount` 新契约后通过；首次构建暴露新增硬编码中文，已迁移 locale 而非提高基线。服务端搜索和正文有界双向窗口仍待实现。
- 扩展生产基线 `loading-production-IB4gjJ` 已完成：1k/10k/100k，冷/热各 3 轮及 60 秒空闲。冷可读 P50 约 969/1873/12833ms、P95 约 1585/1901/13767ms；热 P50 约 885/919/2544ms。HTTP 峰值约 0.646/5.066/49.719MB；100k 冷/热 heap 采样约 254/527MB，非 RSS/真实峰值。基线制品在侧栏迁移前，不作为本次迁移后性能。修正版 1k 冒烟 `loading-production-2FBMt3` 实际计出冷启动下载 **940 条无关会话消息**。HTTP/WS 分计；SQL 包装记录 `.all/.get/.run` 耗时与返回行数，不是实际扫描量。60 秒仍有 receipt/editLearning/read/config/recordsPage，不能声称无 HTTP 空闲活动。
- `npm run test:loading:session-index:e2e`：Chromium `session-index-ui-KjynRB` 通过桌面/390px 窄屏双向翻页、50＋最多 1 活动会话预算、迟到 HTTP 不覆盖新推送头、503 保留旧页/重试、完整到达最旧会话、陈旧 IDB 元数据被服务端精确读取替换，以及 61 条归档的双向分页/真实服务端恢复。最旧页严格校验 1–21 的所有夹具 ID；额外行必须有 `aria-selected=true`，不是放宽为任意数量。此前误将活动行算进固定 21 条的断言失败已修正。
- WebKit `session-index-ui-vtpEDT` 已通过侧栏/窄屏、推送竞争及选中会话元数据验证（归档分页扩展前）；归档扩展仍需该引擎重跑。测试拦截只针对有游标的 sessionIndex，避免延迟无关精确读取造成测试死锁。一次并行 build 的共享 Vite/HMR 导致白屏超时，脚本现使用独立 cacheDir、关闭 HMR/文件监听，独立重跑通过；不把该失败当产品验收成功。
- `courseChat` 服务端模式 bootstrap/刷新/删除后的落脚元数据仅请求首 50 条并精确补活动会话；选中会话、分叉源、消息删除与修改的 CAS expected 改走精确键，不依赖“本地缺失＝不存在”。关联课程最多 5 条、项目目录精确读取；课程数量由服务端 `courseCount` 聚合返回，新增真实 Runtime 墓碑计数回归。课程元数据不再全量装入 store，但 Gate/startCloud 仍全账号基线，不能声称首屏隐形全量已消除。
- 最新 `test:client-runtime` `client-runtime-yozjlF`、`test-session-journal` `session-journal-Qj7mn3`、投影 `record-projections-xVoCqJ`/索引 `session-index-A4lq4G` 及 `check:remote` 均通过；`e2e-server-chat-ui` `server-chat-ui-pnb7aQ` 与 `e2e-chat-session-performance` `chat-session-performance-mFG0ym` 通过真实组件行为/渲染预算。它们是源模块/Vite 测试，不冒充迁移后生产性能基线。

## 最新接续：精确目标、QA 可用性与验证边界

- 首页/QA 落脚保持“最新创建”语义：索引增加 `latestId`，使用创建时间索引；即使最新创建的空会话不在活动排序首 50 内，也只精确补读该会话，不遍历所有导航页。QA 元数据使用共享索引，课程/归档/recentOnly 的完整 scope 阻止旧页越界显示；61 条 QA 双向分页已验。
- `submitLearning` 不再附带全账号 `flushCloud()`；命令只在收据精确键版本满足并原子发布后退休。命令仍在时显式抛 `learning_receipt_projection_unavailable`。widget owner 同步也改为精确 chats 键，而非全局 flush。最新加载回归 `lazy-loading-ElRhj3` 通过；transactions 10 项、account-lifecycle 4 项通过，不代表所有剩余领域读者已经迁移。
- artifact 生成/应用读取服务端精确消息，离屏生成观察目标键而不是整个本地消息镜像。补上 account lifetime 清理：即使无后续记录事件，账号失效也立即取消生成；迟到结果不能恢复已失效输出。`npm run test:artifact:demand` 的 `artifact-demand-p31KwK` 通过脚本化服务端 patch/rewrite、陈旧 IDB、无自动应用、保留无关字段、目标修改/删除取消和账号取消；额外制造“精确读取后、命令执行前”的并发修改，真实服务端 CAS 拒绝并保留 conflict journal 中的完整意图。导航项为离屏 store＋真实 history 路由变化，不冒充完整 artifact 编辑器点击验收。首次夹具直接写 IDB 被只读保护拒绝、使用非 schema 元数据被服务端拒绝、复活墓碑未带 baseRevision 被 CAS 拒绝，均已修正测试夹具后重跑；未关闭保护或删除断言。
- QA 初始化的材料块/已完成字幕“有无可检索文本”改走 `courseReadiness`，仅返回两个布尔值，使用父作用域索引和 ready-segment 部分索引，不下载正文；与会话索引并行读取。补齐账号/数据库生命周期栅栏、失败提示和显式重试。新增 503 专项首次暴露错误对象传给字符串格式器，已修复；`server-chat-ui-oVuJON` 通过失败可见/重试恢复及原有 QA 行为全套。frames 元数据/缩略图和其他课程领域尚待迁移，不能宣称播放器已解除基线依赖。
- `client-runtime-UBu4i0` 通过 readiness 真实 HTTP、空/非空、未完成/空字幕、课程隔离及墓碑用例；投影 `record-projections-cOlavf` /索引 `session-index-UH9M0m` 通过，含精确领域失效、账号隔离和真实部分索引查询计划。`session-journal-xqJmov` 通过；其 full gap repair 仍无界，尚未验收 P2。
- 侧栏/归档最新版 Chromium `session-index-ui-ejZZpb` 与 WebKit `session-index-ui-KfxLiF` 均通过桌面/窄屏、双向分页、推送竞争、503 重试和真实归档恢复；最新 readiness/UI 修改发生在该侧栏回归之后。`check:remote` 在新 readiness 契约生成后通过。
- 生产制品真实分页导航的 1k 冒烟 `loading-production-0xNDU9` 通过，冷/热各 n=1；与其他测试并行，不作可比性能结论，也不是完整规模基线。该制品早于 readiness/账号清理的最新修改；迁移后 1k/10k/100k 多轮、WebKit、完整刷新/阅读恢复与大目录生产验收仍缺。
- 本接续首次完整 `npm run build` 通过（含 latestId、artifact 原有改动及学习 barrier），预缓存 8 项/2209.30KiB。后续 readiness 修改后，工作目录出现并发的 Bilibili/设置改动：完整 build 被其新增中文门禁拦截，`npx tsc -b apps/web` 与资源 UI 因 `SettingsModal.tsx` 引入当时缺失的 `settings/SourcesModule` 失败。未覆盖这些非本任务文件、未提高门禁，也不把此前 build 通过冒充最新全量通过。资源 UI 原有成功证据仍保留，最新尝试不算通过。

阶段仍 0/6，原计划约束未改。全账号 records 基线/订阅仍在；没有声称隐形全量下载、全部缓存预算或 P5 故障矩阵已完成。所有改动未提交、未推送、未部署。

### 本次协调停点

- artifact/学习精确键专项最新为 `artifact-demand-NkyJp3`，在原 CAS/取消断言之外，新增卡片审核与讲义阅读位置在本地投影缺失时仍精确读取并成功提交的回归；`reviewCard` 保留调用者实际看见的 expected 状态，不以新读取覆盖旧决策。
- 最新 `test:loading` `lazy-loading-GBwX0F` 通过；`git diff --check` 通过。并发设置模块补齐后，最新 `npx tsc -b apps/web` 与完整 `test:resources:e2e` 均通过；上述模块缺失仅为前一次失败记录。最新完整 build 仍被 Bilibili/Library 的 5 个文件中文门禁阻挡，不作为本任务通过项。
- 用户选择“先结束并发编辑”：暂停新增代码与生产基线采集，等待另一轮编辑完成的通知；不是再次等待计划批准。恢复后先检查分支/diff、重跑完整 build/check:remote 和针对性回归，再继续原计划。仍需迁移其余领域/恢复消费者、正文双向有界窗口与 gap 修复、服务端搜索、大目录分页，最终才退役全账号基线并完成生产规模/故障验收。

## 接续实施：技能、学习投影与讲义领域

用户随后要求继续完成，已恢复实施；上述暂停和构建失败是历史记录，不是当前阻塞。原六阶段仍 **0/6**，不将某个领域的专项通过折算为整阶段完成。

### 技能和学习

- 技能发现改为共享、有预算的元数据目录（4096 条/8MiB），设置页最多渲染 50 行；目录仍先遍历预算内的完整元数据，不声称只取当前服务端页。正文按选中 ID 精确读取，提示词限制 6000 字符；最后观察者释放后销毁，重新观察重建。完整引用集合使用服务器版本 CAS，避免陈旧 IDB 漏掉第 51 条之后的引用。
- 技能 Chromium `skill-demand-pEypXO`、WebKit `skill-demand-etl2bG` 通过；预算 `skill-catalog-budget-a2XwzY` 验证 4096 成功、4097/8MiB 超限显式失败、无部分 ready、共享遍历及生命周期释放。
- 学习设置使用 `studySummary` 聚合和 owner/epoch/version 签名快照清空，在同一事务验证并删除。清空先预检 20000 行/8MiB，超限不删除；全期统计不受清空预算限制。概览使用 `studyOverview` 流式聚合全历史，只返回最多 371 天和全期统计；最多 32 条本地计时 preview 只参与计算，不写事实。
- `test:study-time:overview`（`study-overview-BVKtEE`）通过 4000 天全期对照、371 天/32KiB、preview、3 时区、闰日/DST、账号/参数/大字段边界。`test:study-time:clear` 通过签名篡改、owner/epoch/并发新增、事务回滚/幂等和行数/字节预检。
- 学习 Chromium `study-demand-QNMXTA`、最新 WebKit `study-demand-txV5Ja` 通过真实组件/API/IDB：1002 日期原子清空、精确收据退休、全期统计、preview 不持久化、范围切换、确认竞争及账号释放。两者均覆盖一次性 SQLite 中真实删除/恢复标量索引的投影故障：保留旧汇总/记录/冲突命令、禁用清空、显式重试恢复。WebKit 最初错误地同步断言 React 按钮状态、又误把错误提示框算成清空确认框，均修正为同轮点击隔离和精确确认框选择器后通过；未删除服务器写入/命令保全断言。
- 计时隔离缺口已实施：模块级 pending/flushChain 改为绑定原数据库/账号 lifetime 的账本与串行有界批次；失败保留原秒数/操作 ID，重复 flush 不重复入队。stop/账号释放补落原账号私有命令日志；释放后只允许这一窄范围持久化，不使用新账号网络或数据库，也不重建已删除数据库。旧异步完成不更新新账号 preview/flushCount。PlayerResource 的播放回调捕获 lifetime/数据库身份，迟到 play/pause/unmount 不干扰新播放器；一般 queueLearning 也加终止身份栅栏。
- 新 `test:study-time:tracker` Chromium `study-tracker-oG8V38`、WebKit `study-tracker-vgJZzr` 通过真实 tracker/learning/浏览器 IDB：延迟 digest/关闭原连接的 A→B→A，60s/30s 精确归属，真实 IDB quota 回滚及 nonce 重试，重复确认、stop/start/pagehide、同数据库同账号新 incarnation、删除后不重建，以及旧媒体回调空闲判定。settings/网络 carrier 为夹具，不冒充生产启动或服务端提交。
- 最新学习 Chromium `study-demand-yigexr`、WebKit `study-demand-XV1oeC` 通过，并新增真实 60s 计时→耐久日志→真实 API 提交→精确收据退休→签名清空闭环；保留之前的 SQL 故障/原稿/账号与清空竞争断言。

### 讲义读取与手动保存

- 新 `latestHandout` read/watch 在事务内通过 `(owner,videoId,createdAt DESC,id DESC)` 索引只选最新一份完整文档；先读取长度再读取正文，完整响应上限 16MiB，超限显式失败，不截断文档。删除、移动、正文更新精确失效课程；课程名称按精确键获取。
- 配图仅查询完整文档实际引用的整秒时间戳，使用独立索引，最多 256 个去重引用、512KiB 元数据；不返回 caption、未引用配图或图片字节。文档仍完整返回，图片沿用原生 lazy。不是将 frame DTO 伪装成完整行写入 IDB。
- `useLatestHandout` 每个视图拥有可释放模型；切换课程、卸载或账号失效释放订阅、监听及正文快照。读取失败保留上一份文档，不显示为空，并禁用生成/导出、提供重试。
- 编辑或保存期间钉住原始文档与 CAS baseline；同份文档的远端改写或新一代讲义不会关闭已打开输入框。冲突继续保留服务器两份版本、私有草稿和未确认任务意图。手动保存准入不再调用全账号 `flushCloud()`；成功完成仅精确读取结果 handoutId。其他任务准入/完成仍有全局 flush，尚未全迁移。导出前精确读取当前所选文档，下载完整不可变 DOCX。
- Chromium `handout-demand-KNusBG` 与 WebKit `handout-demand-AGoTOF` 通过真实 HandoutPanel/编辑表单/API/IDB/隔离 Node 执行器：121 历史版本＋陈旧镜像、61 张配图仅一张被引用、完整原始/修改后 DOCX 字节、SQL 故障/修复重试、空课程切换、编辑期间远端版本和新生成竞争、真实 CAS 拒绝及无模型成功保存、账号失效释放全部模型 refs/listeners。测试没有调用 `startCloud`，不证明全应用启动、生产性能或真机 Safari。390px 有截图，不将桌面 hover 流程扩大为完整触摸编辑验收。
- 专项最初发现保存任务仍会拉取全账号 records，现已修复；测试还误把任务准入日志当学习命令、使用非 IR 的 `p` 块，已改为实际 task-command、合法 `para`，并校验服务端确实因 `handout_edit_conflict` 拒绝准入，不是依赖非法夹具制造失败。
- 最新讲义 Chromium `handout-demand-pwHRre`、WebKit `handout-demand-UDfs9u` 通过，额外验证账号失效同轮点击不产生保存命令、121 版本选择、完整 DOCX、SQL 故障恢复、CAS 冲突及成功保存。旧 Player 媒体 reporter 作用域错误曾令 build 报 TS2304，已移入正确组件后通过。
- 投影 `record-projections-5AVaMX`/会话索引 `session-index-WtWal0` 通过最新记录/配图索引、同时间 id 排序、墓碑/移动/owner/课程隔离、完整大正文边界、256/257 引用和元数据预算；查询计划无临时排序。首次媒体测试把 INSERT helper 当 UPSERT 导致唯一键冲突，已用显式 UPDATE 修正夹具。实际 SQLite 扫描计数仍未测。

### 最新回归及仍未完成项

- 完整 `npm run build` 已通过计时最后 lifetime guard 和课程元数据初版（预缓存 8 项/2221.35KiB）；课程视图终止身份细化后仍须重跑。原 CSS `:is()`、大分包和静态/动态混合导入警告仍在，不视为警告已解决。
- 最新 `check:remote`、`test:web:server-only-adapters`、`test:cloud:transactions`（10 项）、`test:loading`（`lazy-loading-V9Lys7`）通过。`test:account-lifecycle`（4 项）、`test:client-runtime`（`client-runtime-JyQ4Yj`）此前通过。完整 retired QA 入口 `node scripts/test-qa-runner.mjs` 通过当前服务端/压缩/技能/真实 UI 链路（`server-chat-ui-Oo6mTw` 等）；其模型使用受控夹具，不代表付费真实模型质量。
- 单事实源综合 Chromium `single-source-tksN9H` 通过。初次失败为旧测试对已提交不可变文件引用调用 blob.text；改用生产 resolveCloudBlob，保留完整字节断言并增加提交行仍为文件引用的断言。WebKit 两轮在最终无页面异常断言处失败（`single-source-uRYUVj` receipt、`single-source-5LP7Vz` editLearning 的访问控制检查错误），独立增加网络/未处理 rejection 诊断后 `single-source-nrfWE9` 通过，未见 console error；原因尚未定位，不宣称已修复此间歇问题，诊断断言继续保留。
- 全账号启动基线/订阅仍在；剩余课程/播放器/材料/命令确认/恢复/完整导出读者、正文双向有界窗口与 journal gap、搜索/大目录、资源总字节预算和生产 1k/10k/100k 双引擎故障矩阵仍待实施。PWA WebKit 真离线 UI 的原失败未被服务端断 assets 替代验收关闭。未提交、推送、部署、清库，也未调用付费模型或真实 IM。

### 课程显示元数据（整理方案与资料图标）

- `courseMetadata` 复用 Runtime read/watch，最多 720 个显式去重课程 ID、512KiB 响应；逐主键读取 allowlist 的 name/kind 与可选封面不可变文件引用，先计算 SQL 输出字节长度再载入。不是课程集合遍历，不下载视频或封面行的无关大字段，也不把部分 DTO 写入 videos/covers。封面只在 covers=true 时参与精确键失效。
- FolderPlanCard 不再用本地 bulkGet 的缺失决定无法识别；read ready 前仅显示加载状态，失败不显示为删除、禁用确认并提供重试。同轮账号失效的确认回调有独立栅栏。ResourceFileIcon 仅近视口观察元数据，权威 kind 决定无扩展名视频图标；封面替换直接推送。视图释放模型、正文与对象 URL；终止 lifetime 不因状态重渲染而自动重新获取。
- 投影 `record-projections-FWO8lR` 通过 720/721 ID、owner/去重/墓碑、超大字段不外泄、字节预算拒绝、精确失效及真实主键查询计划（非实际扫描计数）。新组件/API/IDB 专项 Chromium `course-metadata-FpqpmT`、WebKit `course-metadata-tPV2zO` 通过 61 门课、陈旧 IDB、缺失课程、远端改名/删除/封面替换、预算错误恢复、近视口、卸载/账号同轮隔离。首轮夹具提前捕获尚未赋值的 React setter，已改为调用时读取后重跑；未删除释放断言。
- 最新终止身份细化和更严格重渲染断言之后仍需复跑两引擎。本专项无 startCloud，不证明 Library 全表读取、大目录分页、课程正文或全应用生产基线已解决。

### 字幕读取、导入与外部文件通知

- 字幕导入的服务端 ID 分配不再读取账号内所有课程的字幕正文。改为按 `(owner,table_name,parent)` 索引只预检当前课程：旧 segments/tracks 行数合计上限 20000、字节上限 16MiB，超限在删除前显式失败；未命中行不入 JS，`JSON.parse` 只解析当前课程。删除与插入均以 ≤200 条 mutation 分批，全部位于同一 SQL 事务与同一 operation receipt；迟到批次失败整体回滚，原 `operationId` 在回滚后可重试，已完成的 receipt 重放不会再次替换。
- 模块级证据 `test:subtitles:scope`：20k 无关字幕正文零解析、401 旧/451 新分段、≤200 批、owner 隔离、状态/receipt 原子、同 ID 幂等、迟到失败回滚，以及超预算不删除且同 ID 修复后可重试；查询计划命中 `cloud_records_parent_key`，无 TEMP/SCAN。仅 SQL/真实命令夹具，不证明浏览器或生产启动。
- 播放器字幕改为 `courseSubtitlePages`（segments / subtitleTracks / videos 三路可释放模型）加 `readCourseSubtitles` 完整视图：每页仍是 50 条 / 512KiB，视图上限 20000 行 / 16MiB；跨页只接受同一 epoch/version，读完再用两次首页读取校验版本，变化则重读，绝不发布混合快照，也不把部分页写入业务 IDB 或读取全局 records。
- `useCourseSubtitles` 使用“脏标记 + 版本比对”收敛刷新：读取结果版本与会话头不一致时丢弃并重读；读取失败保留上一份完整文本但标记未就绪并提供真实重试（未知不等于空或已删除）。切换课程、卸载或账号失效释放三个模型与正文快照。`SubtitlePanel` 的转写错误与读取错误分开呈现，读取错误不再被误报成“转写失败”。
- 修复两处会静默停留旧数据的缺陷：(1) 字幕切分缓存只用文本长度作签名，等长改写/导入会命中旧缓存，现改为内容哈希签名；(2) `watch()` 只在 revision 前进时发送变化，当值已变化而全局 revision 未前进（外部文件系统等来源）时直接丢弃并更新本地基线，客户端会永久陈旧；现改为发送同 revision 的替换快照，delta 仍要求 revision 单调前进。
- 证据：`test:subtitles:demand` Chromium `subtitle-demand-g1KLw4`、WebKit `subtitle-demand-OBWh6d` 通过真实 SubtitlePanel/API/IDB：121 条跨 3 个有界页、IDB 零字幕行、完整 SRT 含首末条、非首页等长改写重绘、真实导入原子替换且导入后不再 `flushCloud()`、真实预算失败保留旧文本且非空态、点击重试恢复、释放三个模型、零无关正文与全局 records 读取、零未处理 rejection。
- `test:filesystem:notify` 在真实 Host+WS 传输下 20/20 外部创建到达投影，并记录到 delta 与替换快照两条路径；`test:client-runtime`（含既有 external filesystem notification 断言）、`test:resources:e2e` 与 `tsc -b apps/web` 通过。此前资源 UI 失败同时受两点影响：测试共享 Vite `cacheDir`（已改为每次独立目录）与上述 revision 丢弃；后者是产品缺陷，已修复而非放宽断言。资源 UI 截图证据改用每次独立目录，旧 `test-results/resource-folders` 不再复用为同一次运行证据。
- 启动封面回填不再扫描全账号课程镜像：cloud 模式改为 `coverCandidates` 有界键分页（每页 100 个 ID、签名游标只向前），只返回仍缺封面的课程键；已有 cover 行、`skipped`、非 Markdown 的 `done`、墓碑与其他账号都被排除，Markdown `done` 与失败状态仍会重试。生成失败不写状态，下次回填自然重试；每次启动最多入队 200 个，避免一次拉起长队列。本地模式保留原表扫描。
- `test:loading:projections` 新增键分页、owner 隔离、排除/包含规则、严格向前推进、游标篡改/并发过期和 PK 索引计划（无 TEMP 排序）断言；`test:cover:backfill` 在真实 API 下验证 250 门无封面课程不进入 IDB、limit=5 只发一次 `coverCandidates`（无 `recordsPage`/`collectionPage`）、零未处理 rejection。两者均未调用 `startCloud`，不证明完整启动或封面生成质量。
- 接续增量（本轮，未提交）：(1) **缓存总字节门禁**——`app-demand-assets` 运行时缓存在既有 160 项/30 天之上新增 64MiB 总字节门禁（`apps/web/pwa-byte-budget.ts` 的自包含 Workbox 插件，经 `handlerDidComplete` 汇总 Content-Length/实测体大小并按最久未服务优先淘汰；方法简写会被 workbox 序列化成非法 SW 源码，必须用箭头函数属性——该坑已用真实 `vite build` + `node --check dist/sw.js` 验证）。模块证据 `test:pwa-byte-budget` 5/5：超预算按 LRU 淘汰、预算内不动、缺 Content-Length 按实测体计数、失败/无响应不抛错。(2) **大目录分页**——服务端 `files.listPage`/`resources.listPage` 提供名称码元序的只向前游标（每页默认 500、仅对当前页 stat，readdir 安全上限 200k；旧 `list()` 5000 条 413 语义保留），DB 映射放置/项目 scope/缺失课程只在首页附带；runtime `resources` 读与 HTTP GET 均支持 `cursor`/`limit`；`ResourceLibrary` 以「投影拥有首页 + 客户端累计后续页」呈现，投影替换时累计页整体重置，搜索词非空时自动补齐剩余页保证筛选覆盖完整目录，上传后按名查找改为分页查找。模块证据 `test:resources:pagination`：1200 条 3 页并集等于完整目录、页间不相交、游标严格向前、越界游标为空页、owner 隔离、映射条目仅首页出现一次、5001 条目录旧路径 413 而分页 11 页读全。
- 本轮验证边界：`tsc -p`（api）、`tsc -b`（web）、`vite build`（SW 含门禁插件且语法有效）、`test:cloud:transactions`（10 项）、`test:task-projections`、`test:task-status`、`test:resource-folders` 通过。浏览器 e2e（`test:resources:e2e` 等）在本容器不可运行：无系统 Chrome 且无 sudo 安装浏览器依赖，与既有约定一致须在本地 macOS/具备浏览器依赖的环境补跑；`test:resource-compat` 因容器缺媒体处理二进制失败，与本轮改动无关。
- 接续增量二（本轮，未提交）：(1) **材料块读者迁移**——新增 `apps/web/src/client/material-blocks.ts`：`readMaterialBlocks` 以 collectionPage 有界遍历单份材料（20000 行/16MiB 预算、跨页仅接受同 version、读毕再以首页校验版本、游标环显式报错、记录必须属于该材料），`materialBlocksExist` 用首页回答「是否存在可检索文字」而不拉大正文；`loadMaterialBlocksSnapshot`/`materialBlocksSnapshotExist` 按模式分流：cloud 走权威协议读取（账号/实例守卫齐备），本地模式保留 IDB 权威。MdReader/DocxReader/HtmlReader 的段标签读取与 ChatPanel 检索就绪检查全部迁移，不再直接查询业务镜像。模块证据 `test:material-blocks` 9/9（纯协议假读者：跨页排序、异属记录拒绝、跨页/读后版本变化拒绝、游标环拒绝、行/字节预算显式报错、守卫中止、存在性只读首页、非法材料号零读取）。(2) **flushCloud 精确失效（任务准入与会话修订）**——`submitCloudTask` 非 chat 分支由全账号 records 周期改为 `flushPreferences()` + `drainLearning()`（与 chat 分支既有契约一致：准入只需把本地待写推上去，任务读的是服务端状态而非本机镜像；完成路径仍负责刷新投影）；ChatPanel 的 `updateMcpServerIds` 会话修订后由全局 `flushCloud()` 改为 `drainLearning([session:<id>])` 精确排空该实体（`submitLearning` 本身已排空并校验，此处保留显式推送屏障）。源码形态回归 `test:task-flush-precision` 3/3：准入段不得出现 `flushCloud()`、完成段保留投影刷新（按 kind 的效果键协议留待后续批次）、会话修订只排空本实体、三个 Reader 与 ChatPanel 不得直接查询 `db.materialBlocks`。
- 本轮验证边界：`tsc -b`（web）、`test:material-blocks`（9/9）、`test:task-flush-precision`（3/3）、连同前序 `test:task-status`、`test:pwa-byte-budget`、`test:resources:pagination`、`test:cloud:transactions`（10 项）、`test:task-projections`、`test:account-lifecycle`（4 项）全部通过；`test:web:server-only-adapters` 等浏览器 e2e 在本容器仍因缺浏览器系统依赖不可运行，须在真实浏览器环境补跑。
- 仍未完成：`startCloud` 的全账号 records 基线与订阅仍在，Library 列表、封面队列仍读业务 IDB；任务**完成**路径的按 kind 精确失效需要服务端在任务回执中携带受影响 (table,key) 版本（协议演进，未在本轮猜测执行器副作用）；恢复/完整导出的读取迁移、正文双向有界窗口与 journal gap、服务端搜索、生产 1k/10k/100k 故障矩阵、WebKit 导航期 pageerror 关闭与 PWA 真离线 UI 验收仍待实施。其中浏览器/真机项须在具备真实浏览器的环境执行，不在本容器伪造证据。
