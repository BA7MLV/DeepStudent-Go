# 云端唯一真相源

当前产品规范统一入口：[当前架构](../architecture.md)。本文的数据不变量仍有效；下述 P0–P5 实施与验收记录保留原时点，不替代后续服务端收敛验收。历史保全已改为显式按需打开，旧 journal 不再导入活动命令表，收据核对/时长转换须单独点击，详见 [历史恢复边界](history-recovery.md)。

## 当前结论（2026-11-05）

P0–P4 实施完成，P5 保留未勾（5/6）。追加收尾已完成可执行部分：真实 BotRunner 准入 fixture 修复后整个 system-files 聚合通过；WebKit Blob 的测试启动问题已定位并解决，Chromium/WebKit 桌面和390px综合故障验收均通过，保留全部 Blob/8MiB+17 字节断言；补齐真实消息/会话删除、分叉、技能和卡片 UI 点击验收，并修复不可见的技能开关。剩余未验为明确的 Xcode/XCTest、模拟器/签名安装和真机环境，不能用 build/harness 代替；WebKit 私密上下文的上游 Blob 限制仍存在，不泛化成所有 Safari 失败。不能使用旧客户端迁移计划的 6/6 或历史冻结矩阵代替本次验收。未提交、推送、部署、清站点数据，也未调用真实付费模型或 IM。

## 实施基线（2026-11-04，本轮）

工作区 main，开始时无改动。`npm run check:remote`、`npm run check:boundaries` 通过。
`npm run test:cloud:transactions` 基线失败：脚本仍导入已退役的 `quarantineExecutorOutbox`，尚未运行到断言。后续必须以新的保全行为替代，不能将旧脚本算作本轮通过。

## 权威与实际入口审计（启动时；下节记录迁移结果）

- 任务准入、执行、聊天生成、任务交互：服务端 task/admission/receipt；Web `chat-server-execution`、`cloud/tasks` 只观察。静态执行路径在 `remoteTasks()` 分支之外；不能因断网转入该路径。
- 消息/会话：服务端 SQLite `cloud_records`，`conversationProducts`、`courseChat` 的属性/删除/分叉、`ChatPanel` 的交互与会话操作尚有可达本地写，需领域命令分流。生成过程中的消息内存视图不是 committed cache。
- 技能：服务器技能文件为正文/支持文件权威，SQL 为索引；`SkillsCard`、`skills/store::importSkillFile` 的包操作必须保持整笔领域事务。`ensureBuiltinSkills` 云端分支已经只拉取服务器。
- 批注：SQLite；`MaterialInk` 的增加/删除/撤销整批提交。
- 卡片：SQLite；`CardsPanel` 审核/撤销使用 expected status，生成由服务器执行。
- 讲义：服务器文件字节；SQLite 管索引/结构/阅读位置。`handoutEdit` 云端由服务器任务执行；`useReadingPos` 仍本地写。
- 学习时长：SQLite，`studyTime` 提交稳定 operation ID 的增量，非整天对象覆盖。
- 资源/目录/播放位置：`client/resources` 已是领域命令；上传 Blob 和原始 intent 已持久化，跨文件/SQL 效果未知时不自动重播。
- 偏好：`cloud/preferences` 已有 DurableCommands，但仍把 pending 值写入 confirmed preferences、按 dirty key 阻止投影，需要分离。
- `artifactEdit`、`widgetState`、`contextCompression`、`legacyHtmlWorks` 的消息/会话交互修改需经过公共领域适配器；局部静态流程不能因此获取云缓存写权限。
- 资源删除 `Library`、本地迁移 `store/migration` 的直接写处于显式 local 分支；云端导入走 create-only importLibrary，不能整库回灌。
- Apple 原生消费者使用 typed Remote 的 Bot/session/task API，没有生产调用 `commitRecords`；Bot 在服务器业务端执行，不是浏览器 IDB 写者。

## 必须保持的边界

