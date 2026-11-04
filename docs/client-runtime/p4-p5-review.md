# P4 / P5 独立复核清单

2026-11-04；获批计划 **6/6，本地 P4/P5 已关闭**。最终 runner 已实际退出0，非测试运行中状态。未提交、推送、部署、清库、调用付费模型或真实外部 IM。完整归档见 [final-acceptance.md](./final-acceptance.md)。

## 本地门槛（全部完成）

- [x] Worker continue/retry 改走任务限定 `resetConversation`；服务端从原 task input 固定 session/row/action，retry 验证精确 write permit，原结果/附件/snapshot 保存于 SQL receipt。真实 continue、末尾结果 retry、仅 user 行的失败 retry 已通过丢响应→刷新恢复与重复启动零模型调用。
- [x] 删除 browser-chat 500ms `/commands/claim` 消费及路由；专有 executor typed stream 承载三种交互，SQL baseline/sequence/target、持久 inbox、begin/applied receipt。审批等待改为 typed authorization stream，保留 lease/report heartbeat。
- [x] cover Blob admission 校验 task/resource/课程归属/图片 MIME；合法真实任务→Blob→持久 cover 及越界拒绝通过，未恢复通用 Worker 上传。
- [x] Worker 会话设置/分支/队列静态可达性审计见下节；未开放UI任意写。实际等待retry审批时取消，Worker结束、零模型调用、原question/result不变已验证。
- [x] P4：实际 `runQa` / `editArtifact` → Browser Worker → 本地 HTTP 模型夹具19场景；完成丢响应、运行中刷新/取消/撤权、lease/parent/account/resource、精确permit及consume后撤权、产品丢响应恢复。服务端 execution fence 与原IDB日志阻止模型盲重跑；`executor-entries-mr4NCu` 是早期16场景，完整19场景见统一冻结日志。
- [x] P4/P5：三交互按原task/sequence/target snapshot、独立executing授权和真实业务效果收据分流。未派发且snapshot未变可显式同identity续接；已提交效果才settle；未知效果hold并保全/导出/归档后另行继续。真实页面中断三动作×四窗口、旧lease冻结、旧realm不得重放原send、inspection克隆拒绝通过。详细语义见domain-recovery.md；服务端另验证错误task、匿名、混合Worker/Cookie、stale observation、无证据resume/settle均拒绝。
- [x] P5：完整build/check:remote/boundaries、受影响完整业务/插件/Bot/chat/executor、双引擎/native协议、导入连续两轮与独占性能全部通过。`client-final-freeze-QughC6/results.json` 有效结果均code=0；source/build前后identity一致，协议/恢复/审计/阶段/计划同步。最终真实产物SHA256为 `c87ab8bc1a60fceb72641ec106c49ac44da591b42a790d8b5675b4b41fd3aee1`。

三条本地门槛均已关闭，P4/P5可勾选；XCTest、真机、OS安装升级、目标代理/部署与隔离Docker/VPS另列外部未验，不冒称已完成。

### 最终统一冻结（优先于下方历史记录）

最终目录 `client-final-freeze-QughC6`：runner实际退出0，`results.json`、`identities-before.json`、`identities-after.json` 均可独立核对。完整构建/业务/插件日志逐项引用 `client-final-freeze-ht6dDv`；仅测试夹具和文档发生后续变更，复用前强制验证同source/build identity。最后导入顺序两轮绿色后独占性能 `client-head-comparison-cSZONz` 六项通过：881.11ms / 41.27ms / 203.94ms / 15,857,084 heap bytes / 2,966,286 JS bytes / idle HTTP0。领域source SHA256 `d8f152bad8feb5995b02e674c0203aba457c2dabe7dd04aa6694d582af6ba269`；当前产物SHA256如上。完整命令、范围、失败修复和外部边界见final-acceptance.md。

### 统一冻结尝试（全部失败证据保留）

`client-final-freeze-xAL9Zd`：完整build/check:remote/boundaries、plain Node Host、license、runtime/products/executor、真实chat/entries/worker products、Node edit、完整cloud、plugin extraction、Bot model/UI、chat followup/session queue、Chromium/WebKit/PWA/native、导入连续两轮均通过。仅plugin-platform停在旧夹具直接向云端IDB写videos/files，被`domain_command_required`正确拒绝；测试改为真实saveMarkdown领域入口，业务断言未删。该次不算全绿，未启动性能。源码/产物前后identity一致，具体命令、起止时间、日志见results.json及identities-before/after.json。

