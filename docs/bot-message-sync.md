# Bot 消息加载与同步：阶段实施记录

2026-11-01；本地 macOS、Node 26.3.0、隔离 SQLite、Playwright Chromium。没有调用真实模型、发送真实 IM、迁移生产库、提交或部署。工作区包含其他任务的并发改动。

## 已实施

- 顶栏保留渐进模糊、完整名称的视觉省略与悬停查看；动作按钮不被长 IM 名称挤走。
- 新能力标识 `bootstrap/status.botSyncVersion = 1`。旧全量详情、有限 `/events` 与 `/state` 接口保留。
- Bot 消息首屏为同一读事务内的快照与持久事件水位；消息按 `seq` 前向排序、向历史使用排他 `beforeSeq` 游标。默认 50、最大 100 条；正文目标 512 KiB，允许一条完整超长消息，不截断 Markdown/附件信封。助手 progress 不进入历史页。
- 会话摘要使用 `updatedAt DESC, id ASC` 复合游标，默认 50 条；指定旧会话可独立查询 summary，不必追完列表。
- 快照包含窗口内交互与所有待处理交互；活动 run 不受“最近 20 条”限制。轻量状态查询支持已加载消息区间。
- schema 30 的 SQLite triggers 在 run、审批、问题、标题/归档变更的写事务内产生 `thread.state_invalidated`。不依赖 best-effort 通知，不改变 Bot/IM 执行和交付语义。
- 新 `/stream` 长连接先补齐持久事件，再持续推送。共享 250ms 数据库补漏、每批最多 64 个事件、最多 64 条连接、15 秒心跳/慢连接期限、`drain` 背压、登出/撤权校验、服务 drain 清理。
- Bot 专用内存缓存按服务端/账号隔离；目标 8 会话/16 MiB 正文估算，活动窗口约 1,000 条。未确认发送不淘汰。历史裁剪后明确标记有较新消息，不把断开的区间拼成连续历史；回到最新时重取最新页。
- ID/nonce 去重，保留未变消息和行引用；状态失效合并刷新，不因 progress 重拉历史；不可逆的审批/问题终态不被晚到 pending 回滚。
- 隐藏/离线关闭流，恢复按事件水位续传；指数退避、Retry-After、45 秒读取超时、有界重同步。旧 API 明确走兼容路径，保留轻量轮询；新增审批因旧接口限制可能额外读取一次详情，不适用新协议零全量请求指标。
- 前插历史和切回缓存会话恢复 keyed 像素锚点；独立新消息播报；消息级富内容错误边界；鉴权图片 URL 复用、引用计数、TTL/容量回收和登出清理。草稿及上传重试仍由 Workspace 管理。

## 新接口

- `GET /api/v1/threads/page?projectId=&cursor=&limit=`
- `GET /api/v1/threads/:id/summary`
- `GET /api/v1/threads/:id/snapshot?beforeSeq=`（重同步可读取原阅读范围）
- `GET /api/v1/threads/:id/messages?beforeSeq=&limit=`
- `GET /api/v1/threads/:id/sync-state?fromSeq=&toSeq=`
- `GET /api/v1/threads/:id/stream?after=`，也接受 `Last-Event-ID`

所有读取先做用户/线程鉴权。游标只定位，不赋予权限。新 API 先于新 Web 发布；生产发布仍需单独授权。没有清理历史事件；未来引入物理事件保留策略时还需配套最低保留水位协议，不能静默跳过事件。

## 实测

`npm run test:bot-sync:e2e`：真实 Web + API，确定性 10,000 条混合高度文本，快照后/订阅前注入消息、500 条 progress、历史前插、上翻收消息、会话切回、离线补齐。

| 指标 | 结果 |
| --- | ---: |
| 已存历史 | 10,000 条 |
| 首屏消息 | 50 条 |
| 首屏快照 | 15,872 bytes |
| 首次 DOM 消息行 | 17 行 |
| 健康连接空闲 60 秒 HTTP 轮询 | 0 |
| 500 条 progress 引发的快照/状态重拉 | 0 |
| 旧全量 thread GET | 0 |
| 历史前插锚点偏移 | 0 CSS px |
| 缓存切回锚点偏移 | 0 CSS px |

