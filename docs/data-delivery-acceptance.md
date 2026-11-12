# 按需数据交付：独立审计与验收

日期：2026-11-11。审计 agent 初始新增本文件和 `scripts/e2e-data-delivery-acceptance.mjs`；随后明确授权接管旧 `scripts/e2e-server-chat-attachments.mjs` 的引用契约更新，最后授权实现 widget/旧 HTML 冷缓存修复及 focused 浏览器门禁（详见下节）。未修改共享 package.json；未提交、部署、生产登录、清库或调用付费模型。工作区存在并发编辑，下面位置是检查时的源码位置，不将未落地方案当缺陷。

## 最新集成结算（2026-11-11，含后续授权修复）

### 后续明确授权的 widget/旧 HTML 生产修复

本节更新上述只读轮之后的状态：用户授权本审计实现 widget/旧 HTML 冷缓存 P1，并运行 focused 真实浏览器门禁；未修改 QA 的 ChatPanel/client/conversations/courseChat、共享 package.json 或原独立门禁脚本。下面原只读结论作为发现记录保留，其中 widget/旧 HTML 的当前状态以本节为准。

- `store/widgetState.ts` 入场先 `readConversationMessage` 精确 hydration，再执行原 role/sessionId/videoId/widget id/html/libs 准入和事务内复查。未落库流式源仍有超时/取消的初始等待；missing-row 精确读与首次提交竞争的 `collection_snapshot_changed` 转单键等待，不伪造源行。状态读/保存重新按键鉴权，过期 session 拒绝写快照。
- 打开中的观察者只 watch 一个 `recordKeys(chats,id)`，直接校验远端源行；修订/删除立即使观察失败并释放订阅，账号 lifetime 终止也释放。`WidgetBlock.tsx` 在失败时移除 iframe，不能让失效脚本继续运行。没有全表或账号 mirror 订阅。
- `legacyHtmlWorks.ts` 用同一精确读取验证原回答及真实 HTML source，保留正常 learning command 适配；迟到/账号变更返回前复查 lifetime。`HtmlAnswer.tsx` 将 owner rowId 传入 WidgetBlock；准入识别仍在当前正文中的 legacyHtmlWorks source，因此仅保留旧适配缓存不能绕过正文修订/删除。
- 新增 `scripts/e2e-widget-cold-cache.mjs`：隔离 SQLite、Vite cache、真实 API/Chromium 与真实 learning command；worker 禁用，provider 为拒绝执行的受控 mock，无付费模型。`widget-cold-cache-DSD7F8/evidence.json` **PASS（10 项）**：空 IDB 历史 widget 打开、远端修改/删除销毁 frame、删除后 read/save 拒绝复活、冷 legacy 适配打开、legacy 正文修改/删除失效、首次提交前等待、取消/异 owner 拒绝、阻塞真实 HTTP 响应后账号失效拒绝迟到 widget/HTML 返回、无 mirror/全表请求及 pageerror=[]。
- `npx tsc --noEmit -p apps/web/tsconfig.json` 已两次通过；未运行 full build。首轮 focused 发现显示错误后 iframe 仍存活，已修为失败即移除，并保留严格 frame=0 断言。Playwright 的 serviceWorkers:block 自身向 opaque sandbox 注入不允许的 navigator.serviceWorker 读取而报 SecurityError，focused 改为不注入该设置，未过滤 pageerror 断言。
- 补跑旧 `npx tsx scripts/e2e-widget-ownership.mjs`：**未通过**，第 112 行测试自身在 `db.chats.get(1)` 取 `.widget` 时为 undefined。该脚本仍假定 flush 会补全账号镜像；新生产路径不会为了旧测试重新恢复镜像。未改此旧脚本；其镜像夹具兼容待所属 agent 协调，focused 用服务端 fixture payload 而不是伪造 IDB 行覆盖真实准入。
- QA delete/retry/quiz 与 Chat 批量删除由同步 agent 负责并已关闭：`client/conversations.ts` 使用服务端完整记录 CAS，`ChatPanel` 的 QA 删除/作答精确读取；`courseChat.retryMessage` 的页面错误由主 agent 统一 catch。真实冷缓存 Chromium/WebKit（主会话补生产页面按钮后 `cold-conversation-d61wX9` / `cold-conversation-90Cez8`）验证 503 保留原问答、零自动重发、无 unhandled，恢复后真实删除并重生成。总体本地集成门禁仍以 11/11 为准；最终重跑证据 `data-delivery-acceptance-s1t6rN/evidence.json`。

