# runtime.v1

The first migration slice uses a versioned request/event envelope so the Go runtime can evolve independently from the desktop shell.

## Request

```json
{
  "version": "deepstudent.runtime.v1",
  "id": "req-123",
  "method": "runtime.health",
  "params": {}
}
```

## Event

```json
{
  "version": "deepstudent.runtime.v1",
  "id": "req-123",
  "type": "runtime.health.result",
  "data": {}
}
```

Unknown fields must be ignored for forward compatibility. Every run produces a
terminal `run.completed`, `run.error`, or `run.canceled` event. Event IDs are
stable for the lifetime of the in-memory replay window; clients may reconnect
with `Last-Event-ID` on the SSE endpoint and receive events after that ID.

## HTTP resource contract

The local profile exposes these JSON resources under `/api/v1`:

- `GET /sessions?limit=50&offset=0` returns `{ "sessions": [...] }`
- `POST /sessions` with `{ "id"?, "title"? }` creates or updates a session
- `GET /sessions/:id` returns `{ "session": { ... } }`
- `GET /sessions/:id/messages` returns `{ "messages": [...] }`
- `POST /sessions/:id/messages` with `{ "prompt", "model"?, "max_tokens"? }`
  appends a user message and starts a run
- `GET /runs/:id` returns the current run status
- `POST /runs/:id/cancel` requests cancellation

`POST /runs` accepts the same run body and creates a session automatically when
the SQLite profile is enabled and no `session_id` is supplied. All failures use
the `error` envelope described by the transport docs and include the request ID.

## Model selection

Run requests may select a provider/model route without changing the transport:

```json
{"prompt":"Explain this function","provider":"deepseek-official","model":"deepseek-v4-flash","reasoning_effort":"high","max_tokens":4096,"input_capabilities":["text","image"]}
```

Provider and model are resolved against the configured catalog. A model profile
overrides provider defaults for reasoning effort, output-token cap, and input
capabilities. `max_tokens` is optional at the profile/request boundary; the
runtime-wide limit remains the final upper bound. `baseURL`/`base_url` may be
paired with `baseURLEnv`/`base_url_env` to resolve an endpoint from the
environment. API keys are represented only by an `apiKeyEnv` reference.

`config.Manager.Reload` swaps a complete validated snapshot atomically. Invalid
edits leave the last known-good snapshot in place; reload does not probe model
availability or credentials.

Built-in provider presets include `siliconflow`, `deepseek`, and
`custom-openai`. Each profile stores an endpoint, API-key environment variable
name, default model, timeout, retry/backoff, and streaming capability. Secret
values are process environment inputs only and are never part of this
contract. The deterministic provider remains the credential-free default.
