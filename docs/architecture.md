# 当前架构

当前产品仅支持服务端模式。Web 是经过认证的客户端，API 是业务执行和持久数据的权威；API 不可用不得启动本地静态应用。开发时同时启动 API 与 Web 代理。

## 数据与执行

- SQLite 保存业务事实和命令收据，文件保存真实资料；跨介质操作沿用文件意图。
- 浏览器 confirmed cache 是只读投影。离线草稿、待提交命令、附件及历史资料保全不属于静态执行模式，继续保留。
- 模型任务由服务器执行，页面只提交、观察与处理用户交互；关闭观察不取消任务。
- 普通聊天的每会话展示投影由 React-free `ConversationSessionModel` 保存，session journal 提供实时消息，列表/单行/输入区分开订阅；全局任务仅负责后台发现。无关学习记录不重拉聊天，正常待确认命令静默。实施证据见[会话模型验收](chat-session-model-acceptance-2026-11-05.md)。
- 发送失败保留服务端具体错误码，仅在聊天消息内显示错误与重试，不在右侧活动浮层显示任务恢复卡片。明确拒绝且重试时再次查证原任务不存在，才允许使用用户当前所选模型；结果未知的请求仍保留原操作内容，刷新只查询，不自动重复执行。消息和附件不丢失。
- 可视化教学练习由「交互式讲解」skill 经 `show_widget` 生成，提交后原地揭晓参考答案解析并支持重练；通用 widget 状态负责保存与恢复。首次作品绑定可等待其真实确认投影，正文流继续更新。正式题卡的判分仍由宿主负责。见[交互式讲解](interactive-explainers.md)及[练习验收](quiz-repractice-2026-11-05.md)。
- 卡片审核通过 `apps/api/src/learning/card-review.ts` 统一普通面板、插件和 Bot 的状态校验。调用方必须传原始 `expected` 状态；冲突不能改用最新状态盲重试。
- 账户根身份由 `client/account-lifecycle.ts` 的 `AccountLifetime` 管理；runtime、数据库、偏好与插件句柄共同失效。局部异步 incarnation 仍用于拒绝已结束订阅的晚回调，A→B→A 不复用旧身份。
- contracts 的 `plugin-dependencies.ts` 纯解析 manifest；API 的可信插件动作、provider、账户句柄由 Cordis 4 `Context.effect/provide` 托管。已删除自研 `PluginRegistry`。
- `realtime/runtime-domains.ts` 显式装配插件、资源、活动与记录领域的读取和失效匹配，公共认证、观察与收据保留在 `ClientRuntimeDomain`。
- 学习时长清空使用 `clearStudyTime` 完整快照 CAS；原收据重试不清除之后新增的时长。
- `handoutEdit/action=persist` 在服务器校验原始 IR/outline/blob 基线、重建 DOCX 与帧图，并在发布前再次 CAS；失败时原文件不变，浏览器保留编辑草稿。
- `chat/action=compressContext` 在服务器冻结完整历史基线，持久化保守的整轮省略计划。普通 chat、QA 和续写共用历史准备入口消费计划；内容改变、工具轮次、未完成轮次和最近两轮受保护，原始消息不删除。
- 同步是静默的后台维护。`useCloudSync.error` 只表示需要用户处理的问题（记录冲突、本地数据库事务异常）；网络/服务端抖动只记 `degradedSince`，records 跟随流按 1s→30s 退避自动重连并从已提交游标续读。界面提醒全部位于固定浮层 `cloud/Activity.tsx`（不进文档流，出现/消失不改变聊天视口高度）：离线持续 3s、重连持续 10s 才显示；未确认的修改只在「可用连接下」等待超过 15s 才提示，冲突立即提示。聊天的「正在同步」提示浮在输入区上方，8s 后才出现。
- 看板只是 `board.main` 挂载位，不预装任何组件：新账户只有 `/system/board/README.md` 与 `template/`。组件即资源文件，用户（或 Chat/Bot 创造模式）写入 `/system/board/plugins/<id>/` 或 `/system/plugins/<id>/` 后经目录流实时出现；导航「看板」仅在存在可用的 board.main 挂载时显示。旧版本自动复制的四个示例（待办/番茄钟/后台任务/定时任务）若仍为原始字节且无数据，在该账户首次加载时一次性移除；改过代码或有数据的保留。测试与运维可用 `BOARD_SEED_DIR` 预装包，示例包在 `scripts/fixtures/board-plugins/`。
- 历史恢复仅由显式操作加载，旧 journal 保存在历史档案，不回灌活动队列。未登录 Gate 可按需打开本机只读导出；无 API 不等于未缓存站点也能首次离线加载。详见[历史恢复](client-runtime/history-recovery.md)。

## 收敛状态

实施与验收以[服务端模式与能力收敛](plans/2026-11-05-server-only-consolidation.md)和[进度记录](client-runtime/server-only-progress.md)为准。聊天本地执行器、自研插件注册器及浏览器模型直连已退役；结构化讲义保存、上下文压缩、清空时长与历史恢复均已接入服务端模式。

## 规范与历史

- 云端数据不变量及已有验收：[唯一真相源](client-runtime/single-source-of-truth.md)。
- 任务执行：[服务器任务执行](server-task-execution.md)。
- `docs/client-runtime/ADR.md`、`stage-status.md`、`final-acceptance.md` 及 `docs/plugins/implementation.md` 是对应版本的历史实施证据，不代表本次收敛验收。历史记录和原始数据均保留。
