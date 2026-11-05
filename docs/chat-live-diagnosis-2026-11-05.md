# Chat 线上链路诊断（2026-11-05）

## 范围和结论

在 `https://139.199.227.35/#/` 的真实已登录浏览器发送两轮诊断消息，并通过 SSH 对运行中 API 容器和 SQLite 做只读核对。线上 API/Web 镜像为 `build-20261105-2d8010a`。

确认当前「回答失败：未获得回答，请重试」可以在任务仍在正常执行时出现，并被之后生成的答案替换。同时任务完成后页面仍保留停止按钮，下一条消息停在客户端队列。

本次没有修改生产数据库、配置或容器，没有部署修复。产生一条诊断会话、两条测试提问及其真实模型回答。

## 真实测试记录（UTC）

1. 04:02:40.452 发送「聊天链路诊断测试：请只回复『链路测试成功』，不要调用工具。」
   - task `3194c92a-17e0-4e4f-b3c2-fef374e0d228`。
   - 04:02:44.586 后端 `completed`、`error=null`、回答 6 字。
   - 页面显示答案但持续显示「停止生成」；后续消息进入队列，未自动提交。
2. 重新加载页面后，手动点击诊断队列消息的「立刻插入」发送「继续诊断：请列出当前资料库的课程名称，只读取列表，不要修改任何资料。」
   - task `1a5562be-dd60-4729-bbd7-bedccb39be6f`，session `2960057445652975`。
   - 04:05:02.960 受理。浏览器快照实际捕获「回答失败：未获得回答，请重试」、思考过程和停止生成按钮同时存在。
   - 不点击重试，随后显示完整课程列表回答。
   - 04:05:38.353 后端 `completed`、`error=null`、回答 1370 字、思考 72 字。
   - 完成后的页面仍显示停止生成按钮。

## 根因一：历史 executor 值使整个任务订阅校验失败

- SQLite 仍有两条已完成封面任务 `executor='media'`：
  - `6d8b2050-e2d0-4df0-b82f-2c46cf192944`（2026-10-28）
  - `c7572c7d-c3ea-41ed-8439-8022de2e61ca`（2026-10-29，处于当前最近 200 条任务窗口）
- 数据库 migration 12 的 CHECK 允许 `node/media/browser`，当前 `packages/contracts/src/{cloud,client-runtime}.ts` 只接受 `node/browser`。
- `apps/api/src/cloud/tasks.ts:14-20` 的 `taskDto` 原样发送 executor；`listOwnerTasks` 返回最近 200 条。
- `apps/api/src/realtime/domain.ts:346-348` 的 `watchTasks` 对整个列表做类型校验，单条旧记录即可令订阅失败。
- `apps/web/src/cloud/Activity.tsx:48-50,71` 只设置 unavailable；正常完成状态不能进入 `reflectCloudTasks`。该组件没有在聊天中直接解释这次任务观察失败。

在生产容器内使用实际生成的 codec、实际 `listOwnerTasks` 输出做只读复验：

```
原始最近 200 条任务：watchTasks snapshot 校验失败
只在内存把 executor media 映射为 node：同一批 200 条校验成功
```

逐条校验定位到 `c7572c7d-...` 的 executor 字段。没有把内存变换写回数据库；此实验只证明故障字段，不代表已确定最终迁移策略。

## 根因二：运行中检查点被误判为失败

- `apps/api/runtime/node.ts:350-368`：模型请求开始前就 report thinking。
- `apps/api/runtime/node.ts:852-858`：检查点持久化默认 `interrupted=true`，正文尚未生成时 content 为空。这是可恢复检查点，不等同于任务已失败。
- `apps/web/src/client/session.ts:31-38`：session projection 含 tasks，但适配层只向聊天传 rows/hasOlder，丢弃该次投影的任务状态。
- `packages/client-core/src/session.ts:75-95`：reconcile 将持久化行转换为消息，并设置 `streaming=false`。
- `apps/web/src/store/courseChat.ts:556-562`：toMessage 仅凭 interrupted + 空正文直接显示固定失败提示，没有判断对应 task 是否 queued/running/waiting_user。
- 同文件 `refreshCloudSession` 只更新消息，没有根据会话任务事实收敛 loading；正常情况下依赖另一路全局任务订阅纠正。一旦前述订阅失败，就出现误报、完成后仍 loading、队列不派发。