confirmed cache 可丢弃重建，仅投影 reducer 可写。命令/草稿/待上传字节和只读历史档案不可在重建时删除。
一个用户意图固定账户、operationId 和原始参数；发送之前先落盘。SQL 安全重试保留 ID；文件未知效果查证据，不自动换 ID。
records revision 是全局分配、按账户过滤，允许间隔；页和 cursor 原子提交后 ack。冲突只阻塞依赖相同实体的命令，不能阻塞整个账户投影。
旧库非空不是失败证据。历史库只读，查看/导出不得要求服务器在线；“已处理”只控制提醒，不代表业务已提交。

## 本轮变更与测试证据

### P1：持久命令和冲突隔离

- `client/learning.ts` 在 `_learningCommands` 保存显式 `ClientLearningEdit`，先落盘再查原收据、发送；保存 operationId、原始 request、实体依赖、Blob、wire request、状态和 receipt。网络失败不会把云会话变成本地模式。
- `command-digest.ts` 对完整输入（含 Blob 字节）计算摘要；同 operationId 内容不同被拒绝。传输 mutationId/baseRevision、学习时长 updatedAt 不属于新意图，重复入队保留第一次 request。服务端仍检查 owner+operationId+wire digest。
- `realtime/domain.ts` 复用 `atomicCommand`：业务 SQL、最终收据及持久变更在同事务中。学习时长按原 mutation ID 增量去重；阅读位置采用服务器接收顺序，不用客户端时间覆盖整个讲义。文件/模型/IM 沿用既有 intent/receipt，不承诺跨介质 exactly-once。
- `DurableCommands` 增加 `entities`、`acknowledge`、`isolateFailures`。冲突或 uncertain 阻塞相关实体的后继，不阻塞无关命令和 records。每次重发先查 receipt；pending/uncertain 收据不是 missing，不能因此重发未知效果。多标签 Web Locks 仅协调，服务端幂等/CAS 才是正确性边界。
- 学习命令 confirmed 后仍留 journal，直到 receipt 的所有版本已经进入 projection，才原子写 completed metadata 并退休 journal；回声与 HTTP 响应顺序不影响收敛。

### P2：producer 与只读投影

- `installCloudCache` 不再捕获任意表 before/after 写 outbox，改为拒绝业务表写入（`cloud_projection_read_only`）。只有 `sync.ts`、`preferences.ts` 的权威 reducer 可用 `markCloudApply`；本地/静态 DB 不安装该边界。
- 聊天消息/会话创建、重命名、修改、删除、分叉经 `client/{learning,conversations}.ts`。迁移了 `conversationProducts`、`courseChat`（包括 newSessionRow）、`ChatPanel`、`artifactEdit`、`contextCompression`、`TaskModelPicker`、`widgetState`、`legacyHtmlWorks` 的可达云端入口。分叉的新会话与消息、删除和技能整包保留同一领域事务。
- `SkillsCard`、`skills/store` 提交技能定义和引用；`CardsPanel` 提交 expected status 的复习/撤销；`useReadingPos` 提交阅读位置；`studyTime` 增量使用稳定 ID；讲义编辑仍走服务器任务，资源入口复用既有 resource commands。
- `MaterialInk` 从 confirmed+journal+尚未落盘的输入构建 overlay。每笔批注落 journal 后即可接受下一笔，不等待网络；刷新可恢复，UI 区分待提交/冲突/确认，不能把离线稿称为已保存到服务器。
- widget/旧 HTML 更新使用检查时的原快照 CAS，不再重读后更换基线；WidgetSession 绑定 DB generation，打开后的异步回调也受围栏约束。
- 偏好 pending 保存在 `_cloudMeta` journal，设置内存是 overlay；confirmed preferences 只接受服务端投影/已确认的 system-file 保存。system files 的读/list/save、remember 及 preference reducer 均检查原数据库/账户。
- 删除生产 `commitRecords` facade、隐式 `clientLearningEdits` 转换桥及 Remote 挂载，通过 generator 更新生成物；服务端明确历史收据查询仍保留，旧 HTTP records 写入不恢复。Apple 最新消费者/Bot 无该生产调用。
- 静态门禁拒绝非 reducer 获得投影写能力、退役桥及 browser executor；保留负例。为并发新增的 study-core 原生 Node dist 测试仅允许精确工具路径及其 manifest export probe，不豁免 shared runtime；忽略 Vite 临时 config bundle，避免扫描期间消失的生成文件造成 ENOENT。

