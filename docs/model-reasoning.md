# 模型思考控制与推理摘要

适配规则核对日期：2026-11-03。规则集中在
`packages/study-core/src/api/reasoning.ts`，浏览器和服务端共用；目录能力不等于实际接口协议。

## 三个不同的概念

- **思考投入**：开关、effort 或 token 预算。提高投入不保证回答更长，也不保证返回思考文本。
- **可展示的推理**：供应商主动返回的思考文本或摘要。OpenAI 不返回原始思考链；Responses 需请求 `reasoning.summary: "auto"`，是否实际返回仍取决于模型和账号权限。
- **续接状态**：签名、加密推理、原生内容块和工具调用顺序。它们不是用户可读内容，不能解码后当作摘要展示，也不能跨供应商回放。

## 请求适配

调用方传 `thinkingLevel`（`none/minimal/low/medium/high/xhigh/max`）意图，不拼厂商字段。
界面从 `reasoningChoices(target)` 取得当前模型合法档位：只有开关的模型显示开关；不可关闭的模型不显示「不思考」；未知接口不编造旋钮。

| 接口 | 思考控制 | 可读推理与续接 |
| --- | --- | --- |
| OpenAI Chat Completions | `reasoning_effort`，输出上限用 `max_completion_tokens` | 通常没有可读推理；不要把「无摘要」判断为 effort 未生效 |
| OpenAI Responses | `reasoning.effort`；启用时请求 `reasoning.summary: "auto"` | 读取 reasoning item 的 `summary_text`；`store:false` 配合 `reasoning.encrypted_content` 无状态续接 |
| Claude Messages（adaptive） | `thinking.type: "adaptive"`，深度放在 `output_config.effort` | 展示 `thinking` 文本，保留完整签名和 `redacted_thinking` 块 |
| Claude Messages（旧预算） | `thinking.type: "enabled"` + `budget_tokens` | 预算至少 1024 且严格小于 `max_tokens`；映射时给答案预留空间，输出上限不足则本地报错 |
| DeepSeek 原生 Chat | `thinking.type`；V4 等已核对模型使用 `reasoning_effort` | 展示并在同一目标工具续轮保留 `reasoning_content` |
| DeepSeek Responses | `reasoning.effort`，不强加 OpenAI 专属摘要字段 | 同时支持 reasoning item 的 `reasoning_text` 与流式对应事件 |
| Kimi 原生 Chat | K2.5/K2.6 用 `thinking.type`；K3 系按文档使用 effort | 区分可切换、始终思考与仅开关的模型，保留工具续轮推理 |
| GLM 原生 Chat | `thinking.type` 和模型对应的 `reasoning_effort` | GLM-5.3 始终思考，仅展示 `low/high/max`；不发送关闭参数 |
| DeepSeek/GLM Messages 兼容接口 | `thinking.type`，effort 放在 `output_config.effort` | 使用 Messages 原生内容块续接；兼容接口必须由供应商实际提供 |
| 百炼 Qwen / SiliconFlow Chat | `enable_thinking`；预算模型用 `thinking_budget`，effort 模型用 `reasoning_effort` | 预算范围来自对应供应商目录；不把同名模型另一家接口的参数套过来 |
| Gemini OpenAI 兼容 Chat | `extra_body.google.thinking_config`；2.5 用 budget，3+ 用模型支持的 level；请求 `include_thoughts` | 展示返回的摘要；保留消息和工具调用上的 `extra_content` / thought signature |
| OpenRouter Chat | `reasoning.enabled/effort/max_tokens/exclude` | 展示可读 `reasoning` / `reasoning_details`，完整保留加密 details 供续接 |
| MiniMax Chat | `reasoning_split:true`，M3 按能力使用 `thinking`；M3.1-Flash 支持 effort | M2.x 不伪造深度或关闭能力；M3.1-Flash 不允许关闭 |
| MiniMax Messages | `thinking.type: "adaptive"`，effort 位于 `output_config` | 原生块续接 |
| xAI | 按已核对模型发送 `reasoning_effort`（Responses 为 `reasoning.effort`） | 不添加 OpenAI 摘要请求或通用 `enable_thinking` |

这不是「任意模型 × 任意协议」的兼容承诺。用户仍须选择供应商实际提供的端点和协议；本项目未增加 Gemini 原生 generateContent 协议。

### 模型例外与保守行为

