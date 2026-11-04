# 六阶段门槛与剩余缺口

本表是验收状态，不替代获批计划或缩减约束。2026-11-04 当前未提交工作区；最终本地冻结实际退出0，六阶段6/6。完整证据见[final-acceptance.md](./final-acceptance.md)，外部未验仍单列。

| 计划步骤 | 已有可复验证据 | 尚缺门槛（未勾选原因） |
| --- | --- | --- |
| 1 / P0 盘点与冻结（已勾选） | ownership-map/transport-inventory完成全域源码归属与路径盘点，上游同代/来源/安全/许可冻结；干净HEAD `02b3b3e` 独立archive/install/build、同夹具冻结阈值；`client-head-comparison-lLvjC9` 六项全过且产物SHA256一致 | 按P0自身门槛关闭，不绑定P5。性能实测是board/todo同夹具，不冒称每个页面均有迁移前测量；所有历史失败证据保留。最终产物仍须P5复验。 |
| 2 / P1 连接契约（已勾选） | 正式生成器/codec、Host/account适配；真实HTTP鉴权/Origin/共享mux、持久收据；真实WS暂停慢消费者、opening snapshot期间HTTP提交、retained cursor缺口、自动credential expiry、重复/乱序/missing-base帧拒绝与显式重建consumer通过；Chromium/WebKit真实Vite代理断连恢复通过；A原生HTTP/WS交付已汇合；真实account Bearer/Worker类别分流及撤销矩阵通过 | 按P1原门槛关闭，不绑定P5；XCTest缺失、真机/目标代理单列外部待验。 |
| 3 / P2 看板纵向（已勾选） | catalog/instance/task模型；三挂载共享、60秒零轮询、100次retain/release、独立设备、任务取消观察不取消任务专项；`plugin-resource-noop-guard`及无调试器`plugin-final-catalog-snapshot`完整原断言/原超时通过 | 已按 P2 自身纵向门槛核验，不人为依赖全部 P5。性能总对照和外部环境验收仍分别属于 P0/P5，不据此宣称全部阶段完成。 |
| 4 / P3 插件生命周期（已勾选） | B交付真实五层Cordis树及生命周期，见plugin-lifecycle.md；layout切typed Host/CAS/收据，旧端点删除；renderer专项规则并入全仓AST门禁；实际renderer command seam、scopes、边界负例、正式生成一致性及完整build通过 | 按P3自身门槛关闭。旧HTTP status=409的renderer CAS重试由command seam兼容typed client/conflict，不回退旧端点。 |
| 5 / P4 业务迁移（已勾选） | 普通历史/持久队列/adapters、领域资源、旧库完整schema/偏好/外部显式映射、实际产品及Blob恢复UI；任务限定reset；实际QA/artifactEdit公开入口→Browser Worker19场景、三交互各四窗口中断及证据结算/同identity续接/未知hold；完整cloud/Bot/chat/插件/Node edit冻结通过。明细见[p4-p5-review.md](./p4-p5-review.md) | 本地门槛关闭；不承诺普适exactly-once，不盲重放未知外部效果。 |
| 6 / P5 收敛交付（已勾选） | 旧thread SSE及row推断桥、browser-chat commands/claim已删；typed interactions/authorization；协议/恢复/审计同步；QughC6全部有效结果code=0，插件完整原断言、导入连续两轮、独占性能六项通过；source/build前后identity一致，真实产物SHA256 c87ab8bc1a60fceb72641ec106c49ac44da591b42a790d8b5675b4b41fd3aee1 | 本地门槛关闭。真机/OS安装升级/目标代理/部署/XCTest/隔离Docker仍外部待验，native协议harness不冒充这些环境。 |

## P4 分域状态

