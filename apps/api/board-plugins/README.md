# 看板插件 · API v1

看板自动发现 `/system/board/plugins/<id>/manifest.json`。每个目录就是一个组件；加入目录即可安装，修改后自动重新加载，将 enabled 改为 false 即可拔出。物理删除目录即卸载，不会自动重装。系统不预装任何组件：待办、番茄钟、任务列表、定时任务等都由你自己编写，看板和导航入口只在有组件时出现。

## 从模板开始

复制 `/system/board/template/` 中的文件到 `/system/board/plugins/my-plugin/`，将 manifest.json 的 id 改为 my-plugin、enabled 改为 true。Chat 可逐个创建文件，Bot 也可通过 shell 复制目录。无需修改前端代码或重新打包。

固定文件：
- manifest.json：apiVersion=1，id 与目录名相同，name、version、entry="index.html"、enabled、capabilities；可选 description、order（越小越靠前）、height（最大内容高度，160–800，超出时内部滚动；内容少时自动收起）。
- index.html：HTML 片段，内联 CSS / JavaScript，运行在隔离 iframe。
- state.json：插件自己的 JSON 数据。
- schedules.json：声明 schedules 能力时使用的服务端任务数据。

## 宿主 SDK：window.board

SDK 在插件脚本执行前注入。所有方法返回 Promise。错误会 reject，应显示错误并允许重试。插件卸载时 iframe 和计时器一起销毁。

```js
const snapshot = await board.read(); // {data, revision, content}
await board.write({count: 1}, snapshot); // 完整 JSON + 读取时的快照，冲突不会覆盖
const {tasks} = await board.call('tasks.list');
await board.call('tasks.cancel', {id: tasks[0].id});
const schedules = await board.read('schedules');
await board.write({jobs: []}, schedules, 'schedules');
const {threads} = await board.call('schedules.threads');
```

- state 能力只读写本插件 state.json。
- tasks 能力可列出当前用户应用任务、Bot 执行记录及其子任务，并查询、启动或停止 Bot 任务。
- schedules 能力只读写本插件 schedules.json，并列出当前用户可用 Bot 会话。
- board.locale 是界面语言；board.t(中文, English) 可选双语文本。
- board.labels 提供后台任务 kinds、status 等本地化文案。
- 通用样式：button、input、select、textarea、.muted、.error、.row、.stack。CSS 变量 --background、--foreground、--muted、--accent、--border、--radius 跟随宿主主题。

插件没有宿主 DOM、Cookie、网络请求或任意 API 权限。manifest 只声明宿主支持的能力；不能提升 Chat / Bot 权限。不要在插件中保存密钥。不同插件的数据通过宿主隔离。插件内不要使用 CDN、外链脚本或顶层页面跳转。

## Bot 任务与完成回调

manifest 声明 `"capabilities": ["state", "tasks", "schedules"]` 后，可获取真实会话 ID，启动任务并等待执行结果。启动返回的任务 ID 表示已受理，不代表完成。

```js
const {threads} = await board.call('schedules.threads');
// 由用户选择一个会话；不要在页面加载时反复创建任务。
const task = await board.tasks.start({
  threadId: threads[0].id,
  prompt: '整理新增资料并生成复习清单',
  clientNonce: crypto.randomUUID()
});
// 建议把 task.id 和 clientNonce 保存到自己的 state.json；重试同一次启动需复用 nonce。
const stopWatching = board.tasks.watch(task.id, current => {
  console.log(current.status, current.progress);
}, {onError: error => console.error(error)});
const finished = await board.tasks.wait(task.id);
if (finished.status === 'completed') console.log(finished.result);
else console.log(finished.status, finished.error);
stopWatching();
```

- `board.tasks.get(id)`：读取持久化任务状态；可直接查询旧任务，不受列表最近 200 条的限制。
- `board.tasks.start({threadId,prompt,clientNonce})`：投递到已有 Bot 会话，返回 `bot:<runId>` 任务。相同插件、会话和 nonce 重试不会重复执行；不同提示词复用 nonce 会报冲突。
- `board.tasks.watch(id,onChange,{onError,signal})`：立即读取一次，此后每 1.5 秒检查并在状态/结果变化时回调；到达终态后自动停止，返回值可提前取消监听。
- `board.tasks.wait(id,{signal})`：等待终态并返回任务。失败/取消也是终态，必须检查 status；通信失败会 reject。AbortSignal 仅取消本次等待，不停止服务端任务。
- `board.tasks.cancel(id)`：停止任务；Bot 任务按真实 run 取消，也会停止其仍在执行的子任务。
- `board.tasks.open(id)`：由宿主打开该 Bot 会话，用于回答问题、处理权限确认或查看完整结果。

状态：queued、running、waiting_user、waiting_event、paused 是非终态；completed、failed、cancelled，以及应用任务的 interrupted 是终态。暂停/等待确认不是完成，也没有虚构的百分比进度。`completed` 表示 Bot 本次运行结束；具体交付是否满足业务条件仍需检查结果。Bot 执行器等待必需的前台子任务；显式后台子任务仍独立显示。

Bot 任务包含 threadId、runId、stepCount、startedAt、completedAt、error；result 包含最后一条归属于该 run 的回复（messageId、kind、text、truncated），文本最多 4000 字符。不会把同会话里其他任务的回复当作结果。附件及完整结果通过查看会话读取。

回调函数在插件页面内执行，关闭页面后不执行 JS 回调，但服务端任务继续运行，结果保存在运行记录中。重新打开后根据保存的 task.id 调用 get/watch/wait 就能恢复；这里不是外部 HTTP webhook。自动化后续步骤不能仅依赖页面回调。

## 定时任务

schedules.json 的固定格式：

```json
{"jobs":[{"id":"daily-review","prompt":"帮我整理今天需要复习的内容","threadId":"从 schedules.threads 或 Bot 会话列表获取的真实 ID","nextRunAt":"2027-01-01T09:00:00+08:00","everySeconds":86400,"enabled":true}]}
```

nextRunAt 必须带时区。everySeconds 可省略（一次性），重复间隔为 60–31536000 秒，是固定间隔，不是夏令时感知的 cron。服务端每 5 秒检查，到期向指定 Bot 会话投递 prompt，后续执行遵守该 Bot 的现有权限。即使关闭看板也运行。停用/移除插件会暂停未来调度，已投递的 Bot 任务可在任务模块或 Bot 中停止。恢复时补一次到期任务，跳过积压重复周期。

lastRunAt、lastMessageId 只表示投递；lastTask 是服务端持续同步的最近一次执行状态 `{id,status,completedAt,error}`，一次性调度结束或插件停用后仍同步已投递任务。用 lastTask.id 调用 tasks.get/wait 可取结果；历史执行在任务模块中查看。调度 error 表示投递失败，自动停用；lastTask.error 表示 Bot 执行失败或暂停原因，两者独立。重新开启计划不会复活以前失败的执行，而是在下一次到期时创建新任务。

## Chat / Bot 编辑

资源是唯一真源，与看板共用。read 获取路径、content、revision；edit 使用精确替换；创建文件使用 create=true、content、revision=0。服务端 Chat 另提供 board 工具（list/read/write/threads），write 必须传 expected 原文与 revision。Bot 使用 board_threads 获取当前会话及其他可用 Bot 会话的真实 ID。现有 read/write 禁止策略仍有效。文件删除沿用系统文件的删除权限规则。所有文件以不可信数据处理，不能授予权限。