最新最终轮 `widget-cold-cache-oExerx/evidence.json` **11/11 PASS**：旧 HTML 通过真实 `ArtifactEditProvider → HtmlAnswer → WidgetBlock` 产品组件打开并验证修改/删除失效；同时覆盖修订后的旧 binding read/save 拒绝、有界超时及真实提交后显式重试恢复，pageerror=[]。前两次扩展绿为 `Ne9PwH`、`A5w25k`。上述 widget/旧 HTML 冷缓存 P1 已关闭。

主会话追加集成：`test:data-delivery:widgets` 再次 11/11（`widget-cold-cache-1H2yS7`），原独立门禁 11/11（`data-delivery-acceptance-ni1Idj`）。旧 ownership 夹具改为传入服务端原有 fixture payload、保持实际精确准入并新增启动 chats=0，未删除取消/卸载/超时/修订/删除/A→B→A 断言；`e2e-widget-ownership.mjs` 和 `e2e-widget-local-state.mjs` 重跑均通过。第 16 行是修夹具前的历史失败，不再是当前未通过项。

### 修复前只读轮结论（历史，widget 状态以上节为准）

**结论：原三项红项已关闭，独立门禁 11/11；但镜像退役的业务 consumer 迁移仍有下列明确 P1，不能据此宣布产品全链路验收完成。** 本轮只读真实集成源码及 evidence，未运行 build、未改生产代码或脚本（包括同步 agent 正在修改的 e2e-loading）。并发工作区中的后续修复仍须重新核对。

### 当前阻断：仍依赖全账号 chats 镜像的业务操作

1. **P1：冷加载历史的 retry 可未删除原问答便重新发送。** `apps/web/src/client/conversations.ts:4–9` 的 `removeConversationMessages` 只 `database.chats.bulkGet(ids)`，过滤本地缺失行后空集合静默返回，也可能只删除已缓存的部分。`store/chatHistory.ts:18–36` 完整历史读取和 `client/session.ts:42–51` 会话投影只返回内存行，不写 IDB；退役后的 `cloud/sync.ts` 不再后台补齐 chats。复现前提：既有服务端会话、全新浏览器账号缓存、最近一问一答未被 exact-key/receipt 单独写入 IDB。打开会话后对最后回答点击重新生成：`store/courseChat.ts:559–576` 读到完整历史，删除函数却没有提交删除命令，随后从 UI 移除旧问答并调用 send；服务端旧问答仍在。QA 相同调用链为 `components/ChatPanel.tsx:1194–1219`。这不是完整历史读取失败，而是其结果未被删除 consumer 使用。依据为可确定的源码路径，本轮未执行产品复现。
2. **P1：QA 历史消息删除、题卡作答依赖本地行，冷缓存失败。** `components/ChatPanel.tsx:595–598` 在调用已迁移的 `removeConversationMessage` 前先 `database.chats.get`，缺失即返回 false；`:638–641` 作答也先读本地行，缺失报题卡已变化。复现：新缓存打开已有含题卡的课程会话，直接删除旧消息或选择答案，服务端有行且 UI 可见，本地没有该行。`store/conversationProducts.ts:9–10,20–23` 已提供服务端 exact-key 读取，但上述前置检查尚未使用，不能因 helper 已迁移就认定调用者通过。
3. **P1：冷加载旧回答的交互讲解/旧 HTML 预览不可用。** `components/WidgetBlock.tsx:229–242` 调用 `openWidgetSession(...waitForSource:true)`；`store/widgetState.ts:46–76,89–105` 仅 liveQuery 等本地 chats，再以本地行准入，没有服务端按键读取。冷加载含 widget 的旧会话，内存已有 payload 而 IDB 无源行，会等待至超时；`store/legacyHtmlWorks.ts:16–23` 同样直接读本地 chats，旧 HTML 点击预览失败。这是既有 consumer 的镜像依赖，不是建议恢复全账号镜像。后续还需保持 widget 的修订/删除校验，不能通过跳过源行准入求绿。

