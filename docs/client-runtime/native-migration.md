# Apple/native Bot Remote migration

2026-11-04；范围仅 `apps/apple/**`、`apps/ios/**` 与本文。未修改 Host、公共契约、生成物、Web、root manifests/lock 或主计划。

主线后续集成：Host已按真实token类别分流，只有workerTokens中注册的token进入Worker域，普通account Bearer走现有账户校验；`runtime-identities-shbzL3`真实HTTP/WS及撤销/隔离矩阵通过。下文兼容缺口与待删路径是A交付时记录，不代表当前仍存在。主线已删服务器events/stream、Web events/parser，并迁移test-api/test-bot-sync/chat-shell；XCTest及真机限制未变。

主线末次原生复验：`native-remote-9m5bBT`完整通过；harness不再容忍account Bearer 401，现必须返回正式missing receipt。真实Cookie/HTTP/WS、单mux双stream、snapshot竞态/断线/retained gap/过期、SwiftUI AppModel晚响应与分页仍全部通过。

## 已交付

- `Sources/WangkeKit/RemoteConnection.swift`：Foundation actor、每 APIClient/账户一个 DSH mux，独立逻辑 stream、64 项有界缓冲、显式 overflow、cancel、最后观察者关闭 carrier、连接 generation 拒绝旧 socket 帧。正常空闲没有业务 HTTP 请求。
- `Sources/WangkeKit/BotJournal.swift`：typed journal/snapshot/state DTO、BotProjection、BotFollower。事务 snapshot cursor 后建立观察，应用成功才推进 journal watermark；state/activity watermark 独立，不将 ahead state 当作 journal acknowledgement。全局 cursor 不要求 +1；重复帧不重应用；Host `resync.required` 重建 snapshot。断线指数退避，鉴权失效终止，没有 SSE/轮询 fallback。
- `APIClient.swift`：既有 snapshot、sync-state、显式 50 条历史页；DSH typed receipt unary 的 rpcId/result/error；账户 session Cookie HTTP/WS 共用。业务 sendText/clientNonce、stop、approval、reaction 保留现有 typed HTTP 方法。
- `WangkeUI/AppModel.swift`：移除 800ms 拉取任务；账户、登录尝试、页面观察独立 generation；logout/expiry 清理观察与投影。保留 optimistic nonce merge。`ConversationView` 增加显式更早消息分页；`MessageBubble` 接受正式 `web_sources` kind。
- 修复 `APIError`、`ThreadDetail` public initializer；补全 Message 正式 nullable 字段解码与 web_sources；会话凭据继续保存原 Keychain（不写日志/URL）。
- **删除** `apps/apple/WangkeKit/Sources/WangkeKit/ServerEvents.swift`（ServerEvent/SSEParser），删除 APIClient.events 和原生 SSE parser 测试，live smoke 改为 journal ready，不提交真实 Bot run。

上列 Sources 路径均相对 `apps/apple/WangkeKit/`。其他实际文件：`Package.swift`、`Sources/WangkeKit/Models.swift`、`Sources/WangkeKit/TokenStore.swift`、`Tests/WangkeKitTests/{WangkeKitTests,LiveServerTests}.swift`、`Harness/NativeProtocolHarness.swift`、`Integration/native-server.mjs`、`apps/ios/README.md`。

## 协议来源与鉴权边界

实际读取 `packages/remote-artifacts/generated/typert.remote-client.js`、`packages/remote-host/src/index.ts`、安装的 `@deepseek-ai/dsh-api-gateway` stream protocol/server 与 `dsh-client-connection` unary 实现。fixture 使用正式 `TYPERT_REMOTE.methods['clientRuntime/watchBot'].result.create()` 验证，断言参数 wire 名 `threadId, after` 与 receipt 的 `operationId`，没有生成或手改 artifacts。