- **普通聊天：history journal、持久队列/adapters与全局重试已交付。** Session/Timeline与Local/Server adapter接生产；watchSessionJournal以事务cursor累计row事实，真实80条突发、WS重连、更新/删除/rollback、缺口修复通过。B最终证据session-queue-QHJ0TF/evidence.json与chat-execution.md：真实Activity双标签丢响应/missing/两种领取顺序/reload/continue严格一次retry HTTP/一任务；取消领取前steer及旧runtime/账户回调拒绝。保留其实现。
- **Bot：模型订阅迁移已验。** BotFollowModel保留已有水位/nonce/窗口/锚点算法，万行历史、500progress、60秒零线程HTTP等专项已通过。native及服务器旧SSE路径本轮已删除；`bot-sync-web-rlmYbQ`再次通过万行/500progress/60秒零HTTP/锚点保持。
- **插件学习：领域迁移及Worker恢复已验。** 四原生视图通过renderer注入模型；cards/practice写与命令收据同SQL事务，文件意图在提交后条件恢复。实际producer及封闭领域学习API、QA审批与文件编辑、19场景Worker恢复已补齐；完整插件最终冻结原断言/原超时通过，见ht6dDv/plugin-platform.log。
- **文件意图：本地专项通过。** 原始字节/CAS/冲突状态持久保留，旧pending幂等转换；冲突不盲重放，显式CAS恢复有稳定successor。`file-intents-e2e-74TN0x`通过核对后磁盘再改时拒绝覆盖、已恢复但响应丢失查原收据、唯一successor与reload；跨账户拒绝、rename/unlink/fsync中断和记录命令关联收据均有直接测试。不是全应用exactly-once。
- **records缓存：只读同步保留，任意生产写关闭。** 同事务去重/收据、确认后删outbox、应用后交cursor、逐key revision及跨标签锁保留。HTTP新写410；typed旧写只取匹配历史收据。客户端editLearning与Worker封闭LearningProduct分开；未知旧事务保留/review，不自动猜副作用。余下producer和脚本验证见resource-write-audit.md。
- **偏好：领域生产接线与浏览器恢复/账户矩阵通过。** preferences query/watch、setPreferences白名单/枚举/CAS/原收据与durable journal；旧records写拒绝第二协议。旧outbox原子转换，混合事务完整review；Activity导出/显式唯一successor。preference-commands-Ctjzh5包含冲突/丢响应/断网reload/双标签/混合legacy；domain-account-vMohNz用两个真实cookie账户，延迟旧setPreferences响应后切换principal/runtime/database，确认新账户不被覆盖/无旧错误通知、原稿保留；同账户新Runtime及导入JSON inspection拒绝。
- **资源：剩余入口已接领域，关键UI故障通过。** 新增课程技能/pin/源/字幕/暂停转写、saveMarkdown文件/CAS/服务端索引、organizeCourses与整批mixed move/undo；云导入不直接创建videos，任意旧单文件链接不进静态编辑器。courseDocument/systemDocument/systemDirectory共享watch取代相关5秒刷新。mixed第二rename/索引后失败补偿已测；进程死亡/补偿冲突保持uncertain，不声称SQL与文件原子。`wrongbook-domain-yygxka`真实QuizCard→错题文件提交丢响应→显式重试仅一次attempt→reload文件权威，以及资料库二进制上传丢响应→reload零重传/原Blob与operationId保留通过。
- **Browser Worker：封闭产物/文件命令与恢复通过本轮专项。** 独立executor库、Bearer unary + capability专有共享mux，WS不借Cookie升级为account；LearningProduct限定实际schema、任务/course/session/owned file，不再接受wire table selector。resourceCommand绑定具体编辑/create/plan及原permit，保留hash/lease/parent。最新16组 `learning-products-aOOdiM`、Blob `executor-runtime-xmEhuC`、实际聊天 `executor-chat-ui-p94UZs`、交互 `executor-interactions-VsOaK5` 通过。pending文件receipt和执行中未知callback保持uncertain，不自动重传/重跑。lease/report heartbeat保留，不能据专项声称所有崩溃窗口均已闭环。

### 后续增量（2026-11-04）

以下增量保留当时状态，不覆盖上方当前总览：

