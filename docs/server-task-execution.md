# 服务器独立任务执行

## 执行边界

持久云端任务由现有 SQLite `cloud_tasks` 和 `CloudTaskRunner` 调度，执行后端统一为 `node`。浏览器只提交命令、显示投影、接收账户 ClientRuntime 的 shared WebSocket 更新；关闭全部页面不会停止服务器任务。没有隐藏 iframe、Executor Remote、browser lease 领取或 task-token 授权/完成接口，也不使用服务器 Chromium。

真正的离线/本地 Web Workers（PDF 阅读、音频抽取、文件写入等）仍然保留，不是云端失败时的回退。需要人工批准的服务器任务会持久停在 `waiting_user`，没有页面时不擅自批准；重新打开页面后可处理。

实现入口：

- `apps/api/src/cloud/{tasks,execution}.ts`：持久调度、账户边界、提交 CAS、权威文件描述符。
- `apps/api/runtime/media-tasks.ts`：封面、ASR 分段检查点、截图/vision/大纲/IR/含图 DOCX。
- `apps/api/runtime/{media,audio,document}-process.ts`：受控子进程、流式 PCM/VAD、惰性文档解析。
- `apps/api/runtime/question-extraction.ts`：原题逐页提取，真实 ResourceFiles 保存及审批。
- `packages/study-core/src/{bilibili,handout}`：Web/Node 共用协议、字幕选择与 DOCX 排版。

## 支持的工作流

| 工作流 | 服务器行为 |
| --- | --- |
| cover | slide 优先；FFmpeg 五点亮度/清晰度/稳定性评分避黑帧；Poppler PDF 首页；Markdown 共用原布局；DOCX/HTML 保留图标；绝不覆盖手选封面，保留尺寸/主色 |
| material | Poppler PDF 正文；独立 Node 进程解析 Markdown/DOCX/HTML；HTML 不执行脚本或加载远程资产 |
| transcribe | B站原字幕优先、多语言轨道落库；失败后流式解码/VAD，再逐段 WAV 调用模型 Gateway；保存句级 cues 和已完成段检查点 |
| handout | 视频真实截图→vision→大纲→分节 IR→含真实 JPEG 的 DOCX；共享封面、目录、页眉页脚、图表排版器；材料为明确标注的文字来源讲义 |
| pluginExtraction | PDF 正文及真实页图；非 PDF 为已索引正文；共享原题技能和 quiz 验证；逐页审批、题库初始 revision 和逐次 CAS、真实保存收据 |
| bilibiliImport | 解析分 P / 合集并按选择逐集下载；FFmpeg 本地 fd 合并为 MP4；原字幕与资源目录一起提交；后台安排封面/转写，关闭页面不停止 |

PDF 页图采用现有 `#source-image/{encodedCourseId}/page-N` 引用，Web 阅读器按需加载对应页面。没有原题的页面会明确记为待人工核对，不得把模型宣称“已保存”当成领域保存收据。

ASR 使用 Gateway 统一的超时、重试/Retry-After、预算和路由策略，不在任务层再叠加一套模型重试。当前每个转写任务逐段串行，不恢复旧浏览器的 AIMD 并发偏好。字幕时间计划不匹配时拒绝覆盖已有检查点，需人工核对后显式重新提交。

## 依赖与打包

服务器 PATH 需要 `ffmpeg`、`ffprobe`、`pdftotext`、`pdftoppm`，Linux 还需 `prlimit`（util-linux）。Dockerfile 的 API-only runtime 已声明媒体工具与字体依赖，不包含 Web 源码或 React/Vite。图像 CPU 操作使用独立 canvas 进程；音频进程用单线程 ONNX WASM 与仓库原有 Silero legacy 模型，不下载新模型。独立运行不是“把浏览器放在服务器上”。

从源码构建使用 `npm ci`、`npm run build:api`；Web 可单独 `npm run build:web`。Remote 定义变化后只能用 `npm run generate:remote` 更新生成物，再运行 `npm run check:remote`。`verify:api-isolation`/`verify:web-isolation` 在裁剪依赖树中分别构建，API 还验证去掉开发依赖后的启动、readiness、404 和 drain。

## 资源预算及限制

