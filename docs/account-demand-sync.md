# 全账号镜像退役与按需作用域读取

2026-11-11；当前工作区直接实施，未提交、推送、部署、清库或调用付费模型。保护接手时已有改动。本文只结算同步分工，不勾选原六阶段计划。

## 已实施

- `cloud/sync.ts` 的 `startCloud` / `flushCloud` 不再调用全账号 `recordsPage` / `followRecords`，无默认保留镜像的 feature flag，也没有把正文全量下载移到后台。启动为配置、偏好、耐久 journal 排空和 `recordHead` 标量失效；视图自己观察范围。`recordsRevision` 是失效通知而非全局游标，不过滤 feed 后推进 cursor。
- 主 agent 协调实现 `recordHead {epoch,version}` 与新学习收据 `epoch`；本分工增加 client-core 的 `recordHead()`、可释放 `collection()` 和仅 refs=0 才成功的 `evictSession()`。后者与主 agent 会话缓存工作整合。
- epoch 更换只清可重建业务投影、revision 元数据和 staging，偏好、命令、任务准入证据、原稿/Blob 均保留。HTTP point read 在读取 head 前后和 IDB 事务内验证代次，迟到旧 head 不能覆盖已接受的新代次。相同 owner 的新 lifetime 也不等于旧身份。
- 学习确认仅读取收据键（每批≤100），满足 epoch/revision 后原子发布并退休。无 epoch 的旧持久收据或其他代收据转 conflict 并保存完整意图，不自动退休；503、配额、版本未到、账号变化均不删除 journal。
- 精确读取的物理缺失（`value:null,revision:0`）只有在前后 head 不变、事务内同代且该键没有被较新点读发布后才清理旧投影；不能仅靠 revision 比较而永久保留旧缓存。新增真实物理删行回归通过。
- 任务 effects 仅在本机首次准入有耐久 generation 证据、终态详情前后 head 一致时比较。恢复任务、旧服务端无 effects、overflow 无 effects，显式读取命名课程/会话作用域，不调用全账号 fallback；每页沿用50行/512KiB，完整作用域≤20000行/16MiB，失败明确抛错，不发布半份或假空。不能识别输出范围的任务显式 `task_scope_refresh_unavailable:<kind>`，不静默跳过。
- `client/collections.ts` 统一完整作用域遍历、末页后的版本校验、parent/key 验证、环与预算拒绝；不会把 UI 页伪装完整集合写入 IDB。`refreshRecordScope` 仅用于明确任务fallback，旧本地键用精确读取确认墓碑/移动，保留更高版本点读结果。

## 消费者审计与迁移

