# 隐式状态机审计：用最小改动同时提升 UX、DX、AX

审计日期：2026-11-10。对象：当前工作区，而非仅 `HEAD`；其中已有大量未提交工作。本次仅新增审计文档、只读探针及其生成证据，不修改应用行为。

## 结论

应用并非“没有状态机”，而是大量流程已用 `status`、布尔组合、Promise、控制器、引用计数、版本号、SQL 条件和时间戳表达了状态。真正的问题是：**同一事实在不同层被重新解释，迁移规则和副作用所有权没有总是成为可验证契约。**

最优方向不是全仓引入状态机框架，而是：

1. **先统一任务语义和能力判断**，修正已确认的 `waiting_event` 覆盖差异。
2. **保留并补强现有可靠机制**：回执优先、稳定 operationId、账号 lifetime、权威版本确认、修订号保存、生成后预览、沙盒清理确认。
3. 仅对复杂流程抽取小型纯迁移函数或领域控制器；简单展开、选择、加载仍保持局部。
4. 同一领域快照供界面、开发诊断、智能体使用；三者不各写一套状态推断。

这里 AX 指智能体体验：能读取真实阶段、阻塞原因、合法下一步和重试条件，不需要猜 DOM、反复轮询或盲目重放。它不意味着放宽授权或把不可信内容升级为指令。

## 1. 方法、覆盖与置信度

### 审计边界

- 首轮扫描了 819 个源码文件，得到 370 个候选文件、2330 条关键词线索；这些是发现工具的计数，**不是状态机数量**。
- 补查 `.mjs`、`.sh`、增量解析、时间戳生命周期、PWA、安装与发布恢复。最终扫描 837 个文件、500 个候选文件、5532 条线索，归并为 64 个流程族。文件清单、SHA-256、线索行号及计数见 [生成证据](evidence/implicit-state-audit.json)。首轮与最终规则不同，不直接比较候选数。
- 覆盖 Web、API、API runtime、共享 client/study/contracts、Swift/iOS、remote host、用户脚本、沙盒及发布入口；当前未跟踪的新文件也在扫描范围内。
- `remote-artifacts/generated` 是生成输出，不作为第二套实现计数；`packages/dsh-typert-protocol-source` 按其 `PROVENANCE.md` 属构建期上游原样输入，不作为本应用运行态实现。依赖包、WASM、构建目录、测试夹具不作为应用状态机目录。
- 关键词扫描会包含 HTTP status、注释、派生展示等误报，也无法证明不存在其他隐藏协议。目录按业务流程族归并，可能包含多个子状态机，也可能共享同一控制器。**这是当前静态审计的覆盖目录，不是形式化的“全应用绝无遗漏”证明。**
- 收尾时指纹检查发现讲义按需投影等 6 个文件仍被其他工作更新；已补读相关读取生命周期并重新生成证据，没有覆盖这些更改。工作区不是冻结快照，后续以证据中的逐文件指纹确认适用版本。

### 三种条目分类

- **I 隐式**：状态主要藏在标志位、资源句柄、时间、版本或队列存在性中。
- **E 迁移隐式**：已有明确状态字段，但合法迁移、能力判断或副作用边界散落各处。
- **L 局部简单**：单一所有者、少量状态，保持原实现通常比引入机器更好。

P1 表示优先治理高影响语义；P2 表示下一批契约/测试；P3 表示保持简单或最后治理。优先级不是“已发现缺陷的严重度”。下表状态箭头为**语义概括**，不一定是源码枚举字面量。

### 证据等级

- **已确认的源码差异**：F01、F02；部分纯逻辑已实际执行。**纯函数已复现**：F10（DSML 分块改变正文空白）。
- **结构性风险/回归边界**：F03–F09；不是声称线上已发生故障。
- 本次不启动服务器、不调用真实模型/外部渠道、不操作真实数据库或 Docker。动态探针范围及结果在第 6 节；不能据此承诺运行时无回归。

## 2. 最重要的发现

### F01 · `waiting_event` 的非终态语义跨层不一致（P1，已确认）

证据：

- `apps/api/src/cloud/tasks.ts:20` 活动集合包含 `waiting_event`；`:221` 同资源互斥也包括它；`:283` 在依赖等待挂起时写入此状态，`:173-183` 检查条件后重新排队。
- `apps/web/src/store/chatTaskState.ts:3` 的 `chatTaskActive` 只有 `queued/running/waiting_user`；`:13` 的 `streaming` 直接取这个判断。
- `apps/web/src/cloud/activityStore.ts:11` 的活动判断同样遗漏。
- `apps/web/src/cloud/tasks.ts:219-221` 的 `cancelResourceTasks` 在发请求前过滤掉该状态。
- `apps/web/src/store/courseChat.ts` 的进度合并、loading 和恢复预览依赖 `chatTaskActive`。

可直接确认的后果：给纯选择器输入 `waiting_event`，聊天活动/streaming 为 false；给资源取消筛选输入同状态任务，该任务不会被选中。**未进行实际会话挂起、点击停止和恢复的端到端复现**；“一定重复提交/一定丢失结果”不能由这些证据直接推出。

最佳方案：先定义不同职责，而不是简单全局替换 `isActive`：

- `isTerminal`：确已结束。
- `isUnfinished`：排队、执行、等待输入、等待事件均未结束。
- `occupiesResource`：是否阻挡同资源下一项，遵循既有调度语义。
- `isComputing`：真实计算中，不等于所有未结束任务都显示高速 spinner。
- `canCancel` / `canAnswer` / `canResume`：依任务种类、权限和状态分别判断；最终由服务端再校验。

界面将 `waiting_event` 展示为“等待依赖/事件”，保留停止和查看阻塞项入口，而不是伪装成完成或持续生成 token。不要把 `commandChatTask` 只接受某些状态的守卫也机械扩大：回答问题与取消不是同一种能力。

联合收益：UX 不会把等待误当结束；DX 新增状态时有完整矩阵；AX 能读到阻塞原因及合法动作。先补全状态用例，再调整共享领域策略，避免错误合并计算态与等待态。