- 后续`client-runtime-hpvkU3`完整回归、API/Web typecheck再次通过；Web无生产调用者的serverClient.events/SSE parser已删除，保留A仍需的Host端点及服务端SSE验收。`test-bot-sync.mjs`8项通过，旧parser framing测试迁入已通过的真实typed codec/WS矩阵，业务activity校验负例保留。旧e2e-chat-shell仍含过时的events模拟，尚未迁移，不声称其可用。
- `wrongbook-domain-yygxka`错题本及资料库二进制导入UI丢响应矩阵通过。`e2e-chat-projects.mjs`改为观测真正的typed submitTask收据，完整原业务断言通过；`e2e-usage.mjs`匹配当前紧凑token展示后完整通过；`e2e-video-playback.mjs`独立静态database夹具修复后Chromium/WebKit全部通过。先前失败仍保留下方历史。

- 技能包 references 丢失根因为 `editLearning` 把同一原事务拆成逐行 `records.apply()`，导致文件意图安装前同步磁盘、删除刚写入的 refs。现一次编译/应用完整事务，保留前序依赖验证视图；`client-runtime-etETcQ`完整通过。`wangke-system-files-ui-uWdrc4`桌面/移动普通文档及设置创建→资料库references→双向编辑→内置技能reload通过；`wangke-mcp-files-ui-TGbPfh`双尺寸完整通过。
- `learning-products-Yugxv7`：13组实际producer的真实HTTP/Host codec，任务类型、课程/会话、过期lease、父run取消、新写拒绝及终态原收据恢复通过。未知字段另测domain拒绝，wire codec仅投影声明字段；不把被codec丢弃的字段说成成功写入。courseDerivation和更多文件/授权边界仍需补充。
- 本轮合法fixtures下`test-video-playback.mjs`与`e2e-auto-subtitles.mjs`通过；字幕包括实际browser decode/VAD/cover、夹具ASR、reload不重复、失败重试与取消。存储UI适配Intl不换行空格后完整通过。`e2e-video-playback.mjs`仍停播放器未挂载，保留诊断继续定位，未记通过。

- 本轮API/Web/core typecheck、正式生成/contracts/Host构建及AST边界通过（之后新增恢复观察/permit收紧仍需末次复验）。`domain-account-vrOT6y`真实双账户晚响应隔离通过；`preference-commands-8jfpMZ`补Worker文件完整恢复。MCP/系统目录/Bot审批改typed watch；cloud-data/tasks-changed业务窗口广播改投影订阅，未修改B的tasks/courseChat/queue模块，也未提前移除A原生端点。

- 偏好 `preference-commands-knUA0B`：真实HTTP门控制造第二设备CAS冲突；恢复UI完整导出、显式唯一successor、原expected归档、旧generation inspection拒绝；两个实际标签并发不同键提交；混合preferences/folders旧事务完整归档、不拆发。仍缺账户切换完整矩阵。
- 内置schedules/pomodoro残留5秒读轮询已删除，改受限bridge查询/状态订阅；番茄钟250ms仅本地绘制。`RfvHQx` 60秒零业务HTTP；worker claim单独列leaseAdmissions，不隐藏原始请求。
- `node --import tsx scripts/e2e-plugin-extraction.mjs`实际浏览器extraction全链复验通过（本地模型夹具，无外部调用）；Worker跨reload/长期桥退出条件未关闭。
- 资源补typed `resourceTrash` watch并接ResourceTrash；真实HTTP/WS已通过trash/restore投影。普通项目文本/目录/删除入口正接领域command，上传和旧资源outbox仍未完成；不据此关闭P4。
- 后续 `preference-commands-fKyToj`通过普通项目文本提交后丢响应/reload不重发、项目进入回收站后仍可核对完整文本/expectedRevision/收据及归档；目录核对失败单独记录，不阻止导出原稿。ProjectFiles目录改query/watch，普通项目写入/建目录/删除接领域command，保留服务端writable/assertIdle。
- 对话路由改lazy，跨页面无条件idle预取改为导航pointer/focus意图预取；`test-route-preload.mjs`通过无启动预取、子元素hover/键盘去重、外站拒绝、cleanup及Save-Data。未删除播放器/阅读器或改变静态模式。
- 补真实Host→generated codec→WS→模型重复/乱序/missing-base帧故障注入，确认baseline/cursor不被污染；发现错误后的`refresh()`只重启carrier无法复活已终止consumer，现创建新incarnation并保留stale投影，显式恢复测试通过。不自动无限重试协议错误。
- 普通聊天队列策略开始从Zustand分离：`SessionQueueModel`在client-core负责按session排队/编辑/清空/插入/续发及附件去重释放，浏览器store仅提供投影与执行port。`test-session-queue.mjs`通过门控、会话隔离、先出队后dispatch、不重放uncertain和共享附件保留；真实store+Dexie+脚本化模型流的`test-chat-followup.mjs`原A–H八项全部通过，历史排序分页专项通过。**这不是普通聊天迁移完成**：队列持久化、Local/Server执行器及普通历史journal仍未交付；既有队列测试明确只验证当前内存语义。
- 队列接线后生产对照 `client-head-comparison-lLvjC9`六项仍通过：首屏855.92→870.99ms、输入40.45→36.14ms、投影4837.38→197.57ms、heap14,993,368→15,796,632、JS3,390,621→2,845,885、idle0→0；冻结阈值及前后产物身份校验未改。
- `preference-commands-hPgzCm`补资源恢复同账户新Runtime代际：旧核对结果不得归档当前命令，原稿仍在；重新核对后可正常导出/归档。核对权限由非序列化WeakMap绑定database/runtime，不接受导入JSON充当授权。`test-client-runtime.mjs`补归档项目与活动execution期间文本/目录写入拒绝，收据为missing，确认尚未dispatch。

