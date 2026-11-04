# 任务级模型与委派：实施记录

更新：2026-11-04。约束来源为已批准六阶段计划及 `docs/task-delegation-spec.md`。这是实施中记录，不是 P1–P6 完成声明；原计划暂不勾选。

## 状态权威与边界

- Chat Session 复用 `cloud_records.chatSessions`；Bot Session 复用 `threads`。分别保存 `defaultModel` / `default_model`，任务覆盖不修改账号或会话默认。
- Chat/临时委派 Task 复用 `cloud_tasks`，唯一队列领取者仍是 `CloudTaskRunner`。当前 Chat 执行证据保存在该任务、进度、消息和模型账本中，不另外制造一套 Run 调度器。
- Bot 的目标及执行尝试仍复用 `runs`、`run_steps`。当前尚未完成显式关联的新尝试改派接口，不把更换运行中模型冒充原尝试。
- `TaskDelegationService` 只做服务端受理、编排和读取；`task_delegations` 只记录来源、根身份、依赖、交付和提升关系，任务状态从 `cloud_tasks` 读取。
- 新增模型快照、根续接身份和命令身份为 additive schema component，重复启动幂等，不清库。凭据不写入快照。

## 已实现的路径

### 选择与执行

受理时冻结任务/会话/路由/账号优先级解析结果、候选顺序和推理设置。Bot Gateway 工具循环与 Chat streaming target 使用冻结选择；每次请求仍检查现有连接配置，明确选择不静默替换。

Bot 消息保存标准化受理命令身份。同 nonce 改模型或正文会冲突；丢失响应后重试返回原消息/Run 回执。向既有 Run 补充消息时携带新模型会明确拒绝（`task_model_requires_new_attempt`），不会忽略选择或原地改写旧 Run。

### 一层轻量委派

`models_discover` 仅返回已配置模型目录，区分 resolved / ambiguous / not_found。`task_delegate` 支持临时创建、读取、等待、取消、提升及 Chat Session 创建/读取/排队发送。工具创建身份绑定服务端父任务和工具调用 ID，限制一层、最多 8 个子任务，依赖只能指向既存同根兄弟，因此不可产生前向循环。

当前临时执行适配器是 **无工具分析**，并非具备 shell/工作区的完整自主 Agent。它通过 canonical Gateway 请求模型，输入包含原始请求、相关约束、来源版本、完成标准和依赖结果，不创建长期聊天。结构化结果包含结论、来源、实际模型/尝试、usage、费用未知、验证和未完成项。调用完成只表示分析请求结束；完成标准逐项标为未独立验证，不宣称写入了文件。

### 等待、恢复与取消

- Chat 工具回合完成并提交所有当前操作后，将消息、工具结果、去重签名、轮数和展示身份保存到 `task_agent_checkpoints`，进入 `waiting_event` 并释放执行 promise/槽位。依赖完成后替换保存的 wait 结果并重新排队，不重放工具。
- Bot 复用 `run_waits`。并发为 1 的 A 主任务 → B 子任务 → A 汇总已用隔离假模型实跑。
- 等待中的 Session 保留会话序列互斥，其他会话/无工具子任务可运行；同 Session 后续任务排队。重启已知安全的等待，不自动重放旧 running/waiting_user 的未知副作用。
- 通用取消 helper 在中止 transport 前撤销提交权，覆盖等待状态、子任务、权限和部分回答的停止标记。任务面板、插件与 Chat 委派入口复用它。
- 显式后台结果使用持久事件去重。父回答结束后创建新 Task/Run，不改写旧回答；续接保存原根任务/Run 身份，预算和根取消不因新回合重置。

### Bot 工作区等待交接（当前执行配置）

`WorkspaceHandoff` 不建立新锁管理器：默认工作区仍由 Bot 的 running scope 互斥，实际命令由 `project_executions` 留存租约。进入 `waiting_event` 时，在保存工具结果/上下文及改变 Run 状态的同一事务中保存工作区版本。任一其他运行中/待审批操作、该 Run 在其他项目留下的执行租约、相关工作区的活动写者都会阻止交接；不会为进入等待删除或绕过未确认清理的租约。

`run_workspace_scopes` 记录真正进入 shell 执行或成功返回 workspace 结果的项目，不把模型随意填写但已被拒绝的 projectId 当作授权范围。默认及已访问的其他项目都参与快照；恢复重新检查当前账号/Agent/项目权限和活动租约，在附件导入或审批/工具恢复之前比较版本。发生变化时持久注入 runtime notice，要求重新读取文件、规划后再写入/执行；不自动重放旧命令。消费快照和保存 notice 同事务，失败回滚后仍能再次发现变化。

