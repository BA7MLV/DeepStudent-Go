# 持久云端任务执行

```text
Fastify API → SQLite cloud_tasks（单实例、有界并发）
                  └─ Node 领域执行器
                       ├─ Gateway：模型、字幕、原题审批、收据
                       └─ 独立进程：FFmpeg / Poppler / Silero / 图像 / 文档解析
```

`cover`、PDF/HTML/Word/Markdown `material`、`transcribe`、完整含图 `handout`、原题 `pluginExtraction` 都由服务器执行，不依赖页面在线。聊天、Bot、卡片、评论、弹幕保留现有服务。不引入 Redis、通用调度框架或服务器浏览器。

- 视频封面优先已有 slide，否则多点亮度/清晰度/稳定性评分；手选封面不可覆盖。Markdown 复用原标题卡布局，DOCX/HTML 保留原图标占位行为。
- 讲义共用采样/差分/类型筛选策略；新帧与讲义原子提交，重生成替换当前帧，不删除历史 DOCX。figure 按请求时刻重新高清抽图。
- B 站原字幕优先；否则独立进程运行仓库原有 Silero legacy 模型与原分段参数。ASR 仍需远程模型，可能收费；已完成段保留，取消不自动重启。
- 原题逐页审批并经 ResourceFiles 的 CAS 保存。每页与精确源文件指纹标记一起原子保存；新命令重试跳过已保存页，同 nonce 查询原任务、不重复追加。用户修改发生冲突时停止，绝不覆盖。
- 旧 browser queued 可迁移；running/waiting_user interrupted，历史原稿/Blob/outbox 只读核对导出，不自动重放。

## 本机部署

安装 `ffmpeg`（含 ffprobe）、Poppler；Linux 安装 util-linux 与中文字体。无需 Chromium。仓库模型随 `@wangke/study-core` 打包，不依赖 Web 源码。

```sh
npm ci
npm run build
npm start
```

API bundle 位于 `apps/api/dist/apps/api/runtime/`；直接开发 API 前先 `npm run build:api`。API 不托管前端，仍需独立部署 Web。`CLOUD_WORKER_DISABLED=1` 是禁用整个持久任务调度的旧环境变量名，不表示恢复浏览器执行器。

## 验证

`test:server-media`、`test:server-extraction`、`test:server-tasks:e2e` 使用真实本地媒体工具与 mock 模型。旧浏览器执行器的历史通过数字不能用于当前版本。资源硬限制在 Linux/Docker 的实际测量仍需该环境，Node heap cap 不等于 RSS 硬上限。详细证据与未验范围以 [server-task-execution.md](server-task-execution.md) 为准。