`client/conversations.ts:12–17` 删除整个会话也直接读本地 chatSessions；当前已检查的常规删除调用者先通过 `readConversationSession` 做 exact-key hydration，故不另列为已复现 P1。`HandoutDocView.tsx` 的本地视频名/帧读取、旧后台 coverQueue 等残留应分别按实际入口复核；不把搜索命中本地表一概当成业务删除或空数据阻断。

### 本次集成只读核对

- **sync 退役与 epoch：** `cloud/sync.ts:111–139,282–331,556–587` 只订阅标量 recordHead；epoch 变化清理可再生投影/revision/cursor/stage，保留命令日志、原件与恢复证据。收据 epoch 不明/不符转 conflict；退休前核对 exact keys、revision 和事务内 local epoch，再原子落投影与删除已确认日志。未发现“epoch 重置直接退休旧命令”的新 P1；不是对所有多标签竞态矩阵的运行证明。
- **collection 竞争/刷新范围：** `client/collections.ts:10–39,60–78` 限定 table/parent、验证游标/唯一键/epoch/version，结束重新校验首屏；20k 行/16MiB 超额显式失败，不发布假空集合。并发更新用 dirty 重读，只发布最新完整版本。`cloud/sync.ts:144–176` scope refresh 仅操作命名父域；缺失本地键再 exact-key 查询，并以 revision 防晚读覆盖较新 receipt，没有将未加载全表当删除。高写入时反复重试及大 scope 显式预算错误是边界，不宣称全应用 100k 已验收。
- **idle session cache：** `store/courseChat.ts:149–165` 与 `client/session-cache.ts` 对闲置会话使用 6 个/16MiB 预算；active、订阅、运行任务、待提交、分页、loading、queued、pendingAsk/Plan、streaming/syncPending/无 rowId 消息受保护。只淘汰闲置可重读正文；`packages/client-core/src/index.ts:280–283` 拒绝淘汰有 refs 的远端 model。未见为满足预算而直接丢待发的明确路径；保护中的工作允许超预算，不是全生命周期硬内存上限，也不覆盖刷新后的非持久草稿保证。
- **metadata 一次上传与 server preview：** `chat/prepareAttachment.ts:75–108` 图片仅上传原件一次，从响应取 previewServerId/width/height，不再浏览器生成及第二次上传 preview。`apps/api/src/server.ts:705–723,736–748` 服务端生成 metadata，原件与 preview GET 都先鉴权/owner 校验再处理 304，private/no-cache；删除先检查关联原图/preview 在 record/task 的引用，已引用返回 409。`cloud/attachment-images.ts:9–43,59–66` 同 owner 关联、确定 preview ID、文件 hash 校验和删除 cascade；未见当前普通文件入口的明确越权 P1。共享引用归档/分叉/删除的组合和全部崩溃清理情形仍非本次只读证明。
- **原红项修复：** 当前 task DTO 有历史输入净化；cloudBlob 缓存命中仍走鉴权条件请求；task nonce 在附件重新准入前按用户意图查重。直接读取 `data-delivery-acceptance-icG461/evidence.json`，11 项全部 passed，三轮均首屏 40、unopenedBodyFrames=[]，WS 应用帧字节分别 29899/29172/29172。该 evidence 为主 agent 重跑结果，不冒称本审计再次运行。
- **迁移饥饿原 P2 已有修正：** `attachment-migration.ts:12–31,36–50` 现有 afterRevision/nextRevision、afterId/nextId continuation，失败行不再必然挡住后继行；调用者须推进返回游标并保留失败重试策略。本轮未运行坏图满批矩阵，旧“无 continuation”结论已过时。

### 验收边界与已知残留

- 主 agent 提供：full build、5/5、oneupload 旧附件 e2e、runner/runtime 均绿；本轮没有重跑这些门禁，不能替代上述未覆盖的冷缓存业务操作。
- **明确延期，不升为新红项：** QA `images[].thumb`；active 会话历史页累计与 journal gap 全量；全应用 100k 规模。idle cache 预算不解决 active 历史累计。
- 仍未由本次审查证明：WebKit、生产规模/线上提速、长期后台静默、所有共享附件引用的归档/分叉/删除组合。旧轮间歇 WS 正文帧失败保留在下方历史记录；新三轮绿不等于已定位旧故障根因。
- 最新运行结算取代下方早期红项状态；下方保留当时发现与运行证据，便于追溯，**不应再把已修复的三红项或迁移 continuation 作为当前缺陷引用**。

