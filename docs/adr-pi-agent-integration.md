# ADR: Use pi-agent-core as the agent loop

- Status: proposed
- Date: 2026-10-05
- Scope: the first tool-call-capable agent run

## Context

The Go runtime already owns the HTTP/SSE contract, SQLite session/event
storage, provider profiles, and request cancellation. It does not yet have a
production tool execution loop. The `ToolRegistry` interface in Go is a narrow
seam, but implementing a second agent loop there would duplicate the
state-machine, tool argument handling, and provider compatibility work already
implemented by badlogic/pi-mono.

`@mariozechner/pi-agent-core` provides a stateful `Agent`, a lower-level
`agentLoop`, tool execution (including schema validation and error-to-
`toolResult` conversion), cancellation, context transformation, and ordered
agent/turn/message/tool events. `@mariozechner/pi-ai` supports the
`openai-completions` API used by most OpenAI-compatible endpoints and exposes
compatibility flags for endpoints with small protocol differences.

References:

- <https://github.com/badlogic/pi-mono/tree/main/packages/agent>
- <https://github.com/badlogic/pi-mono/tree/main/packages/ai>
- <https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/custom-provider.md>

## Decision

Use a small TypeScript/Bun sidecar as the agent boundary. Keep Go as the
transport and persistence boundary:

```text
HTTP POST /api/v1/runs
        |
        v
Go API/runtime ---- localhost stream ----> pi-agent-core + pi-ai
        ^                                      |
        |                                      v
        +---------- normalized events <--------+
```

The sidecar owns one `Agent` per run, pi-ai model/provider selection, and the
allow-listed tools. Go owns run IDs, cancellation, SSE framing, session/event
persistence, and replay. No VFS or shell tools are part of the first slice.

### Runtime modes

The sidecar lifecycle must be explicit rather than inferred from whether a
binary happens to be on `PATH`. The proposed configuration follows the
managed-versus-external split used by OpenChamber's `OPENCODE_BINARY` and
`OPENCODE_SKIP_START` settings:

1. **Managed Pi (default).** Go starts the bundled, version-pinned Pi runner,
   passes it a private loopback address, waits for its health check, and stops
   it with the server. A `DEEPSTUDENT_PI_BINARY` path override is allowed for
   packaging tests, but no download or shell expansion is performed.
2. **Local Pi CLI (opt-in).** Go resolves an administrator-selected `pi`
   executable (or `DEEPSTUDENT_PI_BINARY`) and accepts it only when its
   reported version is in the configured compatibility range. The user owns
   installation and upgrades; the server still supervises process lifetime.
3. **External Pi endpoint.** Go never starts a process and streams to a
   configured loopback/remote HTTP endpoint. This is equivalent to
   `DEEPSTUDENT_PI_SKIP_START=1`; endpoint ownership, TLS, authentication, and
   uptime belong to the deployment. Readiness must fail clearly when the
   endpoint health check fails.

Only the managed mode is intended for the first desktop/Docker integration.
Local and external modes are compatibility escape hatches and should not
silently change provider credentials or tool allow-lists. The eventual config
surface should reject conflicting settings (for example, `skip_start` together
with a managed binary) and record the selected mode in diagnostics without
logging API keys.

### Sidecar protocol (MVP)

Use newline-delimited JSON over a loopback HTTP endpoint (one request creates
one run and returns a streaming response). Every record has `run_id`, `seq`,
`type`, and `payload`. The initial records are:

- `run.started`
- `message.delta` (`text_delta` from a Pi `message_update`)
- `tool.call` (`tool_execution_start`, with call ID, name, and validated args)
- `tool.result` (`tool_execution_end`, with result or an error marker)
- `run.completed` (`agent_end`)
- `run.error` / `run.canceled`

The Go adapter translates these records to the existing `runtime.StreamEvent`
and persists/broadcasts them. `seq` is monotonic per run so the existing SSE
`Last-Event-ID` replay remains valid. Unknown sidecar event types are retained
as metadata and do not break older clients.

### Tool boundary

Tools are registered in the sidecar with Pi `AgentTool` definitions. A future
Go-owned tool can be exposed through an explicit request/response RPC, but the
sidecar must enforce the allow-list and JSON schema before invoking it. Tool
errors become Pi `toolResult` messages and are sent back to the model; they are
not treated as transport failures. The first MVP registers only deterministic,
side-effect-free tools so no VFS or permission model is needed.

### Provider boundary

Configure `pi-ai` models with `api: "openai-completions"`, `baseUrl`, an
environment-variable API key, and compatibility flags (`maxTokensField`,
`supportsReasoningEffort`, etc.) when required. This removes the need to grow
the current Go OpenAI-compatible SSE parser for tool-call deltas. Go continues
to validate provider profile metadata and never receives a raw provider key in
the run request.

## Alternatives considered

### Port the Pi loop to Go

Rejected for the MVP. A Go port would need to mirror Pi's message/context
conversion, streaming tool-call assembly, schema validation, parallel versus
sequential tool execution, cancellation barriers, and event ordering. It
would create a second implementation that will drift as pi-agent-core evolves.

### Keep the existing Go provider and add a Go loop

Useful only as a temporary compatibility fallback. It can preserve the current
single-process deployment, but it repeats the same loop and still needs an
OpenAI tool-call wire implementation. Do not expand `DeterministicRuntime`
until the sidecar spike has been evaluated.

## Risks and mitigations

1. **Bun/Node packaging and lifecycle.** A sidecar adds a process to desktop
   and Docker deployments. Start it from `serverapp`, pass a private loopback
   address, propagate shutdown, and fail readiness if it cannot be started.
2. **Crash/restart and replay.** Go remains the durable source of truth; attach
   a run sequence to every sidecar record and mark an interrupted run failed
   when the stream closes without a terminal event.
3. **Tool security.** Do not expose arbitrary Go callbacks, filesystem paths,
   or shell commands. Keep an explicit sidecar allow-list and add an RPC
   capability only with per-tool authorization and timeouts.
4. **Credential ownership.** Prefer sidecar environment-variable references
   and redact provider errors. Never persist keys in Go events, SQLite, or SSE.
5. **Protocol drift.** Version the sidecar records (`protocol: "pi-agent/v1"`) and
   keep the Go translation table tolerant of unknown fields/types.
6. **Operational complexity.** The first spike should run a single run
   end-to-end with a fake OpenAI-compatible server and a deterministic tool;
   only then wire desktop startup and production providers.

## Incremental plan

1. Add a `packages/agent-sidecar` Bun workspace package pinned to a known
   `@mariozechner/pi-agent-core`/`pi-ai` release.
2. Implement `/run` and `/run/{id}/cancel` with the records above, an in-memory
   run map, and one deterministic tool.
3. Add a Go sidecar client and adapter test using `httptest`; verify text,
   tool-call, tool-result, completion, cancellation, and malformed-record
   handling.
4. Switch `serverapp` to the sidecar behind a configuration flag; retain the
   existing deterministic Go provider as a local fallback until soak tests
   pass.
