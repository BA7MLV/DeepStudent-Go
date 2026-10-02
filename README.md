# DeepStudent-Go

DeepStudent-Go is a Go-first runtime migration workspace for DeepStudent. The
repository keeps the desktop shell and frontend migration incremental while a
small local HTTP/SSE backend establishes provider-neutral contracts.

## Backend foundation

The server is a modular monolith with a deterministic offline provider by
default. It exposes health/readiness checks, versioned API routes, structured
errors, request IDs, exact-origin CORS, append-only session events, and a CGO-free
SQLite WAL store. See [docs/backend-architecture.md](docs/backend-architecture.md)
for the contracts and Mermaid architecture diagram.

### Run locally

```sh
go run ./cmd/server
```

The default listener is `127.0.0.1:8080` and the database is
`data/deepstudent.db`. A JSON config file can be selected with
`DEEPSTUDENT_CONFIG`; environment values override file values. Useful overrides:

```sh
DEEPSTUDENT_HTTP_ADDR=127.0.0.1:8080 \
DEEPSTUDENT_DB_PATH=data/deepstudent.db \
DEEPSTUDENT_CORS_ALLOWLIST=http://localhost:5173 \
go run ./cmd/server
```

Try the deterministic stream:

```sh
curl -s http://127.0.0.1:8080/healthz
curl -s -X POST http://127.0.0.1:8080/api/v1/runs \
  -H 'content-type: application/json' -d '{"prompt":"hello"}'
# then GET /api/v1/runs/<run_id>/events with curl -N
```

### Local Docker profile

```sh
docker compose up --build
```

The compose port is bound to `127.0.0.1:8080`; SQLite is stored in the
`deepstudent-data` volume. Provider API keys are not part of this profile.

## Desktop shell milestone

The existing MyGo desktop shell remains available through `cmd/deepstudent` and
continues to use the versioned runtime boundary in `protocol/runtime-v1.md`.
The existing DeepStudent implementation remains the source of truth until
compatibility and benchmark gates pass.
