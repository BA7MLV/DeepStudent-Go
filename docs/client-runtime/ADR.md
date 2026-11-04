# ADR: DSH 客户端底座（本地六阶段已验）

日期：2026-11-03；2026-11-04最终本地冻结完成，获批计划6/6。证据、真实产物SHA256与外部未验见[final-acceptance.md](./final-acceptance.md)。未提交或部署。

## 版本与边界

上游仓库：https://github.com/deepseek-ai/deepseek-harness

参考源码锁定：tag `dsh-v0.2.2-alpha.2`，SHA `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`。原先使用的 `ce7073d51254c26cd63b22a60835b8f948deb447` 不是本次发布tag，已纠正。
使用公开包 DSH `0.2.2-alpha.2`、Cordis `4.0.6-alpha.1`，精确版本和 tarball integrity 见根 `package-lock.json`。
独立审计已核对原16包manifest/integrity/LICENSE、Cordis 9/9源码；从正确tag重建63个发布JS，62个逐字节一致，renderer一个文件仅3处region路径注释不同。后续最小依赖修复已完成：移除未用client-store，scoped overrides与remote-artifacts固定Zod 4.6.7，最终闭包15包/62个JS、缺失依赖0/安全条目0。完整许可合集/专用打包及renderer压缩license保留测试通过。细节与许可制品由独立审计会话维护，见 `upstream-provenance.md`；最终应用build与镜像验证不能由其局部通过替代。

- Cordis 管服务与作用域；不新增 DI 容器。
- Typert 正式 generator 生成 Host descriptors、Client contributions 和运行时 codec。
- Fastify/account adapter 接入上游 Gateway dispatch 与 mux；不使用 DSH launch-token。
- HTTP unary，`/api/remote.mux` 单物理 WebSocket 多路流。
- `packages/client-core` 无 React/DOM/IndexedDB；平台 transport 由装配注入。
- 生产 PluginHost/PluginSlot/PluginActions、page/message/nav已接入独立 Cordis Slots renderer；四学习视图消费 renderer 注入的 projection hook 与 command。真实 account/project/instance/placement/occurrence scopes及StrictMode/Suspense/依赖撤销恢复/100次释放已通过，见plugin-lifecycle.md。typed layout/CAS接缝和全仓AST门禁完成，P3按自身门槛关闭。

## 普通会话与 records 迁移（2026-11-03 后续）

- `SessionModel` 生产改用正式 `watchSessionJournal`：初始40行分页，后续持久连续cursor的row事实；重连续传，保留缺口显式resync-required后完整重建而非40行覆盖。旧页仍用keyset unary。`SessionTimelineModel`负责历史身份合并/pending/continue-in-place，队列与执行adapter由B独立交付，不提前称courseChat完全拆分。
- `BotFollowModel` 接管失效合并、状态/事件/活动水位、退避和锚点重建。React adapter 只注入浏览器可用性、传输及展示回调；旧服务器兼容的状态查询保留，未把它冒充新 typed WS。
- 交互账户 records 使用正式生成的 `recordsPage/commitRecords/watchRecords`；全库 1500ms timer 删除。Worker 的 250ms records timer 同时删除，写后通知和显式 flush 驱动同步；lease/report 与媒体计算定时职责不受影响。
- 服务器 records SQLite 变更、operation 去重与 `client_commands` 收据在同一个外层事务。浏览器仅在响应确认后移除对应 transaction 的 outbox；推送帧与 outbox 在同一 Web Lock 内排序，存在未确认写入时不推进 cursor，旧 key revision 不能覆盖更晚的命令确认。冲突挂起流并保留 cursor，显式恢复/联网后再打开，不丢页、不恢复周期 poll。
- 任务 admission 与审计同事务，按账户 nonce 拒绝不同 payload；HTTP 兼容与 Typert 共用 `submitOwnerTask`。浏览器 `_cloudMeta` 保存 pending/accepted/uncertain 命令及原内容，并提供 typed `taskAdmission` 查询；这不等于所有普通聊天 pending UI 已支持重启恢复，也不等于外部模型/IM exactly-once。
- Worker旧 `/tasks/:id/records`已删，通用records写拒绝Worker；限任务 `executorRuntime.commitArtifacts`按原task/hash/lease/parent/permit与当前资源授权，同SQL事务业务写/去重/收据，原ID摘要绑定token hash。仍是明确的学习产物迁移桥，退出条件见domain-recovery.md，不把改名当作全部producer领域化。
- executor outbox 新写入保存 `executorTaskId`。启动及领取新任务时，legacy无task/不同task的完整原事务（含Blob、operation/permission id）原子移入同一executor数据库 `_cloudMeta/executor-recovery:<transaction>`，标记 `requires-reconciliation`，不以新token重放；UI数据库完全不参与转换。只有原task的新队列可走task限定写接口。该journal保留恢复证据，不代表已有自动换permit或人工合并界面。
- pending任务命令现在由CloudActivity显示原草稿摘要及显式“核对收据并使用原命令重试”。启动只查询admission；已接受者接回原task，missing者仍提示uncertain，不自动创建新nonce。提交响应丢失→reload浏览器专项已通过；session adapter失效身份下pending/finally微任务循环已修复，另有event-loop/CPU门禁。
- PluginPage、PluginMessage 和导航装配采用正式typed Slots与renderer injection，沿用同一真实scope retain树，不新增生命周期容器。layout写使用typed Host+operationId/CAS/receipt，旧layout REST删除；renderer只在平台command seam兼容旧409冲突约定。
- 文件意图：新增持久system_file_intents，原稿/expected/observed及最终状态均保留，冲突不清除原稿；旧pending不丢字节转换。显式CAS恢复/归档使用原意图身份去重，保存successor收据。typed FileIntentsModel/watchFileIntents与Activity核对/导出/恢复UI已接生产，同mux而非新轮询；真实浏览器已通过冲突、恢复响应丢失、原收据→唯一successor查询和reload。SQLite与fsync仍是不同提交介质，不声称文件与数据库原子提交。
- 普通插件命令区分已审计同步SQL/文件意图handler与任意异步副作用。state/schedules.write、cards.update/generate及practice.submit显式登记atomic=sqlite：业务SQL、关联operationId的文件意图及命令结果同事务，落盘在提交后条件恢复；收据只有关联意图最终applied才返回completed，冲突/归档不伪装成功。原handler不会因文件恢复或回执丢失再执行。其他handler启动后失败保留uncertain并禁止盲重放，不能把未知外部副作用包装进SQLite事务；尚未审计标记的同步handler仍需逐个收敛。

