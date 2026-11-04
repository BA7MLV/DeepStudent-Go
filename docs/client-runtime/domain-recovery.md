# 领域日志、上传与执行器恢复

## 普通历史的生产连接

`apps/web/src/client/session.ts::followServerSession` → account Runtime 的 `session(id)` → core `SessionModel` → generated `watchSessionJournal` → Host/domain。生产 `store/chatHistory` 保留原分页入口，接收到的是基线后累计全部row事实，不再反复覆盖40行窗口。Zustand执行器/持久队列由独立adapter拥有，不把发送副作用交给history。

SQLite `client_session_events` 和 `client_session_cursors` 与 cloud_records 原写同事务提交；rollback不推进cursor。首帧分页40行；baseline/rows/ready完整应用后才确认cursor。后续64条连续事件包含编辑与删除；任务及会话状态仍由同逻辑流唤醒。重连续原cursor，不重新丢弃已加载行。retention floor/缺帧/未来cursor触发显式resync-required，事务一致捕获全历史并按64行传输；不以latest窗口冒充缺口修复。旧账户Runtime销毁后不接晚回调。

`test-session-journal.mjs`：真实HTTP/WS、80条突发、更新/删除、事务rollback、真实carrier重连、保留缺口全量修复、未完整baseline及乱序拒绝。证据 `session-journal-3AHM3q`。常规 `test-client-runtime.mjs` 的分页/共享生命周期/task admission仍通过。

## 资源上传与旧事务

1. 浏览器先把完整Blob、path/size/SHA256/contentType和operationId写入原账户IDB journal。
2. typed resourceCommand(upload) 校验writable/assertIdle及路径/元数据，持久admission。
3. 专用HTTP二进制入口只接受admission，先claim receiving再读流；重新校验归档/执行状态、流长度/hash、图片实际类型，安全install；收据与resources invalidation同SQL事务提交。文件安装不是SQL原子效果，崩溃间隙保持uncertain，绝不自动重放。
4. 已完成同ID请求只回原收据；receiving中断/摘要不符不接第二传输。Activity reload后核对、完整字节导出、授权归档，不自动上传。

旧videos/folders outbox按原transaction分组，先查原receipt；无法安全推导文件效果的事务**整体**进入resource review，包含混合files/其他表、原before/after/mutation/permit和Blob，不静默拆分或丢失。同IDB事务删除自动writer行并保存完整review。导出用base64真实字节，非JSON.stringify(Blob)的空对象；归档许可由WeakMap绑定当前database/runtime，导入JSON无权限。

浏览器 `preference-commands-wg8TRH` 包含真实上传commit后丢响应、reload零重传、原Blob字节与receipt导出、混合legacy全事务恢复。`test-client-runtime.mjs`覆盖未admit拒绝、hash错拒绝、receiving拒重传、完成receipt复用及外部未索引文件变化推送。fs.watch只唤醒授权重读，不广播文件内容。

## 执行器边界与桥退出条件

`executorRuntime.commitArtifacts` 的wire现为封闭 `LearningProduct`，不再传任意table/changes。`task-products.ts`限定实际schema、任务种类/course/session、owned file及派生状态字段；consumed permit不能放行任意表。保留task/hash/有效lease/parent/checkpoint及SQL业务写/去重/结果receipt同事务。`client-core/artifacts.ts`仅把旧本地cache outbox转换为这些明确产物，未知producer原事务保留并报错。客户端使用独立 `editLearning`，不借Worker权限。HTTP `/cloud/records` POST新写一律410；typed旧方法只读已有匹配摘要收据，只读records缓存同步保留。

桥仅在以下条件齐备时删除，不以清库跳过：
- transcribe/material/cover/handout/cards/comments/danmaku/chat现已在wire使用专用产物schema；仍需完成各producer专项矩阵，保留原授权/lease/checkpoint和atomic receipts；
- 所有自动outbox行已由原receipt确认，或完整转入用户可导出的review；
- 各producer故障注入（丢响应、reload、过期permit、父任务撤销、账户切换）通过；
- 退出的是旧row→product本地适配及过时脚本，不要求删除承载封闭产品协议的commitArtifacts方法；不得为通过旧脚本恢复生产任意table写。

