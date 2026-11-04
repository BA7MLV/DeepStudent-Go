# iOS 壳层

原生 SwiftUI App，只做两件事：**登录**和**把后端的数据渲染出来**。所有数据（线程、消息、审批）都来自后端 API，App 本身不存业务数据，也不直连模型服务。

## 目录

```
apps/
├── apple/WangkeKit/          # iOS 与 macOS 共用的 Swift 包
│   ├── Sources/WangkeKit/    # Foundation：共享 Remote mux、Bot journal/model、账户 API、消息分组、钥匙串
│   ├── Sources/WangkeUI/     # SwiftUI：登录页、线程列表、iMessage 式对话、输入栏
│   └── Tests/                # 单元测试 + 对真实后端的联调测试
└── ios/
    ├── project.yml           # XcodeGen 工程描述
    └── WangkeAgent/          # App 入口（十几行）和资源
```

以后加 macOS 壳层：新建 `apps/macos/`，同样依赖 `WangkeKit` 和 `WangkeUI`，入口里把 `ThreadListView` 换成 `NavigationSplitView` 即可，登录、网络、气泡、输入栏全部复用。`WangkeUI` 里平台相关的地方已经用 `#if os(iOS)` 分好了。

## 跑起来

需要 Xcode 15 或更新（iOS 17 SDK）。

```bash
brew install xcodegen
cd apps/ios
xcodegen            # 生成 WangkeAgent.xcodeproj（不进仓库）
open WangkeAgent.xcodeproj
```

选一个模拟器运行。登录页填：

- 服务器地址：比如 `https://agent.example.com`，或者局域网里的 `http://192.168.1.10:3000`（只放行了局域网 http，公网必须 https）；
- 访问密码：网页端初始化时设置的密码，无需填写账号。忘记密码可在网页登录页查看 Passkey 登录或服务器终端重设说明。

后端需要现有账户 password/session API、Bot snapshot/sync-state 和 `/api/remote.mux` 的正式 DSH `watchBot`。不兼容旧的仅 SSE 服务端，也没有静默降级。

## 鉴权

- 新登录调 `POST /api/v1/auth/password/login`，将真实 `wangke_session` HttpOnly Cookie 值连同服务器地址保存到原钥匙串（`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，不随 iCloud 同步）。原生可读取 Set-Cookie；不会将凭据放入 URL、日志或 UserDefaults。
- HTTP 与 WebSocket upgrade 使用同一个账户 session；每个 APIClient 的 URLSession 隔离，不借用全局浏览器 Cookie。重启从钥匙串恢复显式 Cookie，不依赖进程 Cookie jar。
- 退出通过原 `POST /api/v1/auth/logout` 撤销 session；Host 自动关闭过期流后，客户端通过实际 `/auth/session` 判断失效并终止重连。关闭页面只取消逻辑观察，不调用 Bot stop。
- 旧钥匙串的 Bearer 格式仍可解码。当前 Host 若仍把所有 Bearer 当 Worker，旧凭据会被明确拒绝并要求重新登录（生成账户 Cookie），不会 fallback SSE 或伪造 executor token。最小 Host 兼容请求见 `docs/client-runtime/native-migration.md`。

## Bot 连接

同一账户/APIClient 的多个逻辑 `watchBot` 共享一个 DSH WebSocket。先读取事务 snapshot 的消息与 eventCursor，再从该 cursor 打开 journal，重放 snapshot/open 竞态中的提交。仅在应用事件后推进 cursor；保留缺口通过 Host 的 `resync.required` 显式重建，不假设跨线程全局 event_id 连续。断线退避重连，无健康连接业务轮询、SSE 或轮询 fallback。初始 50 条，显式“更早的消息”分页，不再调用无界线程详情作为订阅基线。

## 界面

按 iOS Messages 的规则：

- 自己的消息靠右、系统强调色；Bot 靠左、系统灰（`systemGray5`，深浅色自动适配）。
- 同一方 2 分钟内的连续消息算一组，组间 10pt、组内 2pt，只有每组最后一条带尾巴；相隔 15 分钟以上才插一行时间。规则和网页端 `src/pages/botMessages.ts` 一致，`MessageGrouping` 有单测。
- 进度消息显示成「正在输入」三个点；审批消息里直接是「拒绝 / 批准」；附件显示文件名和大小；双击 Bot 的气泡点赞。
- 输入栏是胶囊形，`TextField(axis: .vertical)` 自动增高到 8 行后内部滚动；有字时发送键弹出。中文输入法组字由系统处理，不会误发。
- 消息列表是 `LazyVStack`，长线程只创建可见的行；默认停在底部，新消息到达时滚到最新。
- 没有副标题和说明文字。

## 测试

`WangkeKit` 不依赖 UIKit / SwiftUI，在 macOS 和 Linux 上都能跑：

```bash
cd apps/apple/WangkeKit
swift build                                  # 包含 macOS WangkeUI 的真实编译
swift test                                   # 有 XCTest SDK 时跑分组/解码/journal/请求测试

# 可选账户 smoke：不发消息、不触发模型/IM；只对明确授权的服务运行
WANGKE_E2E_URL=http://127.0.0.1:3000 WANGKE_E2E_PASSWORD='管理员密码' swift test --filter LiveServerTests
```

没有 XCTest/模拟器时，仍可执行原生专项（从仓库根目录）：

```bash
node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs
```

它启动独立临时 SQLite/Fastify/DSH Host（loopback 随机端口），消费正式生成 codec 夹具，并编译运行 Swift executable。真实验证 Cookie、Remote unary、共享 WS、回放、snapshot/open 竞态、缺口重建、慢消费者、取消、重连、自动过期与实际 AppModel 的晚响应代际隔离。事件由不含 runner 的 BotApplicationService 写入，不调用真实模型/IM。证据与当前边界见 `docs/client-runtime/native-migration.md`。

## 现状说明

- 本轮 macOS Swift 6.1.2 已实际编译 WangkeKit/WangkeUI 与 executable harness，修复跨模块初始化器可见性；旧 Linux 测试记录不当作新协议的通过证据。
- 当前命令行工具链没有 XCTest 模块；`swift test` 的实际失败已记录，替代 executable harness 并非宣称 XCTest 通过。未运行 iOS 模拟器、签名安装或真机网络/后台恢复。
- 附件上传、Passkey 登录、扫码配对还没做，按需求只实现了登录和渲染。