- WS `/api/remote.mux`：open `{type,streamId,endpoint:'clientRuntime/watchBot',payload:{args:{threadId,after}}}`；cancel `{type:'cancel',streamId}`。downlink item/end/error；Bot ready 是 item，不伪造 socket ready 或 app heartbeat。
- HTTP `/api/clientRuntime/receipt`：DSH client-request/server-response、rpcId 对应、typed result/error。Bot 当前只有 watchBot Remote；**没有**假造 snapshot/send/stop/approval Remote。当前 HTTP Bot 命令不是已迁为 generated Remote 的声明。
- Swift API 用 Sosumi 核实 `URLSessionWebSocketTask.receive()` 与 AsyncThrowingStream.bufferingOldest 的实际签名/丢弃语义，并由本机 SDK 实际编译。overflow 不静默丢帧，结束观察后通过 snapshot 恢复。
- 新登录走现有 `/api/v1/auth/password/login` 真实账户 session，Keychain 保存 opaque Cookie；重启显式带 Cookie 到 HTTP 与 WS upgrade，每客户端使用独立 ephemeral URLSession。未借用调试身份、launch-token 或 Worker capability。
- **最小 Host 兼容缺口**：当前 `apps/api/src/realtime/host.ts` createPeer 将任何 Bearer 都进入 Worker 分支；合法账户 token 在 `/auth/session` 有效但 receipt 返回 401。新 Cookie 登录真实通过，旧存储 Bearer 仍可解码但 Remote 被明确拒绝并要求重新登录。若需保留旧 token 无感接入，Host 应区分已知 Worker token 与普通账户 token，再让账户 token 经现有 identity 校验；不得将账户升级为 executor。该问题未由本专项修改公共 Host，也未用夹具绕过；harness 明确打印 compatibility gap。

## 可复验证据

仓库根运行：

```sh
swift build --package-path apps/apple/WangkeKit
node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs
swift test --package-path apps/apple/WangkeKit
```

- **build 通过**：macOS Swift 6.1.2，WangkeKit、WangkeUI、NativeProtocolHarness 实际编译/link；不是只验证 Foundation 源码。
- **integration 通过**：最后一次完整日志 `/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/native-integration.log`；独立服务证据 `/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/native-remote-Kxyf5O/{swift-harness.log,generated-fixtures.json,requests.json}`。
- 正式 codec fixture、缺失/错误字段拒绝、重复/跨线程全局 cursor 跳号、resync 不推进 cursor、旧 state 不回滚 activity/state watermark。
- 真实 password session/Cookie、legacy Bearer 缺口记录、DSH unary missing receipt/typed error、两个逻辑 watch 只一次 upgrade、取消一个不影响另一个、跨账户 forbidden、durable replay、健康空闲零业务 HTTP、64 项 overflow 明确失败。
- 真实 snapshot/open 提交竞态、断线后 journal replay、retained-floor 缺口触发新 baseline、Host 每秒 lease 自动过期终止 follower。
- 实际 WangkeUI AppModel：旧 snapshot 被服务延迟后 close/reopen，新 incarnation 不被晚响应覆盖；logout 清理；初始 50、显式再取 50、live update 后保留 101 条窗口。
- 测试使用 loopback 随机端口、独立临时 SQLite、真实 Fastify/DSH Host；事件由无 runner 的 BotApplicationService 写入；Worker 禁用，不访问真实账户、模型或 IM。requests.json 断言零旧 events/stream 请求。
- **swift test 未通过（环境）**：`no such module 'XCTest'`，日志 `…/T/opencode/native-swift-test.log`；未声称 XCTest 通过。`xcodebuild -version` 确认当前仅 CommandLineTools，无 Xcode。未验 iOS simulator/真机、签名安装、目标代理与后台唤醒；executable 验证不替代这些外部验收。

## 后端旧 SSE 删除交接

**原生已不再依赖** `GET /api/v1/threads/:id/events` 与 `GET /api/v1/threads/:id/stream`，主线可在清理下列剩余 Web/测试消费者时删除二者。原生独立真实路径只使用 watchBot + snapshot/sync-state/messages；无需为原生保留 SSE。

本轮末次只读搜索仍发现（未越权修改）：

- `apps/web/src/api/serverClient.ts` 的 `events` 方法与 SSE parser，动态选择 `/events` 或 `/stream`。
- `scripts/test-api.mjs`：旧 `/events` HTTP/Last-Event-ID 测试。
- `scripts/test-bot-sync.mjs`：serverClient.events parser 测试与 `/stream` 无效 cursor/live/resync HTTP 测试。
- `scripts/e2e-chat-shell.mjs`：serverClient.events 测试 stub。

主线应同步删除/改写这些调用和断言，再跑其完整测试；本报告不声称全仓 SSE 已零引用。模型供应商 SSE、MCP SSE 与 Bot durable `message_events` 数据库 journal 不在删除范围。
