# 聊天会话模型重构：实施验收记录

日期：2026-11-05。当前工作区未提交；不推送、不部署。实施及父代理独立审查完成，计划六步均已勾选；独立审查结论见末节。

## 架构及删除的重复路径

- 服务端继续拥有任务执行、业务事实、100ms 进度持久化和幂等受理收据。DSH 锁定依赖、共享连接及原 wire codec 未更换。
- `packages/client-core/src/session-state.ts` 的 React-free `ConversationSessionModel` 拥有展示快照及 `SessionTimelineModel`；消息、任务、分页、排队和交互状态按 session 保存。平台调度注入，dispose 取消待发布工作。
- `apps/web/src/client/session-store.ts` 只是旧 `useCourseChat` 的兼容 facade：拥有 shell/selection/action，不再另外保存一份会话消息。删除 store 中 parked/sessionTasks/timelines 独立镜像。
- `SessionJournalModel` 合并首次 baseline、连续 journal、旧页 prepend；按消息 key/id 结构共享。Remote SessionModel 不再执行全量 snapshot→diff→patch，也不再重复 parse 已验证的完整投影；内部 materialized delta 不是新 wire 协议。
- `followServerSession` 保留解码缓存、retain/release、ready 和当前帧 replay。删除 `loadSession` 并行 HTTP 首屏读取、提交完成后的额外历史读取。
- 删除全局 activity 中的聊天进度/终态内容重放和 records 变化时刷新全部聊天。全局任务只维护后台发现/runningIds；会话 journal 是实时内容单路来源。
- 列表订阅稳定 key 与布局/分页元数据；`MessageSubscription` 单行订阅；`CourseChatInputRegion`、`CourseChatContextUsage` 独立订阅。resize 继续交给既有滚动/虚拟列表机制。
- 连续内容按帧发布，80ms timeout 防止后台 rAF 永久停顿；交互、提交确认和终态即时发布。待提交 guard 结束后 replay 当前帧，覆盖终态早于 submit 响应的竞争。
- SQLite `chat_session` 通知在 OLD/NEW 可用时提取 sessionId，覆盖消息删除/tombstone、会话元数据及任务终态。无关 records 不再驱动 session projection 或重复 loadPreferences。
- 聊天 admission 等待偏好及必要 session 学习命令，不再 await 全账户 `flushCloud`；新建 session 可只等待服务端收据。附件准备/所有权和原命令持久化仍在原通路。
- queued/短暂 confirmed 学习命令静默，15s 未完成、冲突/错误保留恢复/导出入口。刷新恢复待发草稿只读：idle baseline 不自动派发；观察到运行→终态才推进队列，未知受理只查询收据或显式重试。

## 本轮改动文件

- Core：`packages/client-core/src/{session-state.ts,session.ts,index.ts}`。
- 浏览器适配及 UI：`apps/web/src/client/{session-store.ts,session.ts,chat-diagnostics.ts,learning.ts}`，`apps/web/src/pages/CourseChat.tsx`，`apps/web/src/store/courseChat.ts`。
- 同步：`apps/web/src/cloud/{sync.ts,tasks.ts,preferences.ts,Activity.tsx,LearningRecovery.tsx}`。
- 服务端通知：`apps/api/src/realtime/{migration.ts,runtime-domains.ts}`。
- 测试：`scripts/test-session-model.mjs`、`scripts/e2e-session-model.mjs`、新增 `scripts/e2e-chat-session-performance.mjs`。旧 session fixture 增加 worker-disabled admission 必需的受控模型配置，不删断言。
- 文档：批准计划清单及本记录。其余现有修改不属于本轮新增实现，不回滚、不归功于本轮。

## 最新真实命令结果

下列命令实际执行成功（exit 0）；所有模型用 fixture，不调用真实付费提供商：

