# 应用插件迁移与实施记录

> 历史实施记录：下文“不引入 Cordis”等决定对应早期迁移阶段。当前架构与后续收敛进度统一见 [当前架构](../../architecture.md)，不能把本记录用作当前装配规范。[归档导航](index.md)。

## 决策

采用项目自有 contracts 和可释放类型化注册器，不引入 Cordis。宿主仍使用现有 React / Fastify、Bot / Cloud 执行器及领域存储，不替换会话和模型循环。动态 HTML 始终在隔离 iframe 中运行，内置 React 视图必须由编译期提供者注册。服务声明不是授权。

参考：DeepSeek Harness `docs/architecture.md`、`docs/subsystems/slots.md`、`docs/cordis-primer.md`、`docs/subsystems/web-client.md`。本轮尝试重新读取 GitHub raw 文档发生 transport error；因此不调用任何未验证的 DSH/Cordis API。React 共享订阅实现已核对 react.dev 的 useSyncExternalStore 文档。

## 盘点与迁移边界

| 原入口/实现 | 贡献点/动作 | 执行与权威数据 | 适配状态 |
| --- | --- | --- | --- |
| Board / BoardManager / PluginFrame | board.main、其他支持 HTML 的视图槽 | BoardFiles；v1 原 state/schedules | 已接统一宿主、共享实例与跨位置管理；原 API 保留 |
| WidgetBlock / widgetRuntime / widgetState | chat.message 隔离运行适配器 | 原消息身份、本地作品状态 | 保留，不迁移历史归属 |
| pipelines/cards | flashcards / cards.generate | 本地 IndexedDB 或 Cloud cards 任务 | 插件及旧面板远程分支共用命名动作，生成前确认及提交时 CAS；本地资料 fallback 已对齐 |
| harness/quiz / QuizCard / QuestionInput | practice.generate/present/submit | Markdown 题库；原消息题目快照与 picks | 已接真实原题/AI 生成、历史快照、提交去重；输入 iframe 继续隔离答案 |
| store/wrongbook / study/wrongbook | review.list/present、错题入口 | 原错题/复习记录 | 已读原 FSRS、再作答沿用原 questionId；blob/映射项目文件投递与恢复验证通过 |
| 讲义/摘要生成 | material-tools / handout → material.handout | 原 handout 管道与 Cloud 任务 | 新真实视图、打开视图贡献及旧管道远程分支已接；文字资料 native / 视频 browser；讲义视图与旧 runHandout 浏览器验证通过 |
| 题库/错题本 | practice / extract、present；review / present | 原浏览器 QA 的资源/图片/edit 工具、Markdown 文件、原错题存储 | 旧问答出题/提取/做原题/复习菜单共用注册视图；extract 显式走浏览器工作器，领域、独立提取浏览器与完整浏览器回归均通过；实际 read/edit 保存及收据可核验 |
| 评论/弹幕生成 | material-tools / comments、danmaku | 原 comments/danmakus 执行器 | 新视图及旧管道远程分支已接统一动作；原覆盖语义保留，未冒称每段生成成功 |
| 转写/解析/封面 | material-tools / transcribe、material、cover | 原 Cloud / 本地执行器及资源 | 新视图及旧远程分支已接；浏览器能力不改称服务端能力；封面 force/用户选择保护保留 |
| Bot StudyTools / notebook；native Chat runtime/board | plugins 发现/配置/动作工具 | 同一个 owner-scoped 服务 | 已接 list/describe/layout/configure/invoke；Bot 策略/审批、native allow 校验与 CAS 测试通过 |
| SystemFiles / SystemMaterials / Web resources | /system/plugins、plugin-data、plugin-layout | 现有文件事务日志 | 已接嵌套目录、账户隔离及原子修订写入 |

## 项目作用域补齐复核

- 原 `plugin_project_scope_unavailable` 是未完成项，不是用户批准的范围删减；相关计划项先重开再补齐。
- 复用 ProjectRepository、原资源映射和文件服务；没有新增项目权威表。HTTP、Bot/native 工具、状态、学习动作及调度均经宿主范围检查。
- 管理入口可选择账户/项目/当前资料，复用或新建实例；布局解析同目标以资料覆盖项目、项目覆盖账户。看板项目选择写 URL；Chat 跟随所选项目；reader/资源动作由资料映射推导。
- 既有 project_agents grants 仍是原共享/管理边界；owner 插件操作不因插件声明获得其他账户权限。自主 Bot 沿用 authorizeBot 的 owner 范围和原工具审批，不将 grants 撤销错误解释为撤销 owner 自有项目。
- 重新核对原计划及文档限制：在线浏览器提取、运行中任务重启 interrupted、fixture/模拟设备是既有执行器与验收边界；没有把它们用于替代持久产物恢复、真实保存、跨位置共享或原学习数据约束。未发现另一项与本次项目范围相同的无条件拒绝替代要求。

## 不变量

- v1 默认实例直接引用原文件，不能复制权威 state/schedules；包被删除或停用即撤销 RPC。
- 包、实例、挂载是不同身份；删除挂载不删除数据；同实例多位置不增加调度。
- 账户由认证宿主提供；资料及线程归属由服务端验证；本地 Chat ID 不是服务端权限凭据。
- 学习产物引用领域存储；UI watch 不是持久投递；生成任务完成不等同产物成功保存。
- 原题提取固定宿主新建的资料会话、提示词及输入，不接受客户端任意路径或执行脚本。浏览器工作器复用原工具权限、精确 edit/CAS、图片引用及 Gateway；关闭全部应用页面后没有可用浏览器时任务排队。执行结束且实际工具保存确认、Markdown 已变化并通过来源校验后才登记题库引用；题目数是题库现有总数，不冒称全文覆盖或本次新增数。
- 全部计划步骤按实现和验收证据勾选；成功运行、截图及明确范围限制见 `acceptance.md`。原有本地执行路径继续使用本地执行器，不引入另一套学习权威数据。
