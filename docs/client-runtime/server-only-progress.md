# 服务端收敛进度（2026-11-05）

当前规范入口：[当前架构](../architecture.md)。实施清单：[服务端模式与能力收敛](../plans/2026-11-05-server-only-consolidation.md)，本轮本地实施与验收已完成 **6/6**。本轮在已有未提交工作区增量修改。

## 已落地

- 普通面板、插件及 Bot 使用同一 `cardReviewMutation`，校验课程/账户归属及原始 expected 状态。插件不再用服务端最新状态替换用户基线。普通面板撤销的请求移出 React updater。
- 卡片生成删除本地模型与本地覆盖分支，只提交服务器插件任务。
- 启动 API 缺失、cloud=false、503 或网络失败时停在账户入口，不再加载静态 App。
- `AccountLifetime` 替换 bootstrap epoch/cloudGeneration，runtime、数据库、偏好和插件失效归同一账户根；同账户重建、A→B→A、晚到资源释放有专项覆盖。清投影不删除草稿、journal、Blob 或历史档案。
- 删除自研 `PluginRegistry` 模块及包导出，manifest 固定点解析独立为纯 `plugin-dependencies.ts`；API 使用 Cordis 4 的同步 effect/provide 生命周期托管动作、provider 和账户句柄。
- `runtime-domains.ts` 按插件、资源、活动、记录四领域显式装配读取与失效匹配，公共认证、观察、收据保持。
- 删除 `chat-local-execution.ts` 及 courseChat/ChatPanel 本地模型循环；普通任务、结构化讲义保存与上下文压缩走服务器。压缩结果在 chat/QA/续写的实际历史准备阶段消费，不仅是页面预览。
- 新 `clearStudyTime` 完整快照 CAS，保留原操作收据；清空后的新计时可继续累加，旧清空重试不删除后来工作。
- 历史恢复通过显式操作按需加载；旧 journal 原值与完整 Blob 版本化归档，不回灌活动命令表。Gate 无登录只读导出亦须点击后加载，首屏不枚举库。README 指向唯一当前架构入口；历史文档实移 archive，旧路径保留导航。

## 本轮验证

- 以下记录本轮实际执行结果；历史验收不替代当前测试。
- 新卡片矩阵使用真实 SQLite 和生产 domain/plugin/Bot tool：跨入口陈旧状态拒绝、跨账户/课程拒绝、普通命令及插件命令丢响应重查原收据不覆盖后来的 Bot 审核。
- `node scripts/e2e-plugin-renderer.mjs` 通过：StrictMode、100 次挂载释放、依赖撤销/恢复、账户切换、同账户 runtime 重置、故意注入渲染异常后的恢复。异常堆栈来自测试的 crash 场景。
- `node scripts/e2e-server-only-boot.mjs` 通过：Chromium 的四种不可用 API 场景均显示账户入口，未加载 App 模块。该专项不替代已登录完整应用回归。
- 账户生命周期：4 项单测、真实 API/Remote/IDB 浏览器专项、cloud sync locks、cloud transactions 9 项及 cloud 专项通过。
- 插件平台、插拔、学习、材料、client-runtime；结构化讲义 persist 的真实 DOCX/帧图、归属、起点 CAS、取消、原收据专项通过。
- 服务端压缩 9 组与消费 6 组专项通过；消费测试检查实际 Gateway messages。课程 Panel QA/附件/模型选择/默认模型 CAS/完整压缩链浏览器专项通过（`server-chat-ui-YAEaJp`）。筛选是保守原生模型协议，不冒充专有 `/systemone`。
- 历史按需恢复/无账户下载/零 API/8,388,625 字节逐字节/账户围栏专项通过（`history-demand-WVAGQH`）。静态资源由 Vite 提供，不代表从未缓存站点也可首次离线加载。
- 父会话新增 Gate 四场景回归通过：首次不加载导出 chunk、不枚举库；点击后才加载，且不加载 App。`test-clear-study-time.mjs` 完整快照 CAS/跨账户/事务回滚/原收据/后来增量通过。
- 最终 `npm run build` 通过（API/runtime/Web 类型、i18n、生产产物及 notices），边界正负检查通过。补 `clearStudyTime` 后使用正式生成器更新 Remote schema，`check:remote` 通过。
- 综合 truth E2E 通过（`single-source-yjAgcN`）：真实 UI 分叉/删除/技能/卡片、双端冲突、丢响应原收据、附件保全、显式历史恢复；追加真实 typed Remote 清空时长/后来增量/原清空收据不覆盖验证。分叉删除先等待已挂载分叉会话，再点击，保留原 SQL 删除断言。
- WebKit 390px 综合 truth E2E 亦通过（`single-source-cGjuCZ`），使用隔离持久 profile 保留真实 Blob 断言；不外推 Safari 真机或私密模式支持。
- 完整认证入口及懒路由/设置回归通过（`server-only-app-88y1VO`）：普通聊天、资源库、助手/模型设置、数据设置显式恢复。首次 fixture 使用旧资源库 selector 与错误设置模块，已按实际路由修正；无页面异常或缺失模块。
- Web 适配专项通过：讲义连续收据 CAS/失败保留 IR 草稿，真实 StudyTimeCard 成功/冲突/空快照；A→B/A→B→A 旧确认、晚读取、在途 flush/submit 均拒绝，旧操作不释放新账户锁。
- 聊天生产 UI 专项覆盖 220 条服务器分页（含 90 条同时间桶）、懒会话 journal 先确认、失败不回退 cache、同账户旧分页拒绝；本地分页适配已删除。
- `test-client-runtime.mjs` 并发构建时一次外部文件系统通知等待超时；构建结束后独立完整重跑通过（`client-runtime-bP6SE6`），未放宽 8 秒断言或替换生产 watcher。
- 旧 `test-jev.mjs`/`e2e-worker-products.mjs` 源码归档，活入口实际执行当前服务端等价领域测试并通过：压缩准入/消费/浏览器禁止直连；插件学习产物、typed Remote 综合故障和历史只读恢复（`single-source-xn8IHZ`、`history-demand-tVahwS`）。退役专有协议不伪称仍受支持。
- 最后三个旧入口 `test-widget-state.mjs`、`e2e-widget-protocol.mjs`、`test-qa-runner.mjs` 均实际执行通过，删除对已退役 assistantSnapshot/modelHistory 的导入。保留 JSON/大小/深度/私有隔离、安全 bootstrap、布局与 DOM 错误恢复断言，状态/定向编辑/删除改验真实服务端命令；QA 明确映射到服务器执行、压缩消费、技能及课程 UI。证据 `protocol-CQdk2D`、`protocol-PhCHpn`、`server-chat-ui-ZOlpu8`。故意初始化异常严格核对两条，其他 pageerror 仍失败；server widget 工具列表按生产装配更新为完整精确八项，未放宽权限或子集匹配。
- Web 构建仍报告依赖 CSS 空 `:is()`、第三方 PURE 注释及混合静态/动态 import 警告；构建成功。此次未验证真实模型质量、生产部署或真机，未将模拟 Gateway 结果外推。

## 交付边界

本轮约定的五项收敛及本地综合验收已完成。浏览器委托测试需要已安装 Chromium 和已构建 Web/API 产物；真实设备、目标部署环境及实际模型生成质量不由本地模拟测试替代。

未提交、推送或部署；工作区包含用户此前已批准保留的其他未提交成果。