截图及 JSON：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/bot-sync-web-EeS3M0/evidence/`。该运行覆盖 1440/390/320px；不是延迟/吞吐或真机性能基准。

`npm run test:bot-sync` 的固定短文本夹具，各额外包含 60 条历史 progress：

| 可见历史条数 | 新快照 bytes | 旧全量消息数组 bytes |
| ---: | ---: | ---: |
| 1 | 800 | 14,568 |
| 100 | 12,786 | 38,823 |
| 1,000 | 12,890 | 260,734 |
| 10,000 | 12,994 | 2,497,295 |

比较的是新快照与旧接口的消息数组（不是完整旧响应），仅证明载荷随窗口而非全部历史增长；不能推导响应时间或费用节省百分比。

## 验证状态

通过：

- `npm run test:bot-sync`：7 组（分页/字节边界、事务回滚与重开、nonce/终态、稳定行/图片回收、持续流与背压、分片 SSE、真实 HTTP 鉴权/游标/登出）。
- `npm run test:bot-ui`：10 项。
- `npm run test:bot-composer:e2e`：图片、草稿、粘贴/拖拽/发送/展开、渐进模糊与长 IM 标题，1440/901/760/390/320px。
- `npx tsx scripts/test-bot-migrations.mjs`：空库及六种历史布局、两次启动、原加密密钥与审批/队列/游标保留、局部坏库拒绝。
- `npx tsx scripts/test-bot-continuity.mjs`、`npx tsx scripts/test-api.mjs`。
- contracts 构建、Web/API 类型检查、`npm run build:web`（保留现有动态导入及生成 CSS 警告）。

未全绿，不能当作完整发布验收：

- `npm run test:bot` 的失败事件计数已区分同步失效与会话事件；随后在旧错误码断言遇到 `model_incomplete_response` 对 `invalid_structured_response`，与同时进行的模型 Gateway 改造交叉，未修改该错误码断言。
- `scripts/test-gateway-review.mjs` 的前七组通过，视觉工具场景报 `model_capability_unavailable`；保留失败，未改变本轮之外的模型配置/能力逻辑。
- 普通问答 `scripts/e2e-chat-virtual.mjs`：1,000 条窗口、前插、触顶及全部分页无缺失重复通过；旧 `.reasoning-chain__blur--top` 选择器不存在而失败（项目已有同项待办）。修复测试自身 loadingOlder 空转导致 IndexedDB 饥饿的问题，没有移除后续断言。
- `scripts/e2e-chat-scroll.mjs` 在“回到最新后恢复跟随”超时，当前/HEAD 虚拟列表对照未完成；不能归因或声称完整共享滚动回归通过。空列表提前定位已限定为 Bot 显式选择，普通问答默认路径保留。

## 尚待完成的 P0/P4/P5

- 分组目前保留稳定行并复用时间格式器，但消息变化时仍扫描整个有界窗口；进一步实现局部边界派生。
- 在浏览器完整压测 8 会话/16 MiB、连续超过 1,000 条历史的裁剪/反向恢复、待确认发送保护与账号切换；正文预算是估算且保护活动/发送，不能视作严格堆内存上限。
- API 进程重启期间的端到端补齐；完整新 Web/旧 API、旧 Web/新 API 交互矩阵；失败页重试、资源异步变高、富内容分包失败后的真正重载。
- 检查普通问答失败并完成共享滚动全回归；补深色/浅色、减少动态/透明度偏好、移动软键盘/旋转/安全区与 Safari 真机。
- 首屏时间、长任务、输入延迟、缓存堆内存及请求瀑布前后测量；当前只报告载荷/请求/锚点证据。
- 生产分阶段发布另需授权。本轮保留未提交代码，不切生产。