## 历史发现与优先级（修复前记录，当前状态以上节为准）

1. **P1：历史任务再次交付图片 Base64。** `apps/api/src/cloud/tasks.ts:43–45,85` 的 full/activity/session 都 `JSON.parse(row.input)` 原样返回。`apps/api/src/realtime/runtime-domains.ts:126` 全局 tasks 订阅读取 activity，故只剔除 chats 的 modelTrace 不足以关闭旁路。`attachment-migration.ts:14` 目前只遍历 chats，不处理 cloud_tasks.input/progress/result；QA 截图的 `input.images` 也需独立核验（`ChatPanel.tsx:1133–1137`）。脚本以既有合法旧格式 taskDto 复现，断言失败；这不是声称新任务准入未规范化附件。
2. **P1：同账号撤权被磁盘字节缓存绕过。** `apps/web/src/store/cloudBlob.ts:47–54` 命中 `_fileCache` 后直接返回，不发条件请求。前端新 `prepareAttachment.ts:127` 复用该入口。真实 Chromium 先缓存原图，在隔离 DB 撤销文件行，真实 API GET=404，再读仍返回原字节，严格断言失败。账号 lifetime 防迟到完成与账号数据库隔离已经有测试，不等于同账号持续授权已验证。
3. **P1：附件准入早于持久 nonce 查重。** `apps/api/src/cloud/task-commands.ts:20` 的 normalize 位于 `23–28` nonce 查重之前。文件后续删除/撤权或 preview 元数据变化后，同一已完成 operation 的重放可能失败或变成 nonce conflict；这与 `30–31` 所述“先找旧收据再校验”的恢复契约相反。新增门禁使用真实 completed cloud_tasks 行，不执行模型。
4. **P2：历史迁移失败可阻塞后续批次。** `attachment-migration.ts:14–15,59` 每次固定取最低 revision 的 limit 条，失败仅计数，无 continuation 或隔离。最早 limit 条永久坏图会令以后有效图永远选不到。属于可由源码推导的边界，尚无自动化 20 坏图＋后继有效图复现。
5. **尚存有界性边界：journal gap 全量。** `apps/api/src/realtime/domain.ts:487–490` gap 分支仍 `.all()` 全会话；`packages/client-core/src/session.ts:60,97–100` 历史页/事件仍累计。现有演示测试甚至明确断言 gap 返回全部 65 条。不是本 agent 新发现的数据丢失，但不能把首屏 40 条等同于全生命周期有界。

## 已核验的完整性与权限路径

- 首屏投影剔除 modelTrace/modelRequests，但 recordKeys/collectionPage 保持完整业务记录；只读投影不改原记录。新引用夹具首屏精确为第 26–65 条，旧页为 1–25，完整遍历覆盖全部 65 ID。
- 原图/预览共享鉴权文件路由：`apps/api/src/server.ts` 文件 GET 在 ETag/304 前先检查账号与文件；真实 GET 原字节、未登录条件请求=401、原图/预览跨 owner 条件请求均=404。
- 迁移先落文件、校验 hash、生成 preview，再对原 value/revision CAS：已测有效图保留原 serverId，modelTrace 转 attachment-file 引用；坏图迁移失败后 SQLite 原 value/revision 完全不变，再试不误报已迁移。
- `projects/resources.ts:232–241` 资源归档读取 serverId 而非 previewServerId，避免缩略图当原图；`279–301` receipt 防删除资源后重复导入。真实移动/归档/分叉共享引用删除的组合场景仍未在本脚本自动化，不能宣称生命周期全通过。
- `store/chatHistory.ts:18–36` retry/fork/export 显式遍历服务端 collectionPage，不以 UI 窗口替代完整记录；账号/runtime/lifetime 有栅栏，旧游标失效显式失败。完整操作的真实产品点击＋模型回放应由附件后端专项集成验证。
- client-core baseline 只在 ready 后发布；不完整 baseline 不推进 cursor；HTTP prepend 有 page token 和并发 tombstone 集合。未将“本地未加载”解释为删除。records epoch/reset 更换及精确收据故障矩阵由既有 loading 专项承担，需在同步 agent 最终版本重新执行。