### F02 · Bot 管理页的本地 Run 类型与停止按钮也遗漏 `waiting_event`（P1，已确认）

- `apps/web/src/cloud/BotManagement.tsx:11` 的 `Run.status` 未声明此值；`:73` 停止按钮只检查 `queued/running/waiting_user/paused`。
- `apps/api/src/agent/runner.ts:704` 明确存在 `waiting_event`；`:883` 保存等待交接；`apps/api/src/agent/service.ts:108-110` 的停止逻辑包含它。

静态可确认该值不满足按钮显示条件；尚未在浏览器构造该运行并验证整条取消链。建议管理页直接消费共享运行摘要契约；服务端返回经过授权的能力，UI 不再手写缩减版状态联合。等待事件时应显示可理解的等待项及停止动作，保留 `paused` 与等待的区别。

### F03 · 任务执行、观察者、界面是三台不同的机器（P1，已有正确机制，应保护）

`packages/client-core/src/index.ts` 的 `RuntimeModel` 用 refs/incarnation 管订阅，`TaskModel.wait` 用 settled/release 管等待者；`apps/web/src/cloud/tasks.ts:140-184` 又串行处理进度、同步 widget owner、处理回调失败。它们都不拥有服务端任务本身。

建议在命名和契约中区分：

```text
服务端任务：queued → running → waiting_user / waiting_event → running / queued → terminal
任务观察者：detached → observing → reconnecting → observing → resolved / rejected / detached
界面呈现：loading / stale / waiting / generating / result / actionable-error
```

观察取消只释放该等待者；用户显式停止才发任务取消命令。视图卸载不等于取消付费任务，连接断开不等于任务失败。进度合并不能丢终态；无 observer 时任务仍可完成。不要给每个组件再增加一条任务轮询循环。

### F04 · “结果未知”不是失败，更不是自动重放许可（P1，已有正确机制，应保护）

`packages/client-core/src/durable-commands.ts:48-53` 先查回执，拒绝对不安全的 uncertain 操作自动重放；`apps/web/src/cloud/tasks.ts:49-68` 也区分准入回执；`apps/web/src/client/resource-commands.ts` 额外有上传、退避、review、paused、跨标签页协调。

建议把“投递状态”和“业务执行状态”分开：本机 queued → sending → uncertain / acknowledged；远端 accepted → running → terminal。confirmed 后仍可能需要等权威投影。明确 `replaySafe` 的服务端依据，不能只因收到超时就创建新 operationId。资源上传、外部工具调用与纯 SQL 幂等命令不能共用无条件重试策略。

UX 给出“核对结果/继续等待/明确重试”，不只“失败”；DX 能通过 operationId 追踪；AX 获得明确的重试安全性。已用无外部副作用的探针验证回执成功不重复发送、uncertain 非幂等命令不自动重放。

### F05 · 账号身份是 lifetime，不只是 userId（P1，已有正确机制，应持续统一）

`apps/web/src/client/account-lifecycle.ts:1-2` 已明确 A→B→A 与重建 A 都产生新 lifetime。同步、资源队列、blob 下载、生成草稿和远端模型还有各自数据库/控制器/epoch 守卫。

建议继续以现有 lifetime 作为根所有者；每个异步结果提交前验证 lifetime 和目标版本，旧 finally 只能释放自己的资源。不要把现有多重守卫“简化”为字符串 userId 相等；持久命令按账号隔离，短命 token 不写入持久命令当身份。本次纯探针验证了 A→B→A、失效后迟到资源获取、释放一次等基本语义；未覆盖各适配器的全部提交点。

### F06 · 同步是多个正交状态，不该塞进一个巨大 status（P1，风险边界）

`apps/web/src/cloud/sync.ts:19-63` 同时有健康/降级、错误来源、cursor/highWater、rebuild、flight/repeat；学习/偏好/资源各有自己的命令 journal。

建议保留几个独立维度：transport、projection、outbox、identity。明确确认路径：**远端 ACK → 已确认命令继续覆盖 → 对应权威版本已应用 → 退休覆盖**。重建过程 staging 与正式投影的切换须原子，旧 epoch 不得覆盖新实例。一个循环健康不能掩盖另一循环需要用户处理的错误。

UI 展示“离线/正在追赶/有冲突/等待确认”的区别；AX 读取 cursor 差距和 blocker，而不是把非空 pending 一概当失败。不要为了更显式的状态而全量下载历史 blob、取消按需加载或增加启动阻塞。

### F07 · 编辑保存、生成预览、应用是三类不同提交语义（P1/P2，已有正确机制）

- `apps/web/src/md-editor/save.ts:109-127` 已详述 revision 合并与 flush 契约；flush 只能在实际写完目标或更新修订后完成。dirty、saving、error 允许正交组合，不应硬改成互斥枚举丢失信息。
- `apps/web/src/store/artifactDrafts.ts:24-25` 明确视图切换不取消付费生成、生成不自动应用；`:60-115` 保护 lifetime、目标源版本与控制器身份。
- `apps/web/src/pipelines/handoutEdit.ts` 的被替换任务完成语义不同于 Markdown flush，不能用同一通用队列抹平。

建议先固定测试与迁移表，保留现有 debounce、串行合并、分阶段错误；草稿状态用带数据的联合类型约束 ready 必有 next、applying 必有目标版本。应用前再次比较源版本，预览不写回；保存成功表示原文和相关投影/检索已满足该路径的完成契约，不只是请求已发出。

### F08 · 外部世界的清理、投递与发布不能凭“发出了命令”宣告完成（P1，已有正确机制）

- `infra/sandbox/broker.mjs:92-124,168-173` 以 executionId 墓碑防止先 cancel 后 execute，容器清理确认后才释放工作区锁；清理失败必须保留阻塞/可恢复信息。
- `apps/api/src/gateway/core.ts` 区分连接、绑定、inbox、run、outbox 与 uncertain，渠道 ACK 不代表 Bot 已完成或消息已送达。
- `scripts/lib/release-transaction.mjs:104-111,137-153` 已显式持久化 activation-intent，激活结果未知后只向前恢复，不能自动回滚覆盖新写入。

