# 聊天附件：引用图片与按需字节

## 上传契约

- 最终协议以 [chat-attachment-references.md](chat-attachment-references.md) 为准。复用 `serverClient.uploadFile(File)`，每张图片**只上传未改动的原文件一次**；不生成、上传客户端第二份预览。服务端自动生成 640×640 内、不放大的 WebP 预览。
- `FileDto` 新增 `previewServerId`、`width` / `height`，前端直接采用服务端 EXIF-oriented 尺寸与预览引用；返回附件的 `serverId` 是原图 id，另保留现有 id/name/mimeType/size，绝不带服务端图片 `dataUrl`。预览读取保留路由实际 MIME，不假设 JPEG。视觉模型边界由后端按原图引用加载。
- 仅明确识别的静态 localOnly 部署延续原有本地原文件 + 1600 px `dataUrl`，不把服务器失败降级成仅本机存储。历史嵌入预览仍能显示，即使原图已清理。
- 上传响应缺少有效预览或尺寸时不发布附件，仅删除尚未逃逸的原图引用，由服务端级联预览。账号已切换则不使用新账号凭据清理旧上传。上传失败且未得到原图 id 时不臆造删除，也不保留已退役的第二文件上传失败流程。
- 草稿裁剪继续保留原 File；替换成功前不丢旧附件，成功后仅请求删除旧草稿原图，服务端级联预览。已被提交消息/任务引用的原图和预览均拒绝删除（409），不由前端绕过。

## 渲染与生命周期

- 图片按 MIME/文件扩展名/历史 `dataUrl` 判定，不把纯引用图片变成文档卡。
- 缩略图由 IntersectionObserver 在 240 px 近视口范围内请求预览。图片不阻塞文本；离屏不请求预览或原图，缺少预览时绝不偷拉原图。
- 仅打开查看或下载才读原图。预览/原图分别显示失败与重试；原图缺失明确报错，不能以预览冒充成功原图下载。
- 保留现有产品方形缩略图几何（消息 96 px、草稿 80 px）；存储尺寸、img width/height 及比例占位使加载前后不跳高，不改变裁剪和相册观感。
- 切换图片、关闭、离开近视口、卸载取消组件等待并释放 object URL。共享文件下载仍可为其他等待者完成；账号结束会取消其所有共享请求。下载 URL 在 30 秒内或账号结束时释放。
- 复用 `store/cloudBlob.ts`：账号独立 IndexedDB、终止型 AccountLifetime、请求去重、最多 4 并发、128 条目 / 32 MiB LRU。没有第二份无界字节 Map。失败、401、403 不进入成功缓存。
- 同账号缓存命中也必须鉴权：每次按需获取发 `cache: no-store` 条件 GET（已有 ETag 时携带 If-None-Match），服务端鉴权后 304 才复用磁盘字节，不为像素渲染重复下载完整二进制；旧无 ETag 缓存第一次走完整响应补充 ETag。401/403/404 删除字节及元数据并报错；网络离线不以旧缓存冒充仍有权限。并行等待仍合并为同一个鉴权请求。
- 账号结束清空附件草稿视图，不删除可能已提交的文件。切换会话中完成的删除只修改该会话草稿，不污染新活动会话。

## 自动化证据

```sh
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsx --test scripts/test-account-lifecycle.mjs scripts/test-cloud-transactions.mjs scripts/test-cloud-blob.mjs
npx tsx scripts/e2e-chat-attachment-demand.mjs
ATTACHMENT_BROWSER=webkit npx tsx scripts/e2e-chat-attachment-demand.mjs
```

专项启动隔离 SQLite + 真实 API/Vite + 真实 React/浏览器。禁止外部请求与模型调用，不使用生产登录态。可控故障仅拦截专项文件请求。

覆盖：精确每图一次上传、服务端 WebP MIME/640×320 尺寸、320×160 小图不放大、预览未登录401、保留引用原图/预览删除409、原始尺寸/无 Base64、文字先显示、离屏零拉取、近视口仅拉预览、预览失败重试、原图字节下载与服务端实测 200→304 缓存复用、缺失原图独立重试、无效响应元数据不发布且仅删原图/预览级联、多图慢响应切换/关闭不产生过期 URL、同账号真实删除原图后 GET404 且缓存不能绕过、账号结束全部 URL 释放及另一账号空缓存、401/403 不缓存、真实 132 份文件写入后缓存仍在上限内。

2026-11-11：Chromium、WebKit 通过，预算实测均为 117 条 / 33,546,240 字节（小于 33,554,432）。WebKit 使用临时目录下的独立持久化 profile：该测试环境的隐私上下文写 Blob 会报 `UnknownError: Error preparing Blob/File data`；使用持久化 profile 后预算断言实际覆盖写入与淘汰，不以零缓存伪装成功。

旧 `scripts/e2e-server-chat-attachments.mjs` 已由验收 agent 更新引用断言；主 agent 已整合最终单次上传计数并真实运行通过，保留实际视觉模型输入与裁剪原稿字节验证，新增服务端 WebP 关系、MIME 与像素尺寸验证。QA 的 `images[].thumb` 历史迁移/显示是独立已知边界，本次未扩大该生产路径。

## 独立审计 P1(2) 修复回归

- 新权限/ETag 专项保留生命周期、并发、失败重试和预算断言，补 401/403/404 清理、离线拒绝、旧缓存无 ETag、跨 lifetime 鉴权304复用；账号/事务/缓存组合 23/23 通过。
- 本前端最初独立门禁证据 `data-delivery-acceptance-BWhO9f/evidence.json` 为9/11，缓存撤权通过；后端完成 taskDto/nonce 修复后已报告完整门禁11/11两次，见最终契约文档证据 `data-delivery-acceptance-yCKBst` / `data-delivery-acceptance-NOd7kq`。没有删除/跳过红项断言。
- WebKit 有时将服务端304在浏览器 response 事件中呈现为200；专项直接记录真实 API onSend 状态，断言原图查看→下载准确为200、304，不以浏览器合成状态冒充传输结果。
- 最终单次上传前端协议统一后，本 agent 重新运行完整独立门禁 **11/11 通过**，证据 `data-delivery-acceptance-1QMxXt/evidence.json`；focused Chromium/WebKit、Web TypeScript 与限定文件 diff whitespace 检查同时通过。
