# 会话数据按需交付：执行清单

## Steps
- [x] 附件后端：复用鉴权文件存储，分离图片预览/原图，保证历史数据与模型读取完整。
- [x] 附件前端：上传后仅发送引用，近视口获取预览、按需原图、尺寸占位与失败重试。
- [x] 同步迁移：审计残留镜像读者，按范围读取与精确确认，退役启动全账号拉取/订阅。
- [x] 缓存与生命周期：账号隔离、请求合并、条目/字节预算、取消与缓存淘汰。
- [x] 集成验收（本地）：附件完整性/权限/恢复、无隐形全量请求、快速切换/重连及完整构建。尚未部署，线上耗时与生产历史迁移不在本项内。

## 授权与边界

2026-11-11 用户批准前述建议并要求多个 `dstu/gpt-6.1-sol` subagent 执行。本清单是已授权工作的实施分解，不替代或自动勾选项目原六阶段计划 `cbe2f806-46c1-40f8-a267-136b3a80c30b`。沿用当前工作区，保护既有未提交优化和其他会话改动；不提交、推送、部署、清库或调用付费模型/真实 IM，不重新使用已清除的生产登录态。

## 分工及共享契约

1. 后端 agent：附件服务/文件路由、服务端任务准入/模型取图、旧记录引用迁移及必要 shared attachment 类型；不编辑 Web。
2. 前端 agent：上传准备、图片展示、按需附件加载与有界缓存及浏览器回归；不编辑 API/shared 类型。
3. 同步 agent：`cloud/sync.ts` 及残留全量镜像读者/精确确认/恢复；不编辑附件后端、附件前端、`Gate.tsx` 或翻译文件。需要跨区改动先报告协调。
4. 验收 agent：独立审计与隔离回归脚本；不覆盖其他 agent 生产代码。
5. 主 agent：接口协调、跨区整合、回归与文档结算。

附件字段优先复用已有 `serverId`（原图）；预览引用使用 `previewServerId?: string`，尺寸使用 `width?: number`、`height?: number`。持久消息不携带图片 Base64；临时草稿可使用本地预览。若现有协议/存储更适合其他表示，先报告主 agent 再更改共享契约，避免两端自行造协议。

最终协议已统一：每张图片只上传原图一次，服务端生成 640px 内（不放大）的 WebP 预览并返回上述 metadata。客户端不再另外生成、上传 JPEG；本地草稿路径仍允许临时 dataUrl。

## 不可省略的正确性约束

- 先安全落文件并校验，再替换原记录引用；迁移可重试，失败不丢原图/正文/模型可读内容。不在只读投影请求中隐式改写用户记录。
- 原图与预览均鉴权；跨账号不可读，不因缓存绕过撤权。优先复用已有文件字节缓存/路由，不另造存储底座。
- 当前会话正文分页；非活动会话使用轻量索引/任务状态。缓存按账号/会话身份分区且有字节上限，草稿/未确认命令不可淘汰。
- 未加载不等于空/已删除；不通过过滤全局 feed 后推进其游标来伪造领域同步。epoch/reset、删除、跨标签、命令收据与恢复必须仍正确。
- 首屏/文字显示不得等待全账号镜像或所有图片；视口外图片不预取原图。记录图片尺寸以保持虚拟列表阅读锚点。
- 保留已有 `apps/web/src/cloud/Gate.tsx`、翻译、历史恢复文档与脚本等其他会话未提交改动；共享 `package.json` 最后统一集成测试入口。

## 验收目标

- 有图会话首屏/历史页/journal 事件不携带 Base64；附件原始字节下载及模型边界读图不变。
- 冷启动不调用全账号 `recordsPage`/`followRecords`，未打开会话正文/无关大表不下载；完整导出/任务恢复仍可用。
- 请求去重、加载失败重试、离屏加载、释放/取消、A→B→A、注销/跨账号、无权/缺失文件都有自动化证据。
- 使用隔离 SQLite/真实 API/Chromium 和可用 WebKit；先保证正确性，再单独多轮测量请求/字节与可见耗时。不得以本地数据冒充线上提速。
- 跑相关专项、协议/边界检查、类型检查和完整构建；任何既有失败与本次回归分别记录，不能删断言掩盖。