应保留这些已有边界，增加事件序列测试和可读 diagnostics，而不是重写为“try 成功/失败”二态。对于安全/数据丢失风险，优先级 P1 是保护现有保证，不是本次已发现绕过。

### F09 · 解析器、时间与资源存在性也是状态机（P2，易漏项）

DSML 的 call/passthrough/inBlock、SSE 的缓冲/结束标记、Markdown 的 fence/comment、工具历史配对、VAD 的 speaking/redemption、熔断的 openUntil/probing、配对的 approved_at/used_at/expires_at 都在编码状态。

最佳方案是小型确定性转换器和边界测试，不是 UI 框架。流式输入需验证不同分块方式结果一致、EOF/重复 flush 的契约、截断和限长；VAD 保留迟滞阈值与取整；认证维持事务内单次消费。此次 DSML 探针仅覆盖一个样本的每个单切点及逐字符输入，并发现 F10，不代表所有方言均已验证。

### F10 · DSML 正文空白取决于输入分块（P2，纯函数已复现）

`packages/study-core/src/api/dsml.ts:261-265` 的 `emitBody` 在 `inBlock` 为真时丢弃纯空白块，但遇到包含正文的块就先退出 `inBlock` 再完整输出。因此相同输入的 `</｜DSML｜tool_calls> after`：

- 一次性送入时，尾部正文是 `" after"`。
- 在标签后的空格之后切开（本次样本的 UTF-16 偏移 151），或逐字符送入时，尾部正文是 `"after"`。

探针遍历此样本的所有单切点，保留首个反例及输出；本样本的工具调用名称和参数在这些分块下相同。已证实的是文本分块不变性不成立，**不是工具调用丢失、重复或安全绕过**。

最佳方案：先明确“结构空白”与“正文前导空白”的协议策略，再把待判定空白纳入解析状态，直到后续非空字符/标签/EOF 决定保留还是丢弃；也可选择一致的规范化策略，但不能仅因某块是否全为空白而改变结果。修复应保持现有方言兼容、普通正文透传、限长以及 EOF 截断恢复语义；先保留本反例，再扩充换行、缩进、多个工具块和纯正文用例。

UX 得到稳定排版，DX 有确定性反例，AX 读取到的正文不因网络分块而变化。本次没有修改解析器。

## 3. 全域目录（按流程族归并）

“owner/证据”列标出真实所有者和代表性源码；不是把消费者各算一台独立机器。推荐列指出应显式化的边界或应保留的简单实现。

### A. 启动、身份、持久化与同步

| ID | 流程族 | 分类 | owner / 证据 | 状态 / 事件概括 | 最优处理 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| M01 | Web 启动与服务可用性 | I | boot：`apps/web/src/main.tsx` | 骨架→状态检查→身份/引导→应用或错误 | 单启动快照；失败原因与重试分开；独立请求继续并行 | P2 |
| M02 | 初始化、密码与 Passkey 登录向导 | E | Gate：`apps/web/src/cloud/Gate.tsx`；`apps/web/src/cloud/onboarding/flow.ts` | welcome/key/account/name/models 与 login；busy/created/ready | 扩充已有纯迁移函数；创建账号后不可退回重复创建；取消认证不当服务故障 | P2 |
| M03 | 服务端会话、令牌与设备配对 | I | 认证路由/SQL：`apps/api/src/server.ts` | 未初始化→初始化；配对 pending→approved→used/expired；令牌有效→过期/撤销 | 纯派生状态与事务内守卫；保持绑定所有者、单次消费、防重放 | P1 |
| M04 | 账号与运行时生命期 | I | lifetime/bootstrap：`apps/web/src/client/account-lifecycle.ts`；`apps/web/src/client/bootstrap.ts` | acquire→current→invalidate→disposed；A→B→A | 复用现有根 lifetime；资源统一登记；提交时校验身份与实例 | P1 |
| M05 | IndexedDB 开启、失连和重建 | I | DB owner：`apps/web/src/store/db.ts`；`apps/web/src/store/database-lifecycle.ts`；`apps/web/src/cloud/transactions.ts` | opening→ready→lost→reopening；旧事务失效 | 独立数据库 incarnation；可恢复失败不清用户草稿；等待者有终点 | P1 |
| M06 | 远端投影与引用计数观察 | E | RuntimeModel：`packages/client-core/src/index.ts` | refs 0/非0；loading/ready/reconnecting/error；revision gap/dispose | 保留 incarnation、单逻辑流、不可复活的 disposed；展示 stale 不作为新基线 | P1 |
| M07 | 投影同步、追赶与重建 | I | sync：`apps/web/src/cloud/sync.ts`；`apps/api/src/realtime/domain.ts` | follow/flush/rebuild；cursor/epoch；健康与冲突 | transport/projection/outbox 正交建模；ACK 到权威版本再移除覆盖 | P1 |
| M08 | 偏好、学习命令与通用 durable journal | E | journal：`packages/client-core/src/durable-commands.ts`；`apps/web/src/cloud/preferences.ts`；`apps/web/src/client/learning.ts` | queued→uncertain→acknowledged；conflict 隔离 | 保留回执优先与 replaySafe；按实体隔离阻塞；错误有机器可读码 | P1 |
| M09 | 资源命令、上传与自动退避 | E | ResourceCommands：`apps/web/src/client/resource-commands.ts`；`apps/api/src/realtime/resources.ts` | queued/uncertain/failed/conflict/review/paused；重试与合并 | 分离上传、命令投递、业务执行；稳定 operationId；发送后不随意合并 | P1 |
| M10 | 旧数据迁移与人工恢复 | E | recovery UI/迁移器：`apps/web/src/cloud/migrate.ts`；`apps/web/src/cloud/legacy-migration.ts`；`apps/web/src/cloud/ExecutorRecovery.tsx`；`apps/web/src/cloud/FileIntentRecovery.tsx` | 检测→预览/导出→确认→导入→核对；中断/冲突 | 共用阶段结果与恢复协议，不抹平资源/学习/偏好差异；不盲重跑未知效果 | P2 |
| M11 | 按需 blob、缓存与共享下载 | I | Downloads：`apps/web/src/store/cloudBlob.ts`；`apps/web/src/components/MaterialImage.tsx` | cache hit/miss→排队→下载→缓存/淘汰；view abort/account dispose | 保留账号隔离、去重和并发上限；单视图取消不破坏共享下载；ObjectURL 有 owner | P2 |
| M12 | 技能、目录和模型发现缓存 | I | demand/cache：`apps/web/src/skills/demand.ts`；`apps/web/src/skills/useSkillCatalog.ts`；`apps/web/src/api/catalog/index.ts`；`apps/web/src/api/modelDiscovery.ts` | 未取→pending→ready/error→失效 | 以账号/配置版本标识缓存；single-flight；不因显式化恢复启动全量预取 | P2 |

