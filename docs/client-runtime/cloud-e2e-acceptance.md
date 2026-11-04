# Cloud E2E 独立验收

## 运行边界

- 命令：`node --import tsx scripts/test-cloud-e2e.mjs`。
- 使用独立临时 SQLite/文件目录、随机独立 Web/API 端口、真实 Chromium 两个隔离 browser context；模型 HTTP/SSE 由 API fetch 夹具提供，不调用付费模型。
- Web 使用当前源代码 Vite dev（隔离依赖缓存，关闭 HMR/watch），API 使用当前 TypeScript 源码；专用 `cloud-e2e-source-loader.mjs` 仅将 API 的 compiled Node task runtime 动态 import 重定向到当前 `apps/api/runtime/node.ts`。共享 study-core/remote-host 等使用主线已有定向构建，不执行并行完整 build、不写 dist、不重启共享服务。这不替代最终统一冻结产物的验收。
- 当前 UI 真实创建连接、发现/添加模型、填写测试模型能力、选择默认模型并保存；仅 models.dev 元数据请求返回空目录，避免外部网络依赖。模型浮层打开前完成设置容器的实际滚动，避免 RAC 的正常 scroll-dismiss 与 Playwright 隐式滚动竞争。
- 本地设置 fixture 通过当前设置 store 在未登录时建立完整当前版本快照，然后仍逐字节比较登录前后 localStorage；不以残缺的 v3 JSON 触发无关版本迁移。旧 IDB 课程 fixture 使用合法课程字段/枚举，内容、会话、附件保全断言未删除。
- 不开启旧 records 写接口；测试独立会话使用真实 typed `editLearning`，视频通过资料库正常上传创建课程与封面任务。
- 编辑后的正文从真实资源目录映射到 canonical project text API 读取，而非已不权威的 `records.files`；仍断言审批修改正文存在，撤权后正文及 revision 均完全不变。

## 原业务清单（不得删减）

- Gate 初始化、昵称账户偏好、服务器配置不泄露密钥。
- 登录保留旧本地设置；设置 UI 导入旧 Markdown、会话、消息及附件，读取持久附件字节。
- 虚拟 Passkey 注册、第二设备密码登录、退出后 Passkey 登录。
- 正常 Markdown 导入、Node material 任务及第二设备资料库可见。
- 发起设备关闭后后台 chat 完成，第二设备读取持久会话及回答。
- 写工具待审批、一次批准生效并持久化正文、重复批准拒绝。
- 课程 QA 由另一设备提交并在已打开学习助手实时出现。
- ask_user 跨设备回答后续行；等待中的任务跨设备取消。
- 写策略撤销结束待审批任务且原课程字节不被覆盖。
- 退出后不展示账户课程；移动端设置无横向溢出。
- 正常视频上传、真实浏览器解码/cover Worker、任务 browser executor、持久封面 Blob。

## 证据与失败记录

每次运行输出独立 `cloud-e2e-*` 目录，保留 `evidence.json`；失败另存各活动页面正文与截图，不覆盖历史失败。

- `cloud-e2e-X5xcRe`：初次对齐后模型选项在浮层入场/滚动时被移除；未计通过。
- `cloud-e2e-3M8VtP`：自定义 checkbox 的装饰层拦截直接 input 点击；改真实键盘 focus/Space 并断言 checked，不强制点击或注入状态。
- `cloud-e2e-diDd8j`：浮层正常 scroll-dismiss，改先完成滚动再打开。
- `cloud-e2e-mOqT4S`：残缺 v3 设置 fixture 在已加载应用中被正常初始化规范化，改上述当前 store 完整 fixture，保留原字节断言。
- `cloud-e2e-KCtCWs`、`cloud-e2e-S3NNHW`：旧资料库 input 不再默认挂载；对齐关闭设置 → 资源“更多操作”→“导入课程 / B 站视频”真实入口。
- `cloud-e2e-NOdB2H`：通过前序 UI/导入/跨设备后台聊天后，审批等待超时；真实 Node chat 返回不支持 edit。

