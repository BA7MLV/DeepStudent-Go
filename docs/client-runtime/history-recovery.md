# 历史恢复边界

当前规范入口：[当前架构](../architecture.md)。此页描述 2026-11-05 按需隔离改动与实际专项，不替代全产品验收。

## 按需边界

- 正常 `startCloud`、同步/Activity 不加载历史迁移，也不扫描旧库、计算历史 Blob 摘要或转换旧命令。
- 设置 → 数据 → 历史数据恢复，点击“打开历史恢复”才动态加载 `HistoryRecovery`。此时只做本地保全与读取；关闭页面释放列表订阅。
- 另提供默认无 props 的 `LocalHistoryExport`，供账户入口显式 lazy 挂载：只读列举/完整导出此浏览器 `wangke` 与 `wangke-cloud-*` 原库，无需认证，不依赖 cloud/state、业务 db、sync 或 runtime。它不启动静态业务。账户入口的实际挂载由父会话集成，本专项不替代 Gate 冷启动验收。
- 打开后先按原事务完整复制旧 outbox 到 `_historyTransactions`，保留行 ID、transaction、before/after、许可、executorTaskId 和 Blob。源库始终只读，不改 schema、不删数据。
- 旧 task/resource/preference journal 的原值与完整 Blob 按摘要版本归档；**不复制进活动 `_cloudMeta`，不唤醒旧命令重播**。同键新字节成为新证据，旧 completed 收据不能确认新版本。原库所有表仍可整库导出。
- 查看与完整导出不依赖服务器。复制失败仍展示旧库只读入口，原库未改变；失败不导致清库或降级为本地业务权威。
- “核对历史收据并恢复可验证时长命令”是独立、明确的联网操作。沿用严格整事务验证：仅 receipt=missing、无许可/执行器、合法纯 studyDays SQL 增量可用原 operationId/mutationId 入新 journal；混合、文件或未知效果不重放，不恢复通用 records 写入。设置里的单条“核对收据”只查证据，不执行转换。
- “已处理”只控制提醒。无法验证 payload 的 grouped executor outbox/附件 metadata 不能以 blanket handled 或身份收据隐藏。账户/数据库代际过期的详情不得导出。

## 本轮实际验证

- `node scripts/e2e-history-recovery-demand.mjs`：真实 Chromium + 当前源码 Vite + 隔离 IDB，无 API，验证点击前不加载历史模块/不扫描；打开真实恢复组件后离线保全、列表及原 journal Blob 导出，活动 `_cloudMeta` 与 `_learningCommands` 未获得旧命令；复用现有 8 MiB+17 逐字节 fixture，覆盖源库写入为零、列表不读取完整附件、同键 metadata 更新、不可验证附件/原始收据、A→B→A 旧详情拒绝。该入口 fixture 使用与设置相同的 React.lazy 条件挂载，不声称完成整页设置或已登录应用验收。
- 同一专项在新的无账户页面点击真实 `LocalHistoryExport`，下载原库 JSON，核对原 outbox 文件与变化后的 journal Blob；模块请求证明未加载业务账户 runtime，API 请求仍为 0。证据目录包含 `evidence.json` 与 `cold-original.json`。这是 **API 不可达、Web 静态资源仍由本机测试 Vite 提供** 的测试，不代表首次访问无任何缓存资源时能完全离线下载恢复 chunk。真实断网需要已缓存应用资源。
- 最终专项证据：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/history-demand-WVAGQH/`，无页面错误；原 executor 库恢复写入 0、API 请求 0、8,388,625 字节逐字节保全。另有同键 journal 新字节版本化/可重入与身份收据不能隐藏新证据断言。
- `node --import tsx --test --test-name-pattern='legacy transactions preserve' scripts/test-cloud-transactions.mjs`：原事务、许可、原 ID、完整 Blob、同键新字节版本及可重入保全通过。
- `npx tsc --noEmit -p apps/web/tsconfig.app.json`：初次通过；后续并发集成重跑先被本分工外 `ChatPanel.tsx:666/667` 的 `PROMPTS` 未定义阻塞，最新一次仅报告 `pages/Library.tsx:960/961` 的 `deleteMaterialFile` / `deleteVideoFile` 未定义，已交父会话处理。未跑全量 build，不将旧通过冒称最终全树通过。
- `git diff --check` 与客户端/插件目录全部 Markdown 本地链接存在性检查通过，原历史文档入口保留导航；未改写原失败/通过证据为新验收。

旧综合测试中“启动即复制旧 journal/自动转换”的断言不再是有效行为，后续集成应改成用户显式打开/核对，不能恢复热路径迁移来迁就旧 fixture。本轮未重跑完整 truth E2E、完整应用浏览器矩阵或原生环境；[既有验收](single-source-of-truth.md) 保留其原时点和限制。

## 文档导航

[客户端历史归档](archive/index.md)、[插件历史归档](../plugins/archive/index.md) 保存早期方案及当时的失败/通过证据。旧路径保留导航页，当前有效不变量、插件协议/可插拔契约及 renderer 生命周期未归档失效。没有以旧六阶段 6/6 声称本次收敛完成。