- GPT-5、o 系列及部分 GPT-6 模型不能关闭思考；旧的关闭设置映射为最低合法档位。`max` 和 `xhigh` 是不同档位，不再统一改名。
- GPT Pro 的 Responses-only 限制、GPT-6 部分模型的 Chat 工具调用限制会在请求前给出切换 Responses 的提示，不自动切换端点。
- Claude 4.6 等使用 adaptive；4.5 等使用预算。新一代始终思考模型不发送 `disabled`；允许关闭但限制 effort 的 adaptive 模型在关闭时使用 `high`。
- SiliconFlow 文档点名的 `Pro/deepseek-ai/DeepSeek-V4`、`deepseek-ai/DeepSeek-V4-Flash`、`Pro/zai-org/GLM-5.2` 覆盖目录中的错误预算声明，使用 `high/max`；此规则仅限该供应商。旧 `xhigh` 意图按其文档映射到 `max`。
- 已识别官方域名优先确定接口提供方；其他连接使用配置的供应商标识。Gateway 用公开的 `reasoningProvider` 提示保留接口类型，不传私有地址或凭据。
- 用户能力覆盖能禁用推理或更改努力等级，但不会把一个供应商的协议字段变成另一个供应商的字段。元数据目录覆盖也不是接口提供方覆盖。
- 未知接口只发送已声明的标准 effort；不因名字相似猜测 `enable_thinking`、预算字段或私有思考开关。未设置档位时保留供应商默认，不擅自选择投入。
- 对拒绝/忽略采样参数的思考模型省略 temperature，而非强制发送统一值。

## 返回、持久化与服务端

Bot 与 Chat 不再各自维护协议编解码：

- 请求统一调用 `packages/study-core/src/api/modelClient.ts` 的 `requestBody()`，包括消息清理、工具 schema、图片、缓存、输出上限、采样参数和思考参数。
- JSON 响应及流式接口返回 JSON 的降级响应统一调用 `decodeResponse()`；SSE 仍由同一共享客户端解析。Bot 当前使用非流式调用，不为它再实现一套 SSE 解析器。
- `ModelAdapter` 仅转换 Bot 本地工具 ID、连接/部署信息和运行时结果，不再实现三种协议的请求拼装和响应解析。`botRequest` / `botReply` 仅保留为委托共享编解码的旧入口。
- 服务端 Bot 与 Chat 共用同步思考偏好的读取规则和已保存模型的能力覆盖；Bot 每次执行捕获思考意图，工具续轮不随中途偏好修改而漂移。显式有效意图优先，非法或缺失时回退同步偏好。
- 编解码一致不意味着运行策略完全相同：Bot 拒绝截断的工具调用，视觉任务可保留有标记的部分文本；Chat 保留结束原因交给其循环处理。计费、重试、取消和路由仍由 Gateway 管理。

共享客户端同时处理 SSE 和返回 JSON 的「伪流式」网关；摘要的 delta、done、最终 snapshot 合并时去重。
最终正文与推理文本分别进入 `content` 和 `reasoning_content`，签名和加密内容只放在 `providerState`。

原生状态仅在 `providerId + baseUrl + model + protocol` 全部一致时回放；换模型或连接后仅保留可移植的正文和工具历史，不泄漏原供应商状态。
服务端用 `stateScope` 中的端点指纹代替私有 `baseUrl` 绑定状态，Bot 检查点不会因此暴露上游地址或凭据；即使连接 ID 不变，更换端点也会丢弃旧状态。
浏览器 Gateway 目标在转换代理地址前保留真实连接/部署的供应商提示，并用不透明配置版本隔离状态；不能把代理域名或用户选的目录误当成实际接口提供方。
这沿用项目已有的原生续接通道，而不是把可见摘要重新伪装成签名推理。

课程聊天、问答以及续写的远程任务携带 `thinkingLevel` 快照。服务端优先使用有效快照，缺失或非法时读取同步偏好；主循环和强制收尾使用相同意图。
不能只修浏览器直连，否则服务端执行和跨设备恢复仍会退回模型默认。

## 参考资料

### 官方文档