| 命令 | 结果 |
| --- | --- |
| `npx tsx --test scripts/test-session-model.mjs` | 5/5：引用/selector、调度、dispose、continuation、原型形状键 |
| `npx tsx scripts/test-session-journal.mjs` | rollback、80-event burst、真实 WS reconnect、tombstone、cursor gap rebuild |
| `npm run test:client-runtime` | projection 3/3；真实 codec/WS、乱序/重复、账户释放、100 retain/release、任务和收据全通过 |
| `npx tsx scripts/test-session-queue.mjs` | queue gate、隔离、dequeue-before-dispatch、附件 ownership |
| `npx tsx scripts/test-session-queue-boundaries.mjs` | 边界及负向 fixture |
| `npx tsx scripts/test-session-queue-durable.mjs` | durable claim、receipt、frozen retry、竞争和账户拒绝 |
| `npx tsx scripts/e2e-session-queue.mjs` | 真实 IDB 刷新、FIFO、双标签、Activity 恢复按钮及未知命令不自动重放 |
| `npx tsx scripts/e2e-session-model.mjs` | 65 条分页、进度/终态身份、60s idle、丢响应刷新、显式原命令重试 |
| `npx tsx scripts/e2e-server-chat-interactions.mjs` | 连续深度选择→服务端 low、题卡 iframe/draft/确认/取消/刷新/停止、中文渐显及历史不重播 |
| `npx tsx scripts/e2e-server-chat-ui.mjs` | 真实课程 Panel、TaskModelPicker、压缩消费 |
| `npx tsx scripts/test-server-chat-attachments.mjs` | 文本/PDF/DOCX/图片、附件独立发送、持久化、续写/重试、ownership/负向输入 |
| `npx tsx scripts/e2e-server-chat-attachments.mjs` | 真实拖放、上传阻塞、多模态输入、刷新及后续提问 |
| `npx tsx scripts/test-server-reasoning.mjs` | chat/QA/强制最终回答/continue、snapshot priority、reasoning 持久化 |
| `node --test scripts/test-thinking-depth.mjs` | 21/21 |
| `npm run test:account-lifecycle` | 4/4，A→B→A、旧异步 acquisition、StrictMode、数据库替换 |
| `npm run test:account-lifecycle:e2e` | 真实账户 root rebuild、目录重新获取/取消、数据库往返，journal/Blob/history/draft 保留且无本地 fallback |
| `npm run typecheck -w @wangke/web` | 通过 |
| `npm run typecheck -w @wangke/api` | 两套 API/runtime 配置通过 |
| `npx tsc --noEmit -p packages/client-core/tsconfig.json` | 通过 |
| `npm run build:web` | 通过，含 i18n、类型、Vite/PWA、licenses |
| `npm run build:api` | 通过，含 study-core dist 55/55、runtime、licenses |
| `npm run check:remote` / `npm run check:boundaries` | 均通过 |
| `git diff --check` | 通过 |

## 可复核性能及浏览器证据

`npx tsx scripts/e2e-chat-session-performance.mjs` 最新成功目录：

`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-session-performance-sU4oQm`

- `evidence.json` 含组件调用前后值、请求路径、无关学习记录读数及分页锚点。计数用 DEV-gated 可注入 observer，不用 DOM mutation 猜测组件渲染，也不依赖 React 内部 fiber flags。
- 12 次 140ms 间隔受控流式检查点：尾消息调用 +24，8 条历史及当前 user 行均 +0，CourseChat +0，输入区 +0。开发 StrictMode 的双调用计入原始数字；上下文用量区域 +24 是刻意的独立订阅。
- 提交一次无关 studyTime：sessionProjection 读取 +0，恢复条出现帧 +0，聊天视口前后均 `{top:7,height:886}`。
- 真实 wheel 上读后追加长段落，scrollTop 不变；390×844 输入原稿保持，终态后可继续输入；刷新读取完整持久化回答，历史没有 `.t-stream-w`。
- 真实 React A→B→A：B 前插从 40 到 65 条，`stored-2057` 锚点 top 从 145 到 145；返回 A 不包含 B 的行。
- 截图：`stream-desktop.png`（1280×900）、`stream-mobile.png`（390×844）、`pagination-desktop.png`；实施者已查看桌面/窄屏截图。

其他最新证据（共同前缀为上述 `.../T/opencode/`）：

- `session-queue-3LX9ur`：队列/双标签/恢复。
- `session-model-YHD1RK`：60s idle、分页和收据恢复。
- `session-journal-l0VEZX`：持久 journal/WS/gap。
- `client-runtime-Z3jcG5`：remote/runtime 回归。
- `chat-interactions-qAH1f6`：题卡确认和已回答窄屏截图。
- `server-chat-ui-Q6Tbpx`：课程 UI/压缩。
- `chat-attachments-e2e-5bfjSc`：附件浏览器截图和证据。
- `account-lifecycle-ZEVTvn`：账户切换及数据库生命周期浏览器回归。

## 失败、修复和基线保护

