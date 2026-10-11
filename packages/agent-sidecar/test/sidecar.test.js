import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createServer, createModel } from "../src/index.js";

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

async function readNDJSON(response) {
  const text = await response.text();
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("fake mode emits ordered protocol records and deterministic tool", async (t) => {
  const { server } = createServer({ mode: "fake" });
  const base = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: "test-run", prompt: "hello" }),
  });
  assert.equal(response.status, 200);
  const records = await readNDJSON(response);
  assert.deepEqual(records.map((record) => record.type), [
    "run.started", "tool.call", "tool.result", "message.delta", "run.completed",
  ]);
  assert.deepEqual(records.map((record) => record.seq), [1, 2, 3, 4, 5]);
  assert.equal(records[1].payload.tool_name, "deterministic");
  assert.equal(records[2].payload.output.length, 5);
  assert.equal(records.at(-1).run_id, "test-run");
});

test("cancel emits a terminal run.canceled record", async (t) => {
  process.env.PI_FAKE_DELAY_MS = "50";
  const { server } = createServer({ mode: "fake" });
  const base = await listen(server);
  t.after(() => { delete process.env.PI_FAKE_DELAY_MS; server.close(); });
  const controller = new AbortController();
  const responsePromise = fetch(`${base}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: "cancel-run", prompt: "hello" }),
    signal: controller.signal,
  });
  // Wait for the stream headers, then request cancellation from a second client.
  const response = await responsePromise;
  const cancel = await fetch(`${base}/run/cancel-run/cancel`, { method: "POST" });
  assert.equal(cancel.status, 202);
  const records = await readNDJSON(response);
  assert.equal(records.at(-1).type, "run.canceled");
  assert.equal(records.at(-1).seq, Math.max(...records.map((record) => record.seq)));
});

test("pi mode uses pi-ai OpenAI-compatible streaming", async (t) => {
  const previousKey = process.env.PI_API_KEY;
  process.env.PI_API_KEY = "test-key";
  t.after(() => { if (previousKey === undefined) delete process.env.PI_API_KEY; else process.env.PI_API_KEY = previousKey; });
  const provider = http.createServer((req, res) => {
    assert.equal(req.url, "/v1/chat/completions");
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  const providerBase = await listen(provider);
  t.after(() => provider.close());
  const { server } = createServer({ mode: "pi" });
  const sidecarBase = await listen(server);
  t.after(() => server.close());
  const response = await fetch(`${sidecarBase}/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ run_id: "pi-run", prompt: "hello", base_url: `${providerBase}/v1`, provider: "local", model: "test-model" }),
  });
  assert.equal(response.status, 200);
  const records = await readNDJSON(response);
  assert.equal(records.at(-1).type, "run.completed");
  assert.equal(records.some((record) => record.type === "message.delta" && record.payload.delta === "hello"), true);
});

test("createModel defaults to openai-completions", () => {
  const model = createModel({ base_url: "http://example.test/v1", provider: "local", model: "test" });
  assert.equal(model.api, "openai-completions");
  assert.equal(model.baseUrl, "http://example.test/v1");
  assert.equal(model.id, "test");
});
