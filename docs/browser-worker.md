# 浏览器执行器已退役

当前持久云端任务全部由 API 的 Node 执行器调度；关闭全部浏览器不暂停任务。服务器不会启动 Chromium，也不使用隐藏 iframe、task bearer token、claim 或租约续期。

部署需要 FFmpeg、ffprobe、Poppler；Linux 还需要 util-linux（prlimit）与中文字体。Dockerfile 已声明这些依赖。Silero 使用仓库原有的 legacy ONNX 模型，随 study-core 打包；不运行下载器，不新增推理服务。

旧 executor IndexedDB 只供显式核对、导出。列表仅读取键与数量；导出时才读取完整附件。不会自动续跑、归档或清除旧 Blob/outbox。旧 queued browser 任务迁移 Node；旧运行中或等待用户的任务保守标记 interrupted，不自动重放不确定副作用。旧 token 无写入权限。

真正的本地音频抽取、PDF 阅读等 Web Workers 仍保留，不是云端执行器。历史文档中的「浏览器 worker / 保持页面打开 / 租约过期自动排队」仅描述退役架构，历史验收数字不代表当前版本通过。

当前架构、资源边界与验收范围见 [server-task-execution.md](server-task-execution.md)。
