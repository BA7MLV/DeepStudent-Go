#!/usr/bin/env python3
"""Tiny deterministic pi-agent/v1 sidecar used by local/CI headless smoke tests."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROTOCOL = "pi-agent/v1"


class Handler(BaseHTTPRequestHandler):
    server_version = "deepstudent-fake-pi/1"

    def log_message(self, fmt: str, *args: object) -> None:
        # Keep CI logs focused on the shell smoke output. The parent script
        # still captures stderr if the fake sidecar itself fails.
        return

    def _json(self, status: int, payload: dict[str, object]) -> None:
        data = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path == "/healthz":
            self._json(200, {"status": "ok", "fake": True})
            return
        self._json(404, {"error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler API
        if self.path != "/run":
            self._json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            request = json.loads(self.rfile.read(length) or b"{}")
            run_id = str(request.get("run_id") or "fake-run")
        except (ValueError, json.JSONDecodeError):
            self._json(400, {"error": "invalid_json"})
            return

        records = [
            {"type": "run.started", "payload": {}},
            {"type": "message.delta", "payload": {"delta": "fake sidecar ready"}},
            {
                "type": "tool.call",
                "payload": {
                    "call_id": "fake-call-1",
                    "tool_name": "fake_tool",
                    "arguments": {"source": "macos-shell-smoke"},
                },
            },
            {
                "type": "tool.result",
                "payload": {
                    "call_id": "fake-call-1",
                    "tool_name": "fake_tool",
                    "output": {"ok": True},
                },
            },
            {"type": "run.completed", "payload": {}},
        ]
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        for sequence, record in enumerate(records, start=1):
            envelope = {
                "protocol": PROTOCOL,
                "run_id": run_id,
                "seq": sequence,
                "type": record["type"],
                "payload": record["payload"],
            }
            self.wfile.write(json.dumps(envelope, separators=(",", ":")).encode("utf-8") + b"\n")
            self.wfile.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
