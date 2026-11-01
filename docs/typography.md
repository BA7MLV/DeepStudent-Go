# 文本排版优化

本次仅调整换行、间距、数字对齐与截断，不改文案、字体、颜色或整体布局。未引入依赖或 polyfill；浏览器不支持的新 CSS 声明会被忽略。

## Chat 稳定性优先的最终策略

- 不再向全局 `h1–h3`、`p`、`li`、`dd` 施加 `balance` / `pretty`；只保留明确 UI 文案的增强和既有静态欢迎语样式。
- 共享 Markdown 的标题、段落、列表、引用统一使用 `text-wrap-style: auto`，生成中、停止、历史消息保持相同算法，不在生成结束后切换美化排版。
- 不再全站启用中文标点压缩；取消 `trim-start` 和相应讲义补丁，恢复原生标点空间与已有缩进。
- 自动中西文间距仅在中文共享 Markdown 正文启用；源码、公式、输入框、嵌入式 UI 排除，用户原始提问不额外加工。
- 消息正文不加省略号；保留既有长提问展开功能，导航/文件名的 `title` 只是桌面悬停补充。

这些是当前项目的保守取舍，不宣称是所有聊天产品的通用最优方案。

## 共享规则与修改文件

以下路径均相对于仓库根目录。

| 文件 | 选择器 / 位置 | 调整 |
| --- | --- | --- |
| `apps/web/src/theme.css` | `.card__title, .modal__heading, .empty-state__title` | 仅明确 UI 标题使用基础层 `text-wrap: balance`，不作用于原生消息标题 |
| 同上 | `.card__description, .ui-field__hint` | 仅明确 UI 说明使用基础层 `text-wrap: pretty` |
| 同上 | `td, th, output, time, [role='timer']` | `font-variant-numeric: tabular-nums`，不影响普通正文数字 |
| 同上 | `.button, .toggle-button, .tab, .chip, .tag-mini` | 操作标签默认单行；不全局限制所有原生 button |
| 同上 | `:where(.x-markdown):lang(zh)` | 仅中文共享正文启用 `text-autospace: normal`，不附加标点压缩 |
| 同上 | 显式非中文 `[lang]` 子树 | 重置中文自动间距与标点压缩 |
| 同上 | `pre, code, kbd, samp, input, textarea, .font-mono, .cm-editor, .project-text-editor, .code-block__language, .md-embedded-ui, .katex, svg, canvas, [contenteditable='true'], [style*='monospace']` 及相应后代 | 排除源码、编辑器、公式、嵌入式 UI 与绘制文字的自动间距，保留字面排版 |
| `apps/web/src/components/markdown/markdown.css` | `.x-markdown` 及非嵌入式 UI 的标题/段落/列表/引用 | `text-wrap-style: auto`，不改变 pre/code 的空白规则，不按流式状态切换 |
| `apps/web/src/components/code-block.css` | `.x-markdown .code-block__source` 及其 `code` | 显式保留 `white-space: pre`、普通断词，在代码块内部横滚；修复 Markdown 库未被 `disableDefaultStyles` 禁用的 pre/code 规则覆盖 |
| `apps/web/src/ui/overflowTitle.ts` | `overflowTitleProps`、`updateOverflowTitle()` | 交互时测量实际溢出；仅截断时设置原生 `title`，无需观察器或额外 DOM |
| `apps/web/src/ui/layout.tsx` | 导航标签、Recent 标题、页面标题/副标题、Field 提示 | 接入溢出提示；Field 提示使用专用 `.ui-field__hint` 避免引入组件库样式；保留已有 Recent 滚动行为 |
| `apps/web/src/pages/Projects.tsx` | `.ph-row__name` | 项目名实际截断时提供全文提示 |
| `apps/web/src/components/ModelPicker.tsx` | `.model-picker__provider`、面板标题中的摘要 | 实际截断时提供全文提示；模型选项原有 `title={ref.model}` 是底层标识信息，不是冗余显示名，予以保留 |
| `apps/web/src/pages/ResourceLibrary.tsx` | `.resource-open` 的文件名 span | 接入溢出提示 |
| `apps/web/src/pages/resources.css` | 列表视图 `.resource-open > span:not(.resource-file-icon)` | 单行省略、`min-width: 0`；图标视图继续允许名称换行 |
| 同上 | `.resource-open > small` | 大小等元数据单行、等宽数字 |
| `apps/web/src/ui/skeleton.css` | `.skel-reveal__content` | 补 `min-width: 0`，避免共享 Grid 内容层撑开列表、使省略号失效 |
| `apps/web/src/utils/format.ts` | `formatSize()` | 数字与 KB / MB / GB 之间改为不换行空格，不改变可见文案 |

现有 `apps/web/index.html` 的 `lang="zh-CN"` 与 `apps/web/src/i18n/index.ts` 的语言切换机制已满足需求，无需为本任务修改。

## 强制断词审计

没有发现 `line-break: anywhere` 或直接声明的 `word-break: break-all`。

将以下 **13 处** Tailwind `break-all` 改为 `wrap-anywhere`（`overflow-wrap: anywhere`）：优先保留正常单词/标点断行机会，仅在连续长串放不下时应急断行。

