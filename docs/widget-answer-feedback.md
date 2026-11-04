# 交互式题卡反馈回传：实现与验证

## 修改文件

- `apps/web/src/harness/widgetProtocol.ts`：v1 feedback envelope、类型/JSON 深度/节点数/UTF-8 大小限制、作答身份和更新顺序校验。
- `apps/web/src/harness/widgetRuntime.ts`：只读 `answerFeedback`、`wbw:feedbackchange`、初始化/异步同步和旧 HTML 的纯文本反馈展示；保留 sandbox、opaque origin、CSP，拒绝合成消息事件。
- `apps/web/src/harness/quizFeedback.ts`：仅从宿主题目与已提交 picks 重建判定；AI 参考及主观题保持非权威待核验。
- `apps/web/src/components/WidgetBlock.tsx`：受限反馈 prop、ready 同步、拒绝重复作答请求、答案大小限制、BroadcastChannel 同步。
- `apps/web/src/components/QuestionInput.tsx`：草稿与正式提交分离、宿主确认提交、标准控件降级。
- `apps/web/src/components/QuizCard.tsx`：连接真实判分结果，明确聊天参考批改不能自动回填；不新增成绩或错题写入流程。
- `apps/web/src/pages/WidgetPreview.tsx`：校验并接收独立预览反馈，刷新重新握手，不把反馈放入 URL。
- `apps/web/src/harness/tools.ts`、`packages/study-core/assets/builtin/interactive-explainer/references/runtime.md`、`packages/study-core/assets/builtin/question-bank/SKILL.md`：模型提示与运行时协议规范。
- `scripts/test-widget-feedback.mjs`、`scripts/e2e-widget-feedback.mjs`、`scripts/test-widget-runtime.mjs`、`package.json`：测试与运行入口；旧运行时测试补齐主题所需 DOM 替身。

## 验证结果

通过：

- `npm run typecheck -w @wangke/web`
- `npm run test:widget-feedback`
- `npm run test:widget-feedback:e2e`（Chrome）：真实 QuizCard 正确/错误/待核验、刷新恢复、标准降级、旧 HTML、非法/过大反馈、非权威参考、部分正确异步更新、合成事件伪造、独立预览实时同步及刷新。
- `npx tsx scripts/e2e-widget-protocol.mjs`
- `npx tsx scripts/test-widget.mjs`（24 项通过）
- `npx tsx scripts/test-widget-state.mjs`
- `git diff --check`

未全通过，未做无关修复：

- `npm run test:wrongbook`：7 项通过、3 项失败，均为 Dexie `SubTransactionError: Table segments not included in parent transaction.`，与本任务未修改的存储事务有关。
- `npx tsx scripts/test-quiz.mjs`：前 21 项数据层检查通过；后续 Node 组件打包测试因依赖中的 `window.addEventListener("wangke:bot-session-ended", …)` 报 `window is not defined` 中断。真实组件由新增浏览器端到端测试覆盖。

## 限制与边界

- 聊天 AI 回复没有可靠的原 iframe 关联回填通道。发送参考批改只进入聊天，原题保持待核验；不伪造反馈，不修改成绩或自动错题记录。原有显式自评流程不变。
- 协议可传 partial/review；现有宿主客观题判分器仍是对/错，不凭空制造部分分。AI review 仅供未来受信宿主接入，当前不从聊天文本提取。
- 恢复依赖上层既有 picks 持久化；历史 picks 无提交时间时 timestamp 为 0。一次挂载绑定一次作答身份，新题/新尝试须新建题面。
- 独立预览只读同步反馈，不新增跨窗口作答权限；原窗口关闭后不能获取新反馈。
- iframe HTML 不可信，能改写自身 DOM；只读桥接和宿主题卡结果才是数据边界，不承诺不可信页面能作为不可伪造的成绩凭证。
