import http from "node:http";
import { Agent } from "@mariozechner/pi-agent-core";
import { Type } from "@mariozechner/pi-ai";

const PROTOCOL = "pi-agent/v1";
const DEFAULT_PORT = 8787;
const HOST = process.env.PI_SIDECAR_HOST || process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PI_SIDECAR_PORT || process.env.PORT || `${DEFAULT_PORT}`, 10);
const MODE = (process.env.PI_SIDECAR_MODE || process.env.DEEPLEARNING_PI_MODE || "fake").toLowerCase();
const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * A deliberately tiny, side-effect-free tool. It canonicalizes an input value
 * and reports its length; it never reads files, uses the network, or mutates
 * process state. Pi validates its arguments against this schema before invoke.
 */
export const deterministicTool = {
  name: "deterministic",
  label: "Deterministic",
  description: "Return a stable representation of input without side effects.",
  parameters: Type.Object(
    { input: Type.Optional(Type.String({ description: "Value to normalize" })) },
    { additionalProperties: false },
  ),
  async execute(_toolCallId, params) {
    const input = typeof params?.input === "string" ? params.input : "";
    return {
      content: [{ type: "text", text: input }],
      details: { input, length: input.length },
    };
  },
};

/** Create the OpenAI-compatible model consumed by pi-ai. */
export function createModel(request = {}) {
  const baseUrl = request.base_url || request.baseUrl || process.env.PI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
  return {
    id: request.model || process.env.PI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    name: request.model || process.env.PI_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini",
    api: "openai-completions",
    provider: request.provider || process.env.PI_PROVIDER || "openai",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: request.max_tokens || Number(process.env.PI_MAX_TOKENS || 4096),
    compat: {
      maxTokensField: "max_tokens",
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
    },
  };
}

function envelope(runID, seq, type, payload = {}) {
  return JSON.stringify({ protocol: PROTOCOL, run_id: runID, seq, type, payload });
}

function writeEvent(run, type, payload = {}) {
  if (run.closed || run.response.writableEnded || run.terminal) return false;
  run.seq += 1;
  run.response.write(`${envelope(run.id, run.seq, type, payload)}\n`);
  // A response is chunked by Node; flushHeaders ensures clients can consume
  // the first event immediately even when running behind a proxy.
  run.response.flushHeaders?.();
  if (type === "run.completed" || type === "run.error" || type === "run.canceled") {
    run.terminal = true;
  }
  return true;
}

function closeRun(run) {
  if (run.closed) return;
  run.closed = true;
  if (!run.response.writableEnded) run.response.end();
}

function safeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function toPrompt(request) {
  if (typeof request.prompt === "string" && request.prompt.trim()) return request.prompt;
  const messages = Array.isArray(request.messages) ? request.messages : [];
  const last = messages[messages.length - 1];
  return typeof last?.content === "string" ? last.content : "";
}

function toAgentMessages(request) {
  const messages = Array.isArray(request.messages) ? request.messages : [];
  return messages.flatMap((message) => {
    const timestamp = message.created_at ? Date.parse(message.created_at) || Date.now() : Date.now();
    if (message.role === "user") return [{ role: "user", content: String(message.content || ""), timestamp }];
    if (message.role === "assistant") {
      return [{
        role: "assistant",
        content: [{ type: "text", text: String(message.content || "") }],
        api: "openai-completions",
        provider: "history",
        model: "history",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop",
        timestamp,
      }];
    }
    if (message.role === "toolResult") {
      return [{
        role: "toolResult",
        toolCallId: String(message.tool_call_id || "history-call"),
        toolName: String(message.name || "deterministic"),
        content: [{ type: "text", text: String(message.content || "") }],
        details: {},
        isError: false,
        timestamp,
      }];
    }
    return [];
  });
}

function sleep(ms, signal) {
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    if (signal.aborted) {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
      return;
    }
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    }, { once: true });
  });
}

async function runFake(run, request) {
  const signal = run.controller.signal;
  const prompt = toPrompt(request);
  const delay = Math.max(0, Number(process.env.PI_FAKE_DELAY_MS || 0));
  writeEvent(run, "run.started");
  await sleep(delay, signal);

  const input = prompt.slice(0, 10000);
  const callID = "call-1";
  const args = { input };
  writeEvent(run, "tool.call", { call_id: callID, tool_name: deterministicTool.name, arguments: args });
  await sleep(delay, signal);
  const result = await deterministicTool.execute(callID, args);
  writeEvent(run, "tool.result", {
    call_id: callID,
    tool_name: deterministicTool.name,
    output: result.details,
  });
  await sleep(delay, signal);
  const text = `Deterministic result: ${JSON.stringify(result.details)}`;
  // Keep fake mode visibly streaming while remaining deterministic.
  for (const delta of text.match(/.{1,96}/g) || [""]) {
    await sleep(delay, signal);
    writeEvent(run, "message.delta", { delta });
  }
  if (!run.terminal) writeEvent(run, "run.completed");
}