Browser Worker outcome先持久化再I/O，丢响应不生成第二失败outcome。`preference-commands-wg8TRH`真实completion提交后丢响应、reload、credential过期，以账户恢复核对原task/receipt、导出原outcome并归档，完成调用严格一次；不借新credential重跑。旧检查结果/导入JSON拒绝归档。`executor-runtime-UPRpSn`补真实artifact提交/CAS/资源/跨task/无permit/旧端点拒绝。

### Worker文件命令与观察恢复

Markdown/wrongbook/题库/讲义使用真实资源文件；`saveMarkdown`服务端保存并重索引。Worker走独立 `resourceCommand`，只允许聊天任务的saveMarkdown/organizeCourses；许可绑定具体路径/编辑或目录plan，不仅检查write。精确编辑与真实planner保持布尔replace_all语义，替换字面插入；创建绑定courseId、name、folderId及content。父任务/hash/lease仍校验，原终态收据可读取但不能新写；pending文件效果返回uncertain，绝不伪装completed。

发送前原executor数据库写 `resource-command:<id>` uncertain及taskId/operationId/完整request；确认成功后移入resource-completed。断线不自动重放。账户恢复列表包含文件命令；inspection读取原receipt/task与当前courseDocument（不可读时保留错误），完整导出expected/text/观察结果，显式归档保留记录。WeakMap绑定当前runtime/database与原inspection对象，JSON克隆和旧代际拒绝。

`preference-commands-8jfpMZ`新增真实Worker文件commit后丢响应、reload/原credential过期、只发送一次、当前正文与原request导出、JSON/旧Runtime拒绝、重新核对归档。`executor-runtime-ReE6a2`覆盖具体许可拒绝伪造内容、跨task、pending receipt与终态文件收据；`test-task-file-permit.mjs`补精确planner一致性及创建name/folder越权拒绝。其余producer矩阵及旧脚本迁移仍不据此关闭。

## 本地浏览器与代理

### 2026-11-04 最终领域恢复协议（取代下方早期“仅保留”状态）

`executor_interaction_recovery` 按持久 commandId（即 interaction sequence）保存原目标 snapshot、dispatch phase、attempt 和效果 operationId。关联原 task/nonce/target，不接受客户端任意 row selector。`begin` 只登记原命令，独立的 **executing 授权**在领域 callback 前提交；executing 请求不自动重试，响应不明即进入核对。SQL admission/最终 ack 可按原身份重试，callback 不可据此重放。

| 领域动作 | 已提交效果证据 | 无效果时策略 |
| --- | --- | --- |
| answerAsk | 原目标行 expected.ask → 按原 command.value 验证的 picked/answer，且对应任务产品收据 completed | server phase=started、无 effects 且整个原 snapshot 未变：可显式续接；executing 后不猜测 |
| confirmPlan | 原 plan 的 organizeCourses **资源命令收据 completed**，加原目标 applied=1 的任务产品收据 completed | 只有 begin 未获 executing 授权且 snapshot 未变才可续接；资源效果已提交但目标未提交仍 uncertain，展示资源收据，不再次移动 |
| cancelPlan | 原目标 applied=2 的任务产品收据 completed | 同上；不因取消动作通常无外部效果便盲重放 callback |

账户 `interactionRecovery` 返回原快照、当前目标、效果收据、任务事实及 SHA256 observation。`reconcileInteraction` 在单 SQL 事务重复 owner/task/sequence 检查及 observation CAS：

- **settle**：仅上述已提交证据齐全者结算 applied，不调用 callback、不调用模型；保留原行与收据。
- **resume**：仅 started + snapshot 未变 + 无 effects 者；先冻结旧 worker/lease/permit，再按原 interaction identity 增加 attempt，以 `resumeInteraction` 载入原行的 resume checkpoint。续接原卡片而不是发送原问题；之后仍走正常 task/parent/lease/permit 校验。
- **hold**：冻结原任务，保留 uncertain 和原命令；UI 提供原快照/当前事实/收据、完整导出与核对后归档。用户核对外部效果后，可从原会话显式另行继续。没有“所有未知效果自动续跑”或普适 exactly-once 承诺。

未决 started/executing/uncertain 会在 executor read/Worker 启动处阻止重放原 send；不能靠 lease 到期后换 realm 逃过核对。Activity 恢复动作必须持有当前账户 Runtime 的原 inspection 对象；WeakMap 不接受 JSON 克隆、旧 Runtime 或导入 JSON 作为执行许可。服务端仍独立鉴权及 CAS，UI 检查不是安全边界替代品。