### B. Chat、Bot、调度与渠道

| ID | 流程族 | 分类 | owner / 证据 | 状态 / 事件概括 | 最优处理 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| M13 | CloudTask 准入、执行与恢复 | E | CloudTaskRunner：`apps/api/src/cloud/tasks.ts`；`apps/api/src/cloud/routes.ts` | queued→running→waiting_user/event→queued/running→terminal；重启/停止 | 集中合法迁移和领域能力矩阵；保留 SQL 条件更新、资源互斥与重启中断语义 | P1 |
| M14 | 任务依赖、委派与等待交接 | E | delegation：`apps/api/src/cloud/delegation.ts`；`apps/api/src/agent/workspace-handoff.ts` | 依赖未齐→挂起→唤醒；父取消/权限撤销/依赖失败 | 明确父子所有权与唤醒幂等；waiting_event 不占计算但可占资源 | P1 |
| M15 | 浏览器任务准入回执与恢复 | E | task commands：`apps/web/src/cloud/tasks.ts` | pending→accepted/uncertain；启动只读核对→显式重试 | 保留同一 operationId；准入结果未知不等于任务失败；与会话队列联动 | P1 |
| M16 | 任务观察、进度合并与 widget 就绪 | I | TaskModel/waiter：`packages/client-core/src/index.ts`；`apps/web/src/cloud/tasks.ts` | observing/reconnecting→终态；pending progress/work；owner 尚未同步 | 分离观察与取消；合并中间进度但不丢终态；视图取消只释放 waiter | P1 |
| M17 | Chat 展示、活动列表与操作能力 | E | selectors：`apps/web/src/store/chatTaskState.ts`；`apps/web/src/store/courseChat.ts`；`apps/web/src/cloud/activityStore.ts` | checkpoint/streaming/failed/useful；waiting_event 被漏判 | 修 F01；同一快照派生状态与动作；等待不伪装生成或完成 | P1 |
| M18 | 会话排队、steer 与附件转移 | E | SessionQueue：`packages/client-core/src/session-queue.ts`；`apps/web/src/client/chat-queue.ts` | pending→accepted/uncertain；loading/loaded/pendingAsk；restore revision | 一会话一调度者；先持久化；uncertain 不自动入队；附件只由拥有者释放 | P1 |
| M19 | 会话历史、事件游标与乐观消息 | E | session journal：`packages/client-core/src/session.ts`；`packages/client-core/src/session-state.ts`；`apps/web/src/client/session-store.ts` | baseline→增量→gap→恢复；乐观→confirmed | 保留顺序、去重、cursor 与乐观身份；历史分页和实时跟随分离 | P1 |
| M20 | 问用户、计划确认与写入审批 | E | interactions：`apps/api/runtime/task-interactions.ts`；`packages/study-core/src/harness/askUser.ts`；`apps/web/src/components/AskCard.tsx` | pending→approved/rejected/consumed/expired；等待有效答案 | 守卫绑定 owner/task/参数；事务内消费一次；无效答案不推进模型 | P1 |
| M21 | Bot run、step、预算与续接 | E | BotRunner：`apps/api/src/agent/runner.ts`；`apps/api/src/agent/service.ts`；`apps/web/src/cloud/BotManagement.tsx` | queued/running/waiting_user/event/paused→terminal；预算/输入/唤醒 | 分 run/step/request/approval 子机；先修 F02；pause 不等于失败或 cancel | P1 |
| M22 | Bot 历史与 follow 生命周期 | I | BotFollow：`packages/client-core/src/bot-follow.ts`；`packages/client-core/src/bot-history.ts`；`apps/web/src/pages/useBotHistory.ts` | pending 首屏/分页/follow；disconnect→resume；线程切换 | 固定 thread+lifetime+cursor；旧 finally 不释放新订阅；分页不重启全流 | P2 |
| M23 | 模型请求、回退、预算与熔断 | I | model gateway：`apps/api/src/agent/model-client.ts`；`apps/api/src/agent/model-gateway.ts`；`apps/api/src/agent/model-circuit-breaker.ts`；`apps/api/src/agent/budget.ts` | 预留→请求→结算/释放；closed/open/half-open；fallback | 分请求链和单次尝试；首输出后重试须遵守现有边界；半开单探针 | P1 |
| M24 | 首 token、空闲与总时限 | I | deadline：`apps/api/src/agent/stream-deadline.ts`；`apps/api/src/agent/accounted-fetch.ts` | 等首块→流中→EOF；外部取消/idle/total timeout | 三种时限保持独立，退出释放 timer/listener；超时不是停止副作用证明 | P2 |
| M25 | Bot 记忆提取、维护与版本 | E | memory worker：`apps/api/src/agent/memory-worker.ts`；`apps/api/src/agent/memory.ts` | 待维护→运行→记录版本→完成/退避；过期 source | 小队列控制器和源版本守卫；保留人工编辑、来源与预算，不把摘要完成当 run 完成 | P2 |
| M26 | IM 登录、连接、绑定与就绪 | E | GatewayCore：`apps/api/src/gateway/core.ts`；`apps/api/src/gateway/adapters/ilink.ts`；`apps/web/src/cloud/GatewaySettings.tsx` | login/connected/reconnecting；pair/expiry/revoke；多条件 ready | 连接、身份、绑定、Bot/模型配置分维度；保留唯一渠道消费者与清理等待 | P1 |
| M27 | IM inbox、附件、投影和 outbox | E | GatewayCore delivery：`apps/api/src/gateway/core.ts`；`apps/api/src/gateway/plugin.ts`；`apps/api/src/gateway/retention.ts` | received→处理/投影→pending/sending/sent/failed/uncertain；分块发送 | ACK≠处理完成≠送达；投递回执和未知效果分别恢复；保留去重、顺序、保留期 | P1 |
| M28 | Board 计划与定时派发 | E | scheduler：`apps/api/src/board/scheduler.ts`；`apps/api/src/board/tasks.ts`；`packages/contracts/src/board.ts` | enabled/due→dispatch→run result；周期推进/失败 | 派发不当完成；保持稳定调度身份与 nextRunAt 规则；暂停不等于终态 | P2 |

