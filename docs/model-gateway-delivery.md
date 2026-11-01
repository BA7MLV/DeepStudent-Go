# Model Gateway 实施记录

状态：实施中，未达到整体验收；没有提交、推送、部署或调用付费真实模型。

## 已落地边界

- `packages/contracts/src/model-gateway.ts`：用途、引用、Preset、Deployment、请求/结果、错误分类、attempt 摘要。
- `apps/api/src/agent/model-adapter.ts`：三协议文本/工具/continuation/图片；ASR multipart；私有连接凭据；按模型覆盖协议/部署地址。
- `model-target-resolver.ts`、`model-gateway.ts`、`model-circuit-breaker.ts`：用途与显式引用、候选顺序、有限重试、策略约束 fallback、上下文检查、预算和进程内熔断。
- `model-gateway-runtime.ts`：Node 任务虚拟目标/受控 fetch。虚拟地址不接触网络，Key 与真实 Provider URL 不再交给任务模型 codec。
- `cloud/routes.ts`：旧 `/cloud/models/:provider/*` 保留兼容；规范 `/cloud/model-gateway/providers/:provider/*` 与 `/request`；只解析保存的 Provider ID，不转发 caller Authorization，不跟随重定向。
- `cloud/model-presets.ts`、`cloud/config.ts`：旧默认槽投影为内置 Preset；命名 Preset/用途默认加密持久化及 revision/CAS；删除失效引用阻止原子保存。
- `apps/web/src/cloud/ModelPresets.tsx`：候选编辑/排序/移除、用途默认、跨供应商开关；共享模型设置草稿及冲突处理，不持久化凭据。
- Gateway route 事件复用有界 `cloud_audit`，不新造计费账本。`/model-gateway/status` 返回本用户最近路由、候选引用和熔断；`/preview` 不执行模型请求；`/model-presets` GET/PUT 支持整组 CAS。

## 可靠性与计量

- Canonical 请求通过 Gateway 控制重试；每个物理请求的 ModelClient attempts 固定为 1。
- Bot/子任务使用原 UsageLedger；普通流量只写 model_observations，不借用 Bot 预算。未知用量保持未知，不记为零。
- Native 桥保持 SSE 字节和原生工具语义；Response 返回后不重试，即使还没消费到第一段正文。这个边界比首个可见 chunk 更保守。
- Native 精确目标不会跨协议迁移 payload；跨模型/协议 Preset fallback 目前通过非流式 canonical request。
- Native ASR multipart 在服务端限 20 MiB 音频（另限 multipart 包装大小）解析并覆盖为已选模型，防止上传字段和账本模型错配；原始一次性流即使解析为 FormData 也不会获得重试权限。
- 一次性上传只尝试一次；网络、SSE 失败和取消不返回原供应商异常内容。
- Prompt cache 在 Adapter 使用真实部署信息决定，业务 codec 的虚拟地址不能改变既有缓存策略。
- 普通请求、Bot 请求、fallback 的每次物理请求分别计量；route/audit 事件不再计费。

## 已有验证证据