## 生成与来源

### Interaction crash 与执行 fence（2026-11-04）

选择任务限定、证据驱动的 reconciliation，而不是宣称任意 callback exactly-once。独立 begin/executing 把“尚未派发”与“可能执行”分开；只有目标产品收据（confirmPlan 另需精确资源效果收据）完成才结算。未 dispatch 且 snapshot CAS 未变者可显式同 identity 续接；未知效果停止旧 lease，保全快照、效果与操作日志供核对/导出/归档，用户核对后另行继续。旧 realm 不得自动重发原 send。具体三动作策略与真实页面中断矩阵见 [domain-recovery.md](./domain-recovery.md)。QA/artifactEdit 另有 task execution fence，刷新不重跑模型；取消/撤权/parent/lease/permit 仍逐入口验证。

`packages/contracts/src/client-runtime.ts` 是业务 wire types；`packages/remote-host` 是 Remote 声明；`packages/remote-artifacts/generated` 是输出，禁止手改。
`npm run generate:remote` 生成，`npm run check:remote` 检查漂移。生成器嵌套 TS6 编译 API 与主项目 TS7 分离。
`packages/dsh-typert-protocol-source` 保留指定 SHA 的 MIT 源码，仅用于生成器符号分析，不是运行时 workspace，来源见其 PROVENANCE。

## 授权与生命周期

Peer principal 仅有账户身份；身份来自现有 session/token 校验，不能由 RPC 参数指定 owner。
所有插件资源调用仍经 PluginService。流建立和每次发帧重新检查身份；Host 每秒校验会话 lease，失效则释放 Peer。Worker capability 不能被替换成普通账户 RPC。
取消 stream 只释放观察者，绝不取消持久任务。

## 已知未完成项

- 快照流首帧snapshot+后续baseRevision/revision delta；Bot journal与普通history journal已接生产共享WS/64帧或行batch/逐帧授权/缺口修复，详见domain-recovery.md。初始分页与完整缺口重建不是同一语义。
- 持久命令收据可复用；崩溃遗留未知handler的pending返回uncertain，不盲重放。已登记同步handler采用SQL+文件意图最终收据；其他副作用尚未统一事务/意图恢复，不能称全应用exactly-once。
- `client_changes` SQLite triggers 与业务提交同事务，含 Bot messages/run_steps/message_events 和已有 schema34 数据库补装。invalidation 保留最近 100000 条，revision 缺口重建全部活跃基线；Bot 持久历史未删。文件跨介质意图恢复仍需沿 SystemFiles 验证。
- npm browser entries 使用 DSH module-loader wrapper；`apps/web/dsh-esm.ts` 将 Connection/Gateway 定向到同包无 Node imports 的标准 ESM，将 renderer 既有 factory 静态链接到应用 React/Slots/Cordis。没有 eval、全局 loader 或核心协议改写；依赖列表变化将拒绝装配。生产 Slots 的 StrictMode/100 次生命周期归零专项已通过。
- 生产useBotHistory已不调用SSE；旧parser/服务端/native待A清消费者后删除。目录/学习/task wait/records相应轮询已移除，resources/preferences已具真实领域commands/query/watch/恢复；剩余学习派生产物及旧无文件映射入口仍需审计，不宣称全域完成。
- BotHistoryModel 已拥有生产历史投影、稳定消息/nonce 合并、卡片终态合并、分页窗口/延迟尾部与缓存预算；BotFollowModel已接管订阅调度/恢复/水位，useBotHistory仅保留浏览器与UI适配。旧协议分支和native消费者尚需清理。
- UI/executor独立IDB/outbox，旧库名保留；无task/不同task旧队列完整保留Blob/operation/permit进review。executor completion outcome先持久化、丢响应不改第二失败outcome；跨reload+凭据过期的Activity核对/完整字节导出/归档已实测且不重跑。归档inspection用WeakMap绑定当前runtime/database，不接受导入JSON。尚存artifact producer迁移桥，而非缺少完成恢复入口。
- 依赖漏洞与许可闭包以独立审计最新报告为准，不沿用早期27项原始总数作为最终结论；不执行force fix。

升级时一起核对固定 SHA、闭包许可证、包 integrity、生成漂移、真实 HTTP/WS、Slots 生命周期和浏览器回归，禁止只更新单包 latest。