### C. 编辑、素材、媒体与学习

| ID | 流程族 | 分类 | owner / 证据 | 状态 / 事件概括 | 最优处理 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| M29 | Markdown 自动保存与 flush | I | MdSaver：`apps/web/src/md-editor/save.ts`；`apps/web/src/md-editor/MdEditor.tsx` | clean/dirty/saving/error；rev/pending/running/disposed | 保留 revision 等待、串行最新值合并、错误阶段；补迁移测试，不强换状态机库 | P1 |
| M30 | 产物生成、预览与应用 | E | artifact drafts：`apps/web/src/store/artifactDrafts.ts`；`apps/web/src/store/artifactEdit.ts`；`apps/web/src/components/ArtifactEditor.tsx` | idle→generating→ready→applying；取消/失效 | 目标版本是状态的一部分；ready 带 next；视图卸载不自动取消/应用 | P1 |
| M31 | 讲义增量编辑与 DOCX 重建 | I | edit queue：`apps/web/src/pipelines/handoutEdit.ts`；`apps/web/src/components/HandoutPanel.tsx` | 排队→被更新合并→重建→持久化；编辑/预览 | 保留不同于 MdSaver 的 supersede 契约；构建队列和服务端确认分层 | P2 |
| M32 | 本地文件/附件准备与上传 | I | preparation：`apps/web/src/pages/Library.tsx`；`apps/web/src/chat/prepareAttachment.ts`；`apps/web/src/store/chatAttachments.ts` | 选择→校验/转换→上传→提交/失败；所有权转移 | 每项有稳定 ID、阶段和取消 owner；部分成功可恢复，未发送附件可编辑 | P2 |
| M33 | B 站解析、选集、字幕与音视频导入 | E | Library/import：`apps/web/src/pages/Library.tsx`；`apps/web/src/bilibili/ImportTasks.tsx`；`apps/api/runtime/bilibili-import.ts` | 解析→选集→字幕/媒体分支→下载/合并/上传→导入 | 将导入控制器移出巨型页面；源/权限/批次身份固定；保留部分失败与取消 | P2 |
| M34 | 用户脚本桥、请求、合并与进度 | I | bridge：`apps/web/src/bilibili/bridge.ts`；`apps/web/src/bilibili/remux.ts`；`userscript/wangke-bili-bridge.user.js` | 不可用/版本不符→可用；request→progress→settled/abort | 保留请求 ID、字节上限、跨 realm 克隆、终结一次；不静默切服务器 IP | P2 |
| M35 | 服务端媒体处理与字幕作业 | E | executors：`apps/api/runtime/media-tasks.ts`；`apps/api/runtime/media-process.ts`；`apps/api/runtime/audio-process.ts` | decode/extract→VAD/ASR→结果投影；子进程退出/取消 | 复用 CloudTask 权威状态；阶段进度可读；子进程确实退出后结算/释放 | P2 |
| M36 | 本地转写队列与 worker | E | transcribe queue：`apps/web/src/pipelines/transcribeQueue.ts`；`apps/web/src/media/extractClient.ts`；`apps/web/src/media/extractWorker.ts` | pending→running→done/error；worker ready/terminated | 队列与 worker 协议分机；request ID/目标代次；关闭所有悬挂等待者 | P2 |
| M37 | 语音输入、权限与长按手势 | E | VoiceInput：`apps/web/src/components/VoiceInput.tsx` | idle/permission/recording/transcribing；held/cancelHint/generation | 拆采集生命周期与手势子机；旧权限回调不启动新录音；tracks/timers/meter 必释放 | P2 |
| M38 | VAD 时间线和惰性模型初始化 | I | SileroTimeline：`packages/study-core/src/media/vad.ts`；`apps/web/src/media/vad.ts` | silence→speaking→redemption→segment；pending model→ready/error | 小型转换器；保留迟滞、取整、EOF 和最短/最长段语义；失败允许重新初始化 | P2 |
| M39 | 播放、全屏、快捷键与进度持久化 | I | media element/store：`apps/web/src/pages/Player.tsx`；`apps/web/src/store/videoPlayback.ts`；`apps/web/src/components/usePlayerWebFullscreen.ts` | loading/ready/playing/paused/ended；native/web fullscreen；恢复进度 | 媒体元素作播放事实来源；显式区分意图与实际播放；保留浏览器原生行为 | P2 |
| M40 | 拖动预览、帧提取与 seek | I | preview seeker：`apps/web/src/utils/previewSeeker.ts`；`apps/web/src/components/TimeSliderWithPreview.tsx`；`apps/web/src/media/frames.ts` | hover/drag→seek pending→frame→superseded/disposed | 最新请求代次获胜；计时器与资源限额留在控制器；不要每帧写全局 store | P2 |
| M41 | 学习计时、可见性、idle 与清零 | I | study tracker：`apps/web/src/store/studyTime.ts`；`apps/web/src/study/useQuestionTimer.ts` | stopped/counting/idle/hidden；pending→flushing；clear fence | 保留播放时免 idle、后台不计、跨午夜切分、睡眠截断；串行清零不被旧 flush 复活 | P2 |
| M42 | 练习、复习、错题与评分提交 | E | learning providers：`apps/web/src/plugins/learning/PracticeView.tsx`；`apps/web/src/plugins/learning/ReviewView.tsx`；`apps/api/src/learning/card-review.ts`；`packages/study-core/src/study/wrongbook.ts` | 题目→作答→揭示/评分→提交→下一题；排程更新 | 以服务端学习命令确认结果；重复点击幂等；保留计时和错题版本检查 | P2 |
| M43 | 资源 CRUD、回收站与作用域 | E | domain service：`apps/api/src/realtime/resource-workflows.ts`；`apps/api/src/projects/resources.ts`；`apps/web/src/projects/ResourceTrash.tsx`；`apps/web/src/pages/ResourceLibrary.tsx` | 选中→操作→乐观/确认/冲突；live→trash→restore/delete | 复用资源命令和版本契约；展示态不要复制业务事实；保留权限、文件与记录一致性 | P2 |
| M44 | 文档读取、分页渲染与阅读位置 | I | reader：`apps/web/src/components/PdfReader.tsx`；`apps/web/src/components/DocxReader.tsx`；`apps/web/src/components/HtmlReader.tsx`；`apps/web/src/components/useLatestHandout.ts`；`apps/web/src/handout/useReadingPos.ts` | fetch/parse/render→ready；定位→恢复；目标替换/卸载 | 每文档 generation+渲染资源 owner；内容 ready 后恢复位置；只保留视图拥有的完整讲义；不与浏览器恢复争抢 | P2 |
| M45 | 选区、批注、手写与拖选 | I | input session：`apps/web/src/components/MaterialInk.tsx`；`apps/web/src/materials/inkInput.ts`；`apps/web/src/components/SelectionAsk.tsx`；`apps/web/src/utils/useMarqueeSelection.ts` | pointer down/move/up/cancel；选区→编辑→保存；撤销 | 手势 session 局部化；提交才进入领域命令；滚动/缩放/目标版本各有守卫 | P2 |