- `npm run test:model-gateway`：最终 45 项通过（原 32 项 + Go 13 项）。覆盖三协议原生 SSE 字节/终端 usage、fallback、预算、隔离、SSE 首段后失败、累计 usage 单次结算、取消传播、流读取 deadline、backoff 取消脱敏、一次性上传、ASR/原生 JSON 模型归属绑定、拒答/截断、Deployment 与 Preset CAS/重启及 HTTP 安全。
- `npm run test:model-settings`：通过配置、草稿、12 项 discovery 与官方模型匹配回归。
- `npm run test:usage && npm run test:cloud && npm run test:browser-worker`：通过。
- 最终 `npx tsc -b`、`npm run build`（4 个 workspace）、完整 task executor 和模型设置 E2E 链已通过，包含最后补充的浏览器 Deployment codec / conversationId 透传。构建仍有原有 CSS `:is()` 和动态/静态 import 混用警告。
- `npm run test:model-settings:e2e`：通过，含 Preset 草稿创建、保存、重载、删除及现有设置页/移动布局回归。
- `npx tsx scripts/test-task-executors.mjs`：通过，含缓存、三协议、工具历史、取消/恢复及真实 FFmpeg。中断 fixture 现在连续模拟三次断连以耗尽 Gateway 重试预算；原有失败恢复断言未删除，新增三次请求体一致断言，保证不重放工具轮。
- `npx tsx scripts/test-bot-continuity.mjs`：独立通过。
- `npx tsx scripts/test-gateway-review.mjs`：全部通过。修复迁移造成的旧显式视觉目标误拒绝，仅对已保存精确目标兼容 chat 目录标记；任意视觉引用和新 fallback 候选仍做能力检查。
- `npm run test:bot:hardening`：全套通过，包含迁移、9 项 timeout、服务、生命周期、请求预算和保留策略。预期故障注入的安全错误日志不等于测试失败。
- `npx tsx scripts/test-bot-request-budget.mjs`：通过；Responses 视觉 fixture 补齐真实响应的 `type: message` / `role: assistant` 字段。保留所有原预算断言，并恢复视觉空响应旧错误与显式截断标记。
- 记忆/上下文回归与 22 项图片批处理回归通过，详见本次会话命令记录。

## 未消除的验收项

- Task executor 迁移暴露的 `prompt_cache_key` 丢失已修复，并已通过执行器回归。
- Preset UI E2E 首次暴露供应商 select 可访问名称不精确，已添加明确 aria-label，重跑通过。
- 历史 `test-bot-runtime.mjs:100` 的 `19 !== 17` 在最新并发工作区重跑时已不再阻断，runtime 部分通过；`test-bot-conversation.mjs:135` 的 failed/completed 仍阻断整套 `test:bot`。该 conversation 失败此前用 HEAD Runner 配合当前其余工作区模块同样复现；本任务没有修改或跳过这项断言，这只是局部基线对照，不代表整个 HEAD 分支测试结果。
- `npm run test:cloud:e2e` 在初始化「开始」按钮前超时；该脚本直接访问纯 API 端口，未采用当前单独 Web fixture。未算通过，也未更改整个旧 E2E 流程。
- 已增加用途级 fail-closed 灰度停用开关、健康/路由/上游费用元数据 UI 和普通流首字节耗时。它不是绕过 Gateway 的旧实现切换；按 Worker/任务来源细分灰度、Bot 流 TTFT、精确首个文本 Token 识别与最终全路径 E2E 仍未完成。计划未完成阶段保持未勾选。

## OpenCode Go 官方核对（2026-11-01）

- 当前 V2 文档的正确地址为 `https://opencode.ai/v2/docs/console/go` 和 `https://opencode.ai/v2/docs/console/api/inference`，不是 `/v2/docs/go`。
- Discovery：`https://opencode.ai/inference/go/v1/models`。
- Responses/Chat：`https://opencode.ai/inference/go/openai/v1/{responses,chat/completions}`；Messages：`https://opencode.ai/inference/go/anthropic/v1/messages`。Google native 另有 `/google/v1beta/models/<model>`，首期仅保留扩展边界。
- 文本模型可由 Console 在 API 家族之间转换；目录清单不是账户授权。不能静态固定模型授权或从名字猜协议。
- 必须自有 User-Agent 和绑定稳定 conversation 的 `x-opencode-session`，不能取 retry/run ID。
- `usage.opencode.allowance` 是本请求占用套餐月额度的美元值，不是账户剩余额度；`cost`、`billing_source`、`list_cost`、`estimated` 必须与本地预算区分。
- 真实订阅验收需用户提供服务器环境/本地 secret；当前没有注入或读取真实订阅 Key。官方面向 coding-agent 流量，学习类业务使用前需确认服务适用范围。
- Go connector 已实际接在统一 Gateway/Adapter 后，无 runner/study 的 Go 专用请求分支；真实订阅验收仍未完成。

