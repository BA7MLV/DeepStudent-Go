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
| Web preview | Responsive DeepStudent shell with chat, learning resources, tasks, flashcards, settings, and light/dark themes |
| CI | Go format/test/vet/build checks, Pages preview workflow, unsigned macOS arm64 workflow |
| Not implemented | Real provider adapters, authentication, tool execution, durable SSE replay/cancel, and a native iOS app |

The existing DeepStudent implementation remains the source of truth until the
migration passes compatibility and benchmark gates.

## Verification status

The branch includes [`go-backend.yml`](.github/workflows/go-backend.yml), which
runs `gofmt`, `go test ./...`, `go vet ./...`, and a CGO-free server build on
pushes to `feature/go-backend-runtime` and pull requests targeting `main` or
this branch. This checkout documents the workflow but does not contain a
recorded successful Actions run; treat Go CI as **unverified until a run is
observed in GitHub Actions**. Do not describe the backend as CI-green based on
this README alone.

For a local verification pass, run:

```sh
gofmt -w cmd internal
test -z "$(gofmt -l cmd internal)"
go test ./...
go vet ./...
CGO_ENABLED=0 go build ./cmd/server
```

The frontend can be checked independently with `bun run typecheck` and
`bun run build` from `frontend/`. These checks do not prove that the browser
chat is wired to the Go SSE API.

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

Model routes are independent from transport. A provider may declare
`baseURL`/`base_url`, an `apiKeyEnv` reference, and defaults; its `models` map
can override `reasoning_effort`, `max_tokens`, and `input` capabilities for a
model. `DEEPSTUDENT_BASE_URL` and
`DEEPSTUDENT_PROVIDER_<NAME>_BASE_URL` provide deployment overrides without
loading API keys into config. `config.Manager` reloads validated snapshots
atomically and leaves the last known-good config on invalid edits.

### Configuration reference

Configuration is loaded in this order: built-in defaults, the optional JSON
file named by `DEEPSTUDENT_CONFIG`, then environment overrides. Invalid reloads
leave the last known-good snapshot in place. Common local overrides are:

| Variable | Default | Purpose |
| --- | --- | --- |
| `DEEPSTUDENT_HTTP_ADDR` | `127.0.0.1:8080` | bind address for the API |
| `DEEPSTUDENT_DB_PATH` | `data/deepstudent.db` | SQLite database path |
| `DEEPSTUDENT_CORS_ALLOWLIST` | localhost/127.0.0.1:5173 | comma-separated exact origins |
| `DEEPSTUDENT_DEFAULT_PROVIDER` | `deterministic` | provider route for new runs |
| `DEEPSTUDENT_DEFAULT_TIMEOUT` | `45s` | runtime run timeout |
| `DEEPSTUDENT_MAX_TOKENS` | `2048` | runtime token ceiling |
| `DEEPSTUDENT_MAX_CONCURRENCY` | `2` | bounded active runs |
| `DEEPSTUDENT_AUTH_ENABLED` | `false` | reserved session boundary; login is not implemented |

Provider endpoint and credential settings use metadata only. Set
`DEEPSTUDENT_PROVIDER_<NAME>_BASE_URL` or a `baseURL`/`baseURLEnv` reference;
set `apiKeyEnv` to the name of an environment variable, never to the secret
value. The deterministic provider remains the only provider instantiated by
`cmd/server` today.

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
`run.error`. Runtime runs are bounded by the configured default timeout (45s by
default); completed in-memory history is retained briefly (5 minutes) to allow
an immediate late subscription, then released.

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
The image pre-creates `/data` with the distroless non-root UID's ownership so a
new named volume can be opened by the server. Verify this permission when
switching volume drivers or a pre-existing host bind mount.

## Preview links

These are explicit placeholders until a deployment/artifact URL is recorded:

- Expected Pages URL after a successful deployment (verify before sharing): https://ba7mlv.github.io/DeepStudent-Go/
- macOS preview artifact: `<MACOS_ARTIFACT_URL>` (the workflow artifact URL is run-specific)
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
3. **Study** — resources, tasks, and flashcards as secondary shelves
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

## Branch relationship

- `feature/go-backend-runtime` is the backend migration slice documented here.
  It adds the local HTTP/SSE service, SQLite event store, deterministic provider,
  Docker profile, and backend-specific CI workflow.
- `migration/mygo-shell-poc` is the UI-first shell experiment. Its chat remains
  a local stub and it has no Go backend verification workflow.
- The existing DeepStudent implementation remains the source of truth until
  compatibility, performance, and security gates are agreed and met. Keep the
  runtime contract versioned when integrating the two branches.

## Known limitations and roadmap

The current server is local/test-only: authentication is disabled, only the
deterministic provider is instantiated, and the browser shell is not connected
to `/api/v1/runs`. SSE history is in-memory and retained briefly for late
subscriptions; durable replay, reconnect/resume, cancellation, and remote
client discovery are not implemented. Tool execution, telemetry, migrations,
provider adapters, signed packaging, and production deployment are also out of
scope.

Next gates are:

1. Connect the shell through a typed HTTP/SSE adapter and add contract tests.
2. Add explicit replay/cancel/auth semantics before shared or remote use.
3. Integrate a real provider through an environment-backed secret boundary.
4. Benchmark persistence/runtime behavior and document migration/recovery.
5. Add accessibility, release-signing, deployment, and incident/runbook gates.

## Safety and scope

This workspace is local-first and intentionally conservative: deterministic
offline behavior is the default, credentials are referenced by environment
name rather than persisted values, and the first milestone does not migrate the
full product, delete the existing implementation, or change its data schemas.
