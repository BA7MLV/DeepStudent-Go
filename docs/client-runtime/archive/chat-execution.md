# 普通聊天执行与持久队列

> 历史实施记录：浏览器本地执行描述不再是产品规范，不为旧协议提供兼容承诺；历史草稿与附件仍须保全。[当前架构](../../architecture.md) · [归档导航](index.md)。

本单元只涉及普通聊天、私有队列 metadata、浏览器执行 adapters，以及获追加授权的 `cloud/tasks.ts` 全局重试接线；不代表整个 P4 完成。未修改公共 contracts、Host/API、普通历史 journal、cloud 同步、Worker、package/lock、原生代码或阶段计划。

## 生产接线

- `packages/client-core/src/session-queue.ts`：React 无关的 session 队列策略、编辑/清空、插入与续发门禁、附件释放策略、异步持久化 barrier、原 operation 的原子领取/admission 策略。`SessionQueueModel.commands()` 提供同模块策略工厂，无需改 core index/public types。
- `apps/web/src/client/chat-queue.ts`：真实 Dexie/IndexedDB adapter、跨标签原子事务与 Web Locks、账户/server/执行模式隔离、草稿身份与懒创建 rekey、附件引用检查。
- `apps/web/src/client/chat-local-execution.ts`：Local 上下文/技能/附件准备、历史预算与压缩、resource tool 组装、Agent loop、无工具续写，以及捕获原数据库的 snapshot IO。无 React/Zustand 或对 `useCourseChat` 的运行时依赖；Worker snapshot/附件/session准备写走命名conversation products，非Worker保留Local事务。资源工具 IO 使用既有 executor port 和 AbortSignal。
- `apps/web/src/client/chat-server-execution.ts`：仅使用现有 typed task submit/admission 与 task-command journal；没有 Local 导入、网络失败回退或独立 HTTP 协议。
- `apps/web/src/store/courseChat.ts`：消费队列/执行 adapters，保留草稿、会话切换、卡片动作、乐观时间线及过程投影。它仍是已有会话/UI store，不把其中的视图/卡片投影伪装成新的通用 core 业务模型。实际 Agent loop、工具构造、上下文/技能/附件准备已移出；没有把整份巨型 store 改名迁走。

`followServerSession.changed({ rows, hasOlder })` 与 `runtime.session(id).projection()` 保持原入口。普通历史 baseline/cursor/gap 重建属于主实施者的 SessionModel，不在此复制历史 journal。

## 持久身份与状态

队列只写本地私有 `_cloudMeta`，不新增公共 records 字段，也不把未发送内容上传成聊天历史。

1. `session-queue:<server/account/mode/executor>:<operationId>` 保存 session 身份、顺序、文字、技能、持久附件引用及 `pending/uncertain/accepted`。UUID 是原 command 身份，不是排序字段；恢复按保存的创建顺序排序。
2. `pending` 表示尚未领取。领取用 IndexedDB `rw` 事务，在外部 IO **之前**改为 `uncertain`；领取不设置自动过期重派 lease。
3. frozen request 直接复用现有 `task-command:<operationId>.command`，不在 queue record 中另存一份 request/receipt。队列只保存操作引用及队列状态。typed Host admission 是服务器受理事实的来源。
4. 正常响应或 admission accepted 更新队列为 `accepted`；恢复不把它放回待发列表。
5. response lost、缺失 admission、未完成查询或查询网络错误保留 `uncertain`。**missing 不证明原请求从未到达**，自动恢复只查询，不 submit。
6. 只有显式原命令重试可在收据 missing 后再次 submit；复用 frozen request 和 operationId，忽略重新传入的文本/模型配置。pending/非 missing 收据不允许重发。
7. 每个命令的 Web Lock 跨标签覆盖核对、领取与 submit。竞争标签不会仅依赖 Host 去重而各发一次 HTTP。无 Web Locks 环境仍有原子首次领取；服务器未知命令的显式重试安全拒绝为 `cross_tab_lock_required`。
8. 已领取内容不允许编辑/清空改写。pending 的删除使用 tombstone，迟到编辑不能复活它。持久化错误会显示错误并阻止派发，不把未保存内容当成可靠队列发送。

草稿身份存于 tab sessionStorage；pending 草稿可以刷新恢复而不创建空会话。首次真正派发时，session 创建与草稿映射/rekey 在同一事务中完成；迟到的草稿写入也通过映射归入原 session。切到新草稿前先等待旧队列写入，避免新 model 恢复旧快照覆盖 parked 队列。

## 生命周期、取消与附件

- queue drain 同步摘除视图项并设置 session 内派发门禁，等待持久化后才执行；重入/连续 drain 不会同时派发同一队首。插入竞争退为排队时保留原 command 身份。
- pendingAsk 优先；已有排队/插入、继续回答、技能/附件、全局输入草稿及消息 key/滚动锚语义保留。续写失败的 pending operation 保留原 rowId/action，刷新后显式重试不生成新的用户提问。
- 账户结束递增 generation、停止观察、abort 本地轮次并清理旧视图；晚到的 accepted/error/stream callback 不写入新账户。已受理服务器任务不因账户视图解除而被取消。
- Local persistence 捕获原数据库，不在异步回调中向切换后的全局 db 写旧回答。Server 失败保留原 command/receipt，不进入 Local 工具链。
- 队列撤销先持久化，再释放引用。跨 session/跨标签仍被队列、草稿或历史引用的本地 blob 不删除；事务中确认无队列/历史引用才删本地 blob。一次释放失败不阻止其他附件。
- **不从队列 DELETE 远端附件**：本设备缓存不能证明服务器历史没有共享引用。队列释放自身引用；远端 blob 生命周期仍由现有授权文件存储/资源所有者管理。这避免误删共享远端文件，不宣称新增了远端引用计数/GC 协议。
- Local 刷新不尝试重建 Agent/tool 调用栈；已领取、结果未知的 Local 项保留 unknown 状态，不能自动再执行外部工具。