- 调度并发 `CLOUD_CONCURRENCY` 默认 2，范围 1–4；等待审批的任务不占 running 配额，但活动任务总数上限 8。单任务内部媒体处理串行。
- 输入只来自账户鉴权后的服务器索引文件，子进程继承 fd3；不接受用户任务提供的路径/URL，不经 shell。FFmpeg 只允许列举的媒体格式和 file/pipe 协议，不允许 playlist 或网络流。
- 每个进程默认墙钟 120 秒；输出默认 16 MiB（页图/封面 4 MiB、单段 WAV 2 MiB、VAD 区间 JSON 1 MiB）。超时、取消、输出超限会终止整个自有进程组。
- Linux 原生 FFmpeg/Poppler：`prlimit` 地址空间 1 GiB、CPU 120 秒、文件描述符 64。macOS 不提供这些 Linux 资源硬限制，仅验证输出/墙钟/取消。
- Node worker 使用显式 V8 heap cap，音频 worker 为 128 MiB；不能设置相同 RLIMIT_AS，否则 V8 地址空间预留会导致启动失败。**heap cap 不等于整个进程的 RSS 硬上限。**
- 流式音频最长 4 小时；API 不保留整段 PCM。讲义每 25 秒采样、差分阈值 16、最多保留 60 帧、12 节，DOCX 上传限额 32 MiB。figure 按请求时刻重新抽取不超过 1600 宽的图。帧和 DOCX 仍在 API heap 内组装，不应据此声称总内存恒定。
- 文档输入上限 128 MiB，HTML 16 MiB，DOCX 正文解压限额 32 MiB，文档输出 16 MiB；PDF 原题最多 2000 页。限制触发即失败，不静默宣称处理全文。
- B站导入网络仅固定元数据/播放/登录 API、DmView、精确字幕 CDN 与 `*.bilivideo.com/cn` 视频 CDN；连接时拒绝非公网 DNS 地址。只允许 b23 短链逐跳白名单跳转，其余重定向拒绝；不是通用抓取代理。Cookie 仅加密保存在账户凭据表，只发送给固定 B 站 API，不进入任务或 CDN。
- B站每集下载上限 `MAX_FILE_BYTES`（至多 512 MiB）、30 分钟，MP4 输出独立受相同大小上限与 120 秒合并超时约束；单账户最多排队/运行 4 个导入任务。取消/失败清理该任务临时文件，重启不会自动重复下载；已保存分 P 保留。

部署方仍需设置容器/cgroup 的总内存、CPU 和 PID 预算。不能仅凭 V8 heap、单进程 AS 和并发限制推导整机不会 OOM；应在目标 CPU/架构上压测后设置预算。当前未给出实测可用的生产内存规格。

## 取消、失败与重新启动

取消会中止模型请求与媒体进程组，写入前再次检查任务状态。来源文件被替换、删除或映射改变时，不把旧 fd 结果提交到新来源；原题提取在审批等待结束后的保存边界也重新复核来源。审批拒绝、策略撤权、题库并行修改均不能覆盖用户工作。

重启将 `running`/`waiting_user` 标为 `interrupted`，保留 progress/result 和既有产物；不自动重放效果未知的模型/写操作。重新提交转写可复用与当前时间计划一致的已完成段。讲义目前不支持中途模型步骤检查点恢复。

题库部分保存后若失败/取消，已保存页仍保留，收据由实际有效题库和服务器检查点投影。每页与精确源指纹标记原子保存，新 nonce 显式重试跳过已保存页；同 nonce 仅返回旧任务。资源命令进入领域处理后失败可能给出“inspect original draft, receipt and directory”提示；必须先核对草稿/目录/收据，不能把它当作安全自动重试的信号。

## 旧浏览器执行器数据迁移

1. 发布前备份 SQLite、文件目录和客户端历史数据库；不要清库或清站点存储。
2. 旧 `queued` 任务迁为 `node`，清 lease/worker 标记。旧 `running`/`waiting_user` 标为 `interrupted`，不自动重新排队；完成、失败及不确定的历史证据保留。
3. 旧 executor IndexedDB 仅用于核对和导出；列表仅读取键/数量，单条核对不全表读取附件，完整 Blob 仅导出时读取。没有创建新 executor DB 或恢复浏览器写权限的入口。Blob、checkpoint、outbox、草稿保留，不批量回灌或自动重放。账户 DB 身份和运行时世代拒绝 A→B→A 的旧结果。
4. 旧 task-token、executor WebSocket、claim/authorize/finish 不再接受写入。账户 ClientRuntime、用户任务命令和本地 outbox 恢复不受此退役操作替代。
5. 旧版本 executor 测试脚本仅为历史材料，不再作为有效执行路径的验收入口；使用下列服务器验收替代。

