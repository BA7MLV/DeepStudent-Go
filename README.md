# DeepStudent-Go

DeepStudent-Go is an incremental Go runtime migration for DeepStudent. It
combines a local-first Go HTTP/SSE service with a small React/MyGo desktop
shell, so the runtime boundary can evolve without replacing the existing
product all at once.

> **Status: prototype / migration workspace**
>
> The Go transport, deterministic stream, SQLite event store, and desktop shell
> are working foundations. The web chat still uses a local `StubAdapter`; it is
> not yet wired to the Go SSE endpoint. An iOS client is planned as an
> experiment and has not been built in this repository.

## What exists today

| Area | Current state |
| --- | --- |
| Go runtime | HTTP JSON + SSE routes, deterministic offline provider, request IDs, structured errors, exact-origin CORS |
| Persistence | CGO-free SQLite with WAL, single-writer policy, append-only session events |
| Desktop shell | MyGo window with a React 19 + TypeScript + Vite UI and typed health bridge |
| Web preview | Responsive DeepStudent shell with chat, learning resources, tasks, flashcards, templates, settings, and light/dark themes |
| CI | Go format/test/vet/build checks, Pages preview workflow, unsigned macOS arm64 workflow |
| Not implemented | Real provider adapters, authentication, tool execution, durable SSE replay/cancel, and a native iOS app |

The existing DeepStudent implementation remains the source of truth until the
migration passes compatibility and benchmark gates.

## Architecture