## OpenCode Go 配置与交付（本轮新增）

### 服务端环境与连接

1. 单 Key 部署只需在 API 进程的私密环境配置 `OPENCODE_GO_API_KEY`。不要把 Key 发到聊天、前端同步配置或仓库；环境密钥不会写入数据库。该 Key 对服务端可访问的账号生效。
2. 设置 → 模型 →「添加 OpenCode Go（服务端环境密钥）」注册内置 `opencode-go`。密钥缺失也可保存连接并发现目录，但不能推理。此连接不接受普通模型编辑器回传的 Key；需要多 Key 时使用下方账户管理。
3. 使用现有模型列表刷新（服务端固定 `https://opencode.ai/inference/go/v1/models`），选择动态模型 ID。目录只供发现，不证明订阅、区域或模型授权。默认 Chat 转换，不硬编码模型清单；可通过已有带 `modelRevision` CAS 的 `PUT /api/v1/cloud/providers/opencode-go` 配置按模型 Deployment：

```json
{
  "modelRevision": "<当前 config 的 revision>",
  "provider": {
    "id": "opencode-go", "name": "OpenCode Go",
    "protocol": "openai-chat",
    "baseUrl": "https://opencode.ai/inference/go/openai/v1",
    "catalogId": "", "serves": ["chat"],
    "deployments": [
      { "model": "<discovery 返回的精确 ID>", "protocol": "openai-responses", "dataPolicy": "eu-us-no-training-retain30", "allowFallback": false }
    ]
  }
}
```

协议可为 `openai-chat`、`openai-responses`、`anthropic-messages`，由 Adapter 固定路由到官方 OpenAI/Anthropic 家族端点。即便保存了自定义 baseUrl/Deployment URL，也不能改变 Go 实际出口或带走凭据。Google native 没有实现 codec，会明确拒绝，不宣称支持；经 Console 文本转换与原生 Google 是不同能力。

### 会话与 fallback

- Canonical `/model-gateway/request` 传 `conversationId`；native HTTP 出口传 `x-wangke-conversation`。Gateway 生成 owner 隔离的稳定摘要作为 `x-opencode-session`，同一会话跨 run/retry/模型协议保持稳定，项目 UA 固定为 `wangke-model-gateway/0.1`。不转发 caller 的 Authorization、User-Agent 或 x-opencode-session。
- Bot 使用 thread，视觉/记忆继承所属 thread；Node QA 使用 sessionId，其余任务使用逻辑 task ID（重试不变）。Browser Worker 若未明确提供 conversation header，使用其服务端已授权逻辑 task ID。无会话的直接推理失败关闭，不生成每次请求随机 session。
- Go 可进入普通 Preset。默认未知 policy 或未显式许可的 Go Deployment **不能自动进入或离开 fallback**。管理员必须核对 Console 的 restricted/region、训练和数据保留条件，再设置明确组合 `dataPolicy` 和 `allowFallback:true`；所有候选 policy 必须完全一致，且 Preset 不得禁止跨 Provider。标签不是自动地理定位或供应商授权证明；上游 401/403/402/明确 quota 类 429 均不会 fallback。
- Native 流在 Response 返回后即禁止重试，比首字节边界更保守；Canonical 保留现有有限重试/fallback。无副作用轮重放。

### Provider 多 Key 账户

