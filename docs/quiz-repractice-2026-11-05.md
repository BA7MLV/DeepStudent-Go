# Skill 驱动的可视化练习：实现与验收

## 最终范围

按用户纠正后的架构约束实现：用「交互式讲解」skill + `show_widget` 生成教学练习，而不是扩展正式 Quiz 产品。提交/完成后自动在原组件展开 AI 参考状态、答案、解析；揭晓后可「重新练习」，清本轮选择/反馈/参考分数/计时并恢复输入。使用现有通用状态 API 保存当前进度，不额外调用模型。

本轮最初新增的 `practice.retry` 及契约已经完整撤除，只撤除了本轮自己的新增内容。`QuizCard`、`QuestionInput`、`PracticeView`、实践服务器、学习契约均无本轮最终差异；未改并行 session agent 的文件，未提交/推送/部署。

## 修改文件与路径

- `packages/study-core/assets/builtin/interactive-explainer/SKILL.md`：扩充可视化练习适用范围、自动揭晓和重练规范，指向新参考。
- `packages/study-core/assets/builtin/interactive-explainer/references/practice.md`：三条路径的 API/可信边界；完整可运行响应式 HTML 参考例子，含只读恢复、空白重练快照、保存串行/失败重试。
- `packages/study-core/assets/builtin/interactive-explainer/references/runtime.md`：区分普通 show_widget 本地 AI 参考核对与正式题卡反馈。
- `packages/study-core/src/harness/widgetTool.ts`：工具描述 + 共用 `WIDGET_PRACTICE_RULE`，嵌入现有 `SERVER_WIDGET_RULE`。
- `packages/study-core/src/harness/prompts.ts`：浏览器运行时提示同用此规则。
- `apps/web/src/store/widgetState.ts`：作品首次归属绑定可按 rowId 响应式等待真实 confirmed cache；支持取消/账户生命周期/超时清理，已建立绑定仍立即拒绝删除或改版。
- `apps/web/src/components/WidgetBlock.tsx`：首次绑定使用可取消等待，卸载或超时释放等待，不让文字流等整库同步。
- `docs/interactive-explainers.md`：说明能力/边界/验证入口。
- `scripts/test-skill-practice.mjs`：真实内置技能安装/参考读取、HTML 校验和提示规则接线测试。
- `scripts/e2e-skill-practice.mjs`：隔离 API、SQLite、账户与 Vite；模型只返回技能中的 HTML，真实 show_widget 执行和状态保存。
- `scripts/e2e-widget-ownership.mjs`：真实服务器投影的源码版本迟到、取消/卸载释放订阅、超时/重试、删除/改版和 A→B→A 生命周期保护。

调用路径：用户请求 → 交互式讲解技能/服务器共用行为规则 → show_widget(format=html) → 原有 Node widget 执行器校验并持久保存消息 → WidgetMessage/WidgetBlock 沙箱 → HTML 本地参考核对与重新练习 → `setWidgetState` → `saveWidgetState` → 现有 `editMessage`/学习命令 → 服务器持久化 → 页面刷新恢复。没有新增宿主 API，没有把 HTML 当成可信判分来源。

正式结构化 quiz 的可信判分、AI 参考、主观自评与错题记录沿用现有实现；正式题卡并未获得新的服务器重练能力。普通 ask_user 仍是确认/偏好提问，未加正确答案或练习按钮。

## 验收结果

以下命令已实际通过：

```sh
npm run build:api
npx tsc -b apps/web --pretty false
npx tsx scripts/test-skill-practice.mjs
npx tsx scripts/e2e-skill-practice.mjs
npx tsx scripts/e2e-widget-ownership.mjs
npm run test:widget-feedback
npx tsx scripts/test-widget.mjs
npx tsx scripts/test-widget-state.mjs
npx tsx scripts/test-server-widgets.mjs
node scripts/test-ask-visual.mjs
npx tsx scripts/test-plugin-learning.mjs
git diff --check
```

另运行 `npx tsx scripts/test-quiz.mjs`：数据层 21 项通过，6 项已有 SSR 题卡渲染用例失败，均为 `Missing getServerSnapshot, which is required for server-rendered content`（QuizCard 的插件可用性订阅没有 SSR 快照）。本轮未改 QuizCard/插件订阅，不为此改正式题卡。新增真实浏览器练习测试通过。最终 e2e 重载时 Vite 输出 WebSocket proxy `ECONNRESET`，不影响通过结果，浏览器 pageerror 仍为零。

归属 handoff 修复后的实际复跑：Web typecheck、skill 单测/首次实时延迟投影 e2e、独立 ownership e2e、widget-feedback/runtime、server-widgets 均通过；`test-widget-state`（串联 protocol + server 浏览器测试）最终也通过。中间一次串联运行在 `e2e-server-widgets.mjs:164` 活跃聊天刷新后未显示 widget 超时，当时页面没有消息内容；随后原命令原样复跑完整通过，未通过修改 session/页面或放宽断言掩盖该次失败。未修改无关 SSR 用例。

新增 e2e 验证：