## 验证

全部为无付费 fixture；E2E 使用独立 `52941` 端口（可由 `SESSION_QUEUE_PORT` 覆盖）及临时真实 API/SQLite、生产 Vite 模块、真实 Chromium IndexedDB 和同 context 两标签。

最终完整 E2E 证据（含真实 Activity 闭环）：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-queue-QHJ0TF/evidence.json`。原交付 `session-queue-jLQw2e` 证据保留。

```sh
npx tsx scripts/test-session-queue.mjs
npx tsx scripts/test-session-queue-durable.mjs
node scripts/test-session-queue-boundaries.mjs
node scripts/test-chat-followup.mjs
npx tsx scripts/e2e-session-queue.mjs
npm run typecheck -w @wangke/web
```

专项证据覆盖：

- enqueue/edit → 真 reload → 原 FIFO/operationId/技能恢复 → 生产 `sendQueuedNow` 一次 submit。
- Host 已受理但 response lost → 真 reload 仅核对 receipt，零自动 submit。
- 未到达 Host 的未知请求 → reload 不重发；显式重试只发送 frozen 原命令。
- 两真实标签同时领取同命令：SQLite 一条任务且网络也只有一次 submit，不用 SQL 幂等掩盖双派发。
- 同账户不同 server namespace 隔离；账户切换后旧队列不可读/派发；已接受但延迟的旧响应不能污染新视图。
- 共享本地附件的编辑/清空与最后引用释放。
- 纯静态 Local：真实 IndexedDB reload 后运行真实 Agent loop，仅用脚本模型流，不联网付费；草稿队列 reload 与 lazy session rekey。
- core 故障矩阵额外覆盖 pending receipt、不确定结果、原请求冻结、竞争领取、账户失效；边界检查包含违规负例。
- 既有 A–H 真实 store/Dexie/假模型回归通过；旧测试名称中的“队列本身不落库”断言实际检查 `chats` 历史，现仍成立，不代表私有 metadata 不持久化。

首轮 E2E 曾发现历史 push 提前置 `loaded` 导致 loadSession early return 漏恢复，已改为 finally 恢复。一次 A–H F 揭露新草稿切换丢弃旧 persistence barrier，已在旋转 binding 前 flush 修复；不删除失败记录，不把它们算作通过。

## 全局 Activity 重试闭环（已接通）

追加授权后已修改 `cloud/tasks.ts::retryPendingTaskCommand()`：先捕获账户、数据库及 runtime 并检查所有权，再动态加载、优先委托普通聊天 adapter：

```ts
import { retryQueuedChatOperation } from '../client/chat-queue';
const task = await retryQueuedChatOperation(operationId);
// 非 undefined：普通聊天原 operation 已由此 adapter 处理。
// undefined：不是当前账户/server 的普通聊天队列命令，继续原有其他任务恢复逻辑。
```

匹配后直接返回并清除 Activity 未确认提示；锁竞争、未知收据或账户错误直接向 UI 报错，**不 catch 后进入旧 submit**。只有未匹配才继续原非聊天任务恢复，仍使用原 kind/input/operationId。动态 import 避免初始化环；队列 → Server adapter → `submitCloudTask`，不会再调用全局 retry，因此没有递归。

`e2e-session-queue.mjs` 现在挂载真实 `CloudActivity` 并点击生产按钮，而不是只直接调用 adapter。新增证据：

- 已受理丢响应：Activity 与另一标签聊天队列同时核对，零 retry HTTP、一任务；reload 不重发。
- missing：reload 零派发；分别固定 Activity/聊天队列抢先，持有真实 submit 响应制造跨入口竞争；每组仅一次 submit HTTP、一任务，reload 后仍成立。HTTP 使用真实 typed RPC envelope 统计，不仅检查 Host 去重结果。
- 非聊天 `modelOnce` 通过真实 Activity 按钮按原命令重试，保留旧语义。
- 延迟 missing admission 后替换 runtime / 切换账户：真实 Activity 入口拒绝，不进入 fallback、不派发，reload 后原稿仍在。
- Server `retryMessage` 继续回答失败 → reload → Activity 原 rowId/action 恢复；不转成新 user 提问。

最后代码审查确认普通 send、steer、continue 均走对应执行 adapter，纯静态 Local 与懒草稿仍通过。另修复两项：admission 返回后再次检查 runtime 所有权；queue adapter 使用账户 lifetime 拒绝切走再切回的旧回调。还把 Server steer 的取消移入取得命令锁/持久 claim 后的 submit 阶段，避免竞争失败或 accepted receipt 恢复取消原任务，并加入 accepted steer 任务未被取消的断言。

测试过程记录：最初直接挂载 Activity 会合法触发空闲 pending 队列自动续发，干扰“显式发送前零派发”的 fixture；改为在故障命令已 uncertain 后挂载真实组件。按钮文字在“正在核对”时改变，不能以旧文字 selector 消失当作完成，现等待完整 recovery section 消失。一次并行 A–H 的 A 在流式正文已显示但 snapshot 未落库时提前断言失败，未改旧测试；单独完整重跑 A–H 通过。继续回答的 canonical input 无 text，Activity 使用标准恢复提示，测试按该真实结构定位。

最终 Web typecheck 通过。过程中曾受主实施者正在改的 `packages/client-core/src/session.ts` 两处 RuntimeJson→object 类型错误阻塞；未越界修复，待其并行修正后完整重跑通过。未运行/宣称最终整应用 build、Safari/PWA、性能矩阵或整个 P4 验收。