- `apps/web/src/components/settings/UsageModule.tsx`：供应商 / 模型名称。
- `apps/web/src/components/settings/PromptCacheUsage.tsx`：供应商 / 模型名称。
- `apps/web/src/components/settings/LiveModule.tsx`：分享链接预览。
- `apps/web/src/mcp/McpSettings.tsx`：命令 / URL、工具名称（2 处）；工具名称补 `min-w-0`。
- `apps/web/src/mcp/McpAdvanced.tsx`：诊断消息。
- `apps/web/src/cloud/BotManagement.tsx`：运行 ID、错误码、请求说明、步骤摘要、步骤预览、产物文本、记忆元信息（7 处）。

保留 **9 处** `break-all`：

- `apps/web/src/components/HtmlAnswer.tsx`：HTML 原始源码（1 处）。
- `apps/web/src/components/WidgetBlock.tsx`：HTML 源码、结构化状态 JSON（3 处）。
- `apps/web/src/components/ArtifactEditor.tsx`：修改前后原始源码对比（2 处）。
- `apps/web/src/cloud/BotSettings.tsx`：原始工具调用参数（1 处）。
- `apps/web/src/cloud/GatewaySettings.tsx`：错误标识码、等宽账号标识（2 处）。该文件已有的其他修改不属于本次排版任务。

这些保留项展示的是源码、参数或机器标识，不是自然语言正文；原本就使用预格式化/等宽或原始值展示。

## 真实页面验证案例

通过实际聊天页面与资源库页面的组件渲染测试内容，不使用独立排版样板页；测试使用隔离浏览器存储、只读模拟接口，不操作用户数据或请求 AI 服务。截图目录：`test-results/typography/`。

1. **标题普通换行**：撤回聊天正文标题的均衡换行；逐段追加标题时，不因均衡算法移动开头字符。欢迎页的静态标题增强保留。
2. **段落稳定**：撤回全局 `pretty`；允许段尾自然出现短行，优先避免生成中或结束后为了孤词重新安排已有行。逐次追加正文、关闭 streaming 后均检查位置。
3. **中文混排**：同页 `DeepStudent`、`PDF`、`Markdown`、`AI`、数字与中文之间由浏览器补适当间距；代码示例保持字面间距。截图同上，也提供 `chat-*-desktop.png`。
4. **长文件名**：资源库列表从多行名称变为单行省略；长名称有全文 `title`，短名称无多余提示。见 `library-before-mobile.png` / `library-after-mobile.png`，另有深色截图。
5. **数字稳定（保持现状）**：实际思考计时器已有 `tabular-nums`。`11.1` / `88.8` / `99.9` 三种同位数文本宽度前后均为 **77.359375px**；不重复改动。见 `timer-before-mobile.png` / `timer-after-mobile.png` 和 `before.json` / `after.json`。所用 Roboto 字体文件的 GSUB 包含 `tnum`。不同位数之间仍会变宽，不添加固定宽度。

聊天专项截图与检查记录位于 `test-results/chat-typography/{chromium,webkit}/`。测试覆盖逐次追加的标题/段落、未闭合代码围栏、代码缩进/双空格、超长代码横滚、长 URL、表格、公式和用户提问换行。完成态比较只针对正文排版；表格收尾、公式解析等结构变化仍遵循原有组件契约，不声称流式过程完全没有布局变化。

## 验证与边界

```sh
npx tsx --test scripts/test-typography.mjs scripts/test-stream-markdown.mjs scripts/test-markdown-table.mjs
node scripts/e2e-chat-typography.mjs
BROWSER=webkit node scripts/e2e-chat-typography.mjs
node scripts/e2e-typography.mjs
TYPOGRAPHY_BEFORE=1 node scripts/e2e-typography.mjs
npm run build:web
git diff --check
```

- 前后对比模式从 Git `HEAD` 读取本次涉及的基线样式与大小格式化函数，并禁用新增溢出提示；不会改写工作区。后续提交后可通过 `TYPOGRAPHY_BASE_REF=<优化前的提交>` 指定基线。
- 聊天专项覆盖 Chrome 和 Playwright WebKit 的 360 / 390 / 768 / 1440px 视口及明暗主题，共 16 组；WebKit 不是实机 Safari，未测试 Firefox 或实际移动设备，也未做性能基准。
- 另跑 `scripts/e2e-stream-markdown.mjs` 与 `scripts/e2e-chat-table.mjs`，验证首页 Chat / 素材 Chat 的真实生成管线、历史重载、公式、流式表格与移动端展开操作。
- 构建仍提示部分生成 CSS 的空 `:is()` 选择器与模块静态/动态混合导入告警；本次未改动相关组件库或打包策略。
- 原生 `title` 是桌面悬停补充，不承诺触屏或键盘一定显示弹出提示；完整文本仍留在 DOM 中。
- 不启用中文 `keep-all` 或分词，不引入 BudouX / `Intl.Segmenter`，不做中文两端对齐、固定正文行宽、批量文案空格替换。
- 保留移动端资料库路径按钮的有意换行，以及讲义既有的首行缩进和对齐方式。