### D. 插件、嵌入内容、模型协议与基础设施

| ID | 流程族 | 分类 | owner / 证据 | 状态 / 事件概括 | 最优处理 | 优先级 |
| --- | --- | --- | --- | --- | --- | --- |
| M46 | 插件安装、启用、目录与投影 | E | plugin service/catalog：`apps/api/src/plugins/service.ts`；`apps/web/src/plugins/catalog.ts`；`apps/web/src/client/plugin-projection.ts` | discover/validate→enabled/disabled/error；revision→invalidate | 清晰分离配置事实与运行实例；按需目录/renderer 去重；禁用后拒绝新命令 | P2 |
| M47 | PluginFrame 与 renderer 生命周期 | I | frame owner：`apps/web/src/board/PluginFrame.tsx`；`apps/web/src/client/plugin-renderer.tsx` | mount→握手/加载→ready→reload/dispose；pending RPC | frame incarnation 隔离迟到消息；注销监听器、拒绝悬挂 RPC；不以 load 当业务 ready | P2 |
| M48 | Widget 流式预览、运行与反馈 | I | widget runtime：`apps/web/src/components/WidgetBlock.tsx`；`apps/web/src/components/WidgetStreamFrame.tsx`；`apps/web/src/harness/widgetRuntime.ts`；`apps/web/src/store/widgetState.ts` | streaming→完整→运行；local state→confirmed；resize/feedback | 展示流、可执行实例、持久反馈分开；owner 已投影才开桥；不隐式转移内容所有权 | P1 |
| M49 | MCP 连接、工具发现与 OAuth | E | McpManager：`apps/api/src/mcp/manager.ts`；`apps/api/src/mcp/oauth.ts`；`apps/web/src/mcp/client.ts`；`apps/web/src/mcp/McpSettings.tsx` | disabled/connecting/ready/disconnected/auth_failed/failed；revision/idle dispose | 配置 revision 与连接 owner；连接、OAuth、调用三层取消；副作用调用超时不盲重放 | P1 |
| M50 | SSE、模型协议、重试与输出提交 | I | shared parser/client：`packages/study-core/src/api/modelClient.ts`；`packages/study-core/src/api/messageHygiene.ts` | request/retry→首输出→buffer/events→协议结束/截断；tool 结果配对 | 明确重试提交边界；SSE chunk 不等于完整事件；保持 usage/finish 与工具消息一致 | P1 |
| M51 | DSML 工具还原与超限透传 | I | recoverer：`packages/study-core/src/api/dsml.ts` | text/tag/call/parameter；inBlock；oversize→passthrough；flush | 保持有界解析、普通正文透传、仅声明工具时启用；做分块不变性与截断测试 | P2 |
| M52 | Markdown、链接与续写增量解析 | I | parsers：`packages/study-core/src/materials/md.ts`；`packages/study-core/src/utils/linkify.ts`；`packages/study-core/src/utils/continuation.ts`；`apps/web/src/utils/framePatch.ts` | fence/comment/inline；前缀等待→输出；重叠续写→拼接 | 保持纯转换器；分块、转义、嵌套、EOF 与内存上界为测试主轴 | P2 |
| M53 | 渲染器惰性初始化与错误恢复 | I | diagrams/readers：`apps/web/src/components/mermaid/DiagramBlock.tsx`；`apps/web/src/components/mermaid/MermaidBlock.tsx`；`apps/web/src/utils/preload.ts` | cold→single-flight→ready/error；内容修订→重绘 | 每资源/版本去重；错误可重试；仅当前代次提交渲染结果；不全局化瞬态尺寸 | P3 |
| M54 | 模型设置、发现、探测与配置保存 | E | settings：`apps/web/src/components/settings/ModelsModule.tsx`；`apps/web/src/components/settings/ModelLibrary.tsx`；`apps/web/src/utils/useProviderModels.ts`；`apps/web/src/cloud/Models.tsx` | 编辑→探测/发现→保存→confirmed/error；provider 切换 | provider+configuration revision 绑定结果；探测不隐式保存；权限/能力来自实际路由 | P2 |
| M55 | 上下文压缩、消息删除与恢复 | E | command/UI：`apps/web/src/store/contextCompression.ts`；`apps/web/src/components/useContextCompression.ts`；`apps/web/src/components/useMessageDeletion.ts`；`apps/api/runtime/context-compression.ts` | idle→请求→执行/等待→确认；删除/恢复/版本失效 | 复用任务与命令协议；preview/approval 与应用分开；旧上下文不覆盖新消息 | P2 |
| M56 | Swift 认证、远端连接与账号切换 | E | native model：`apps/apple/WangkeKit/Sources/WangkeUI/AppModel.swift`；`apps/apple/WangkeKit/Sources/WangkeKit/RemoteConnection.swift`；`apps/apple/WangkeKit/Sources/WangkeKit/APIClient.swift` | signed out→connecting→ready/reconnect；token expiry/cancel | 原生实现同领域契约但不强共用 UI；Task/stream 按账号代次终结；令牌安全存储 | P1 |
| M57 | Swift BotJournal、分页和乐观发送 | I | BotJournal：`apps/apple/WangkeKit/Sources/WangkeKit/BotJournal.swift` | initial/page/follow；optimistic→receipt/uncertain；thread switch | 与 Web 共用测试轨迹语义；保持游标、operationId、旧结果隔离与取消观察边界 | P2 |
| M58 | 沙盒准入、执行、背压与清理 | I | broker：`infra/sandbox/broker.mjs`；`infra/sandbox/cleanup.mjs`；`apps/api/src/agent/sandbox.ts` | admission→spawn→running/backpressure→terminating→cleanup→released | 清理确认前锁不释放；先 cancel 墓碑；disconnect/timeout 不伪装已停止 | P1 |
| M59 | 发布事务、快照、激活与恢复 | E | release journal：`scripts/lib/release-transaction.mjs`；`scripts/lib/release-docker.mjs`；`scripts/lib/release-storage.mjs` | prepared→stopping→snapshot→staged→activation-intent→complete；rollback/recover | 已显式且设计关键；保护停写证明、恢复点、激活后向前恢复，不另写通用机器 | P1 |
| M60 | API 排空、staging 与退出 | I | process owner：`apps/api/src/server.ts`；`apps/api/src/lifecycle.ts`；`apps/api/src/storage/release.ts` | staged/serving→draining→settled/deadline→exit；activation | 不再准入新工作后等待已收任务；deadline 只报告未结束，不表示已停止 | P1 |
| M61 | 安装与部署维护入口 | E | CLI owner：`install.sh`；`scripts/release-deploy.mjs`；`apps/api/scripts/deployment-maintenance.mjs` | step started→completed/failed/interrupted；adopt/deploy/recover | 复用 durable release；保持可重入检测和明确恢复提示；完成进度不早于真实完成 | P2 |
| M62 | PWA 首装、接管与升级提示 | I | service worker boundary：`apps/web/src/main.tsx`；`apps/web/pwa-precache.ts` | 无 controller→首次接管；旧 controller→新版本；旧页仍运行 | 保留首次不提示、升级不强刷；有草稿/命令时不自动丢状态；按需缓存不回退 | P2 |
| M63 | 滚动跟随、虚拟列表与页面恢复 | I | viewport owner：`apps/web/src/components/useChatScroll.ts`；`apps/web/src/components/VirtualMessages.tsx`；`apps/web/src/components/useAssistantPosition.ts` | follow bottom/用户离开/新消息/resize；定位请求 | 小型局部状态；用户滚动优先；不因新 token 抢滚动；DOM 布局反馈不进业务机 | P3 |
| M64 | 简单面板、选择、菜单与反馈 | L | local UI：`apps/web/src/components/SettingsModal.tsx`；`apps/web/src/ui/feedback.tsx`；`apps/web/src/ui/copy-button.tsx`；`apps/web/src/ui/layout.tsx` | closed/open；选择/拖拽；copy→success→reset；toast→dismiss | 单一布尔/局部联合保留；只为异步竞态加 generation 和 cleanup；不引入框架 | P3 |