### P3：订阅、代际与重建

- 新 confirmed DB：`wangke-cloud-projection-v2-${owner}`；旧 `wangke-cloud-${owner}` 留作只读源，不导入乐观业务行/cursor。旧标签只能写旧库，不能污染新基线。
- 删除“存在 outbox 就拒绝整页 records”的全局闸门。按键 revision 拒绝旧值，tombstone 删除数据；页和 cursor 同事务落盘后订阅才 ack。全局 revision 按账户过滤允许间隔。
- records 增加 `epoch/highWater/reset`；未来 cursor 或服务端进程 epoch 改变触发重建。从 0 分页写 `_projectionStage`，检查 epoch，再原子替换业务表、revision 和 cursor，journal/草稿/Blob/历史档案保留。依赖服务端 tombstone 保留，不把某个最新页当全库。
- epoch 当前为进程随机 UUID：正常重启也会安全重建，代价可能较高；本轮没有宣称实现长期稳定的备份代际或历史 compaction 协议。
- Blob 解码/哈希/网络在短 IDB 事务外；提交前检查数据库与 Runtime。`startCloud` 在 open 前捕获原 DB，并使用 cloudGeneration；A→B→A、旧订阅/旧解码/哈希晚回调不能写回新代际。
- `flushCloud` 合并 flight 时记录再次唤醒，避免最后一个 queued edit 滞留。使用存储通知、online、共享 WS 恢复，不增加空闲全表轮询。诊断提供 queued/uncertain/conflict、最老 pending 年龄、cursor/highWater 距离与重建原因（距离不是账户缺失行数）。
- `database-lifecycle.ts`/`DatabaseNotice.tsx` 处理 blocked/versionchange：提示关闭其他页面，旧连接显式关闭且禁止隐式 reopen；不自动刷新或删除草稿。

### P4：历史保全与用户恢复

- `legacy-migration.ts` 以只读事务读取旧主库；按原 transaction 完整复制到 `_historyTransactions`，摘要/处理状态放 `_historyRecovery`，保留原 ID、before/after、许可、executorTaskId 与附件完整字节。先保存再标记，可重入；不以新 ID 重放未知事务。
- 同 transaction/同键但字节变化，完整 digest 产生新的证据版本，标记 `changedEvidence`。原身份 completed receipt 不能确认这些新字节，也不能使新证据自动消失。
- 唯一自动转换为新 learning journal 的旧主库 outbox：原收据 missing、纯 studyDays SQL 增量、无许可/执行器身份、字段/数值严格合法，整事务保留原 operationId 和 mutationId。混合事务、负基线、数值字符串、未知字段及文件效果整笔保留待核对；不拆开挑选安全行。
- 旧 task/resource/preference journal 保留；旧偏好草稿先进入 review/conflict，不把旧乐观值提升为 confirmed。旧快照始终可在设置发现，不产生全局失败告警。
- 恢复入口移至“设置 → 数据 → 历史数据恢复”。Activity 仅展示具体未决证据；本地详情、完整导出与远端收据查询分开，服务端离线仍可保全原稿。独立 handled metadata 只控制提醒，不代表业务完成，不写原 legacy 库。
- executor 列表按键/数量，不读取所有附件正文；小命令 metadata fingerprint 能使同键新 metadata 再次出现。snapshot 的 keys-based fingerprint 不是附件完整性证明，但 snapshot 不产生 pending 提醒且设置始终可见。
- 无法完整验证的 grouped executor outbox、含 Blob metadata 禁止 blanket“标记已处理”。其身份收据（无论原 metadata 自带 completed，还是之后查得 completed）也不能关闭提醒；保持待核对，不声称能在惰性列表检测同键同大小字节替换。完整原稿可按需导出。
- `LearningRecovery` 不再向用户渲染任何界面：queued/uncertain 命令由后台同步循环重试，conflict 在后台自动原子归档原 journal 后移除当前冲突（与原“保留原稿并结束此修改”同一事务语义），依赖后继重新查证/CAS，不静默丢弃；原稿保留在历史数据恢复中，综合 E2E 已验。新增恢复/数据库/同步/批注状态提供中英资源，综合 E2E 实际切换双语。