```text
React shell (assistant-ui) ──┐
                             ├─ presentation only
MyGo desktop window ─────────┘
          │ typed bridge today; HTTP/SSE adapter next
          ▼
Go API (`/healthz`, `/readyz`, `/api/v1/*`)
          ▼
provider-neutral runtime ── deterministic provider (current default)
          │
          ├─ SQLite WAL + append-only session events
          └─ future provider/tool/execution adapters
```

The contracts live in [`protocol/runtime-v1.md`](protocol/runtime-v1.md) and
the backend boundary is documented in
[`docs/backend-architecture.md`](docs/backend-architecture.md). The current
SSE route streams live in-memory run events; persisted events are the basis for
a future replay API, not a claim that reconnect/resume already works.

## Technology

- Go 1.27.1, `net/http`, and provider-neutral runtime interfaces
- SQLite via `modernc.org/sqlite` (CGO-free, WAL, single writer)
- React 19, TypeScript, Vite, and `@assistant-ui/react`
- MyGo 0.1.22 for the desktop shell and generated-compatible bindings
- Bun for frontend install/build scripts
- Docker Compose for a local server profile

## Run locally

Prerequisites: Go 1.27+, Bun, and (optionally) Docker.

### Go API + SSE runtime

```sh
go test ./...
go vet ./...
go run ./cmd/server
```

The default listener is `127.0.0.1:8080`; SQLite is stored at
`data/deepstudent.db`. The default provider is deterministic and never reads a
secret or accesses the network. The `DEEPSTUDENT_CONFIG` JSON path is optional;
environment values override file values. Useful overrides are:

```sh
DEEPSTUDENT_HTTP_ADDR=127.0.0.1:8080 \
DEEPSTUDENT_DB_PATH=data/deepstudent.db \
DEEPSTUDENT_CORS_ALLOWLIST=http://localhost:5173 \
go run ./cmd/server
```

Try the current stream:

```sh
curl -s http://127.0.0.1:8080/healthz
curl -s -X POST http://127.0.0.1:8080/api/v1/runs \
  -H 'content-type: application/json' \
  -d '{"prompt":"hello"}'
# Paste the returned run_id between the quotes:
RUN_ID="paste-run-id"
curl -N "http://127.0.0.1:8080/api/v1/runs/${RUN_ID}/events"
```

The run endpoint returns `202 Accepted` and an `events_url`. SSE event types
currently include `run.started`, `message.delta`, `run.completed`, and
`run.error`.

### Web shell

```sh
bun install
bun run dev:web
```

This serves the responsive shell through Vite. Its chat adapter is still a
local stub, while the settings view can report the MyGo health bridge when
running inside the desktop shell.

### MyGo desktop shell

```sh
bun install
go install github.com/egoist/mygo/cmd/mygo@v0.1.22
mygo generate
bun run build -- -platform darwin/arm64
```

The build is unsigned and currently configured for macOS 12+ arm64. Linux
configuration is present; release packaging and signing are not part of this
prototype.

### Docker profile

```sh
docker compose up --build
```

The compose server binds to `127.0.0.1:8080` and stores SQLite in the
`deepstudent-data` volume. Provider credentials are intentionally not included.

## Preview links

These are explicit placeholders until a deployment/artifact URL is recorded:

- Pages preview: `https://<owner>.github.io/<repository>/`
- macOS preview artifact: `<MACOS_ARTIFACT_URL>`
- CI workflow (real link): [`macOS shell workflow`](https://github.com/BA7MLV/DeepStudent-Go/actions/workflows/macos-shell.yml)
- Pages workflow (real link): [`Pages preview workflow`](https://github.com/BA7MLV/DeepStudent-Go/actions/workflows/pages-preview.yml)

Do not treat a workflow run as a published app. The macOS job currently emits
an unsigned arm64 artifact when it succeeds.

## Screenshots / visual review

There are no product screenshots in this checkout yet (only app/logo assets).
Add real captures under `docs/screenshots/` after running the corresponding
surface; do not substitute generated or imagined screenshots.

| Surface | Reproducible capture checklist | Suggested file |
| --- | --- | --- |
| Web shell | Run `bun run dev:web`; capture 1440×900 light and dark chat states, then one learning-resource state | `docs/screenshots/web-shell-light.png`, `web-shell-dark.png`, `web-learning-hub.png` |
| macOS shell | Build with the MyGo command above; open the unsigned `.app`; capture the chat landing and settings/health state | `docs/screenshots/macos-shell.png` |
| Go stream | Run `cmd/server`; capture `/healthz` and an SSE run in a terminal or API client | `docs/screenshots/api-sse.png` |
| iOS experiment | Capture only after a native target exists and its shell reaches the stated experiment gates | `docs/screenshots/ios-shell.png` |

## iOS shell experiment (planned, not built)

The iOS work is a thin-client experiment around the existing Go contracts. It
is inspired by Telegram's native iOS information architecture and interaction
density—compact list rows, fast search, a chat-first detail view, swipe/context
actions, and a bottom composer—without claiming a Telegram clone or a finished
iOS product.

### Proposed information architecture

1. **Sessions** — the launch surface: pinned/recent study sessions, compact
   64–72pt rows, unread/run status, pull-to-refresh, and search
2. **Session detail** — dense message timeline, streaming assistant deltas,
   inline run status, and a bottom composer with attachment/tool affordances
3. **Study** — resources, tasks, flashcards, and templates as secondary shelves
4. **Settings** — runtime URL, diagnostics, theme, and experiment flags

Use `NavigationStack` on iPhone and `NavigationSplitView` on iPad. Keep the
first spike intentionally small: fake session data and shell interactions first,
then replace the data source with the Go API without redesigning navigation.

### Go API / SSE seam

The native client should target a configurable base URL and use this sequence:

1. `GET /healthz` and `GET /readyz` before enabling send
2. `POST /api/v1/runs` with `{ "session_id", "prompt", "model", "max_tokens" }`
3. Read the returned `events_url` as `text/event-stream`
4. Map `run.started`, `message.delta`, `run.completed`, and `run.error` into
   timeline state; keep `id` and `run_id` for diagnostics

The current server does not expose an authenticated iOS profile, durable SSE
replay endpoint, cancellation route, or remote-device discovery. A native
client must therefore treat the experiment as local/test-only, avoid embedding
provider secrets, and show a recoverable “connection lost” state instead of
pretending that a run resumed. Add replay/cancel/auth contracts before any
shared or production deployment.

### Suggested experiment gates

- **Spike:** navigation, dense session rows, empty/loading/error states, and
  fake streaming timeline
- **API slice:** health check, prompt submission, and live SSE deltas against
  the deterministic Go provider
- **Resilience slice:** explicit reconnect/error UI and event diagnostics; only
  enable resume after a server-side replay contract exists
- **Decision gate:** compare scroll/typing latency and information density with
  the web shell before deciding whether to continue a native client

The proposed Swift/Xcode target (for example `ios/DeepStudentShell/`) does not
exist yet. This section is a design plan, not evidence that an iOS app has been
built.

## Repository map

```text
cmd/server/                 local Go HTTP/SSE server
cmd/deepstudent/            MyGo desktop entry point
internal/api/               HTTP, CORS, errors, and SSE transport
internal/runtime/           provider-neutral contracts and deterministic stub
internal/storage/           SQLite schema and append-only event store
frontend/                   React shell and MyGo-compatible health client
protocol/runtime-v1.md      versioned request/event envelope
docs/backend-architecture.md
```

## Safety and scope

This workspace is local-first and intentionally conservative: deterministic
offline behavior is the default, credentials are referenced by environment
name rather than persisted values, and the first milestone does not migrate the
full product, delete the existing implementation, or change its data schemas.
