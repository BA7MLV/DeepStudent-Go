# Pi sidecar stream protocol v1 (spike)

This document specifies the loopback protocol used by the planned
`pi-agent-core` sidecar. It is intentionally separate from the public API v1;
the Go server translates these records into its existing SSE events.

## Transport

- `POST /run` with `Content-Type: application/json`
- request includes `run_id`, `session_id`, prompt/messages, provider/model, and
  the selected tool definitions
- response is `Content-Type: application/x-ndjson; charset=utf-8`
- one JSON object per line, flushed after each object
- cancellation is `POST /run/<run_id>/cancel`; the sidecar emits a final
  `run.canceled` record before closing when possible

Every record uses this envelope:

```json
{"protocol":"pi-agent/v1","run_id":"run-123","seq":1,"type":"run.started","payload":{}}
```

`seq` starts at one and increases strictly within a run. The Go bridge uses it
as the SSE `id` and rejects a sequence regression or a changed `run_id`.

## Event payloads

```text
run.started    payload: {}
message.delta  payload: {"delta":"hello"}
tool.call      payload: {"call_id":"call-1","tool_name":"clock","arguments":{"tz":"UTC"}}
tool.result    payload: {"call_id":"call-1","tool_name":"clock","output":{"hour":12}}
run.completed  payload: {}
run.canceled   payload: {}
run.error      payload: {"code":"provider_error","message":"model failed"}
```

`tool.call` is emitted after Pi validates the tool arguments. Tool failures are
normal `tool.result` records (`error: true`, `error_message`) so the agent can
send the error to the model and continue. They are not transport failures.

## Go mapping

| Sidecar type | Go `runtime.StreamEvent.Type` | Terminal |
| --- | --- | --- |
| `run.started` | `run.started` | no |
| `message.delta` | `message.delta` | no |
| `tool.call` | `tool.call` | no |
| `tool.result` | `tool.result` | no |
| `run.completed` | `run.completed` | yes |
| `run.error` | `run.error` | yes |
| `run.canceled` | `run.canceled` | yes |

Unknown event names are passed through with their payload in `metadata` so a
new sidecar remains observable by an older Go server. The envelope types and
stream decoder live in `internal/runtime/sidecar_protocol.go`; the tests cover
round-tripping, mapping, malformed payloads, sequence regressions, and run ID
changes.