## 历史阻断运行（保留，不代表当前结果）

命令：`node --import tsx scripts/test-cloud-e2e.mjs`，exit **1**。

最终证据目录：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cloud-e2e-wHEvom`。

- `evidence.json`：实际通过里程碑与完整失败任务/堆栈；`errors` 为空。
- `server-0.json` / `server-1.json`：真实账户可见 tasks/permissions 快照。
- `failure-1-0.txt` / `.png`：仍存活的第二设备正文/截图。发起聊天的第一设备已按原测试关闭。
- 独立 `db.sqlite` 与 files 目录保留，不清除失败现场。

已实际通过：初始化和当前模型 UI、密钥不泄露、登录前后本地设置逐字节相同、旧库/附件导入与字节读取、昵称偏好、Passkey 注册、正常 Markdown 导入与 Node material 解析、第二设备密码登录与课程可见、关闭发起标签后后台 chat 完成及第二设备持久回答可见。

### 阻断 1：原普通聊天审批编辑不产生审批

复现：完成上述前序 → typed `editLearning` 创建独立普通会话 → 正常 `POST /api/v1/cloud/tasks` 提交 `kind=chat`、`text=审批修改课程` → mock 返回 `edit(/courses/<courseId>/material, edits)`。

任务 `9d3b3117-e4f7-4ac5-8879-029f05332489` 被路由为 `executor=node`，状态最终 `completed`，但 tools.result 是“当前任务不支持该工具。”，permissions 无该任务待审批记录。脚本现在在无审批且任务已终态时立即失败，避免无意义等待；未增加超时。

定位：`apps/api/src/cloud/execution.ts:35-42` 将普通 chat 路由到 Node；`apps/api/runtime/node.ts:778` 仅传入 library/MCP tools，`:589-636` 的 libraryExecutor 没有 edit 分支；`:445` 将 edit 交给该 executor。以上文件本任务均未修改。

静态审查另发现同一 Node 分支没有 `ask_user` 处理；尚未实际执行原 ask/cancel 步骤，不将静态观察冒称运行结果。没有改成 `qa + pluginExtraction` 或 Browser 强制路由来规避普通 chat 的原断言。需主线确认/恢复所需产品能力后重跑。

### 阻断 2：已实际出现的 Browser cover Blob admission 403

前序正常 Markdown 导入派生的两个 cover 任务在 `server-0.json` 中均失败：`executorRuntime/admitBlob` HTTP 403。此时 Node material 任务成功。主线正在修改 Worker Blob admission；本任务不修改 Worker/API 或重试隐藏此错误。最终视频 cover 断言尚未执行，不能宣称已通过。

### 当时未执行的后续原断言

一次审批写入及重复批准 409、课程 QA 跨设备实时显示、ask 跨设备回答与取消、策略撤销保持原字节、退出/Passkey 再登录/移动布局、正常视频上传及 browser cover 持久 Blob。全部仍保留在脚本，等待上述业务阻断修复后完整重跑。

## 最终完整通过（主线修复后）

命令：`node --import tsx scripts/test-cloud-e2e.mjs`，exit **0**。未删业务步骤，未增加原超时。

最新证据目录：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cloud-e2e-QzcNMO`。

- `evidence.json`：`passed: true`、`errors: []`、命令、运行方式、Node 版本、实际独立端口、全部业务里程碑及真实持久 cover 记录。
- `server-0.json` / `server-1.json`：完整任务、审批快照，成功和失败均采集；最终视频 cover 任务 `609120d8-715f-42f4-8e6d-0c1135a35456` completed、executor=browser。
- 持久封面为 `image/webp`、320×180，`blob.$file=9f6c6a3f-b01c-a4f8-3e98-b65d2f296b3b`。
- 独立 Web `http://localhost:50012` / API `http://127.0.0.1:50023`，运行 2026-11-04T01:49:25Z—01:50:04Z，进程已正常关闭，目录保留。
- 前一轮 `cloud-e2e-JJodxx` 也完整通过；两轮均在主线告知 remote-host 定向 build 后新建 API。最终轮额外保存成功 tasks/permissions 快照。

