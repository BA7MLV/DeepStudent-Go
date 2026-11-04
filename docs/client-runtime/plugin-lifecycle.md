# Plugin renderer 生命周期与边界

本专项使用锁定的 `@deepseek-ai/cordis@4.0.6-alpha.1`（DSH `0.2.2-alpha.2`）。调用前查询 Context7 Cordis 文档，并逐项核对安装包 `src/{context,registry,fiber,reflect}.ts`；以实际锁定源码为准，不套用旧版 `fork()` API。

## 生产所有权

```
committed usePluginRenderer effect → shared renderer Cordis root
  → account(server + account)
    → project(context project / account seat)
      → instance(plugin + instance + package revision)
        → placement(layout placement identity)
          → committed occurrence fiber (unique incarnation)
            → HTML observations / native projection subscriptions
```

`client/plugin-scopes.ts` 的 Map 只索引真实 Cordis fibers 与引用数，不实现第二套 DI/资源容器。每层通过 `ctx.plugin` 创建 fiber、`isolate/provide` 提供身份 token；occurrence 通过真实 `inject` 声明四层依赖。观察 disposer 由 `ctx.effect` 收集、逆序释放。底层 ClientRuntime 仍拥有唯一 account 连接及业务 Model，没有重建 runtime/model 容器。

同实例三挂载只增加 placement/occurrence，业务 source 仍按 account/instance/query 复用。原生 projection 仍由 DSH `keyedHooks` 的 selector/uSES 桥绑定；新增 scoped source 包装只给该次 committed occurrence 的订阅添加 Cordis effect 所有权，不复制业务快照。projection source 描述符本身不 retain。

## 提交、撤销与异步

- 只有 committed effect 创建 renderer 和 scopes。StrictMode replay 的旧 lease 幂等释放；未提交 Suspense/concurrent 子树不创建任何 Cordis root。
- account/project/instance/revision/placement 改变时，不用旧 lease 渲染新身份。每个 occurrence 有唯一 incarnation，包 revision 改变重新激活。
- 旧 lease 在发起 command 前、结果返回后重新检查；观察回调亦检查 lease。停止后迟到响应不得进入新视图。已提交的后端任务不被撤销。
- manifest unavailable/error/disabled/uninstalled 时不 retain scope；恢复时分配新 incarnation。生产 catalog 已消费服务端 dependency availability 投影，客户端不发明新的权限真相。
- account 结束事件立即使全部旧 scopes 无效并释放观察；服务端权限和每次调用校验仍是权威。
- Cordis disposer 的运行时单次语义可能让第二次调用返回 `undefined`（即使声明写 Promise）；适配层使用 `Promise.resolve`，不在返回值上直接调用 `.catch/.finally`。
- 视图 ErrorBoundary 显示保留数据的错误提示；按 incarnation 重新激活可恢复。诊断只计失败，不采集异常内容/私密参数。

## HTML 与 placement 草稿

HTML 仍是 sandbox 数据，不加载为 Cordis/React contribution。CSP、iframe source/channel、文档 generation、请求与观察配额以及服务端授权不放宽。

HTML 草稿 key 包含 server/account/project/plugin/instance/placement/material；原生练习/复习接收 renderer 的不透明 `draftIdentity`，不同 placement 不共享答案草稿。业务模型 key 不包含 placement，避免把输入草稿变成业务事实。

宿主销毁文档时，SDK 显式拒绝 pending unary 与 task wait (`plugin_scope_expired`)、清除请求 timeout 与观察回调。取消 wait/watch 只撤销观察，绝不调用 `tasks.cancel`。已受理任务及持久收据保持独立生命周期。旧文档晚响应只能返回旧 captured iframe/channel，不能写入新 sandbox。

## React/transport 边界

- `PluginHost/Slot/Actions/Page/Message/Navigation` 继续使用 typed Slots。业务视图只收到 hook/props/callback，不收到 ctx、transport 或 source 对象。
- 旧菜单目录 hook 的 uSES 桥移到 `client/plugin-renderer-hooks.ts`。`plugins/catalog.ts` 仅保留 bare source/平台 acquisition；React hooks 不在 source 内绑定订阅。
- 原 `shared/availability/legacy-actions` 不再直接 import serverClient。HTML asset 保留独立 HTTP；目录走 typed catalog read；旧 named actions 走生成命令/持久 operationId，不用旧 actions URL。
- **明确剩余协议 seam：** plugin layout 管理仍由 `client/plugin-renderer-commands.ts` 调用现有 `/plugins/layout` CAS endpoint；Host 尚无 typed layout mutation。没有虚构新契约或手改生成物。主实施者若要关闭该传输旧路径，最小需要一个 typed `savePluginLayout({content, expected, revision, operationId})` 管理命令，返回 SystemDocument，并沿原账户/CAS授权。