## 外部待验与本地可继续

### 本轮直接生产者及导入证据（2026-11-04）

下方为追加历史，后续证据已取代其中“尚缺”描述。**当前门槛、producer覆盖、删除审计、候选性能SHA256和未完成项以 [P4/P5独立复核](./p4-p5-review.md) 为准**。计划仍4/6；旧性能身份不代表最新候选构建。

- `e2e-plugin-extraction.mjs`真实Worker QA原读写工具完整通过；修复`modelHistory.sessionCacheKey/contextCheckpoint`漏用通用IDB写，改命名会话产品，不放宽缓存门禁。
- `worker-products-ui-yC37XH/evidence.json`：实际`runCards()`、真实Host/codec/capability、commit后断响应、持久产品journal、相同operationId/mutationId重试、权威卡片仅一张、通用Worker写拒绝。该专项不冒称正常调度器会把Node cards任务路由到Browser。
- `chat-shell-Sb0XUG`：聊天壳已使用真实typed HTTP/WS，仅模型为隔离夹具；移动导航、IME、新行、真实read事件及延迟回执通过。独立Receipt夹具改Vite模块以避免双React实例，不修改产品回执语义。
- `library-import-EiEdoy`、`library-import-ui-zSOTSY/evidence.json`：create-only领域快照、原ID/会话引用/目录环/文件归属、真实Markdown；真实设置UI断网、binary及快照commit后断响应、reload原identity、成功binary零重传、旧IDB/outbox/Blob不变。新增全表原始快照导出、顶层未知字段拒绝、跨标签导入锁；courseFiles尚不能安全自动转换，不声称完整历史schema已验。
- `runtime-identities-shbzL3`：真实account Bearer HTTP/WS、invalid/revoked/live revoke、Worker账号域403及WS拒绝/过期拒绝。`client-runtime-9NcxqX`完整矩阵通过；`e2e-server-widgets.mjs`真实API/Node chat+QA完整通过；`e2e-auto-subtitles.mjs`真实browser decode/VAD及夹具ASR完整通过。
- 本轮`npm run build`、Web/API typecheck、`npm run check:remote`、`git diff --check`通过。`test-cloud-e2e.mjs`先因API不再托管Web得到404，已改隔离Vite preview/真实API代理；最后仍卡旧设置页heading，未计通过。所有失败保留。
- 最新`library-import-ui-aium5c`通过上述完整UI矩阵并新增未知字段上传前拒绝、全表原始快照/原operationId/嵌套Blob无损下载；前一次`EzTs5C`离线draft读取竞态失败保留，不宣称无flaky。产品16组及executor末次分别为`learning-products-Xa83g5`、`executor-runtime-S4At09`。
- 当前产物末次浏览器复验：`runtime-browser-oI0JuV` Chromium、`runtime-browser-EJheB7` WebKit真实Vite代理断连/重连/释放通过；`client-pwa-CUyWvO`双引擎生产SW静态离线/业务不缓存/联网恢复通过。不是OS安装或跨版本升级验收。
- 冻结性能`client-head-comparison-dMO7QJ`六项全过：首屏846.97→872.90ms，输入43.63→37.33ms，投影4839.15→188.07ms，heap14,982,468→15,842,320，JS3,390,621→2,941,977，idle business HTTP 0→0。阈值未改；output-identities.json测前测后一致，HEAD SHA256 `4e159726d86a4447f5fceeffd1cc988d27c69c7ef1362ed9953b657b180a21fb`、当前 `a215959720a667388e0b492ade796a26c40e2a3707bab3e273c7c7f3472c796c`。之后只更新测试/文档，无生产源码或产物变动；未来生产修改必须重新冻结。
- 原生末次`node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs`完整通过，`native-remote-9m5bBT`；将harness原来允许account Bearer 401的兼容缺口分支改为必须成功，确认当前Host修复未被测试容忍。plain Node compiled Host专项及typed Bot sync 8项再次通过。XCTest环境缺失不变。

