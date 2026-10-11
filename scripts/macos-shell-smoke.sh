#!/usr/bin/env bash
# Headless macOS shell smoke test. It intentionally exercises the Go runtime
# and fake Pi/tool bridge instead of opening a GUI window; GUI acceptance still
# requires a real macOS desktop check (see the workflow log).
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SERVER_BIN=${DEEPSTUDENT_SERVER_BIN:-}
PYTHON_BIN=${PYTHON_BIN:-python3}
TMP_DIR=${DEEPSTUDENT_SMOKE_TMPDIR:-"${TMPDIR:-/tmp}/deepstudent-macos-shell-smoke.$$"}
SERVER_LOG="$TMP_DIR/server.log"
PI_LOG="$TMP_DIR/fake-pi.log"
EVENTS_LOG="$TMP_DIR/events.log"
RESPONSE_JSON="$TMP_DIR/run.json"
SERVER_PID=""
PI_PID=""

mkdir -p "$TMP_DIR"

stop_process() {
  local pid=$1
  [[ -n "$pid" ]] || return 0
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    # Give cmd/server a chance to drain its HTTP listener before diagnostics
    # are uploaded, then force-kill a wedged child so CI never leaks a port.
    for _ in {1..25}; do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.2
    done
    if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid" 2>/dev/null || true; fi
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  status=$?
  stop_process "$SERVER_PID"
  stop_process "$PI_PID"
  if [[ "$status" -ne 0 ]]; then
    echo "macOS shell smoke failed (artifacts: $TMP_DIR)" >&2
    echo "--- server.log ---" >&2
    cat "$SERVER_LOG" >&2 || true
    echo "--- fake-pi.log ---" >&2
    cat "$PI_LOG" >&2 || true
    echo "--- process snapshot ---" >&2
    ps -axo pid,ppid,stat,command | grep -E "deepstudent|fake-pi" | grep -v grep >&2 || true
  else
    echo "macOS shell headless smoke passed (logs: $TMP_DIR)"
  fi
  # Keep logs on failure for CI upload; local callers may remove this directory.
  if [[ "$status" -eq 0 ]] && [[ "${KEEP_SMOKE_LOGS:-0}" != "1" ]]; then rm -rf "$TMP_DIR"; fi
  exit "$status"
}
trap cleanup EXIT

pick_port() {
  "$PYTHON_BIN" - <<'PY'
import socket
with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

HTTP_PORT=${DEEPSTUDENT_SMOKE_PORT:-$(pick_port)}
PI_PORT=${DEEPSTUDENT_FAKE_PI_PORT:-$(pick_port)}
BASE_URL="http://127.0.0.1:$HTTP_PORT"
PI_URL="http://127.0.0.1:$PI_PORT"

if [[ -z "$SERVER_BIN" ]]; then
  SERVER_BIN="$TMP_DIR/deepstudent-server"
  echo "Building headless server smoke binary: $SERVER_BIN"
  (cd "$ROOT_DIR" && go build -o "$SERVER_BIN" ./cmd/server)
fi
if [[ ! -x "$SERVER_BIN" ]]; then
  echo "server binary is not executable: $SERVER_BIN" >&2
  exit 2
fi

"$PYTHON_BIN" "$ROOT_DIR/scripts/fake-pi-sidecar.py" --host 127.0.0.1 --port "$PI_PORT" >"$PI_LOG" 2>&1 &
PI_PID=$!

wait_for() {
  local url=$1
  # macOS hosted runners can be cold after installing Go/Bun; allow the
  # freshly started sidecar and server enough time to bind their ports.
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if curl --fail --silent --show-error --max-time 2 "$url" >/dev/null 2>&1; then return 0; fi
    sleep 0.2
  done
  echo "timed out waiting for $url" >&2
  return 1
}
wait_for "$PI_URL/healthz"

export DEEPSTUDENT_HTTP_ADDR="127.0.0.1:$HTTP_PORT"
export DEEPSTUDENT_DB_PATH="$TMP_DIR/deepstudent.db"
export DEEPSTUDENT_BLOB_ROOT="$TMP_DIR/blobs"
export DEEPSTUDENT_PI_MODE=external
export DEEPSTUDENT_PI_ENDPOINT="$PI_URL"

# The app bundle is intentionally not launched here: macos-latest has no stable
# user GUI session. This binary starts the same serverapp/runtime path headlessly.
"$SERVER_BIN" >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!
wait_for "$BASE_URL/healthz"
wait_for "$BASE_URL/readyz"

curl --fail --silent --show-error "$BASE_URL/healthz" | tee "$TMP_DIR/healthz.json"
curl --fail --silent --show-error "$BASE_URL/readyz" | tee "$TMP_DIR/readyz.json"
curl --fail --silent --show-error "$BASE_URL/api/v1/pi/discovery" | tee "$TMP_DIR/pi-discovery.json"

curl --fail --silent --show-error --max-time 5 -X POST "$BASE_URL/api/v1/runs" \
  -H 'content-type: application/json' \
  --data '{"prompt":"macOS shell smoke","provider":"deterministic"}' >"$RESPONSE_JSON"
RUN_ID=$("$PYTHON_BIN" - "$RESPONSE_JSON" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as stream:
    value = json.load(stream)
run_id = value.get("run_id", "")
if not run_id:
    raise SystemExit("run response did not contain run_id")
print(run_id)
PY
)
echo "started run $RUN_ID"

curl --fail --silent --show-error --no-buffer --max-time 15 \
  "$BASE_URL/api/v1/runs/$RUN_ID/events" >"$EVENTS_LOG"
cat "$EVENTS_LOG"
grep -q 'event: run.started' "$EVENTS_LOG"
grep -q 'event: message.delta' "$EVENTS_LOG"
grep -q 'event: tool.call' "$EVENTS_LOG"
grep -q 'event: tool.result' "$EVENTS_LOG"
grep -q 'event: run.completed' "$EVENTS_LOG"
grep -q 'fake sidecar ready' "$EVENTS_LOG"
echo "healthz, readyz, Pi discovery, SSE, and fake tool events verified"