- **首次实时生成即可使用**：测试故意暂停真实 confirmed cache 写入事务（不修改数据或消息流）；session 正文照常出现，只有 widget 显示准备中；释放原事务后自动运行，不调用 flushCloud、不刷新，不生成假的 db.chats 行。随后立即作答、揭晓、重练并保存。
- 作答前答案、解析隐藏；未选择不能提交。
- 错误与正确选择提交后均自动展开参考状态、答案、解析；标为 AI 参考/非正式成绩。
- 重练清选择、反馈、参考分数和计时；空白状态写入服务器，刷新后仍为空白；可再次作答并核对。
- 注入一次浏览器命令日志存储失败：本轮 UI 可重置但明确未保存，服务器保留上次快照；「重试保存」成功后再刷新恢复。不是在测试中替换保存函数或用 setState 假装成功。
- 首次加载/状态恢复不写回，不出现保存循环；只生成时有 2 次固定模型请求（工具调用与正文收尾），作答、保存重试、重练与刷新均无额外模型请求。
- 没有模态对话框、正式 quiz 成绩或 plugin_practice_snapshots 新记录。
- 320px 宿主与 iframe 无横向溢出；页面脚本错误为零。

截图与 JSON 报告：`/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/skill-practice-evidence/`。

主要截图：`practice-before-submit-desktop.png`、`practice-reference-incorrect-desktop.png`、`practice-reference-correct-320px.png`、`practice-reset-320px.png`。固定 HTML 的验证不代表所有真实模型都会稳定生成正确练习，仍需模型端遵守技能。

## 首次归属交付修复与边界

### 新聊天会话投影的首次 widget 交付时序

修复前首次直接打开刚生成的作品时，真实浏览器测试曾两次出现「预览失败：此交互讲解已修改或删除，请重新打开」。服务器任务 completed、show_widget 载荷已经落库且没有脚本错误；当时手动 `flushCloud()` 后刷新才通过。历史失败证据保留为 `practice-setup-failure.png`，不代表最终实现。

根因与修复：

1. `apps/web/src/pages/CourseChat.tsx` 新 session 投影传给 `WidgetMessage` 的 `rowId`，可以早于旧 `db.chats` 的已确认投影到达。
2. 原 `openWidgetSession` 只做一次 `db.chats.get(rowId)`；归属行/源码版本尚未到达时立即拒绝。现在仅首次 admission 可选择 `waitForSource`：使用 `liveQuery(() => database.chats.get(rowId))`，匹配真实 assistant 行、精确 HTML、依赖和宿主 widget ID 才建立绑定，不拉取整账户、不复制 session journal 业务事实。
3. `WidgetBlock` 为本次绑定传入 AbortController，超时或卸载即 abort。`waitForWidgetSource` 同时监听账户 lifetime 信号；成功、错误、取消、超时均取消订阅、移除监听并清理 timer。等待沿用 `WIDGET_READY_TIMEOUT_MS=12000`，不会永久 pending；超时后用户可重试。
4. 绑定后的 read/save/observe 不使用等待；源码改版或归属删除仍立即由 `assertSession` 拒绝。WeakMap scope 额外保存原账户 lifetime，A→B→A 即使 DB 对象没变，旧绑定也不能再读取/保存。

上述修复只改 widget 领域；未改 CourseChat、session-store、courseChat 或 cloud 文件。未恢复全局 flushCloud gate，未丢弃 rowId 绕过归属验证。

最终 skill e2e 已移除首次生成后的 flushCloud + reload workaround，改为验证真实延迟投影自动 handoff；后面的刷新仅用于验证用户状态恢复。额外 ownership e2e 检查取消/卸载/超时后的目标 key 查询次数不再增加，证实订阅已释放；新投影到达不会复活已取消 iframe。既有 protocol 回归继续覆盖真实保存、源码编辑和删除保护。新证据为 `practice-waiting-for-ownership.png` 与 `ownership-report.json`。

### 已安装技能内容

现有 system-skill-records 有意不覆盖已安装（可能用户改过）的内置技能。新账户可安装并读取新增 practice.md（已测）；既有服务器聊天会直接收到更新的 SERVER_WIDGET_RULE，无须 node.ts 改动。若用户要把完整示例带入其已有技能，应显式更新对应技能文件，不能静默覆写其修改。本任务未改技能迁移策略。

## 父代理独立审查

- 已复核首次绑定的按主键观察、成功/超时/取消清理、账户 lifetime 检查，以及首次实时交付、保存与重练的浏览器断言和截图。首次生成测试已不使用全账户 flush 或刷新绕过问题。
- 发现并修复原生 skill 的参考路径重复目录问题：`skillRefs.path` 已含 `references/`，旧 runtime 再追加一层，导致技能正文写明的 `/skills/交互式讲解/references/practice.md` 无法读取。`apps/api/runtime/skills.ts` 现在以包内原路径发布和解析引用；未扩大技能范围或文件读取权限。
- 新增 `scripts/test-skill-reference-routing.mjs`，以真实安装的内置包验证 URI 编码/中文名称、正文列出的规范路径、完整示例读取及范围拒绝。更新 `test-server-skill-activation.mjs` 使用规范引用路径，保留原生 chat/QA、按需加载、权限与压缩后的技能恢复断言。
- 父代理实际执行通过：`npx tsx scripts/test-skill-reference-routing.mjs`；`node scripts/build-runtime.mjs`（工作目录 `apps/api`）；`npx tsx scripts/test-server-skill-activation.mjs`。原生激活脚本首次在未重建的 runtime bundle 上失败，重建后原断言通过。