| 入口 | 结果 |
| --- | --- |
| 卡片、讨论、弹幕面板与飘屏 | 从 business IDB 改为有界课程 collection 观察；失败保留旧完整行但标记未ready，禁生成/导出并提供重试。卸载/账号释放停止观察；hook 增加终止数据库栅栏，防注销后同DB错误重启本地读取。 |
| MaterialInk / highlightContext | 批注按材料显式读取，保留 pending/conflict 和私有队列叠加；读失败禁书写。观察远端材料失效，账号释放清显示值。 |
| ChatPanel 帧目录 / FrameThumb | 课程 frames 显式有界读取；缩略图行按精确键，不再信任缺失镜像。正文 session 归另一分工，未覆盖其实现。 |
| ChatAddMenu 课程选择 / libraryFolders 移动 | 仅用户打开选择时遍历有预算的课程/目录；移动的每个 expected 行按精确键，不再把未加载看成删除。此处是明确完整选择器，不是启动预热，也不声称已实现服务端搜索。 |
| fileStore 课程原文件 | cloud 精确读 courseFiles/files，HTTP响应及Blob完成后复核账号 lifetime；本地模式保留本地权威。 |
| wrongbook | cloud 直接观察 courseDocument；不再等 courseFiles 镜像存在才观察。创建判断精确读取。 |
| 转写启动恢复 | cloud 不扫描局部 videos 推断要重新提交；服务端队列负责执行恢复，既有 Activity tasks 模型恢复进度，避免刷新重复计费。 |
| materials/images | 主 agent 已迁移 videos 精确键与单课程 frames 有界读取，并有其独立真实测试；本分工未编辑该文件。 |
| 导出/分叉/重试/恢复编码器 | 复核既有服务端 streamChatHistory 与纯编码器，不改为局部UI窗口；非本轮新完成项。 |
| 冷缓存 Chat/QA 删除、重试、题卡作答 | 最终审计发现的P1已修：`client/conversations.ts` 批量删除精确读取 chats，整个会话删除精确读取 session及消息，不依赖调用者先hydration；QA delete/answerQuiz前置检查改用 `readConversationMessage`，不拿session投影作CAS。QA retry读取失败显示错误并保留UI/原问答，不自动重发。Chat页面 `courseChat.retryMessage` 现同样统一 catch 并提示，原问答保留、不自动重发。 |
| 原有技能/字幕/材料块/学习统计/导航/资源 | 已有各自权威 projection；保留，未重新造全局镜像。主 agent 的 refreshArchived cloud guard避免非本地误读。 |
| storageStats/modelUsage/migration/Library本地分支 | 历史本地/恢复用途，或serverManaged分流；不拿它们当cloud全量事实。 |

## 真实验证