真实页面销毁测试 `e2e-executor-chat.mjs` 对三动作分别覆盖 executing 授权前、callback 执行且目标提交前、目标提交后 ack 前；保留中断时持久日志，重新打开同一 browser context 完成核对。安全续接仅调用检查点之后的一轮模型；未知窗口不调用 callback，已提交窗口仅结算。正常路径还保留原 WS 重连、begin/applied 丢响应、真实资源移动/不移动断言。

QA/artifactEdit 的真实 Worker 使用服务端 `beginExecution` fence（按 owner/task 固定身份）和 executor IDB `executor-execution:<task>` 原输入/阶段/结果日志。刷新时已有 started 不再调用模型；已保存结果可走原 completion，完成提交丢响应后仅查原 receipt。未知执行可在恢复日志核对原任务、产物、导出/归档，再显式另行发起；不把模型执行当作可幂等 SQL 写。取消、read 撤权、lease 过期、parent 取消和不同账户 capability 阻止新效果；QA 文件还要求精确 consumed write permit，消费后撤权仍拒绝。`e2e-executor-entries.mjs` 通过公开 runQa/editArtifact 入口提交任务，再运行真实 Browser Worker + 本地 HTTP 模型夹具，覆盖19个入口场景，不用产品 seam 代替 producer。

### 2026-11-04：任务限定 reset 与 executor 交互

- `resetConversation` 不接收任意 row selector；服务端从已接纳 chat task 的 sessionId/rowId/action 固定终端范围，保全原 question/result/modelTrace/附件。retry 必须在精确 `reset_chat_result` write permit 的 consume 期间执行；删除与receipt同SQL事务，每task仅一次。continue只授权更新原终端结果身份，不放开其他旧task行。
- 客户端持久原reset request/receipt，丢响应后只取原操作结果；收到权威tombstone后才开始模型，先写 `started` 阻止刷新重复生成。已started而业务未结束不能自动重跑，仍需核对。
- executor WS 使用 `wangke-executor` + capability 子协议；未知/过期token不得回退Cookie。`watchInteractions` 从committed SQL读最多64条/批、baseline后递增sequence；事件只携带wake。nonce重复返回原结果，变更payload或同target不同回答拒绝；浏览器checkpoint及ask answer结构在入队前校验。
- durable inbox 顺序为 received→applying→applied；SQL begin/applied收据仅允许重试SQL admission/ack，不重试领域callback。callback开始后carrier中断不撤销该callback；本地已applied可再次确认原receipt。跨刷新遇applying/uncertain会停止、保全原命令并提供账户核对/导出/显式归档，**尚不代表业务可可靠续跑**。任意文件pending/uncertain仍不自动重传。
- 审批等待用 `watchAuthorization` 的task/permission限定SQL baseline +事件wake，消费许可仍走原验证；不再每秒查询等待状态。lease/report heartbeat保留。
- 等待订阅同时接受任务AbortSignal；取消会停止观察，authorize前后及领域callback前均检查取消，不能因credential失效后stream重连而无限等待。真实 `executor-chat-ui-ODDWMz` 在write审批pending时取消，Worker退出、零模型请求、原question/result保持；`executor-interactions-Goyg1s`验证取消观察不approve/consume。
- 实际Worker `executor-chat-ui-p94UZs` 包含continue/结果retry/失败retry的reset丢响应刷新、重复启动零模型调用、真实ask/确认方案/取消方案的socket中断及begin/applied丢响应；确认移动真实资源，取消原位置不变。`executor-interactions-VsOaK5` 补专有mux不借Cookie、错误凭据/permission越界、sequence/target/receipt。未覆盖callback执行中进程死亡的完整reconciliation，不据此关闭P4/P5。

- `runtime-browser-jxCZyL`：Playwright WebKit，真实Vite WS代理两端socket断开、新carrier恢复，三个placement共享投影与释放。
- `runtime-browser-8shPLW`：同矩阵Chromium。
- `client-pwa-wsVvZh`：生产SW在Chromium/WebKit激活、静态资源真实缓存、origin返回503时不合成业务/config/HTML，恢复联网及update检查；产物前后SHA256一致。不是OS安装或跨版本升级验收。
- 断连注入的WebKit network lost/代理ECONNRESET为预期，未宣称零网络错误。真机Safari、OS PWA安装及目标代理部署仍单列外部待验。