- [OpenAI reasoning / summary / encrypted continuation](https://developers.openai.com/api/docs/guides/reasoning)
- [OpenAI 最新模型与协议限制](https://developers.openai.com/api/docs/guides/latest-model)
- [Claude thinking 类型与各代差异](https://platform.claude.com/docs/en/build-with-claude/thinking)
- [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- [Claude extended thinking 与预算约束](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)
- [DeepSeek thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api)
- [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini thinking](https://ai.google.dev/gemini-api/docs/thinking)
- [百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)
- [SiliconFlow Chat API](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)
- [Kimi thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models)
- [GLM-5.3](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)
- [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
- [MiniMax OpenAI compatibility](https://platform.minimax.io/docs/api-reference/text-openai-api)
- [MiniMax Anthropic compatibility](https://platform.minimax.io/docs/api-reference/text-anthropic-api)
- [xAI reasoning](https://docs.x.ai/docs/guides/reasoning)

### 开源实现交叉核对

通过 Context7 检索下列文件的源码片段与类型声明，核对字段层级和状态回放；不是直接引入整套 SDK，也不把 SDK 默认行为当作供应商协议承诺。

- [Vercel AI SDK：OpenAI Responses](https://github.com/vercel/ai/blob/main/packages/openai/src/responses/openai-responses-language-model.ts)：独立的 effort / summary 参数及加密续接。
- [Vercel AI SDK：Anthropic Messages](https://github.com/vercel/ai/blob/main/packages/anthropic/src/anthropic-messages-language-model.ts)：adaptive / enabled 的请求字段与采样限制。
- [Vercel AI SDK：Google history conversion](https://github.com/vercel/ai/blob/main/packages/google/src/convert-to-google-messages.ts)：thought signature 随原生内容回放。
- [Anthropic TypeScript SDK：Messages 类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)：`output_config.effort` 与 thinking 配置分离。

### Pi / OpenChamber 源码对照

本轮另行读取仓库源码，固定核对版本：Pi `642e30b68930a644050794011555a04ed9027eb4`；OpenChamber `782ae0dde489252468729e73529ab441f530a30e`。没有直接引入它们的 SDK 或复制整套运行时。

- [Pi transform-messages](https://github.com/badlogic/pi-mono/blob/642e30b68930a644050794011555a04ed9027eb4/packages/ai/src/api/transform-messages.ts)：统一消息边界；思考和签名仅在原 provider/API/model 上保留，切换目标后保留正文与工具历史。本项目额外绑定连接和端点，现有 `messageHygiene.ts` 负责孤儿工具修复与残缺轮次处理。
- [Pi Chat Completions](https://github.com/badlogic/pi-mono/blob/642e30b68930a644050794011555a04ed9027eb4/packages/ai/src/api/openai-completions.ts)：`reasoning_content` / `reasoning` / `reasoning_text` 选第一个非空字段，避免兼容代理重复展示；推理 details 不仅按 index 合并，还要区分类型和不同 ID，防止加密状态串块。本项目已补齐这些边界。
- [Pi Responses](https://github.com/badlogic/pi-mono/blob/642e30b68930a644050794011555a04ed9027eb4/packages/ai/src/api/openai-responses-shared.ts)：完成事件可提供完整工具参数，不能只依赖 delta；未收到原生终止事件或工具参数尚未完成时，不能作为成功工具调用交出。本项目统一处理 arguments.done、item.done 和最终 output，保留截断结束原因供运行时处置。
- [Pi Anthropic](https://github.com/badlogic/pi-mono/blob/642e30b68930a644050794011555a04ed9027eb4/packages/ai/src/api/anthropic-messages.ts)：内容块与增量独立处理。本项目补齐 block start 已携带文本或工具 input 的情况，后续 JSON delta 不与初始 `{}` 拼接。
- [OpenChamber 主聊天调用](https://github.com/openchamber/openchamber/blob/782ae0dde489252468729e73529ab441f530a30e/packages/ui/src/lib/opencode/client.ts)：先应用模型/agent 选择，再调用 OpenCode session prompt；它不是主聊天供应商协议适配器。可借鉴的是模型与 variant 一起传递，而不是在 UI 重做模型协议。
- [OpenChamber 实际模型选择](https://github.com/openchamber/openchamber/blob/782ae0dde489252468729e73529ab441f530a30e/packages/ui/src/lib/messages/userModelChoice.ts)：以 assistant 记录的实际 provider/model/variant 为显示依据；[模型元数据缓存](https://github.com/openchamber/openchamber/blob/782ae0dde489252468729e73529ab441f530a30e/packages/web/server/lib/opencode/models-metadata.js)与运行时协议分离。目录不能取代端点实际能力，这与本项目区分元数据和 `reasoningProvider` 的方向一致。

## 回归验证

```sh
npm run test:thinking
npx tsx scripts/test-model-overrides.mjs
npx tsx scripts/test-prompt-cache.mjs
npm run test:model-gateway
node scripts/test-message-hygiene.mjs
npm run build:web
```

`test:thinking` 包括离线协议契约测试、`test-model-protocol-parity.mjs` 的 Bot/Chat 一致性测试，以及真实 BotRunner、服务端任务执行器、Gateway、SQLite 持久化与注入传输的集成测试。
覆盖各供应商请求参数一致性、三协议图片编码、JSON/伪流式解码、工具 ID 转换、工具续轮、聊天、问答、收尾、续写、快照优先级、偏好回退、推理保存、摘要去重，以及换连接/端点/模型/协议后的状态隔离。另覆盖空推理别名、同索引的异类/异 ID 推理块、Responses 完整工具参数快照与残缺调用拒绝、原生终止标记和 Claude 初始内容块。

以上是离线验证，不代表每个付费模型、账号权限和第三方代理均已实测；没有使用真实 API Key 发起计费请求。
后续新增模型应先核对官方支持列表，再增加明确规则与离线夹具，而不是仅扩宽名称正则。