## 执行结果

附件、主同步和非活动会话缓存实现已落地，旧加载聚合测试已更新通过。最后独立复核发现的三项冷缓存遗漏均已修复并真实验收：历史作品源行准入、Chat 批量删除精确 CAS、QA 删除/作答精确读取，以及页面级重试错误呈现。详细结果分别见 `chat-attachment-references.md`、`chat-attachment-ui.md`、`account-demand-sync.md`、`data-delivery-acceptance.md`。本清单仅结算当前 Chat 交付范围，不将它折算为原六阶段全应用计划完成。

### 协调：recordHead 与回执 epoch

主 agent 已实现 RuntimeRead `{kind:'recordHead'}`，值严格 `{epoch:string,version:number}`；version 为当前账号各表 `*` collection head 之和，只读标量，非全局/分页游标；触发任意账号内 cloud_records 写入。API pump 观察 epoch 改变后唤醒全部快照，允许 revision 回退时以 snapshot 替换（不跨 epoch 生成 delta）。`RuntimeRecordsReceipt.epoch?: string` 已加入；新 `editLearning` 事务回执包含 epoch，原持久回执若无 epoch 必须保守保留恢复，不自动退休。task effects 暂无 epoch，sync agent 采用请求前后 head 校验/任务详情重读与本地绑定，无法证明同一代次时保留未确认意图而非比较 revision 猜测。主 agent 负责生成共享契约，不要并行运行 generator。此协议仍不免除逐领域消费者迁移。

### 主会话：会话缓存与协议验证

- `client/session-cache.ts` 为非活动、无未确认工作的会话设置最多 6 个窗口／16MiB 保守 payload 估算（不是 JS heap 测量）。LRU 按实际选择更新，超预算同时移除 UI view/timeline 与无订阅的 runtime journal。字节统计复用不可变子树，避开流式逐 token 序列化。
- 活动会话、运行中任务、历史请求、待发/未确认消息、交互卡片与新草稿受到保护，可以超过闲置缓存预算；不清除持久队列或任何服务端记录。淘汰后重新打开获取最新 40 条基线，再正常向前分页，不复用过期删除事实。
- `test-record-head.mjs` 已通过：1000 条多 KB 私有记录下仅标量输出、账号隔离、墓碑与物理删除推进 head、只扫描索引小表、活动 watch 的 epoch/revision 回退返回完整 snapshot、幂等回执保留原 epoch。
- `test-session-idle-cache.mjs` 与扩展 `e2e-session-loading.mjs` 已通过；后者真实 Chromium 连续切换 14 个会话，校验去重与 ready 屏障、A→B→A、历史分页、超过 6 个闲置窗口时 UI/远端双层淘汰及新基线重新加载。
- `check:boundaries`、`check:remote`、API typecheck、投影专项及 session journal 真实 WS 重连专项已通过。证据根 `session-data-integration-h849TV` 用于最终集成日志，尚不等于后续完整构建或生产验收。
- 明确未因此解决：活动会话连续向前翻页及 journal cursor-gap 的全历史修复仍可能超出窗口预算；不能将闲置缓存上限说成整个运行时/活动历史已经严格有界。

### 集成回归（本地，不是生产提速验收）

