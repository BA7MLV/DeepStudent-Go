# 任务执行架构（第一阶段）

```text
Fastify API
    ↓
SQLite 持久化任务调度（单实例）
    ├─ Node：模型调用、聊天/问答、文本生成、纯文本材料解析与持久化
    └─ 用户浏览器 Worker：视频封面、音频解码、PDF 预览及 UI 依赖任务
```

队列仍使用 `cloud_tasks`，不新增 Redis 或外部队列服务。现有提交、查询、进度、取消、审批接口保持不变。
任务查询结果的可选 `executor` 字段为 `node` 或 `browser`；历史已完成任务可能仍保留 `media`。待执行任务会重新选择执行器。
API 生产镜像不安装 FFmpeg 或 Chromium；普通已登录页面自动托管浏览器 Worker。

## 当前分流

| 任务 | 执行器 |
| --- | --- |
| `modelOnce` 单次模型请求（Chat / Responses / Anthropic） | Node |
| `cards`、`comments`、`danmaku` | Node |
| `handoutEdit` 讲义单块 AI 改写 | Node |
| `material` Markdown / Word 正文解析 | Node |
| `cover` 视频封面（优先复用已有课件帧） | 用户浏览器 Worker |
| `cover` 材料封面 | 外部浏览器 Worker |
| `material` PDF / HTML 解析 | 外部浏览器 Worker |
| `chat`、`qa`、`artifactEdit` | Node |
| `transcribe`、`handout` | 外部浏览器 Worker |
| Bot 工作空间 | 原有 Node `BotRunner`；命令仍交给独立 Docker 沙盒 |

聊天和课程问答的模型调用、检索、任务进度与聊天记录由 Node 完成；浏览器 Worker 只负责仍依赖浏览器 API 或 UI 的任务。
上传自动准备字幕：B 站原字幕优先，否则使用浏览器 WebCodecs + VAD 分段及 ASR 检查点。ASR 仍需配置语音识别服务，可能产生费用。完整讲义仍在浏览器 Worker 中执行，不随字幕自动生成。

## 数据与运行边界

- 调度器管理持久化队列。Node 执行器在 API 进程内运行；媒体计算使用用户浏览器，不增加服务端解码进程。
- Node 执行器直接读写账号隔离的服务端数据，不启动页面、不使用 IndexedDB，也不依赖前端 `dist`。
- 原生材料解析限制源文件为 128 MiB、Word 解压正文为 32 MiB，超限明确报错，不影响原文件；避免直接在 API 进程内无界读入/解压。
- 文本任务与浏览器模式共用模型协议客户端、提示词、生成与清洗算法，避免维护两套生成规则。
- 模型地址和凭据只从服务器保存的配置读取，不接受任务输入提供的 URL / Key，不跟随重定向。
- 记录替换通过同一 SQLite 事务提交，取消后不再提交生成结果；文件必须是本账号的服务器文件索引引用。
- 视频封面使用浏览器多点采样评分，复用已有课件帧且不覆盖用户手选封面。
- 失败任务保留错误与重试，不自动无限重做，避免重复模型费用和副作用。
- 默认计算并发仍由 `CLOUD_CONCURRENCY` 控制（1–4，默认 2），不同执行器共用此上限；同一课程/会话串行执行。
- 取消字幕会中止 ASR 请求和解码 Worker，并保留已完成段；主动取消的字幕不会因刷新重启。服务器重启后 Node 任务标记 `interrupted`；浏览器任务及失效租约返回队列，可在页面重开后继续。
- `BotRunner` 的定时唤醒及重启恢复策略不变，与云端流水线调度分开管理。

## 部署

Docker 和本机部署均无需 FFmpeg 或 Chromium。保持普通已登录页面打开即可自动处理浏览器任务；仍可单独打开 `?cloud-worker=1`。浏览器不支持的容器/编码会明确报错，不做服务端转码兜底。

```sh
npm run build
npm start
```

`npm run build:api` 会编译 API，并将无浏览器依赖的共享代码打包为 `dist-api/apps/api/runtime/node.mjs`。
构建会检查 Node bundle 没有引入浏览器数据库、前端状态或组件。开发 API 使用原生执行器前也应先运行 `npm run build:api`。

没有已认证 Worker 时，浏览器任务会保持 `queued`，不会在 API 容器中启动浏览器。`CLOUD_WORKER_DISABLED=1` 仍表示禁用整个云端任务调度。

```sh
npm run test:tasks  # 不需要 FFmpeg、Chromium、前端构建或真实模型凭据
```

测试覆盖三种模型协议、共享文本生成、账号隔离、Markdown/Word 解析、取消、重启恢复、失败不回退，以及媒体任务等待浏览器领取。浏览器 E2E 另测真实封面抽帧与自动字幕。