## 开发诊断

从 `client/plugin-renderer.tsx` 调用 `pluginLifecycleDiagnostics()`：renderer refs/contexts；各层 scopes、fiber state/incarnation/refCount、occurrence retain、active observations、created/released/failures/observationReleases；catalog listener/retain/refreshWaiter/generation/status；已释放 renderer 的累计计数。`pluginRendererDiagnostics()` 旧形状保留，便于现有门禁。

输出不含账户 ID、server URL、scope 名称、任务参数、草稿、凭据或原始错误。业务 Model/连接的 stream refs/generation/revision 继续由既有 ClientRuntime.diagnostics 提供，不复制诊断事实。

## 可复现专项矩阵

各浏览器脚本自行创建 loopback Vite/Fastify 端口与独立临时数据，不操作用户服务或生产。

| 命令 | 覆盖 |
| --- | --- |
| `npx tsx scripts/test-plugin-scopes.mjs` | 真实 Cordis 四层共享/placement 分离、incarnation、旧异步回调、account invalidation、真实 provide/inject 依赖撤销恢复、100 次循环、幂等 disposer、诊断脱敏 |
| `npx tsx scripts/e2e-plugin-renderer.mjs` | 生产 PluginHost→typed Slots→ScopedPluginView、StrictMode、100 次 committed 挂载归零、同 instance 三 placement、disabled/re-enable、账户替换、ErrorBoundary/revision 恢复、未提交 Suspense 无资源 |
| `npx tsx scripts/e2e-plugin-frame-lifecycle.mjs` | 生产 PluginFrame+正式资料笔记 HTML、100 次 resize/save/卸载、pending unary/task wait disposal 拒绝、晚 unary 释放、无 tasks.cancel、观察回基线 |
| `npx tsx scripts/e2e-plugin-catalog-model.mjs` | 真实 Fastify/HTTP/共享WS+生产 catalog/Host/todo/tasks/flashcards、三挂载共享、外部状态/学习收据更新、正式命令、task观察取消、各 slice 60秒零 HTTP、100 次 catalog 释放 |
| `npx tsx scripts/e2e-plugin-renderer-commands.mjs` | 生产目录读取、layout CAS、named action 经正式 typed command、旧 CAS 拒绝；不调用旧 actions URL |
| `node scripts/test-plugin-renderer-boundaries.mjs` | 新专项内所有 plugin TSX 的 transport/db/Cordis/source 禁入；含违规负例，不改全仓边界脚本 |
| `npm run typecheck -w @wangke/web` | 应用类型检查 |

本轮上述专项均已运行通过。scoped native source 接线后的真实 model 矩阵也已通过（shell `sh_1a20b0dda001ss2Pi637d49lBT`）；最终 iframe 独立 placement 草稿与 disposal 负例通过（`sh_1a20dbff70010pw0QPGTpFAb7j`）。command seam 的网络/结果证据：`opencode/plugin-command-seams-xmQTcf/evidence.json`（位于获批临时目录）。renderer 故障注入有一条预期的 React caught TypeError 控制台栈，断言 ErrorBoundary 展示、失败计数及 revision 修复；不是宣称控制台无错误。

保留开发失败事实：新增 command seam 测试首次将正式 endpoint 错写为 `/api/remote.call/clientRuntime/command`，业务/CAS/结果断言已过但网络断言失败；核对实际 Host 路由 `/api/:namespace/:method` 后修正为 `/api/clientRuntime/command`，完整重跑通过。scope 单测初次暴露 disposer 二次调用 undefined，修复 Promise.resolve 后完整通过。并行实施期间一次 Web 类型检查暴露非本专项 `cloud/preferences.ts` 的类型错误；未越界修改，主实施者修复后最终应用类型检查通过。

没有反复执行完整插件长回归，没有提交/部署。Safari/PWA/真实代理及全应用性能仍属于主计划验收，不由本专项声称关闭。