- `npm run build` 最终 5/5 通过，`build-final.log`；首次因三个新增用户提示超 i18n CJK ratchet 失败，新增中英译文解决，未放宽 baseline。仍有依赖构建 CSS 语法警告和 bundle size 提醒，不称零警告。
- API/Web typecheck、边界/生成协议检查、ClientRuntime、清空学习时长、账号 reset、server-only app、真实聊天 UI、流式渲染/分页竞争专项通过。
- `e2e-data-delivery-acceptance.mjs` 主会话最终 11/11 通过（`data-delivery-acceptance-icG461/evidence.json`）：三轮产品冷切换、首屏精确 40、未打开正文不传、503 历史页保全/重试、原字节与账号隔离、历史任务不再夹带 Base64、迁移失败原稿保全、删除原图后已完成 nonce 收据可回放、同账号文件撤权不能被字节缓存绕过。WS 为应用帧大小，不是压缩网络量。
- focused 图片按需专项 Chromium/WebKit 均通过：离屏不取图、近视口仅预览、原图查看下载、重试、尺寸占位、URL/账号释放、鉴权 200→304→撤权404；字节缓存仍为 4 并发/128项/32MiB，命中必须条件 GET 鉴权，不离线回退。
- 三个后端附件专项、原真实 native runner 附件专项、资源归档专项通过；旧真实拖放/裁剪/发送/刷新/追问浏览器专项更新为单次图片上传后通过，两个模型轮次的原图 SHA-256 均相等，持久模型轨迹为引用。
- `materials/images.ts` 来源视频和 frame 引用已改精确 videos key + 当前课程 frames 完整有界范围，真实浏览器空 IDB 仍读取正确原图字节，不重新填充 frames 镜像；`refreshArchived` 明确 local-only，服务器归档列表已有 sessionIndex 分页观察。
- 先前独立审计 3 红项已关闭：历史 task UI 视觉数据投影、同账号文件撤权条件验证、nonce 先查收据；历史迁移增加 continuation，20 条坏图之后的合法记录可继续迁移。失败/竞争不删原值。
- 仍存在的旧门禁：`test-session-queue-boundaries.mjs` 禁止 ChatPanel 出现任何 `cloud.enabled`，与 HEAD 已有多处本地/服务器分流矛盾；本轮没有放宽或删除断言，不宣称全仓测试通过。
- 扩展运行 `tsx --test scripts/test-file-names.mjs scripts/test-image-upload.mjs` 为 5/7：通用文件 `/files` 原字节/命名通过；项目上传旧夹具未先准入而收到 `resource_upload_admission_required`，IM retry 夹具未找到 attachment 消息。这两处失败位于本轮未编辑的项目准入/IM链路，未修改其断言，也未完成 HEAD 隔离对照，不将其描述为已验证的本轮回归或既有基线成功。日志 `file-image-upload-final.log`。

### 仍需完成／外部验收

- 线上未部署、无新一轮认证测试；不得将本地合成 10k/三轮数据当作此前生产三个会话的优化后耗时。生产历史数据迁移 API 需单独确认后显式分批执行；未自动后台改写任何生产记录。
- QA 截图是 `images[].thumb`／`input.images` 独立路径，当前已瘦身任务 UI 并保留执行器视觉，但新旧 QA 截图消息/缩略图与历史 input 的完整引用迁移尚未交付，不宣称“全部图片都已剥离”。
- 活动历史双向有界窗口、journal gap 仅修复已加载范围、服务端搜索、超大目录分页、跨领域总缓存预算以及 1k/10k/100k 全应用弱网矩阵仍属于原全应用计划。
- 移动端 Safari 真机／弱网 P50/P95、原生客户端和 Linux/Docker 目标环境验收未由本地 Chromium/WebKit 代替。
- 无可证明同代 effects 且不能从 task input/resource 得到有限输出的任务（如部分旧/overflow `bilibiliImport`）会明确 `task_scope_refresh_unavailable` 并保留恢复证据；完整范围超过 20000 行/16MiB 也显式失败。未使用全账号 fallback，功能限制需服务端 effectsEpoch 或有限 scope 协议进一步关闭。

### 旧加载套件对齐

- 同步 agent 已将 `scripts/e2e-loading.mjs` 的全量基线/全量重建旧断言迁移到新协议：仍保留实际 503、配额、墓碑、未来版本、A→B→A、原稿/回执保全与失败原子性，不恢复退役正文 feed。
- `npm run test:loading` 全绿，证据 `lazy-loading-e6MCOf`；有效 sharp PNG 代替不可完整解码的旧 PNG 夹具，冷/热启动均零 recordsPage，显式 cover/chat 精确读取，warm 条件 GET304，head 故障退避/online 与 epoch reset 故障保全重试。
- 更新后的账号同步真实 React/完整范围读取专项 Chromium `account-demand-L8zPAQ`、WebKit `account-demand-Dj37Zn` 通过：10k 无关正文零传输/IDB、121 张卡片范围分页、读错/重试、回执缺失/overflow fallback 与墓碑、旧无 epoch 回执保守保全、reset 后旧 confirmed 转 conflict、online/logout 释放。补终止数据库栅栏，注销不因同一 DB 对象重新走本地旧缓存。
- 最新生产源码收束后主会话再次 `npm run build` 5/5 通过，日志 `build-frozen.log`；`record-head-final.log` 与 `git diff --check` 同轮通过。没有运行全部旧测试，既有边界失败如上保留。