导入旧失败`library-import-ui-qd6NEz`保留；只读SQL核对两个library-blob操作均completed、最终library snapshot也completed，不能据此推断发生字节重传。后续ht6dDv仍复现计数失败，YriHbp又发现临时Dexie观察连接读draft为null；最终统一等待导入自身busy结束、用原账户raw IDB取证，并以显式releaseSnapshot barrier固定两个Blob完成后才释放快照丢响应注入。QughC6两轮均通过，network.json保留；不删除历史失败、减少计数断言或宣称唯一复原所有历史时序。

## 已通过证据

### 本轮新增及候选复验（优先于下方历史表）

| 范围 | 最新证据 / 命令 |
| --- | --- |
| 真实 Worker continue、结果 retry、失败 retry，reset 丢响应刷新、重复启动不调用模型；真实 ask/confirmPlan/cancelPlan、socket 断开、begin/applied 丢响应、真实文件移动/取消不移动 | `executor-chat-ui-p94UZs`；`node --import tsx scripts/e2e-executor-chat.mjs` |
| 上述完整矩阵加等待retry write审批时取消，Worker退出且不调用模型、不删除原结果 | `executor-chat-ui-ODDWMz`；审批等待已接任务AbortSignal |
| authorization等待取消，不approve/consume，停止订阅 | `executor-interactions-Goyg1s`；Web/client-core typecheck通过 |
| reset 原 snapshot/附件、固定资源与 permit、终态原收据；executor WS 带 Cookie 不可读 account tasks、未知 capability 不回退 Cookie、审批 SQL baseline、三种 command/nonce/target/receipt/reconnect | `executor-interactions-VsOaK5`；`npm run test:client-runtime:products` |
| Blob admission、cover 错 MIME/跨资源拒绝、原 HTTP 字节/lease/receipt | `executor-runtime-xmEhuC` |
| 真实 cover/handout/DOCX、闭合产品及 Blob 丢响应恢复 | `worker-products-ui-TGlKX5` |
| 16 组产品授权 / 原生任务交互 / Node edit 完整审批链 | `learning-products-aOOdiM` / `native-task-interactions-CXCwMU` / `node-chat-edit-9tyRMH` |
| 未删原断言的完整业务 E2E | `cloud-e2e-jqLOZh`；B 独占文件未修改 |
| 双引擎 / 生产 PWA / 原生协议 harness | `runtime-browser-cd5FVw`、`runtime-browser-n91LB7` / `client-pwa-3wQ42q` / `native-remote-w2uFYJ` |
| 会话双标签持久队列 / 完整旧库 / 导入恢复 | `session-queue-uoqdVn` / `library-complete-VAGRVZ` / `library-import-ui-eVf7j8`、`library-import-RXPeSD` |
| 实际 ASR/字幕与 cover | `auto-subtitles-ZnU3xy` |

完整 `npm run build`、API/Web/client-core typecheck、`check:remote`、plain Node compiled Host/codec、`test-client-runtime.mjs`、生产许可检查与 `git diff --check` 通过。不是最终 P5 冻结。

此后修复了审批等待取消的AbortSignal接线；上述完整build/性能仅为该修复**之前的候选**，不能冒称当前最终产物身份，最终需重建/复验。

下列证据目录均在 `/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`。历史失败目录保留。

