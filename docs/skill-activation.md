# Chat Skill discovery and activation

Skills use progressive disclosure, not permanent per-turn injection:

1. **Discovery:** only names, descriptions and declared MCP dependencies are advertised. `skillIds` keeps its existing semantics: missing = all enabled Skills, `[]` = none, IDs = allowlist. Availability never means activation or tool authorization.
2. **Activation:** the model reads a relevant `/skills/{name}` body on demand, or the user explicitly selects **Use next message**. Explicit invocation loads the complete body before the first model request; it does not depend on the model choosing a tool. References are listed as paths, not loaded.
3. **Reuse:** actual loaded bodies are part of persisted model traces, at their original activation point. Later turns replay retained history; they do not resolve old selections as new activations. Identical bodies are deduplicated across explicit invocation, lazy reads and later turns. A repeat invocation still identifies the current user's intent.
4. **Pruning:** full bodies count toward the normal history budget. Current explicitly requested instructions are protected while history is fitted; overflow fails visibly rather than truncating the body. Compression does not restore every previously used Skill. If its body has been omitted, a relevant task reads it again; an explicit invocation or continuation of its originating explicit task restores it within budget. A name, summary or loading receipt is not proof the full body is present.
5. **Changes/revocation:** request assembly removes retained host envelopes whose ID, name or revision no longer matches current enabled/allowed metadata. A new version is loaded only on actual activation, not automatically on unrelated turns. Scope and MCP authorization still apply at read/call time.

The searchable picker has one invocation list, with availability/MCP controls behind **Availability (advanced)**. There is no forced-injection pin mode. Composer choices clear after submission and do not alter availability. UI badges say **Selected**, not **Loaded**; host loading receipts report actual complete-body reads, without promising model adherence or reference loading.

## Compatibility and persistence

Legacy `pinnedSkillIds` is ignored by browser chat, course QA and native runtime, including when it references deleted Skills or unavailable MCP connectors. It remains an inert optional storage field for synchronization compatibility; new sessions and forks do not copy it. It is not converted to an implicit invocation or an authorization change.

User rows retain `explicitSkillIds` for retries, queued/remote turns and interrupted-task continuation. Only IDs travel in task inputs; the host loads owner-scoped packages, never caller-supplied instruction text. Activation bodies live in model traces, not the visible message or system prompt. A fork copies its real message history, not session-level forced activation.

Browser entry points share `apps/web/src/skills/activation.ts`; native tasks use `apps/api/runtime/skills.ts`. Both use the same host envelopes and request projection in `packages/study-core/src/api/transcript.ts`. Arbitrary Markdown, including nested XML examples, is length-framed. Projection does not mutate stored traces or leave replaced bodies in opaque provider state.

Lazy Skill bodies also bypass the native generic tool-result character cap. Browser and native loops check full Skill context before every request, including tool-free closing rounds. Oversized lazy reads fail visibly rather than sending a truncated policy.

## MCP boundaries

Native chat and video/material QA keep the host-owned `McpManager`: HTTP/SSE/stdio transports, OAuth, connections, validation, resource/prompt gateways and cancellation are shared with the existing integration. Session MCP scopes are owner-record based and rechecked per call. A Skill dependency is checked upon activation/read, never merely because it is discoverable or was pinned by an older client. Missing dependencies produce an explicit activation error; no Skill grants tools. Discovery errors, timeouts and MCP errors remain visible without automatic replay. Plain-text continuation stays tool-free. Bot child study tasks do not expose MCP connectors, preserving BotRunner's external-call approval boundary.

## Verification

```sh
npm run dev -w @wangke/web -- --host 127.0.0.1 --port 5196 --strictPort
BASE_URL=http://127.0.0.1:5196 node scripts/e2e-skill-activation.mjs
BASE_URL=http://127.0.0.1:5196 node scripts/e2e-skill-picker.mjs
npm run test:skills
npm run test:mcp:server
```

Tests inspect outgoing model messages, not model compliance. MCP integration tests run the real host/scheduler and real HTTP/stdio fixtures with mocked model responses.

## Design references

- [Agent Skills integration](https://agentskills.io/integrate-skills): metadata → full instructions upon activation → resources on demand.
- [OpenAI Skills](https://learn.chatgpt.com/docs/build-skills): explicit/implicit invocation and progressive disclosure.
- [Claude Code lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle): retained context, deduplication and compression lifecycle.

These sources support the loading principles; they do not prescribe one universal picker UI or permanent session pin behavior. This product intentionally returns omitted, non-explicit Skills to discovery instead of automatically reattaching all of them.
