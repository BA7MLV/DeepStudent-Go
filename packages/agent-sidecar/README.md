# DeepStudent Pi agent sidecar

A small Node/Bun-compatible loopback service that implements the `pi-agent/v1`
NDJSON contract. The default `fake` mode is offline and deterministic for local
smoke tests. Set `PI_SIDECAR_MODE=pi` to use `@mariozechner/pi-agent-core`
and `@mariozechner/pi-ai` with an OpenAI-compatible endpoint.

## Run locally

```sh
cd packages/agent-sidecar
npm install                 # Bun works too: bun install
npm start                   # http://127.0.0.1:8787
# or: bun run start
```

```sh
curl -N -X POST http://127.0.0.1:8787/run \
  -H 'content-type: application/json' \
  -d '{"run_id":"demo","prompt":"hello"}'
```

The stream emits `run.started`, a deterministic `tool.call`/`tool.result`,
`message.delta` records, and one terminal record. Cancel with:

```sh
curl -X POST http://127.0.0.1:8787/run/demo/cancel
```

For a real provider, configure the endpoint and key in the sidecar process (the
Go API never receives or persists the key):

```sh
PI_SIDECAR_MODE=pi \
PI_BASE_URL=https://api.openai.com/v1 \
PI_MODEL=gpt-4o-mini \
PI_API_KEY="$OPENAI_API_KEY" npm start
```

`PI_FAKE_DELAY_MS` adds a deterministic delay between fake events, useful for
cancellation tests. The only enabled tool is `deterministic`; it canonicalizes
its string argument and reports its length and has no filesystem, shell, or
network access.

## Docker

Build/run the sidecar as a separate supervised process. It listens only on the
container network by default; publish to localhost for development:

```sh
docker build -t deepstudent-pi-sidecar .
docker run --rm --name deepstudent-pi-sidecar \
  -p 127.0.0.1:8787:8787 \
  -e PI_SIDECAR_MODE=fake deepstudent-pi-sidecar
```

Point the Go service at `http://pi-sidecar:8787` with
`DEEPSTUDENT_SIDECAR_MODE=external`, `DEEPSTUDENT_SIDECAR_URL=http://pi-sidecar:8787`,
and `DEEPSTUDENT_PI_SKIP_START=1`. Do not put provider keys in Go or Docker
compose files; inject `PI_API_KEY` into the sidecar supervisor only.