## 本地验收（2026-11-04）

模型均为测试桩；使用隔离数据库、文件目录与端口，未调用付费模型、真实 IM 或生产服务。已通过：

```sh
npm run build
npm run check:remote
npm run check:boundaries
npx tsx scripts/test-task-executors.mjs
npx tsx scripts/test-media-policy.mjs
npx tsx scripts/test-server-media.mjs
npx tsx scripts/test-plugin-extraction.mjs
npx tsx scripts/test-server-question-extraction.mjs
npm run test:model-gateway
npm run verify:api-isolation
npm run verify:web-isolation
npx tsx scripts/e2e-server-task-execution.mjs
npm run test:plugins
npm run test:plugins:e2e
npm run test:plugins:extraction:e2e
npm run test:cloud
npm run test:cloud:e2e
npm run test:subtitles
npm run test:subtitles:e2e
npm run test:bot
npx tsx scripts/test-node-chat-edit-e2e.mjs
npx tsx scripts/test-chat-followup.mjs
npm run test:client-runtime:tasks:e2e
```

原生媒体测试实际运行 FFmpeg/Poppler，检查二进制 JPEG/含图 DOCX、PDF/惰性 HTML、字幕优先、多轨和 cues、取消/超时/限额、账户隔离、手选封面、检查点及旧任务迁移。原题测试实际运行服务器 runner→mock 模型→审批→ResourceFiles 保存→领域收据，不是手动把任务改为 completed 来代替执行。

浏览器验收实际启动 API 和 HTTP mock：浏览器提交后在 ASR 阻塞期间关闭全部页面及整个浏览器，再释放模型；转写、含图讲义、封面、HTML、扫描 PDF 与原题均服务器完成。审批由测试端显式批准，不是生产自动批准。随后重开完整 App，idle 60 秒无任务轮询或 executor realm；退役 HTTP routes 返回 404。恢复 fixture 检查 8 MiB+17 字节附件逐字节一致、旧库零写入、列表零 getAll 和账户切换后拒绝旧导出。

新增策略 fixture 对比原 vad-web FrameProcessor 的 20,000 个概率输入（阈值、误触发、EOF），真实媒体 fixture 覆盖黑首帧、重复画面、类型无、重生成不增长、失败保全旧图、帧 CAS、高清 figure 和手选封面；不把时间线状态机对比误称为全平台音频解码逐样本一致。扫描 PDF 测试覆盖两页部分保存、关闭 runner/服务、重启同命令不重跑、新命令只补第二页，并保留页面图片引用。归档期间保存和 Bot 来源 grant 撤销均拒绝；原题账户任务不能借 parent 身份绕开原审批域。

真实模型 fixture 还对同一 16kHz PCM 运行安装的原 NonRealTimeVAD 和已打包服务器 ONNX 子进程，校验合并后时间戳一致。它不替代不同解码器/设备/长音频的实测。

`scripts/freeze-client-runtime.mjs` 已将退役 executor/worker 项切换到服务器生产者、原题审批/CAS 和浏览器全关闭/恢复测试；原专项文件保留为历史证据，不再作为当前有效执行器入口。没有删除业务/授权/数据保全用例来制造旧 28/28 结论；本轮没有重跑整个历史客户端冻结矩阵，不声称该矩阵全绿。

父会话独立复验：`node --import tsx scripts/e2e-server-task-execution.mjs`、`npm run check:remote`、`npm run check:boundaries` 均退出 0；确认真实浏览器关闭后的完整任务链、退役路由 404 和重开后的 60 秒无任务轮询。历史恢复 fixture 返回 `{ size: 8388625, writes: 0, listFullReads: 0 }`，逐字节核对附件、旧库零写入和账户切换拒绝均通过；`git diff --check` 通过。

### 尚未验收/不能宣称的范围

- 本机 Docker daemon 不可用，未实际运行 Linux Docker 镜像，也未实测 Linux AS/CPU/PID/cgroup 和长媒体峰值 RSS。
- 尚未验证所有编码器/真实设备、字体跨平台像素一致性、长时间真实模型调用及超大历史数据库导出的峰值资源。不得将本机策略与媒体 fixtures 泛化为任意输入完全等价。
- 旧浏览器架构的历史 28/28 等数字不用于当前验收。未做生产部署、commit 或 push。