## 4. 建模决策：什么值得改、什么不该改

### 默认选择纯迁移契约，不默认引入依赖

复杂流程的最小单元：

```ts
type Transition<S, E, Effect> = (state: S, event: E) => {
  state: S;
  effects: readonly Effect[];
};
```

这是方向示意，不是要求统一实现上述接口。服务端 SQL 事务仍是真相源和原子守卫，已有 class 控制器仍可保留；effects 由现有适配器执行，完成后携带实例/版本身份回报。不要在 reducer 中请求网络或访问 UI。

选择准则：

- 多个布尔共同表达互斥阶段、多条异步完成路径、重入/重试/恢复、跨层消费，优先显式化。
- 真正正交的事实保留组合：例如保存时又产生新修改、重连时仍有旧快照、生成失败但仍保留上一版预览。
- 不持久化能安全派生的展示状态；不把控制器和 Promise 塞入序列化状态。
- 短时高频数据（音量、pointermove、逐帧 seek）留在局部资源 owner；只发布 UI 真正需要的快照，保持现有合并、选择性订阅与按需加载。
- 已显式且可恢复的发布事务不重写；简单 modal/open 不做复杂机器；解析器不套 UI 状态框架。
- 只有实现阶段确实出现深层嵌套、并行层级和可视化工具收益时，再比较库方案；本次没有引入依赖的必要证据。

### UX、DX、AX 共用的状态说明

对高风险领域，建议在现有 DTO/diagnostics 上增量补齐，而不是另建第二套状态真相：