版本为包含目录、文件及链接/特殊条目元数据的摘要，不读取内容、不跟随符号链接；不是文件内容验收或外部文件系统的原子快照。扫描最多 20,000 个条目、64 层，超限或扫描期间目录变化明确失败，不跳过版本检查。默认 scope 与命令租约以外没有新增跨项目的长期锁；后续操作仍依赖现有互斥、权限及 revision/CAS 检查。这是已支持 Bot 等待路径的安全补齐，**不代表完整 Bot 持久子 Session、配置交集或所有共享工作区组合验收已完成**。

### Session

持久子会话当前为 Chat 执行配置。历史分支在精确消息边界复制协议无关的 role/content/附件/来源身份；会话配置采用白名单复制，不携带模型 trace、native continuation、缓存、旧 checkpoint、旧强制激活技能或未来未知字段。父子后续独立。

临时任务提升在事务内保存唯一会话映射，复用任务目标、上下文与已有结果，不重执行模型；重复调用返回同一 Session。已有 Session 发送复用默认模型或单次覆盖，服务端按会话资源串行；取消某次派发不取消目标会话的其他任务。

### 预算

配置了预算的普通 Chat，以及参与委派的调用，进入原有 `UsageLedger`；保留其他普通无预算流量的单次观测行为。临时任务不能因为没有 Bot Run 而跳过根 token/cost 预留。Chat 子任务/后台续接按根 Task 汇总，Bot 子调用/后台续接按根 Run 汇总。未知价格不伪造费用。

普通父调用在首次委派之前即把精确 Task 身份、未知用量预留和可用价格快照保存在原 `model_observations`。受理后续根调用时汇总该证据与 `bot_requests`，不搬移/复制物理调用、不改变 Chat 统计来源，也不重复计数。已测量用量用实际 token，网络结果未知时保留预留；根 token/cost 和账号 dayTokens 均包含这些有 Task 归属的父调用。**旧版未保存 Task 身份的历史观测无法可靠逆向归属，未伪造回填。**

新增 `TaskStepBudget` 在工具执行前做事务内根额度检查。Bot 仍以既有 `runs.step_count` 为权威，Chat 使用 `task_tool_steps` 持久计次；Chat 子 Session、Bot 的原生学习子调用和后台续接共享对应根额度。计费键由服务端轮次/序号产生，不依赖供应商是否复用 tool-call ID。等待恢复不重计，审批恢复复用原已计费操作；预算失败不执行下一个工具或提问，也不留下失败预留。单 Run 的原有限额和 Chat 的轮次上限仍保留。独立打包的原生执行器预算异常按内部异常类型名称/代码跨边界识别，能暂停精确 Bot 父 Run。

## 已运行的验证

以下均在隔离数据库和假 fetch 上运行，不调用付费模型或真实 IM：

- `npx tsx --test scripts/test-task-delegation.mjs`：21/21 通过，覆盖冻结/默认不变、不支持的 native fallback 明确拒绝、幂等与越权、历史分支、Bot 并发 1、Chat 等待重启/不重放/稳定消息身份、取消与迟到结果、后台回传重放、忙 Session 排队及取消隔离、实际 Gateway 根预算拒绝、Chat/Bot 续接预算身份；根工具额度跨 Session/续接、事务拒绝、原生异常暂停 Bot、真实起草→复核→汇总、依赖失败不执行下游，以及首次委派前父调用的 Task 归属、已测量用量与未知预留。新增三项覆盖嵌套文件/改名/链接/深度上限、不确定的其他项目命令不放锁、事务回滚/权限失效/数据库重开，以及实际 Bot 等待重启后复核两个工作区、重新读取而不重放旧工具。初版新增 fixture 违反 threads 不可变作用域触发器，已改为创建时指定 project_id，未放松生产约束。
- `npm run test:model-gateway`：46/46 通过（协议、严格指定/fallback、安全、原生 streaming、用量与部署路由回归）。这不等于 Chat 配置 fallback 路径已交付，见下节。
- `npx tsx scripts/test-task-executors.mjs`：通过，含原生协议、Chat/QA、重启、取消、cache/raw tool history 和不回退浏览器执行。
- `npm run test:bot:hardening`：已通过完整 suite；包含 timeout、数据保留迁移、服务/领域、生命周期、实际三协议请求预算与 Gateway retention。测试内用于故障注入的日志不代表正常启动错误。
- `npm run test:tool-parallel`：14/14 协议/Bot 并行项及 17 项通用循环通过，覆盖并发额度、审批恢复不重放、排空在途操作、取消和乱序结果。旧 fixture 缺少 `freezeModel` 的失败已通过接入真实冻结 hook 修复，未放松生产受理检查。
- `npm run test:usage`：通过普通/Bot 单次物理计量、空/未知/部分 token、三协议缓存/推理用量、来源/日期/模型统计、重启及账号隔离。首次运行揭示观测表 additive 列未纳入重启 schema 校验，已按显式列白名单及声明校验修复，并新增错误类型拒绝用例；另一个旧受理替身已补真实冻结 hook。
- `npm run test:client-runtime`：通过真实本地 HTTP/WS、typed Session/Task 投影、重复事件/断线、持久回执与事务回滚。此前一次在无模型配置的旧 admission fixture 失败，已补只用于冻结的假配置；另一次遇到 external filesystem notification 的 8 秒超时，不改超时重跑通过，仍记录该 watcher 偶发失败。
- `npm run test:client-runtime:tasks:e2e`：通过，真实本地 HTTP/WS + 浏览器 bootstrap，共享等待、推送进度/结果、取消隔离、60 秒无任务 HTTP 轮询。
- `npm run check:remote`：通过。
- `npm run build`：已通过（contracts/remote-host/API/runtime/Web、i18n、边界和 notices）。Web 构建仍报告 CSS 空 `:is()`、第三方注释及混合静态/动态导入警告，未为本任务改动无关样式/打包设计。
- `npx tsx scripts/test-projects.mjs`：本轮额外回归未通过，在第 145 行旧的无受理凭证上传请求即收到 `resource_upload_admission_required`（400，旧断言为 201），尚未运行到后续 Bot/项目场景。当前 typed runtime 回归中的正式资源上传受理/传输/幂等流程已通过；未放松生产上传准入，也未把该旧项目脚本称为全绿。待按当前资源命令协议更新 fixture 后重跑完整项目 suite。