- 所有 Provider 都支持多个服务端保存的 Key。设置页可添加账户名称和 Key、手动启用或删除账户；当前激活账户的 Key 只在 API 进程内解密使用，浏览器只看到账户 ID、名称和 configured 状态。OpenCode Go 另支持用 `OPENCODE_GO_API_KEY` 作为无账户的单 Key 入口。
- 账户凭据与现有 CloudConfig 一起加密保存，并受 `modelRevision` CAS 保护；模型设置保存不会覆盖账户凭据。环境变量 Key 可作为无账户时的简单默认连接。
- 多 Key 当前是手动切换，不默认自动轮换；这样不会无声绕过供应商额度、区域或审计边界。后续若需要账户级 fallback，应单独配置并记录切换原因。

### 用量、管理与灰度

- `usage.opencode.allowance` → `billing.allowanceUsd`；`cost`、`list_cost`、`billing_source`、`estimated` 独立保存为上游报告元数据，支持三协议 JSON/SSE。继续用 `bot_requests` / `model_observations` 结算，元数据关联原 requestId 写有界 `cloud_audit:model.metric`，不新增账本、不改变本地价格预留。
- `/model-gateway/status` 和设置页「刷新路由与用量」展示 owner 隔离的熔断、最近路由/错误/attempt 耗时、最近请求及上游费用。普通 SSE 的首字节耗时仅是 transport 指标，**不是 TTFT**；Bot 流该项未知，不能假称测得。
- 展示套餐本请求占用和上游报告扣费，不展示伪造的余额或剩余额度。5 小时/周/月限额与 Extra Usage 在 Go Console 管理，本地 Token/费用预算独立执行。审计有保留上限，不可据此重建订阅账单。
- `MODEL_GATEWAY_DISABLED_PURPOSES=chat,vision,asr,decision,memory` 可先只放行 Bot；逐步移除用途放行。停用后拒绝新请求，但保留 discovery/preview/status，不回退到绕过认证/计量的直连。默认空值全用途启用；正在执行的请求不被此环境开关追溯取消。

### 改动文件与验证范围

- 新增 `agent/opencode-go.ts`、`agent/model-metrics.ts`、`agent/model-rollout.ts`、`cloud/ModelGatewayStatus.tsx`、`scripts/test-opencode-go.mjs`；扩展 Go 账户的加密保存、切换/删除 API 与设置页。
- 扩展 Adapter/Gateway/resolver、配置与 HTTP routes、原 budget/observations、shared usage、通用任务/视觉/记忆 conversation 归因、模型设置页、测试脚本。没有修改无关材料标注、聊天 UI 或用户的 Bot 同步实现。
- Go fixture 最终 13 项通过。覆盖 owner 密钥隔离、环境 Key 不落库/响应、固定 discovery/协议端点、自有 UA、稳定 session、429/额度/鉴权/不存在模型、policy fallback、首段后失败不重放、三协议 SSE allowance 单次记录、原生 JSON 模型归属绑定和灰度拒绝。没有读取真实 Key 或调用付费服务。
- 最终命令链 `npx tsc -b && npm run build && npm run test:model-gateway && npm run test:model-settings && npm run test:usage && npx tsx scripts/test-task-executors.mjs && npm run test:model-settings:e2e` 全部通过。设置 E2E 包括 Go 添加/重载、官方 discovery、自有 UA 与健康 UI；另行复跑设置/usage/task/E2E 链也通过。`test:cloud`、`test:browser-worker`、`test:bot:hardening`、gateway-review、bot-continuity 与 `git diff --check` 通过；`test:bot` 和 `test:cloud:e2e` 仍按上文位置失败，未删断言。整体验收未完成，不把 Go 实现与真实订阅验证混为一谈。

### 需用户提供 / 未验证

需要目标 API 运行环境、私密注入的真实订阅 Key（单 Key 或多个账户 Key），以及学习业务适用范围和 Console privacy/region/Extra Usage 的确认。尚未验证真实模型授权/质量/成本、真实受限区域行为、真实 5 小时/周/月限额、Extra Usage 扣费、多实例部署与真实订阅 SSE。官方文档未给出所有额度错误代码，未知 429 保守按 rate-limit 处理；不通过供应商自由文本猜测账单状态。