| 复核项 | 命令 | 最新证据 |
| --- | --- | --- |
| 完整旧schema、嵌套历史/附件/annotations、偏好、显式外部文件映射/reload、原IDB/outbox不变 | `npx tsx scripts/e2e-library-complete.mjs` | `library-complete-fhrkfy`；含特殊字符/扩展名原标题、旧size与映射实际字节不同仍保全；stale source CAS上传前拒绝 |
| 离线、Blob/快照提交丢响应、原operationId、未知顶层/嵌套字段上传前拒绝与完整导出 | `npx tsx scripts/e2e-library-import.mjs` | `library-import-ui-roY92S` |
| owner/hash/size/mime/重复映射、同大小损坏字节、持久文件缺失拒绝，无部分导入 | `npx tsx scripts/test-library-import.mjs` | `library-import-zZB0yJ` |
| 实际producer、封闭journal、丢响应→刷新→原operation/mutation/expected/value、确认后不重提 | `npx tsx scripts/e2e-worker-products.mjs` | `worker-products-ui-ud4uGU`；明细见下表 |
| 实际解码/VAD/ASR、双语言原字幕、失败/取消/显式重试、已提交片段丢响应原命令恢复与reload不重复 | `node --import tsx scripts/e2e-auto-subtitles.mjs` | `auto-subtitles-1DbRpe`；逐operationId断言，不把并行不同片段算重复 |
| 16组product/task、课程/session、lease/parent/permit、owned file、终态原收据 | `npx tsx scripts/test-learning-products.mjs` | `learning-products-QPkAjB` |
| executor HTTP/codec、Blob admission、错误字节uncertain不重传、无通用上传逃生口、lease/终态原收据 | `npx tsx scripts/test-executor-runtime.mjs` | `executor-runtime-WQlNV7` |
| Node edit持久审批/一次consume/CAS/撤权/取消不写，无效回答不继续、有效持久回答恢复 | `npx tsx scripts/test-native-task-interactions.mjs` | `native-task-interactions-O5SKA1` |
| 完整跨设备/审批/撤权/Passkey/恢复/移动/视频 | `node --import tsx scripts/test-cloud-e2e.mjs` | B连续两轮 `cloud-e2e-JJodxx` / `cloud-e2e-QzcNMO`；主线后续 `cloud-e2e-ENKuqb` / `cloud-e2e-tVTx2R`；未改B独占文件或删业务断言 |
| QA原读写工具、领域文件许可、原文保全 | `node --import tsx scripts/e2e-plugin-extraction.mjs` | 完整通过，不等于所有browser-chat continue分支通过 |
| compiled API/Host/generated codec（plain Node） | `node scripts/test-client-runtime-build.mjs` | 通过 |
| Chromium/WebKit真实Vite upgrade、断连/恢复、三投影共享与释放 | `npx tsx scripts/e2e-client-runtime.mjs`；WebKit加 `RUNTIME_BROWSER=webkit` | `runtime-browser-Lcz4Mm` / `runtime-browser-yNE8Qy` |
| 双引擎生产SW、静态离线、业务/配置/HTML不缓存、联网恢复 | `npx tsx scripts/e2e-client-pwa.mjs` | `client-pwa-trk2zQ` |
| 原生真实account Bearer/Cookie、共享mux、分页/生命周期、凭据过期、空闲零HTTP | `node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs` | `native-remote-3EFyv2`；不是XCTest或真机 |

### 实际producer清单

`worker-products-ui-ud4uGU/evidence.json` 保存原请求及 producerChecks；不以手造产品代替实际函数。

| producer | 实际产物 / 覆盖 |
| --- | --- |
| `runCards` | candidateCard；文本清洗、提交丢响应、原identity恢复、权威卡片唯一 |
| `saveImportedSubtitles` | transcriptSegment/subtitleTrack/courseDerivation；实际bundle转换、丢响应/reload |
| `runComments` / `runDanmaku` | courseComment/courseDanmaku；本地模型夹具、实际解析/父回复引用、丢响应/reload |
| `reindexMaterial` | materialBlock/courseDerivation；实际分块/统计、丢响应/reload |
| `ensureCover` | courseCover/courseDerivation；实际canvas Blob、admission/HTTP上传响应丢失、reload仅查原收据零重传 |
| `runHandout` | slideFrame/handoutDocument及附属cover；本地FFmpeg视频、真实解码/抽帧/DOCX，分别丢帧产品和DOCX提交响应并恢复；仅显式开放同课程封闭cover产品 |
| `persistHandoutEdit` | handoutDocument；实际IR→DOCX、原expected、丢响应/reload、摘要持久化 |
| `patchConversationSession` / `appendConversationMessage` | 实际命名会话/消息函数、原identity、丢响应/reload；不是完整聊天/QA入口覆盖 |
| `sessionCacheKey` / `fitModelHistory` | 实际缓存键与历史截断checkpoint、丢响应/reload |
| `runTranscription` | `auto-subtitles-1DbRpe`实际媒体/VAD、本地ASR夹具、原receipt、不重复写 |
| QA / artifactEdit / folderPlan | 具体资源command/permit而非通用写；extraction及executor许可矩阵保留，完整逐入口刷新/丢响应覆盖仍须结合P4剩余分支核对 |

Blob unknown已通过实际恢复区域inspect、完整字节下载、显式archive；WeakMap绑定当前runtime/database，拒绝structuredClone与旧runtime。没有自动重传或换permit。

### Worker 会话写可达性

以 `worker.ts::__runCloudTask` 的显式switch/回调为入口，不把整个store的UI方法视为自动授权：