原业务清单全部实际通过：Gate/模型 UI/昵称及配置脱敏；本地设置原字节与旧库附件保全；Passkey 注册、密码跨设备登录及退出后 Passkey 登录；Markdown Node 解析；关闭发起标签后台聊天及持久历史；真实审批写入、重复批准409；课程 QA 跨设备实时显示；追问跨设备回答与取消；撤权结束审批且正文/revision不变；退出隔离与390px移动布局；正常视频上传、真实browser cover与持久Blob。此处账户隔离口径是原脚本的退出后课程不可见及两个独立设备context，不冒称新增了双不同principal矩阵。

### 本次重跑中保留的额外失败

- `cloud-e2e-TwJzsQ`：源码 API 实际加载旧 compiled Node runtime，故仍有旧 edit 失败；之后用测试专用 loader 对齐源码执行，不据此误报主线修复无效。
- `cloud-e2e-koU0QX`：真实审批及 edit 已成功，但旧断言读取 `records.files` 非权威位置；改为 canonical resource/project text，保留内容及撤权不变断言。
- `cloud-e2e-FOdgPL`：审批、QA、追问/取消及撤权通过后，退出页面旧“登录网课云端”标题不存在；改为当前 Gate “DeepStudent Go”标题，不改变退出隔离断言。

主线产品修复由主线完成：Node edit/ask 交互、Worker admitBlob 白名单及 shared packages 定向构建，本任务未修改这些业务源。末次运行有 Node `module.register` deprecation/localStorage experimental 提示及退出时 Vite WS EPIPE；未过滤日志，完整断言仍通过，页面异常列表为空。

## 前轮 Patch 范围

本任务仅修改 `scripts/test-cloud-e2e.mjs`，新增专用 `scripts/cloud-e2e-source-loader.mjs` 及本文；未修改共享 `fixture-domain.mjs`、业务源、contracts/generated、package/lock、阶段状态或总文档；未 build、提交或部署。保留先前 A/B 工作及其他未提交改动。专项 `git diff --check` 及脚本/helper `node --check` 通过；不据此关闭整个P4/P5。

## 后续授权业务闭环：Node chat / QA edit

用户后续授权修复普通 Node chat/QA 的工具注册、编辑及审批；以下为该轮增量，不覆盖上面的历史失败记录及前轮范围。

### 契约和实现边界

- 依据 `apps/web/src/harness/resources.ts`、`agentInstructionsResource.ts`、`materials/systemFiles.ts` 的现有业务：普通聊天可编辑课程 Markdown 与受限系统文档；系统文档新建/修改免常规审批，但显式 deny 保留，学习聊天不可修改全局 MCP 连接。
- Node chat 和 QA 均注册 `edit`，模型调用不在实际允许工具表内的工具返回真实 error，不能以“不支持”的普通成功结果冒充执行。保留 Gateway、skills、MCP、附件及已有 ask/cancel 流程。
- 课程支持已有 `/courses/<id>/material` Markdown 的精确替换及 `replace_all`；QA 的 `current` 解析为本任务课程。不会宣称实现浏览器端所有根目录/讲义创建或 regex 能力；工具描述明确该子集。
- 课程通过既有 ResourceFiles + `executeResourceCommand(saveMarkdown)` 写入，审批前捕获原字节并在写入时 CAS。许可绑定 owner/task/arguments，一次消费；资源 operationId 由许可 ID 派生，留下唯一持久收据。审批后再次校验任务、账户、策略、课程范围；原资源服务继续拒绝归档项目写入。
- 系统文档经既有 SystemMaterials 读取/保存并遵守 revision/bytes CAS：AGENTS、具名记忆及已有技能/看板等实体文档；具名记忆可创建，记忆开关与来源验证保留。禁止全局 MCP 配置写入、任意主机路径、删除及 shell；没有放宽系统或项目策略。
- 保留既有取消与恢复语义：取消不能再批准；进程被实际 SIGKILL 后重启，native task 变 interrupted、待审批许可 expired，不自动重放或写入。