证据根：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`。

- `npx tsx scripts/e2e-account-demand-sync.mjs`：Chromium `account-demand-L8zPAQ`、WebKit `account-demand-Dj37Zn`。真实 API + IDB + startCloud，10k未打开消息；冷启动/显式flush零业务行、零全账号请求、HTTP/WS零无关正文。121卡片跨页、真实 React hook 超预算失败/保留旧值/not-ready/显式重试、精确单键、503确认保全/恢复、缺失/溢出回执命名fallback含墓碑、真实epoch reset/旧及无epoch收据保全、online恢复、真实logout后lifetime释放均通过。无pageerror/未处理rejection。
- `npm run test:loading`：最新 `lazy-loading-k1x2Ql`（此前 `lazy-loading-e6MCOf`）通过。原脚本有效PNG改用sharp，不再使用非法PNG尾拼字节；旧1000消息/6次recordsPage和warm增量全量镜像假设替换为零feed+明确cover/chat键。保留503、配额、墓碑回滚、未来revision、A→B→A、原附件原稿、cursor不推进、文件失败重试、真实鉴权304、资源目录重验证时缓存可读断言。原mid-staging失败改为head刷新503保留旧投影/意图/原稿，真实epoch更换成功后仅清投影且staging始终为空。首次运行在旧PNG上传断言失败；迁移后整套通过，未恢复镜像迎合旧测试。
- 最新 `npx tsc -b apps/web`、`test-account-demand-sync` + `test-task-flush-precision` + `test-cloud-transactions` + `test-account-lifecycle` 合计22项通过；`git diff --check` 通过。前4项是协议伪reader，task-flush为源码防回退，不冒充真实API；上列双引擎为真实运行证据。
- 增强React专项初次两引擎重试按钮因服务端修复自动恢复而消失，改为显式503闸门确保真实点击重试；随后暴露注销后hook重新进入local分支，已加终止栅栏并重跑双引擎通过。没有force click或删除释放断言。
- 最终物理缺失增强后 account专项 Chromium `account-demand-sLagm2` / WebKit `account-demand-zTm0G4` 均通过。
- `npx tsx scripts/e2e-cold-conversation-actions.mjs` 与 `BROWSER=webkit`：最新 `cold-conversation-oh62jR` / `cold-conversation-AQQkE1` 均通过。真实空chats IDB、真实 API/SQLite/learning commands、真实 `useCourseChat.retryMessage`（未挂CourseChat页面按钮）与QA产品删除/重试/题卡按钮；精确读503保留Chat及QA旧问答且不发模型，显式恢复删除旧问答后受控server模型重生成；helper不依赖调用者先读session，传显示DTO仍精确取完整CAS；题卡点击前904未缓存，成功持久化选择并保全被投影剔除的modelTrace。无全账号请求、pageerror或未处理rejection，未调用付费provider。第一次题卡夹具误用null pick触发组件错误，改为合法未答值-1；加入Chat真实retry后需等该任务完成才统计QA阶段模型次数，保留“不自动重发”严格断言，不过滤错误。
- 最后 web typecheck、上述22项再次通过。完整build/generator遵从主agent统一运行，不重复执行。
- 冷缓存P1与物理缺失修复后的最后 `npm run test:loading` 再通过：`lazy-loading-g0Xmp5`（含9项blob测试），`git diff --check`通过。
- 完整build/生成契约由主 agent 统一执行，本文不将其此前成功冒充本分工最后一次改动后的完整构建。

## 剩余边界与明确 blockers

1. 不声称原六阶段/全部领域验收完成：生产1k/10k/100k多轮性能、全部多标签竞争/慢网/API重启/撤权矩阵、真机Safari/PWA离线仍非本专项证据。`test:loading` timing每延迟仅1轮，不作性能保证。
2. Task.effects暂无线代次列；本机没有准入代次证据就不比较旧effects。`bilibiliImport` 等不能由现有task input/resource识别有限输出的旧/overflow任务会明确失败并保留准入恢复证据；要消除此功能性限制需服务端提供有限scope或effectsEpoch，不能以无界全账号回退代替。大于20000行/16MiB的完整会话/课程fallback同样明确失败；正常有effects路径不受此整scope上限影响。
3. ChatAddMenu完整课程选择器和ChatPanel帧目录仍读取一个明确完整scope，虽有严格预算，但不是轻量metadata分页产品；海量单scope需要专用索引/选择器协议才能进一步降低成本。HandoutDocView无media的IDB fallback属于本地路径，cloud正常latestHandout已提供media；独立调用者必须继续遵守这一契约。
4. MaterialInk目前远端观察回调会再执行一次完整有界读以与本地journal叠加，正确但有冗余请求；未在此宣称最优request count。Cards/Comments/Danmaku真实面板全部交互/触摸验收未由通用hook专项替代。
5. epoch/revision不能在客户端完全阻止服务端在最后一次响应后立刻reset；现有代次观察使投影收敛，confirmed必须同代才能退休，不伪造跨代比较。
6. Chat页面按钮的失败呈现已由主agent收尾：`courseChat.retryMessage` 在读取/删除异常时显示本地化错误，原问答保留且不自动重发；生产 `CourseChat.tsx` 多处 `void retryMessage` 不再产生 unhandled rejection。真实页面按钮在 Chromium `cold-conversation-d61wX9` / WebKit `cold-conversation-90Cez8` 验证 history 503 与 exact-key 503 均可见报错，显式成功重试后才删除完整记录并重生成。QA对应catch与真实按钮已通过。

## 本分工改动文件

`apps/web/src/cloud/{sync,tasks}.ts`；`apps/web/src/client/{collections,conversations}.ts`；`apps/web/src/components/{useCourseCollection.tsx,CardsPanel.tsx,CommentsSection.tsx,DanmakuPanel.tsx,DanmakuLayer.tsx,MaterialInk.tsx,ChatAddMenu.tsx,ChatPanel.tsx}`；`apps/web/src/materials/{highlightContext,libraryFolders}.ts`；`apps/web/src/store/{fileStore,wrongbook}.ts`；`apps/web/src/pipelines/transcribeQueue.ts`；`packages/client-core/src/index.ts` 的collection/recordHead/evictSession工厂；`scripts/{test-account-demand-sync,e2e-account-demand-sync,e2e-cold-conversation-actions,test-task-flush-precision,e2e-loading}.mjs`；本文。其他并发改动不归本分工。
