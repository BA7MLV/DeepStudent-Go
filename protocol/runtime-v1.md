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