### 实际验证

下列命令均退出 **0**：

```sh
node --import tsx scripts/test-node-chat-edit-e2e.mjs
node --import tsx scripts/test-native-task-interactions.mjs
node --import tsx --input-type=module -e "import { register } from 'node:module'; register('./scripts/cloud-e2e-source-loader.mjs', import.meta.url); await import('./scripts/test-task-executors.mjs');"
node --import tsx scripts/test-cloud-e2e.mjs
npx tsc -p apps/api/tsconfig.runtime.json
npm run typecheck -w @wangke/api
```

- Node 专项最终证据：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/node-chat-edit-5Si2XP`。真实独立 HTTP API、可控模型、SQLite；`evidence.json`、`model.jsonl`、`host.log` 及数据库保留。覆盖审批前无写、拒绝无写、批准唯一收据、并发/重复批准、跨账户决定/资源隔离、跨任务许可注入拒绝、QA 当前课程范围、CAS 冲突、取消、策略撤销、系统 CAS/deny/MCP/主机路径/shell 拒绝、具名记忆隔离、项目越界、等待中归档、真实杀进程重启。
- helper 专项：`native-task-interactions-MBZQH4`，审批/CAS/取消/持久回答通过。
- 全 cloud 流程连续通过 `cloud-e2e-GdKUb5`、`cloud-e2e-JnQgmw`；最终目录为 `/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cloud-e2e-JnQgmw`。`passed: true`、`errors: []`，上面的原业务清单全部保留并通过。
- 最终 cloud 时间 2026-11-04T02:53:13.545Z—02:53:55.558Z，独立 Web `http://localhost:65349`、API `http://127.0.0.1:65423`，进程已关闭。视频 cover 任务 `82047a00-4f0d-496d-8912-bbef57e34929`，持久 `image/webp` 320×180，Blob `4014d8c6-0ee2-4736-d72b-cf58c5c789ad`。
- 保留额外失败 `node-chat-edit-lF5rYp`：记忆创建使用了服务不接受的 `task:` 来源而返回 `invalid_memory_source`。改用现有用户笔记 `user:` 来源后最终专项通过，没有改来源校验器。API typecheck 曾受并发主线 `task-products.ts` 的 undefined 错误阻断；未修改该文件，主线更新后的末次完整 typecheck 已通过。
- Node deprecation/localStorage experimental 与 Vite 关闭时 ECONNRESET 日志保留，不过滤成假绿。

### 本轮实际增量范围与汇合

- 修改 `apps/api/runtime/node.ts` 的 chat/QA 允许工具、read/edit 接线及结果真实性校验；修改已有未提交 `apps/api/runtime/task-interactions.ts` 的 edit 许可 helper，保留其 ask 实现。
- 新增 `apps/api/runtime/node-documents.ts`、`scripts/test-node-chat-edit-e2e.mjs`；更新专用 `scripts/test-native-task-interactions.mjs` fixture 以匹配真实上下文；更新本文。前轮 cloud 脚本和专用 loader 保留，本轮无需再绕过或删改业务断言。
- 未修改主线 realtime、Worker、cover admission、continue/retry IDB 或 browser-chat 轮询实现；未改 contracts/generated、依赖、阶段状态或总文档，未 build、提交或部署。
- Node 专项及原 cloud 全流程均已汇合通过，无剩余被跳过脚本；可解除 `node.ts` 本轮独占。最终冻结构建验收与 P4/P5 整体状态仍由主线负责。
