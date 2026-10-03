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

The full contract will add session prompts, streaming deltas, cancellation, tool calls, and normalized errors. Unknown fields must be ignored for forward compatibility. Every request must produce a terminal result or error event.

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
