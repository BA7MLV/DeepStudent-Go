# AGENTS.md

面向所有 AI 编码代理与新成员的仓库约定。本文件是唯一权威来源;约定变更时改这里,不要在 PR 里口头约定。

## 仓库结构

- `apps/web` — React 19 + Vite 5 前端(HeroUI v3 + Tailwind v4 + zustand),离线优先(Dexie/IndexedDB),PWA。
- `apps/api` — Node API 服务,独立部署,前端经反代访问。
- `packages/contracts` — 前后端共享契约类型,不依赖任何其他 workspace。
- `packages/study-core`、`client-core`、`remote-*` — 领域包与远程运行时载体。
- `scripts/` — 测试与构建脚本;`test:*` 走 `node --test` 或 `tsx`,`e2e-*` 需要 Playwright 浏览器。

## 边界规则(由 `scripts/check-boundaries.mjs` 静态强制)

- workspace 依赖方向:`contracts` 不依赖任何包;`study-core`/`remote-*` 只能依赖 `contracts`;`api` 与 `web` 不被任何包反向依赖。
- `apps/web` 不得 import `apps/api` 内部模块;跨端通信只走 `packages/contracts`。
- 改动边界相关代码后必须跑 `npm run check:boundaries`。

## 代码规范

- 一律具名导出(named exports);禁止 barrel files(`index.ts` 聚合再导出)。
- 外部数据(网络响应、文件内容、用户输入)必须在信任边界处校验,不得以 `unknown`/`any` 一路穿透。
- 禁止反模式:链式类型断言 `as A as B`、参数标 `unknown`、空对象条件展开 `{...(cond ? {a:1} : {})}`。
- CSS 与页面组件同目录放置;样式顺序敏感处(如 `md-table.css` 依赖 `@ant-design/x-markdown` 先加载)必须保持 import 顺序。
- 注释解释「为什么」,不复述代码;中文注释与现有风格一致。

## 性能守门

- 启动预算:`npm run test:boot-budget` —— 入口静态 import 图 ≤ 4 个 JS 文件、gzip ≤ 640KB;重库(katex/mermaid/pdf/chart/cytoscape/codemirror)必须留在懒加载边界之后。
- 基线度量:`npm run build:web && npm run test:boot:metrics`(需 Playwright Chromium):报告 Slow 4G + 4x CPU 下的 FCP/LCP/hydration。
- 涉及启动路径、分包、样式加载的改动,合入前必须跑上述两项并报告数字增减。
- 意图预加载(`src/utils/preload.ts`):指针停留 100ms 或键盘 focus 才预取;Save-Data 下不预取;新增路由页面时把入口加进 `App.tsx` 的 `preloadOnIntent`。

## 测试约定

- 纯逻辑/纯数据变换 → `tsx --test scripts/test-*.mjs`(node:test)。
- 需要真实浏览器或服务的端到端 → `scripts/e2e-*.mjs`(Playwright),命名 `test:<domain>:e2e`。
- 新增功能必须带测试;先看 `package.json` 里同域脚本怎么写,保持风格一致。
- 提交前必须通过:`npm run check:boundaries`、改动包的 `typecheck`、相关域的 `test:*` 脚本、`npm run check:i18n`(动了文案时)。

## 提交与发布

- 提交信息聚焦一个变更单元;性能相关提交带 `perf:` 标记并在正文写清测量方式(实验室/线上)与数字。
- 不提交生成产物与 `dist/`;`scripts/generate-remote.mjs` 产物由 `check:remote` 校验。
- 发布走 `compose.*.yaml` + Docker;不要在 PR 里改部署拓扑,除非任务明确要求。

## 安全底线

- 密钥、token、一次性 Setup URL 不写入日志、测试或提交。
- Bot 命令默认需审批、默认可联网由用户显式控制;改动权限语义必须有对应测试。