根续接身份、分支白名单和父调用预算归属加入后的全量构建、完整 Bot hardening、用量及迁移回归均已通过。最新工作区交接补丁后 API/runtime 类型检查、typed runtime、Remote 检查、迁移回归、完整构建、完整 Bot hardening 和任务观察器 E2E 已重跑通过；专项最终再次运行仍为 21/21。构建 Web 部分命中缓存，API/runtime 实际重新构建。

## 尚未交付：不能用测试通过替代

1. **完整 Session 执行配置**：Bot 持久子 Session 的创建/精确历史分支/续聊尚未实现；Chat 子 Session 不能冒充具备已授权 Bot workspace 的执行器。既有 Bot 等待路径的工作区版本留证/恢复复核及不确定租约拒绝交接已补齐（见上），但执行配置交集、项目/技能边界继承，以及未来 Bot 持久子 Session 的共享工作区交接与组合故障仍需完成。
2. **Chat configured fallback**：当前 streaming codec 固定首选 target；canonical Gateway 有 fallback 不代表 Chat 能跨协议候选安全回退。现已在 native 任务受理时用 `task_fallback_not_supported` 明确拒绝多候选 configured fallback（事务不留任务），不再接受后静默忽略；仍需实现实际候选执行/调用链与前端错误展示。Bot/canonical 临时委派保留支持的候选。
3. **完整追踪验收**：当前支持路径已实现根 token/cost/工具步数和首次委派前父调用归属；旧版无 Task 身份的历史观测不伪造回填。全链路 request identity 的工具/结果/UI 投影与未来 Bot 持久子 Session 的预算继承仍需补齐验收，不能据此宣称所有未来执行配置已覆盖。
4. **跨入口体验**：任务卡、子结果详情、子会话入口、课程 ChatPanel 的本次模型、Bot 成功发送清空草稿、账号切换隔离、本地能力边界和 IM 文本选择/澄清/交付仍不完整。已有选择器不能代表 P4 完成。
5. **运行中改派**：目前明确拒绝原地变更，仍需提供关联新尝试、保留旧证据的用户操作及后端契约。
6. **全面故障验收**：起草→复核→汇总及依赖失败阻断已用真实 CloudTaskRunner/Gateway 和假模型验证；仍需真实入口端到端、更复杂多依赖、权限撤销/审批定位、跨设备与关闭浏览器持续运行、共享工作区组合测试。现有通用 IM/MCP 回归通过不等于新委派 IM 流程通过。部分未运行旧测试的 scheduler doubles 可能仍需显式实现新 freezeModel admission hook；不通过生产代码的可选调用绕过冻结来迁就旧测试。
7. **质量/费用评测**：尚未进行。需要模型配置和明确费用授权；没有据此启用默认自动多 Agent 拆分。

上述除实际付费评测外均是剩余实施工作，不是已确认的外部阻塞。没有提交、推送、部署或清理用户数据；既有未提交工作与批准规范保留。