function makeAgent(run, request) {
  // Credentials are process-owned. Never accept provider keys in a run request.
  // Go may select a configured environment-variable name per provider. Only
  // resolve a conventional shell variable name here; the value itself never
  // enters the request, NDJSON stream, or an error message.
  const requestedKeyEnv = typeof request.api_key_env === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(request.api_key_env.trim())
    ? request.api_key_env.trim()
    : "";
  const apiKey = (requestedKeyEnv && process.env[requestedKeyEnv]) || process.env.PI_API_KEY || process.env.OPENAI_API_KEY;
  const model = createModel(request);
  const agent = new Agent({
    initialState: {
      model,
      systemPrompt: process.env.PI_SYSTEM_PROMPT || "You are a concise assistant. Use the deterministic tool when useful.",
      tools: [deterministicTool],
      messages: toAgentMessages(request),
      thinkingLevel: "off",
    },
    sessionId: request.session_id || run.id,
    toolExecution: "sequential",
    getApiKey: () => apiKey,
  });
  agent.subscribe(async (event) => {
    if (event.type === "agent_start") {
      writeEvent(run, "run.started");
    } else if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      writeEvent(run, "message.delta", { delta: event.assistantMessageEvent.delta });
    } else if (event.type === "tool_execution_start") {
      writeEvent(run, "tool.call", {
        call_id: event.toolCallId,
        tool_name: event.toolName,
        arguments: event.args ?? {},
      });
    } else if (event.type === "tool_execution_end") {
      const result = event.result || {};
      const details = result.details ?? {};
      const content = Array.isArray(result.content) ? result.content : [];
      writeEvent(run, "tool.result", {
        call_id: event.toolCallId,
        tool_name: event.toolName,
        output: details,
        ...(event.isError ? { error: true, error_message: content.map((part) => part.text || "").join(" ") } : {}),
      });
    } else if (event.type === "agent_end") {
      if (run.cancelRequested || run.controller.signal.aborted) {
        if (!run.terminal) writeEvent(run, "run.canceled");
      } else if (agent.state.errorMessage) {
        if (!run.terminal) writeEvent(run, "run.error", { code: "provider_error", message: agent.state.errorMessage });
      } else if (!run.terminal) {
        writeEvent(run, "run.completed");
      }
    }
  });
  return { agent, apiKey };
}

async function runPi(run, request) {
  const { agent } = makeAgent(run, request);
  run.agent = agent;
  // Agent.prompt() accepts a string and owns conversion/tool-call assembly.
  await agent.prompt(toPrompt(request));
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); } catch { reject(Object.assign(new Error("invalid JSON"), { statusCode: 400 })); }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  if (res.writableEnded) return;
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

export function createServer({ mode = MODE } = {}) {
  const runs = new Map();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { ok: true, protocol: PROTOCOL, mode });
    }
    if (req.method === "POST" && url.pathname === "/run") {
      let request;
      try { request = await readJSON(req); } catch (error) { return json(res, error.statusCode || 400, { error: safeError(error) }); }
      const id = String(request.run_id || "").trim();
      if (!id) return json(res, 400, { error: "run_id is required" });
      if (!/^[-A-Za-z0-9_.:]+$/.test(id) || id.length > 160) return json(res, 400, { error: "invalid run_id" });
      if (runs.has(id)) return json(res, 409, { error: "run already exists" });
      if (!toPrompt(request)) return json(res, 400, { error: "prompt is required" });
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-content-type-options": "nosniff",
      });
      const run = { id, request, response: res, seq: 0, terminal: false, closed: false, cancelRequested: false, controller: new AbortController(), agent: null };
      runs.set(id, run);
      res.on("close", () => { if (!res.writableEnded && !run.terminal) run.controller.abort(); });
      const execute = mode === "pi" ? runPi(run, request) : runFake(run, request);
      execute.catch((error) => {
        if (!run.terminal && !run.closed) {
          if (run.cancelRequested || run.controller.signal.aborted) writeEvent(run, "run.canceled");
          else writeEvent(run, "run.error", { code: "sidecar_error", message: safeError(error) });
        }
      }).finally(() => {
        closeRun(run);
        // Keep completed runs briefly only to make duplicate cancel requests idempotent.
        setTimeout(() => runs.delete(id), 5 * 60 * 1000).unref?.();
      });
      return;
    }
    const cancelMatch = req.method === "POST" && url.pathname.match(/^\/run\/([^/]+)\/cancel$/);
    if (cancelMatch) {
      const id = decodeURIComponent(cancelMatch[1]);
      const run = runs.get(id);
      if (!run) return json(res, 404, { error: "run not found" });
      run.cancelRequested = true;
      run.controller.abort();
      run.agent?.abort();
      if (!run.terminal) writeEvent(run, "run.canceled");
      return json(res, 202, { run_id: id, status: "canceled" });
    }
    return json(res, 404, { error: "not found" });
  });
  return { server, runs };
}

if (process.argv[1] && new URL(`file://${process.argv[1]}`).pathname === new URL(import.meta.url).pathname) {
  const { server, runs } = createServer();
  server.listen(PORT, HOST, () => console.log(`pi-agent sidecar listening on http://${HOST}:${PORT} (${MODE})`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    for (const run of runs.values()) {
      run.cancelRequested = true;
      run.controller.abort();
      run.agent?.abort();
    }
    server.close(() => process.exit(0));
    // A provider may fail to honor AbortSignal. Do not keep a container alive
    // indefinitely during supervisor shutdown.
    setTimeout(() => process.exit(0), 5000).unref?.();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
