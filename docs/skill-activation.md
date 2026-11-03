# Chat skill activation

Chat distinguishes permission scope from explicit activation:

- **Automatic scope** (`ChatSessionRow.skillIds`): unchanged three-state allowlist. Missing means all enabled skills, `[]` means none, and an ID list limits automatic discovery and resource reads. Only metadata is advertised; the model reads relevant bodies on demand.
- **Use this turn** (`turnSkillIds`): composer-only selection, consumed by the next submitted turn. The host loads complete instructions before the model request, without waiting for a model tool call.
- **Pin to conversation** (`ChatSessionRow.pinnedSkillIds`): explicit instructions loaded again on each turn, including after refresh or history compression. Unpinning affects subsequent turns.

The two explicit selections are merged and deduplicated, then checked against enabled skills and the existing allowlist. A selection never broadens the allowlist or authorizes MCP tools. Missing, disabled, empty or out-of-scope skills and unavailable declared MCP dependencies produce visible errors rather than silent fallback.

`apps/web/src/skills/activation.ts` is shared by library chat, the course panel and the browser QA runner. Native account-mode tasks use `apps/api/runtime/skills.ts` to resolve the owner's live packages, with the same scope/activation separation and lazy reference reads. Instructions are separate user-level context, not elevated above system rules. Full bodies and a reference path listing are injected outside historical context selection. No character truncation is applied; context overflow fails with a reduction/switch-model message.

Native library chat and video/material QA use `apps/api/runtime/mcp.ts`, backed by the same host-owned `McpManager` as HTTP chat and BotRunner. HTTP/SSE/stdio, OAuth, tool validation, resources/prompts and large-catalog gateways therefore share the existing implementation and connections. Session MCP scopes retain their three-state semantics (missing = all enabled owner connectors; `[]` = none; IDs = allowlist), are read from owner records rather than task payloads, and are rechecked for every call. Required Skill dependencies are validated against the connected, authorized catalog before sending instructions. Failed discovery is recorded as a tool warning; MCP `isError` and timeout failures are recorded as errors without automatic replay. Task cancellation propagates to the MCP call. Plain-text continuation revalidates Skill dependencies but remains tool-free. Bot child study tasks do not expose MCP connectors: external calls remain in BotRunner's per-call approval flow, preserving project isolation.

One-turn instructions are deliberately excluded from historical model traces, so they do not become sticky on later turns. User rows store explicit IDs for regeneration and interrupted/resumed turns; replay revalidates current permissions and loads current contents. Queued turns and remote task payloads carry IDs, not caller-supplied instruction bodies. Pinned choices follow session switches and forks; a new conversation starts without them.

The picker shows available versus selected/pending-load states. Completed host loading steps appear in the existing tool trace as “加载技能”; this means the instructions were loaded, not that model adherence or reference loading is guaranteed.

Verification (Vite dev server required):

```sh
npm run dev -w @wangke/web -- --host 127.0.0.1 --port 5196 --strictPort
BASE_URL=http://127.0.0.1:5196 node scripts/e2e-skill-activation.mjs
BASE_URL=http://127.0.0.1:5196 node scripts/e2e-skill-picker.mjs
node --import tsx scripts/test-server-skill-activation.mjs
npm run test:mcp:server
```

These tests use isolated storage and mocked model responses. They inspect actual outgoing model messages rather than trusting checkbox state or the generated answer. The native MCP regression starts the real API host/scheduler and exercises real HTTP and stdio MCP transports.