- 旧 worker-disabled session fixture 没有模型配置，当前 admission 正确拒绝；补受控不可调用模型配置后通过，不放宽 admission。
- 快速思考 slider 曾从低被旧 projection 回滚为极高：偏好读取改为一致事务，异步 journal 之前增加 localIntent overlay；最新交互已重复通过。
- 首轮渲染计数用 React fiber flags，无法区分 bailed-out fiber；弃用该方法，改为真实组件函数 observer，最终数据如上。
- 性能脚本曾在 `mouse.wheel` 返回后立刻读取旧 scrollTop（315），随后原生滚动到 0 误报。改为等待真实滚动落地再测，保留上读追加不跳转断言。
- 队列 browser 测试曾在刷新后丢掉 queued[0]：新的 ready 等待暴露旧 finally drain。恢复和初始 idle 只读，运行→终态才 drain 后，完整原脚本通过。
- `shareSessionValue` 增加自有键检测及 defineProperty，防止 `__proto__` 改变原型，也避免同数量但不同 undefined 键误复用旧对象；有专项测试。
- 首次验收时与基线 manifest 比较：`apps/api/runtime/node.ts`、PreferenceRecovery、ChatAddMenu、ModelPicker、TaskModelPicker、motion.tsx、subtitle-danmaku.css、package.json、既有 reasoning/UI/interaction 脚本及原 server-only 计划均逐字节保持。只有 preferences、tasks、courseChat 三个基线文件因本轮职责扩展发生增量修改。随后复审追加了 UI 脚本的真实记录回归（见下节），不再宣称该脚本与初始基线逐字节一致。
- 仍保留完整长回答/思考、首 answer phase、reasoningOffset、中文渐显、taskId 题卡绑定、连续偏好命令及 CAS、附件原始字节和未知副作用只读恢复。未清库、未恢复浏览器模型执行。

## 限制及父代理审查重点

- 浏览器为真实 Chromium + 隔离 API/SQLite/IndexedDB/React，模型 HTTP 受控；不是实机 Safari/iOS 或线上付费模型验收。组件计数来自开发模式，生产只执行构建，不宣称生产 profiler 数值。
- 增量保留身份并避免无关 React 渲染，但 reconcile/key selector 仍扫描已加载消息；不宣称合并算法为严格 O(1)，没有万条消息吞吐 benchmark。
- scoped 学习命令仍沿用账户级 navigator.locks 以防跨 realm 竞争；可能等待已持锁的写入，不再主动等待整账户 cache 下载。没有人工注入长时间占锁的 admission 延迟测试。
- 父代理应重点复核：分页 fence 生命周期、释放背景会话及终态先于提交的所有分支。旧页窗口竞态及 render-slot opaque layout 闭包在复审后修正并增加回归（见下节），不代表所有排列穷尽。
- Web 构建有 CSS `:is()`、Rollup PURE 注释及静态/动态混合导入警告，exit 0；测试 teardown 偶见 Vite WS ECONNRESET，不是浏览器 pageerror。未在本任务扩展修复这些无关项。
- 工作期间另有 study-core 提示词/作品工具相关改动出现在 git status；未覆盖或回滚，也不将其算作本轮会话模型实现。

## 父代理复审后的修正（2026-11-05）

本节更新并限定首次验收的结论。父代理复现的迟到旧页复活删除是真实缺陷，原“live facts win”只保护存在行，不能保护未加载行的删除；已修正，不通过全量重读或暂停流规避。

### 分页 fence、删除及模型生命周期

- `SessionJournalModel.beginPage()` 在 HTTP 发出前创建绑定该模型/当前观察的请求 token。只允许最新 token 合并一次；等待期间的 journal tombstone 记录在该 token 中，过滤迟到页，但存在的最新 live 行仍优先。删除后重新插入的行不会被错误丢掉。
- baseline、resync-required、协议 gap、重连/断线、refresh、release 和 dispose 都使 pending token 失效；成功的完整 baseline 或恢复 events 才重新开放分页。HTTP 失败/返回后清理 token，不把 tombstone 留成无界的会话级历史。
- `runtime.sessionPage` 在 await 前绑定原 SessionModel 和 fence，返回后不重新 lookup/create 模型；SessionModel 的取消信号还保护 journal apply/commit，旧 generator 不能在观察释放后提交游标。
- 同 baseline 中已知耗尽的 hasOlder=false 不被迟到 true 回退；新 baseline 可以重新设定其值。旧响应不能跨新 baseline 修改行或元数据。校验 page 的 session.id（若提供）、每行 sessionId 和重复行 ID。
- `courseChat.loadOlder` 只清理 loadingOlder，不再将原 HTTP page.hasOlder 写回展示模型。合并和分页 metadata 只能由成功接受的 journal projection 发布。
- 服务端 gap baseline 仍是完整会话，不裁成首屏：真实 HTTP/WS 测试保留并断言修复中早于首屏的行，浏览器测试中完整 baseline 为 104 行。

### UI metadata、闭包及 QA 精确通知

