# 通信路径盘点

> 历史源码盘点，不代表当前协议兼容承诺。当前规范：[当前架构](../architecture.md)；[历史导航](archive/index.md)。

## 新路径（隔离实测与已迁移生产入口）

- `POST /api/clientRuntime/read|command|receipt`：Typert 生成入站/出站 codec + Gateway dispatch；named action 使用明确 command target，复用持久 operationId。
- `WS /api/remote.mux`：上游 mux，含 generation 事件通道和独立可取消领域流。
- `clientRuntime/watch`：catalog/plugin/task，首帧 snapshot，其后 revision delta；服务端每 100ms 从持久变更 journal 读取 invalidation，不是浏览器业务轮询。
- 身份 lease 每 1000ms、WS heartbeat 每 15000ms，均与业务查询分开统计。
- `clientRuntime/watchTask`：正式 codec 校验任务投影；生产 `cloud/tasks.ts::waitCloudTask` 已消费账户共享 runtime 的 TaskModel，不再每 750ms GET。观察 abort 仅释放 waiter，不发送 cancel。进度缓存工作有界合并；作品 owner 等待使用 Dexie liveQuery 和 15 秒超时。
- `clientRuntime/watchTasks`：正式生成的账户任务列表流，生产 CloudActivity 消费 TaskListModel，删除每标签 250ms tasks GET；保留原任务列表领域筛选/200 条上限与聊天/jobs 临时适配。该路径的真实浏览器 60 秒/生命周期专项正在验收。
- `apps/web/src/client/bootstrap.ts`：每个浏览器账户上下文共享 runtime，cookie HTTP + 单 mux WS，账户/session/pagehide/HMR 释放；Worker 不使用账户 Remote。
- 生产 `plugins/catalog.ts`、四个学习视图与 sandbox state 使用共享 Models；Local 保留存储事件读取，无目录/学习订阅定时 GET。PluginHost/Slot/Actions 使用专用 Cordis Slots renderer；业务视图只接注入 projection/command。生产多挂载、四个各 60 秒窗口与释放专项已通过。
- `PluginFrame` SDK `tasks.watch/wait`、`queries.watch/unwatch` 与 tasks.observeList 使用共享 scoped Models，不经账户级 TaskModel 绕过实例授权。每 iframe 共用 16 条观察配额，cleanup 全部释放；SDK 合并等待处理的中间进度并单独保留终态。tasks HTML 原 3 秒 tasks.list 轮询已删除。
- `clientRuntime/watchBot`：生产 Bot follow，持久 cursor 重放，64 帧 bounded batch，过期/未来 cursor → resync-required、逐帧 scope 校验。10000 历史/500 progress/60 秒无线程 HTTP/一业务 WS/无 SSE 的真实浏览器专项已通过。
- `clientRuntime/watchSessionJournal`：生产普通 SessionModel；初始40行分块baseline，后续逐会话连续durable cursor，新增/编辑/删除事务事实，重连续传；retention缺口显式resync-required后完整重建，不截断为最新40行。分页仍用read(session,before)。
- `clientRuntime/savePluginLayout|setPreferences|resourceCommand`：真正领域参数、原revision/CAS/权限与operationId收据；不是任意table RPC。上传HTTP必须携带已持久领域admission ID，校验size/SHA256后commit；失败receiving不盲重放。
- `executorRuntime/read|report|complete|receipt|commitArtifacts`：仅HTTP、原task短期credential、无账户principal/WS。commitArtifacts保留原mutation/permit但新增task/hash/parent/资源/收据约束，明确迁移桥；旧task records POST已删，通用records POST拒绝Worker。

## 旧路径（尚未替换/删除）

- `api/serverClient.ts`：手写 REST 与仍待审计删除的旧 Bot SSE parser；生产 useBotHistory 不再调用该 SSE。
- `plugins/shared.ts`：旧 subscribePluginRead/PluginQueryObserver 及 timer 已删除；其他 legacy unary/cache 和静态适配仍须按使用入口审计，不把文件名变化当作全域清理。
- `cloud/tasks.ts`：等待已迁移；提交、显式取消、任务命令/列表仍使用旧 HTTP，尚未统一可靠命令收据。
- todo/tasks 原模板相应定时读取已删除，仅升级 hash 一致的已安装原模板。用户修改的 HTML 不覆盖，不能声称任意用户插件都无轮询。
- `cloud/sync.ts`：records缓存已改 committed mutation 唤醒、跨标签锁与coalesced flush，不再页面1500ms/Worker250ms业务轮询；UI领域未迁完的records与限task artifact bridge仍保留，不能删除未同步行。
- `cloud/state.ts`：GET 自动网络重试；Worker 许可审批检查。
- `cloud/preferences` 已接领域query/watch及CAS journal，混合旧事务完整隔离，不自动拆分执行。

浏览器 executor 使用独立 `wangke-cloud-executor-${owner}` cache/outbox，页面仍保留原 `wangke-cloud-${owner}`，不删除旧编辑。此隔离修复了任务 token 误提交页面 studyDays 的路径，不是 records 同步迁移完成；Worker lease/permit 和限制均不放宽。

上传/下载/Range、Worker lease/permit 不是待删除的通用轮询替代品。原生客户端/脚本消费者在删除旧接口之前须单列审计。