```text
identity：taskId / runId / operationId / account-lifetime / revision
phase：queued / computing / waiting-input / waiting-event / reconciling / terminal
blocker：稳定 code + 可理解说明 + 可见范围内的依赖 ID
capabilities：canCancel / canAnswer / canResume / canRetrySafely
outcome：accepted / confirmed / uncertain / conflict（按职责分开）
progress：粗粒度阶段、更新时间；不把日志或 token 输出冒充完成
```

- UX：文案区分等待、重连、未知、冲突和完成；合法动作明确，用户意图可保留。
- DX：穷尽事件/状态、稳定错误码、相关 ID、迁移测试，无需跨十个组件拼状态。
- AX：读同一权威快照，知道何时等、何时确认、何时停止，重试可说明依据。
- 安全约束：capabilities 仅作提示，不替代执行端授权；不暴露密钥、隐藏依赖或跨账号状态；智能体不能以自报状态跳过审批。

## 5. 不破坏功能的落地顺序

这是建议顺序，**本次未实施应用迁移**。

### 第一批：修语义漂移，控制改动面

1. 为所有 CloudTask/Run 状态建立表驱动测试，覆盖非终态、计算、资源互斥、取消、回答、恢复和展示，不共用一个含糊的 active。
2. 修 F01/F02；迁移前后逐项检查可用操作和文案。服务端负责最终能力校验，旧客户端保留兼容策略。
3. 补 waiting_event 真实任务端到端：等待依赖时可查看/停止；依赖结束后继续；停止后不被唤醒；刷新恢复不重复执行。

### 第二批：把已有安全边界变成可回归契约

优先 M04–M09、M15–M21、M29–M30：先写现状特征测试，再局部抽出迁移/策略；旧外部接口暂不变。命令回执格式、operationId 和持久 journal 不做无版本变更。

每个修改单独满足：

- API 与快照兼容；历史 pending/uncertain 数据仍可读可恢复。
- UI 旧功能与快捷操作保留；同源生成、手动应用、卸载与恢复语义一致。
- 延迟/断网/刷新/A→B→A/重复操作的轨迹结果一致；未增加付费请求或外部写入。
- 无新增按视图轮询、启动全量加载、逐 token 全局重渲染。
- 失败可诊断并可向前恢复；不通过删除草稿或清空队列“解决”异常。

### 第三批：资源密集界面与协议

逐项处理 Library 导入、VoiceInput、frame/worker、Swift 对等轨迹及解析器性质测试。只有同类机制有相同完成语义时才复用控制器；不要把下载、保存、生成、发布统一成一个万能 async hook。

### 最后：简单 UI

M53/M63/M64 保持局部；只修有证据的竞态、清理和交互问题，避免“为了显式化”增加状态、包体和维护成本。

## 6. 验证记录与后续验收

### 本次实际执行

运行：

```sh
node --import tsx docs/evidence/implicit-state-audit.mjs > docs/evidence/implicit-state-audit.json
```

探针只读源码，并导入无应用启动效果的纯模块；输出包含最终扫描统计、目录、源文件指纹、任务谓词矩阵、Bot 按钮源码守卫和 7 组纯逻辑检查：

1. 八种 CloudTask 状态的选择器/源码矩阵；Board 终态对照。
2. 账号 A→B→A 与失效资源释放。
3. completed 回执不重复发送。
4. uncertain 非幂等操作不自动重放。
5. 熔断半开只允许一个并发探针。
6. 单一 DSML 样本的所有单切点和逐字符输入：工具调用一致，但正文空白存在反例（F10）。
7. VAD finish 保留最小样本语音段。

本次结果为 **6 组通过、1 组失败**；DSML 探针保留失败，脚本输出完整 JSON 后退出码为 1。不能把它作为全绿回归测试，也不代表 F01/F02 已修复。服务端活动集合、资源取消、Activity、Bot 按钮从源码提取；chat 选择器实际调用。不会伪称对 HTTP 取消或数据库状态迁移做过运行验证。

### 后续修改必须覆盖的轨迹

- 任务：八状态矩阵；queued→waiting→terminal；重复停止；取消与完成竞争；父子取消；重启；部分进度+终态同批。
- 投递：发送前失败、发送后 ACK 丢失、回执 pending/missing/completed/uncertain、稳定 operationId、跨标签页并发与实体冲突隔离。
- 身份：A→B→A、同账号重建、await 后/回调前切账号、旧 finally、迟到资源获取、数据库重开。
- 同步：增量缺口、旧 epoch、重建中断、confirmed 但投影未到、一个循环成功另一个失败。
- 保存/编辑：rev6→rev7 合并、运行中新增编辑、各阶段失败、flush 与 dispose、生成中目标删除/变更、预览后目标变化、切页面后返回。
- 媒体：权限框期间取消、长按移出取消、worker 退出、seek 超时、源变更、后台/睡眠/跨午夜、清零与 flush 竞争。
- 协议：每个 token/标签分界、非法/截断 UTF-8、EOF、限长、重复终止、输出后断流，确保不重复调用工具。
- 外部副作用：IM 模糊送达、MCP 超时、沙盒清理失败、发布 activation-intent 后断电；证明恢复方向，而非仅检查异常文案。

仓库已有 `test-task-projections`、`test-client-runtime`、`test-account-lifecycle`、`test-onboarding`、`test-background-tasks`、`test-resource-recovery`、`test-bot-*`、`test-gateway-*`、`test-release-*` 及相关 e2e，可作为实施时的回归基础；本次没有运行整个测试套件，也没有验证各脚本当前都通过。涉及真实渠道/模型/部署的测试应先隔离环境和确认副作用，不能直接在用户账号上运行。

## 7. 交付范围

- 本报告：流程目录、证据、最佳处理方式、约束与实施顺序。
- [机器可读证据](evidence/implicit-state-audit.json)：复查目录/状态矩阵/源码指纹，方便后续开发和智能体定位。
- [只读复查脚本](evidence/implicit-state-audit.mjs)：重新生成证据；源码结构改变时提取失败会明确报错，不静默猜测。

未修改应用代码、未引入依赖、未提交/推送；现有未提交工作保持原样。源文件指纹用于识别审计后的变化，不能把未来工作区当成本次已验证对象。