两路投影还存在正常运行时的交错风险：消息检查点到达会把进行中的消息转换为非流式/失败，再等 task progress 覆盖。因此仅修复旧 executor 数据不足以消除状态误判。

## 历史真实失败需单独辨认

只读查到 11 月 4 日六条 chat/qa 任务实际失败，错误相同：

```
Cannot find module '/app/packages/study-core/dist/utils/vtt'
imported from /app/packages/study-core/dist/handout/docx.js
```

这是当时服务端产物的模块加载问题。本次当前部署两轮真实模型任务均完成，不能把旧错误当成今天所复现误报的原因。库中另有历史 model_connection_failed/model_timeout，不代表本次测试遇到它们。

## 修复验收要求

1. 按当前协议处理已有任务的 executor 数据/DTO，使实际历史库任务订阅可读；不靠删除历史任务绕过。
2. 会话消息合并时使用同一 projection 的任务状态；运行中的空检查点显示准备/思考，只有明确终态失败才报错，并保留真实原因。
3. 完成、失败、取消状态可靠收敛 loading/streaming；完成后客户端队列自动派发。
4. 加入旧 media 任务 + 新 chat 的整链路回归、检查点/任务事件交错、思考无正文、刷新及真实失败原因回放。
5. 发布后在同一线上地址实测普通文本、工具调用和连续排队，确认不误报、不永远生成、不需刷新恢复。

## 后续实施：状态修复与按会话归档（本地已验证，未部署）

用户确认上传文件按会话分类。本轮已实现：

- taskDto 将历史 media 执行器投影为当前 node 协议值，保留原任务记录。
- 会话订阅与分页传递 tasks，消息转换结合任务状态；正在思考的空检查点保持 streaming，不报失败；真正失败保留具体原因和已有正文。
- 完成时收敛 loading/runningIds，并派发排队消息；补充快速完成先于 submit 返回、刷新恢复队列的处理。
- 资料库按「聊天附件 / 会话标题 / 原文件名」归档已提交的普通 Chat 附件。来源包括历史用户消息和受理后的任务输入，因此模型失败也能保留附件；未发送的草稿不归档。
- 使用独立的会话/文件收据避免重试重复复制；同名会话与文件自动消歧，账号隔离，删除或移入废纸篓后不从聊天历史复活。数据库初始化增加 chat_resource_roots、chat_resource_sessions、chat_resource_attachments。

验证通过：

```
node --import tsx --test scripts/test-chat-live-state.mjs scripts/test-session-model.mjs scripts/test-session-queue.mjs
node --import tsx scripts/test-chat-resource-attachments.mjs
node --import tsx scripts/test-resource-folders.mjs
node --import tsx scripts/e2e-chat-live-state.mjs
npm run build
```

完整页面 E2E 使用真实 API、SQLite、上传和生产应用组件，仅模型 HTTP 为受控响应。覆盖旧 media 任务、延迟思考、DOM 误报监听、连续两轮自动排队、终态停止按钮消失、刷新、资源库进入会话文件夹。

截图证据：`/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-live-state-6ieZvG/{thinking-and-queue,session-attachments}.png`。

首次 E2E fixture 缺 nonce、随后等待了非流式思考按钮及落在100ms持久化节流内的单个思考块，均修正测试设置后完整通过；没有放宽业务断言。工作目录另有并发附件模型读取和历史恢复 UI 改动，本轮未覆盖。服务器仍待统一发布和真实模型复验。