### 冷缓存作品准入追加修复

- `widgetState.ts` 与 `legacyHtmlWorks.ts` 入场精确读取服务端源消息，保持源正文、修订、owner 与账号栅栏；正常 local snapshot 仍留在设备，不恢复账号镜像。打开中只观察单个 chats key，远端修改/删除即失效，失败立即移除 iframe。
- `scripts/e2e-widget-cold-cache.mjs` agent 最终 11/11 通过（`widget-cold-cache-oExerx/evidence.json`）：真实历史 widget/旧 HTML 产品组件、初次提交等待及重试、修改/删除后 read/save 拒绝复活、取消/跨账号与迟到 HTTP、零镜像请求，pageerror=[]。Web TypeScript 通过；主会话另行重跑集成。
- 旧 `e2e-widget-ownership.mjs` 首次失败在依赖镜像的 `db.chats.get(1).widget` 夹具。主会话仅将输入改为服务端 fixture 的实际 UI payload（准入仍精确读取），补启动 chats=0；原取消/卸载/超时/版本/删除/A→B→A 严格断言全保留，真实重跑通过。`e2e-widget-local-state.mjs` 也通过，未伪造 IDB 源行。
- 主会话重跑 `test:data-delivery:widgets` 为 11/11（`widget-cold-cache-1H2yS7`），原独立门禁仍 11/11（`data-delivery-acceptance-ni1Idj`）。日志 `widget-{cold-cache,ownership,local-state}-final.log` 与 `acceptance-post-widget.log`。
- 作品修复后主会话完整构建再次通过，`build-post-widget-final.log`；新增取消提示已提取中英翻译，未提高 CJK baseline。`check:remote` 与 `git diff --check` 通过。

### 冷缓存会话操作（删除/重试/作答）

- `client/conversations.ts` 的批量消息删除与会话删除改为服务端完整记录精确 CAS，不再把稀疏本地 `chats`/`chatSessions` 当完整事实；会话删除会复核每条消息归属，拒绝混合会话。
- `ChatPanel.tsx` 的 QA 历史删除与题卡作答先精确读取源行；重试链路显式捕获错误，读取失败保留原问答且不自动重发。`courseChat.retryMessage` 同样统一 catch：页面按钮丢弃 Promise 也不会产生 unhandled rejection，原问答不被删除，用户看到本地化错误；只有重试成功才删除旧问答并重新发送。
- 新增 `scripts/e2e-cold-conversation-actions.mjs`（npm `test:data-delivery:actions`）：真实 API/SQLite/learning commands、受控 server 模型，空业务 IDB 下调用真实 `useCourseChat.retryMessage`、生产 QA 删除/重试/题卡按钮。精确读取或完整历史 503 均保留两条服务端原记录、零模型调用；恢复后真实删除并重生成；题卡点击持久化并保全被投影剔除的 `modelTrace`。
- subagent 交付双引擎绿 `cold-conversation-oh62jR` / `cold-conversation-AQQkE1`；主会话补真实生产 `CourseChat` 页面按钮（history 503 + exact-key 503 + 成功重试）后 Chromium `cold-conversation-d61wX9`、WebKit `cold-conversation-90Cez8` 均通过，页面无 unhandled/pageerror。未恢复账号镜像。
- 最终收束：`npm run test:loading` 主会话在 courseChat catch 后全绿 `lazy-loading-yh26nv`（9 blob 单测 + 加载回归）；`test:data-delivery:acceptance` 最后 11/11（`data-delivery-acceptance-s1t6rN`）；`test:data-delivery:sync` 最新 Chromium `account-demand-C3ppR4`，WebKit 用 agent 最终 `account-demand-zTm0G4`；作品专项再次 11/11；生产页面按钮专项最终 `cold-conversation-QmIzWo`；`npm run build` 5/5 通过（`build-final3.log`），Web tsc 与 `git diff --check` 通过。构建缓存命中 4/5，属 Turbo 缓存，不是跳过验证。