- CourseChat 根改订阅 key/role/user 导航文本的浅相等布局投影，以及独立的 latestInterruptedKey；不订阅 assistant 正文每个 chunk。idle 同 key interrupted true/false 和 user 文本修改都能更新对应提示/导航。
- 删除 MessageSubscription 的自定义比较器和 opaque rowLayout token；将 renderMessage 创建于每次 root render，作为稳定于该次 root 的 children 传给虚拟槽。默认 memo 比较全部 props，虚拟器内部重测不制造新的 root 渲染闭包，真正 root 变化也不再隐瞒动作闭包变化。
- ChatPanel 不再借全局 activity.dataRevision 监听 records：以 Dexie liveQuery 查询 `chatSessions.where('videoId').equals(videoId)` 和 `chats.where('sessionId').equals(activeId)`，均为索引范围，不扫描全账户表。toArray 观察既有行非索引字段更新和 delete；结果签名去除可能的 false-positive 通知。任务订阅仅检查当前 QA task signature，保留原进度呈现，不恢复 CourseChat 全局内容重放。
- QA 异步 refresh 增加请求序号，较旧 history 响应不能覆盖较新刷新。
- 精确 cache 通知可能先于本地 create/fork 返回；这些本地列表追加现按 session ID 去重，防止重复 Select key 导致面板异常。保留原 create/fork 操作及消息删除断言。

### 新增实测结果

- `npx tsx --test scripts/test-session-pagination-races.mjs scripts/test-session-model.mjs`：11/11。可控 promise 覆盖 unseen delete/live edit/reinsert、gap 完整 baseline、reconnect/reset、旧观察 token、跨模型 token、乱序响应、hasOlder、重复响应、失败请求清理不取消新请求和跨 session 拒绝。
- `npx tsx scripts/test-session-journal.mjs`：真实 SQLite 先完成 HTTP read，再人为扣住响应，让真实 WS 前进；验证未加载行删除不复活、完整 gap baseline 不被旧页回退、release/reacquire 和 dispose 不接收旧页。最新证据：`.../T/opencode/session-journal-VZgozz/result.json`（前缀同上）。
- `npm run test:client-runtime`：通过，证据 `.../T/opencode/client-runtime-3oUiKd`。
- Web 和 client-core typecheck、`git diff --check` 均通过；按父代理要求不无意义重跑全部已绿构建/附件门禁。
- `npx tsx scripts/e2e-chat-session-performance.mjs`：通过。最新证据 `.../T/opencode/chat-session-performance-sCslpp/evidence.json` 和同目录桌面/窄屏截图。idle 同 key 继续回答提示出现/消失、用户导航文本更新；12 个流式检查点仍为尾行 +24，历史/根/输入 +0。生产 loadOlder 延迟 HTTP page.hasOlder=true，gap 期间删除后完整基线为 104 行/hasOlder=false；释放旧响应后仍为 `{count:104,hasOlder:false,loadingOlder:false,deletedRowReappeared:false}`。普通分页锚点仍 145→145px。
- `npx tsx scripts/e2e-server-chat-ui.mjs`：完整通过，证据 `.../T/opencode/server-chat-ui-KZ7oGa/evidence.json`。无任务时真实远端 QA 行内容修改、删除及新建同资料空会话均更新面板；已验证计数器能观察真实 history read 后，无关 studyDays/其他资料消息变更产生 0 次当前 QA history read。原模型选择、发送、分叉、删除及压缩断言仍通过。

本轮修正文件限定于 `packages/client-core/src/{index.ts,session.ts}`、`apps/web/src/store/courseChat.ts` 的 loadOlder、`apps/web/src/pages/CourseChat.tsx`、`apps/web/src/components/ChatPanel.tsx`、`scripts/{test-session-pagination-races.mjs,test-session-journal.mjs,e2e-chat-session-performance.mjs,e2e-server-chat-ui.mjs}` 及本报告。未修改偏好同步、Activity、题卡 skill 文件；计划第六步仍未勾选。

## 父代理最终独立审查

- 已对照接手前 baseline manifest 检查原有修复，审查会话所有权、按帧发布及即时终态、提交等待结束后的当前帧 replay、分页 token 失效、UI 订阅闭包和 QA 精确记录通知。发现的分页删除复活、idle 布局陈旧及 QA 跨设备通知遗漏均已修正并有对应回归。
- 已读取最新性能/QA JSON 证据及桌面、窄屏截图，复核断言使用真实 API、SQLite、DSH、IndexedDB 和 React。性能结论仍限定为受控模型、开发模式计数，不扩展成线上卡顿根因或生产耗时结论。
- 父代理独立重放最初的分页缺陷：cursor 10 时请求旧页，cursor 11 删除未加载行 12，随后旧页携带 `[12,40]` 返回；最终消息为 `[40,41]`，已删除行未复活。
- 最终整合实际执行通过：`npm run build:web`、`npm run build:api`、`npm run check:remote`、`git diff --check`。两项构建均包含边界门禁，Web/API 类型检查和产物打包成功；构建警告范围如上。
- 并行的 skill 练习及 widget 首次归属等待已单独审查，见[可视化练习验收](quiz-repractice-2026-11-05.md)。新增技能参考读取路径修复通过原生技能回归，架构说明已更新。该报告列明的既有题卡 SSR 六项失败不计为本次通过项。
- 计划第六步完成。代码留在当前工作区，未提交、推送或部署。