### 实际运行结果（仅本轮，不等于所有历史测试已重跑）

临时证据根：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`。以下短目录均相对此根。

- `npm run test:client-runtime`、`npm run test:cloud`、`npm run test:cloud:transactions` 通过；事务专项最终 9/9，包含 blocked/versionchange、原事务/字节版本保全、namespace/只读边界、本地模式、事务回滚和永久失败保全。
- `npm run test:widget-feedback`、`npm run check:remote`、`npm run test:boundaries`、`npm run check:boundaries`、`git diff --check` 通过。边界负例未删。
- `npm run test:client-runtime:truth:e2e` 和 `NARROW=1 npm run test:client-runtime:truth:e2e` 通过；最终证据 `single-source-SmWFzE`（1280px）、`single-source-ShP2zc`（390px）。两者覆盖最后一次附件收据提醒修复，包含双语恢复 UI。
- 综合测试为真实 SQLite/API/typed Remote/共享 WS/IDB，注入传输故障：同内容冲突、无关 feed 前进、相关依赖阻塞、丢响应/同 ID/刷新/多标签、WS 故障与重复页、未来 cursor/epoch 重建、tombstone、不丢 journal Blob、技能整包、卡片/阅读/批注/时长、旧主库原身份转换及非法整事务拒绝、只读边界和 A→B→A。不是用 mock completed 替代业务链路。
- `scripts/fixtures/executor-recovery.mjs` 被综合 E2E 调用：8,388,625 字节（8 MiB+17）逐字节导出对照，原库写入计数 0，列表不 materialize 全部附件、同键新 metadata 重新出现、不可验证 outbox/附件不接受静默关闭，以及晚回调/旧详情导出账户隔离。最后新增断言覆盖 completed metadata 和 identity-only receipt 都不能确认附件字节。
- `npm run test:client-runtime:sync-locks:e2e`、`npm run test:client-runtime:activity:e2e`、`npm run test:client-runtime:tasks:e2e`、`npm run test:client-runtime:e2e` 本轮通过；runtime 浏览器证据 `runtime-browser-cCobG2`。sync-lock 已去掉掩盖漏唤醒的额外手动 flush。
- `npm run test:cloud:e2e` 本轮完整通过：`cloud-e2e-7hfNSM`；包含新会话生产入口，修复了原 newSessionRow 直接写 IDB。`npm run test:server-tasks:e2e` 通过，含全部浏览器关闭后服务器继续执行及重开只观察原任务；文件未知效果沿已有 intent 状态，不由本地伪确认。
- `npm run test:widget-feedback:e2e` 初次因无 5188 Vite 服务失败；随后 programmatic Vite 提供服务后完整通过。system-files、skill-files 独立脚本及 agent-instructions 通过；`npm run test:system-files:e2e` 桌面/窄屏通过。当时 system-files 聚合未通过；追加收尾的完整聚合结果另列下节，不以独立子脚本代替。
- `node scripts/test-native-task-interactions.mjs`、`swift build`（`apps/apple/WangkeKit`）、`node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs` 本轮通过；原生交互证据 `native-task-interactions-oaTnC9`，真实 HTTP/共享 WS harness `native-remote-ZApfg0`。
- 最后生产修改后再次 `npm run build` 退出 0，5/5 任务成功（4 项缓存命中），Web/API、i18n、许可验证通过。完整日志：`/Users/ba7mlv/.local/share/opencode/shell/77059c9c5f933a7db0d5c83cb792d00e0c23b871/sh_1a75eca74002R7NA44gLANXNfq.out`。仍有 CSS 空 `:is()`、chunk 和依赖 annotation 警告；没有将警告隐藏成“无警告构建”。
- 新增异步浏览器断言使用 Node 侧 `waitForProbe`；不使用会产生假阳性的 Playwright async waitForFunction 写法。

### P5 追加可执行收尾（2026-11-05）

#### Notebook 准入 fixture（已关闭）

- `scripts/test-notebook-tools.mjs` 的两处 BotApplicationService fixture 都委托真实 `BotRunner.freezeModel`，使用原隔离 offline/test 模型配置。只暂缓 enqueue，保持直接工具/文件事务和数据库重开测试的原时序；之后仍由真实 BotRunner 执行，模型响应使用 fixture fetch，不访问真实模型。
- 新增持久 `model_snapshot.candidates` 精确断言。全部原 notebook/文件/CAS/回滚/崩溃恢复/账户隔离/ask策略/无自动日记断言保留，没有修改生产模型准入或权限。数据库重开后使用新 store/config 的准入实例，不复用已关闭连接。
- 实际执行 `TMPDIR=/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode npm run test:system-files`：退出0，system-files、skill-files、notebook-tools、agent-instructions 四个子脚本全部通过。本聚合内未再发现其他缺 freezeModel 的 fixture。

#### WebKit 有界环境排查与启动修复（已关闭测试阻塞）

- 本机 macOS 15.5（24F74）、arm64，Node v26.3.0、Playwright 1.63.0；实际默认 WebKit 为 `~/Library/Caches/ms-playwright/webkit-2359/pw_run.sh`，浏览器报告26.6，包 manifest要求revision2359。Chromium153.0.8010.12/build1243作对照。也只读使用了本机已有 `webkit-2370/pw_run.sh`，未下载/安装浏览器或大型组件。
- 探针不加载任何应用模块。系统临时目录的 `/var` 路径真实解析到 `/private/var`；系统temp、隔离temp、新profile均属uid501、权限0700，实际写/读/删除自建探针文件成功。非持久WebKit的字符串、ArrayBuffer成功，Blob事务以 `UnknownError: Error preparing Blob/File data to be stored in object store` abort；仅换隔离TMPDIR仍失败。**同一2359二进制改用全新持久profile后 Blob和File均逐字节读回成功**，2370的独立持久profile也成功。排除了目录不可写、路径别名、应用模块、普通IDB全面故障以及必须下载新版浏览器的假设。
- 精确复验：`IDB_PROBE_MATRIX=1 IDB_PROBE_EXECUTABLE=/Users/ba7mlv/Library/Caches/ms-playwright/webkit-2370/pw_run.sh DEBUG=pw:browser node scripts/probe-webkit-idb-blob.mjs`。证据 `idb-blob-probe-qh3Nrw/{environment,evidence}.json`，浏览器启动/退出完整日志 `webkit-blob-matrix.log`（均在上述临时证据根）；页面console/pageerror为空，失败由transaction.onabort明确捕获，不靠超时推测。matrix退出0要求Chromium和默认WebKit持久profile成功，私密模式失败仍作为对照保留；不带matrix的原探针继续复现该限制并退出1。
- 官方仓库 [playwright#42795](https://github.com/microsoft/playwright/issues/42795) 同版本同错误；成员明确说明为上游 File/Blob 私密模式限制（[成员回复](https://github.com/microsoft/playwright/issues/42795#issuecomment-5817567961)，关联 [WebKit156347](https://bugs.webkit.org/show_bug.cgi?id=156347)）。不是应用存储协议错误，也不能据此声称所有Safari都失效或真机已经验收。
- 综合E2E仅为WebKit的两个测试设备各建立全新隔离持久profile（证据目录下device-a/b-profile），各自IDB独立，登录只复制测试cookie；同一设备仍真实刷新/多标签恢复。未碰用户profile，未清站点数据，不改业务Blob格式或删字节断言。默认2359即通过，无需使用替代可执行文件才能验收。

#### 真实生产者点击补验与本轮修复

- 先核对旧脚本：综合测试此前调用了领域适配器，不能代替迁移后实际组件事件；旧本地聊天/设置脚本也不能代表云端只读边界。因此新增 `scripts/fixtures/truth-producer-ui.mjs`，由同一真实API/Remote/WS/IDB综合测试挂载生产 `ChatPanel`、`SkillsCard`、`CardsPanel`，全程保持projection只读。
- 实际点击消息分叉（两条消息整笔复制，原会话不变）、消息删除并确认、分叉会话删除并确认；服务端核对原会话/消息保留、分叉及消息墓碑。技能真实填写表单并通过文件input添加支持文件，保存、启停、编辑、整包删除，核对SQL记录和引用正文/数量。卡片真实点击保留→撤销→丢弃，核对服务器状态和最终confirmed projection，所有新增命令退休；故障阶段故意保留的既有冲突journal不要求清空。
- **发现并修复真实生产缺陷**：SkillsCard使用空的HeroUI v3 Switch，未包含Content/Control/Thumb，开关不可见也无法正常点击。补齐与项目一致的复合结构；无force click、DOM派发、替换事件处理器或放宽权限。
- 新fixture调试中修正了测试事实/选择器：消息role使用契约的assistant；确认按钮位于对应popconfirm内；卡片适配器按当前CAS契约显式传expected=0；技能弹层保存后等待真实关闭。原始业务/Blob/故障断言均保留，新增 `page-errors.json` 留证且最终仍严格断言无pageerror，不过滤访问控制错误。
- 第一轮持久profile综合运行曾在最终pageerror断言捕获一条访问控制错误，业务断言已通过；未将其隐瞒成通过或删除断言，后续重复完整运行无该错误。部分故障/关闭过程有Vite WS代理 `ECONNRESET` 日志，最终仍须以实际服务端事实、原ID和页面错误断言判定；这不是会话工具/模型的ConnectionRefused。

#### 追加实际结果

以下综合命令均退出0，包含完整历史附件字节验收、原故障矩阵及新增真实UI生产者；不是只跑新增片段。每个目录含 `evidence.json`、`producer-ui.json`，截图为自建测试数据。

- `npm run test:client-runtime:truth:e2e`：Chromium1280px，最终 `single-source-UElVlU`（此前 `single-source-3ANDEq` 同样通过）。
- `NARROW=1 npm run test:client-runtime:truth:e2e`：Chromium390px，`single-source-tm1EhH`。
- `BROWSER=webkit npm run test:client-runtime:truth:e2e`：WebKit1280px，`single-source-QFtndw`。
- `BROWSER=webkit NARROW=1 npm run test:client-runtime:truth:e2e`：WebKit390px，最终 `single-source-TiRebY`（此前 `single-source-9ySZpv` 同样通过）。最终桌面Chromium/窄屏WebKit另验证技能保存弹层已关闭，保存了生产者截图。
- `npm run check:remote`、`npm run check:boundaries`、`npm run test:boundaries`、`git diff --check`：通过；边界负例未豁免。
- SkillsCard生产修复后 `npm run build`：退出0，5/5任务成功，本次5项Turbo缓存命中（不是声称全量无缓存重编）；i18n、类型、API/Web及许可检查日志保留。日志：`/Users/ba7mlv/.local/share/opencode/shell/77059c9c5f933a7db0d5c83cb792d00e0c23b871/sh_1a952eb0e002h7FEhfMOUYXzr0.out`。既有空`:is()`、chunk和annotation警告仍存在。
- 已有真实cloud/任务观察器/全浏览器关闭服务器执行、widget/讲义/阅读/批注/时长、核心/事务等证据保持上节原结果，本次不机械重跑无改动的整套冻结矩阵；不将并发study-core/plugin等改动归为本会话交付。

### P5 剩余限制与继续条件

唯一剩余验收缺口是已明确记录的原生完整环境：`swift test` 历史实测报 `no such module 'XCTest'`，当前CommandLineTools不具备环境；需可用Xcode/XCTest执行测试、iOS模拟器、签名安装及真机验收。遵照用户要求，本次没有安装Xcode、改变系统开发者路径或重复无效测试；原生build/真实HTTP/共享WS harness已有通过证据，但不冒充上述验收。Safari真机/私密模式也不由Playwright持久profile的通过外推；若要求私密模式支持原生IDB Blob，需要上游引擎解除该限制，不能以改变数据保全协议绕过。

旧fixture和WebKit综合测试均不再列作待修阻塞。计划仍5/6，P5不缺验勾选，已有待办只更新而不重复新增。并发study-core、plugin/flashcards等工作区改动已保留；本报告不是对所有未提交文件的独占所有权声明。
