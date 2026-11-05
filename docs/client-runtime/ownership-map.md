# 状态归属与迁移清单

当前规范入口：[当前架构](../architecture.md)。本表保留历史归属盘点，见 [归档导航](archive/index.md)。

> 历史盘点：下表包含已退役的 Browser Worker/executorRuntime，不是当前写入规范。当前任务权威见 [服务器任务执行](../server-task-execution.md)，当前领域命令、只读投影及本轮验收见 [云端唯一真相源](./single-source-of-truth.md)。

本文是源码盘点，不是全部已迁移的声明。

| 域 | 现有权威/写入口 | 客户端投影与视图 | 目标/当前进度 |
| --- | --- | --- | --- |
| 插件目录/布局/实例 | PluginService、PluginFiles、SystemFiles；账户级授权与 CAS | plugins/catalog、renderer 注入 projection、PluginHost；placement 草稿 | account/project/instance/placement/occurrence 真实 Cordis 树已交付；layout 已接 typed savePluginLayout，旧端点删除；三挂载/60秒/100次及负边界专项通过，见 plugin-lifecycle.md |
| 持久任务 | cloud_tasks、CloudTaskRunner、Browser Worker lease/permit | cloud/tasks、iframe task watch | 生产 wait 已消费共享 TaskModel；iframe watch 改为经插件 scope 的 tasks.get Model（新回归进行中）；提交/显式命令与 Bot 通知闭包待完成 |
| 普通聊天 | cloud_records、事务内 client_session_events/cursors、任务执行器；静态模式本地 adapter | core SessionModel/Timeline、client/session、store/chatHistory；生成草稿与队列独立 | 生产 SessionModel 通过 watchSessionJournal 累计新增/编辑/删除，重连续游标、缺口修复；队列持久化/执行器由 B 独立交付，未验不勾全域 |
| Bot | threads/messages/runs、持久 Bot events；Agent 服务 | core BotHistoryModel 投影，useBotHistory adapter，BotWorkspace 草稿/锚点 | 生产 follow 已共享 Typert WS；nonce/分页/稳定引用/预算算法已移 core；订阅调度及部分水位仍在 hook，旧 SSE 消费者未删 |
| 资源 | ResourceFiles/ProjectRepository、文件归属、真实文件与 SystemFiles | 共享 resources/resourceTrash query/watch、Activity 恢复、IndexedDB 旧投影 | 目录/回收站/项目文本等领域命令已接；上传先领域admission再专用二进制HTTP，hash/size/receipt/commit；legacy资源混合事务和Blob完整隔离恢复；外部fs.watch唤醒授权重读。视频派生/播放元数据与无真实文件映射的旧入口仍需逐项领域化 |
| 学习 | 原资料/题库/产物及学习记录；插件学习服务 | plugins/learning 注入 projection、学习页缓存 | 四插件视图已迁移，不直接持 transport/订阅；原学习记录权威与 permit 校验保留，非插件记录域仍待迁移 |
| 偏好 | typed setPreferences、账户CAS/收据；静态本地设置 | store/settings、preferences query/watch、durable command journal | 白名单/枚举/冲突、旧outbox原子转换及Activity恢复已接；旧records写拒绝preferences；完整账户切换矩阵待补 |
| Worker | 服务端 task/hash/lease/parent/permit/checkpoint 与完成确认 | executorRuntime HTTP-only facade、独立 executor IndexedDB/outbox、Activity恢复 | read/report/complete/receipt/commitArtifacts 已接；旧通用records写与task/:id/records删除/拒绝。artifact命令仍是明确限task的迁移桥，不宣称全部学习产物领域化；见 domain-recovery.md 退出条件 |

新 runtime 以 server/account/scope 根隔离模型。同一根内相同资源共享一个模型和逻辑流；首个 acquire 开流，末个 release 关闭。连接丢失保留 stale 数据，只有新 generation snapshot 接纳后 ready。生产目录/学习 source adapter 只在 React subscribe 提交后 retain，不在 render 中开流；Slots renderer 有真实 StrictMode/Suspense/100 次释放及完整业务 scopes 证据。

账户 runtime 暴露只读 lifetime AbortSignal；销毁时中断异步 adapter 工作，包括任务已终态但仍等待作品 owner 缓存的 waiter。生产 waiter 在进度回调和结果返回前核对 runtime 身份，懒加载 carrier 期间也拒绝账户切换。此 signal 取消客户端观察，不发送持久任务取消命令。