## 自动化门禁

运行：

```sh
npx tsx scripts/e2e-data-delivery-acceptance.mjs
```

特点：独立 SQLite/files/cacheDir；Vite HMR/文件监听关闭；真实 API 文件字节与真实 Chromium 产品启动/切换；外部浏览器网络拦截，worker 禁用、模型 fetch 拒绝。每轮新 BrowserContext/IDB，三轮冷启动后 A→B→A→C→A，逐条校验会话归属。503 历史分页失败必须保留 40 条与显式错误，重试得到完整 65 条；不用任意 sleep。任何失败均保留断言、写 evidence 并非零退出。

首屏无全量的观察区间是导航至首屏 loadSession 完成，不是 60 秒后台静默证明。HTTP 请求检查和 WS 帧检查同时进行；WS 字节是应用帧，不是压缩网络量。原图/预览为 sharp 生成的有效 PNG，最初沿用旧专项的 PNG 在新 sharp 完整解码下失败（vipspng read error），已修正测试夹具而非绕过校验。

## 真实运行记录

- `npx tsx scripts/test-session-presentation.mjs` 通过（运行时为并发修改前的投影版本）。
- `npx tsx --test scripts/test-account-lifecycle.mjs scripts/test-cloud-transactions.mjs scripts/test-cloud-blob.mjs` **21/21 通过**；其中缓存命中跨 lifetime 重用是既有行为，不覆盖撤权。
- 集成 `data-delivery-acceptance-Lr2FsD`：7/8 通过，历史 task input 失败；三轮首屏 40，无 mirror 请求，WS 总应用帧约 29KB。此版尚未增加撤权/分页失败/迁移门禁。
- 扩展 `data-delivery-acceptance-xPhRof`：迁移完整性通过；缓存撤权失败；三轮冷切换中两轮出现未打开正文帧断言失败，另一次独立运行三轮均通过。尚未定位，不能将间歇失败删除或以后一轮绿证明解决；脚本后续增加 offending frame prefix 诊断，全部为合成夹具无真实内容。
- 完整独立门禁 `data-delivery-acceptance-x3zG6P`：**8/11 通过，3 项失败**。迁移成功/失败保全、精确历史/权限/字节、三轮冷切换＋503 保留/重试均通过；历史 task input、完成 nonce 在原图删除后重放（“附件不存在或无权访问”）、同账号缓存撤权三项失败。前一轮 nonce 夹具最初遗漏 `_pluginProviders` 导致首次重放即 conflict；已改用真实 PluginFiles.admitTask 生成持久输入，并在撤销文件前先断言重放确实成功，未削弱恢复断言。
- 授权更新的旧附件全链路 e2e：将旧 uploads=2/3 改为精确 text 原件＋图片原图/预览上传关系；保持 crop 像素/尺寸断言；检查持久 refs、无 Base64，模型输入 image_url 必须解码后与下载原图 SHA-256 一致，后续轮历史重放也必须包含同一原图。503 文本回退先只清理 disposable file cache，避免成功缓存掩盖故障。`npx tsx scripts/e2e-server-chat-attachments.mjs` **通过**，证据 `chat-attachments-e2e-0ZTYn0`（同临时根）：真实拖放、发送前阻塞、裁切像素/尺寸、原图/预览引用、原字节、持久模型轨迹无 Base64、刷新、文本故障回退、图片查看器与后续轮原图模型 hydration。provider HTTP 为受控无付费夹具。
- 两个脚本 `node --check` 及限定这三个交付文件的 `git diff --check` 通过。没有运行共享 build 或修改共享 package.json；最终源码全构建由主 agent 协调。

证据均在 `/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/<上述目录>/evidence.json`。仅本地隔离源码测试，**不是线上优化后速度、生产制品、WebKit 或全应用规模验收**。真实模型完整请求/恢复、归档与文件删除组合、离屏→近视口→原图预览点击、长期后台无全量、最终完整 build/typecheck，仍需主 agent 集成门禁；不能用本结果替代。