| 方法 / 分支 | Worker 可达性与写入 |
| --- | --- |
| bootstrap/loadSession | 读取projection、恢复视图/私有队列metadata，不授权删除会话 |
| send/continueInterrupted | 命名conversation products；snapshot、附件描述、上下文/缓存checkpoint也走同一封闭协议 |
| retryMessage | Worker先进入任务限定reset分支并return；后面的Local直接delete/transaction不可达 |
| answerAsk/confirmPlan/cancelPlan | 仅typed inbox允许的三个动作；checkpoint固定row target；目录动作另需精确resource command/permit |
| setMcpServerIds/setSkillIds/clearCourseContext/setCourseContext、会话删除、forkFrom | UI入口，Worker switch、Agent tool executor和stream均不调用；不为这些方法开放通用Worker写。模型的set_course_context走独立onContextChange→reviseConversationSession |
| queued/steer/sendQueuedNow | Local/Server队列adapter与task admission拥有业务；Worker仅上报视图，不接受任意queue命令；真实Server双标签/插入/取消领取与Local附件引用专项 `session-queue-uoqdVn` 保留 |

此审计不替代callback执行中崩溃、QA/artifactEdit逐入口故障矩阵。

## 候选构建与性能（不是最终P5）

完整 `npm run build`、API/Web/client-core typecheck、`npm run check:remote`、AST边界、`git diff --check`、生产许可打包/压缩license检查通过。后续生产修改须重新冻结。

```sh
node scripts/benchmark-client-head.mjs /private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-baseline-head-4rgby508/source .
```

`client-head-comparison-83M3CL`：原阈值不变，测前测后产物身份相同；仅 board/todo 同夹具。

| 项目 | 干净HEAD | 当前 | 结论 |
| --- | ---: | ---: | --- |
| 首屏ms | 993.21 | 871.47 | 通过 |
| 输入ms | 51.37 | 36.44 | 通过 |
| 投影ms | 4848.62 | 93.60 | 通过 |
| heap bytes | 15,007,348 | 15,832,868 | 通过 |
| JS bytes | 3,390,621 | 2,960,719 | 通过 |
| idle business HTTP | 0 | 0 | 通过 |

- HEAD SHA256：`4e159726d86a4447f5fceeffd1cc988d27c69c7ef1362ed9953b657b180a21fb`
- 候选产物 SHA256：`56c15be9652b723802d8cacaca9469b0295e29ee67f509506569358dea6a1623`
- 同board/todo夹具，不冒称所有业务页或活动browser-chat零命令轮询。

## 删除与保留审计

- 删除整文件：`apps/api/src/agent/message-stream.ts`、`apps/apple/WangkeKit/Sources/WangkeKit/ServerEvents.swift`。
- 删除接口/消费者：thread events/stream、Web/native SSE parser/800ms poll、`taskProducts()` row推断桥；通用Worker IDB写继续拒绝。
- `system-files-changed`剩余消费者：MaterialReader、Library、McpConfigReader均在cloud query/watch分支返回后，仅静态本地使用；catalog listener有 `!cloud.enabled` 门控；sender为 `writeLocalPluginLayout`。保留静态功能。
- 保留账号失效/visibility/online/storage/abort、受限HTML bridge、模型/MCP SSE、媒体缓冲清理、学习计时、UI日期/耗时/装饰计时器、Worker lease/report。
- LiveGuest offline索引恢复属于独立LiveLink通道，保留既有语义，不是account records轮询替代。
- 已删除 browser-chat commands/claim 路由/定时器；新的 executor interactions/authorization stream 不借 account Cookie。未知 callback 效果仍保留 uncertain，不能冒称崩溃后自动续跑。

## 历史失败与外部未验

保留 `cloud-e2e-wHEvom`、library full-schema的 `08IBKo`/`9rT3Zf`、Worker modal遮挡/文案等失败目录。ASR故障夹具曾误把并行不同operation片段计为重复；修正为逐operationId断言，未放宽重复提交要求。

本轮也保留 `library-import-ui-qd6NEz`：故障注入断言期望两次二进制请求而仅观察一次；未改断言重跑 `library-import-ui-eVf7j8` 通过。原脚本仅等通用网络错误toast，可能匹配其他请求/前次错误，现新增明确等待本轮二进制/快照route.abort完成的barrier，全部原断言保留，`library-import-ui-ybbFJs`通过；尚未证明这是原失败唯一原因。Worker fixture旧resource不匹配真实input被新admission拒绝，已修正fixture使用实际task资源；Local附件引用释放断言移至Local adapter，仍保留全部引用断言，不开放Server files投影写。

仅CommandLineTools、无XCTest/Xcode；真机Safari、iOS simulator/签名安装、OS PWA安装/跨版本升级、目标代理和隔离Docker/VPS尚未验收。不得与首节本地代码缺口混为一谈。未执行生产变更。