### 实际删除及保留边界

- 整文件删除：`apps/api/src/agent/message-stream.ts`、`apps/apple/WangkeKit/Sources/WangkeKit/ServerEvents.swift`。
- 接口/实现删除：`GET /api/v1/threads/:id/events`、`GET /api/v1/threads/:id/stream`，Web `serverClient.events`和SSE parser、原生`APIClient.events`及800ms poll、Worker `taskProducts()`任意row推断桥。`apps/`末次搜索这些旧消费者/路径/符号为零匹配。
- 保留：模型供应商/MCP SSE、Bot持久`message_events` journal、Worker lease/claim/heartbeat；静态本地`system-files-changed`及登录/错误/HTML受限bridge事件不等于旧远程业务SSE。全仓业务广播使用点仍须按语义核对，不能用旧符号零匹配替代该审查。

本轮新增：`session-journal-3AHM3q`完整history journal；`plugin-command-seams-WJMZok` typed layout；`runtime-browser-jxCZyL` WebKit代理、`runtime-browser-8shPLW` Chromium代理；`client-pwa-wsVvZh`双引擎生产SW。完整build已通过，仍有既有空:is()/Zod PURE/混合import警告。

后续：`client-head-comparison-Okz7mZ`六项全过（首屏861.49→878.11ms，输入44.58→29.26ms，投影4865.44→195.42ms，heap15,037,452→15,856,276，JS3,390,621→2,874,982，idle0→0）；`client-pwa-GI2NzF`新产物双引擎复验。媒体时长及Player播放位置已补recordMediaDuration/recordPlayback领域命令，SQL事实与receipt同事务，静态仍本地写，服务端失败不回退本地；专项通过，不再列其为generic资源写入口。Darwin新项目目录fs.watch竞争已补active directory watcher，随订阅释放；实际外部写专项复验通过。

阅读位置/HTML视图补recordReadingPosition/setReadingView领域命令，MaterialReader不再直接云端IDB写；真实HTTP receipt/非法位置/跨owner与浏览器断网不回退本地验证通过（domain-account-tXicop）。该增量完整build/正式生成一致性/compiled Host再次通过；最终性能仍待全部消费者汇合后统一冻结，不能把较早Okz7mZ当作该产物的identity证据。其余videos/folders入口逐项状态见resource-write-audit.md，P4保持未勾选。

真机Safari、真实PWA安装及目标代理/部署需对应环境和授权，单列待验，不阻断上述本地实现。当前没有发布、推送、部署、付费模型或真实外部IM调用。
