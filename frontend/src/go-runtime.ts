import type {
  ChatModelAdapter,
  ChatModelRunResult,
  ToolCallMessagePart,
  ThreadMessage,
} from "@assistant-ui/react";

/** The version shared by the shell and feature/go-backend-runtime. */
export const RUNTIME_VERSION = "deepstudent.runtime.v1" as const;

type RuntimeInputCapability = "text" | "image" | "audio" | "video" | "file";

export type GoRuntimeEventType =
  | "run.started"
  | "message.delta"
  | "tool.call"
  | "run.completed"
  | "run.error"
  | "run.canceled"
  // A few early development servers used the shorter names. Keeping these
  // aliases here makes the adapter tolerant without weakening the typed API.
  | "run"
  | "completed"
  | "error"
  | "canceled";

export type GoRuntimeEvent = {
  id?: string;
  run_id?: string;
  type: GoRuntimeEventType | string;
  delta?: string;
  text?: string;
  error_code?: string;
  error_message?: string;
  done?: boolean;
  created_at?: string;
  metadata?: Record<string, unknown>;
};

type RunStartResponse = {
  run_id: string;
  session_id?: string;
  events_url?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  max_tokens?: number;
};

type RuntimeErrorEnvelope = {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: unknown;
  };
};

type FetchLike = typeof fetch;
type EventSourceLike = new (url: string, init?: EventSourceInit) => EventSource;

export type GoRuntimeAdapterOptions = {
  /** API base URL, normally `/api/v1` or `http://127.0.0.1:8080/api/v1`. */
  baseUrl?: string;
  /** Stable application session ID; falls back to assistant-ui's thread ID. */
  sessionId?: string;
  /** Overall budget for POST + SSE, in milliseconds. */
  timeoutMs?: number;
  /** Number of times an interrupted SSE connection should be reopened. */
  reconnectAttempts?: number;
  /** Delay before the first SSE reconnect, in milliseconds. */
  reconnectDelayMs?: number;
  /** Optional provider route sent to the Go model catalog. */
  provider?: string;
  /** Optional model route sent to the Go model catalog. */
  model?: string;
  /** Controls whether intermediate deltas are committed as they arrive. */
  streamingMode?: "events" | "buffered";
  /** Optional local adapter used when the Go service is unavailable. */
  fallback?: ChatModelAdapter;
  /** Dependency injection keeps the adapter straightforward to test. */
  fetchImpl?: FetchLike;
  eventSourceImpl?: EventSourceLike;
};

export class GoRuntimeError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;

  constructor(message: string, options: { code?: string; requestId?: string; retryable?: boolean } = {}) {
    super(message);
    this.name = "GoRuntimeError";
    this.code = options.code ?? "runtime_error";
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
  }
}

type RunOptions = Parameters<ChatModelAdapter["run"]>[0];

type SseFrame = {
  id?: string;
  event?: string;
  data: string;
};

const defaultBaseUrl = (): string => {
  // Do not put provider URLs or credentials in the bundle. This is only a
  // local API route and can be overridden by the deployment environment.
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const configured = typeof env?.VITE_GO_RUNTIME_URL === "string" ? env.VITE_GO_RUNTIME_URL.trim() : "";
  return configured || "/api/v1";
};

const normalizeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "") || "/api/v1";

const runtimeUrl = (baseUrl: string, path: string): string => `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

const canUseLocalFallback = (error: unknown): boolean => {
  if (error instanceof GoRuntimeError) {
    // Keep a local adapter for a missing/offline Go process, while surfacing
    // client errors (bad model, invalid prompt, etc.) to the user instead of
    // silently changing the meaning of the request.
    return error.retryable || ["http_404", "stream_disconnected", "stream_unsupported", "timeout", "network_unavailable"].includes(error.code);
  }
  // Fetch rejects with TypeError for a refused connection in browsers. Avoid
  // treating arbitrary provider/application exceptions as an offline runtime.
  return error instanceof TypeError;
};

const randomRequestId = (): string => {
  const cryptoApi = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto : undefined;
  return cryptoApi?.randomUUID() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const delay = (milliseconds: number, signal: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal.aborted) {
    reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
    return;
  }
  const timer = globalThis.setTimeout(resolve, milliseconds);
  const onAbort = () => {
    globalThis.clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
});

const responseError = async (response: Response): Promise<GoRuntimeError> => {
  let payload: RuntimeErrorEnvelope | undefined;
  try {
    payload = await response.json() as RuntimeErrorEnvelope;
  } catch {
    // Some reverse proxies return an HTML/plain-text error. Do not expose the
    // response body as it could contain deployment details or credentials.
  }
  const detail = payload?.error;
  return new GoRuntimeError(detail?.message || `Go runtime request failed (${response.status})`, {
    code: detail?.code || `http_${response.status}`,
    requestId: detail?.request_id,
    retryable: response.status >= 500 || response.status === 408 || response.status === 429,
  });
};

const parseRunStart = (value: unknown): RunStartResponse => {
  if (!value || typeof value !== "object") throw new GoRuntimeError("Go runtime returned an invalid run response", { code: "invalid_response" });
  const candidate = value as Partial<RunStartResponse>;
  if (typeof candidate.run_id !== "string" || candidate.run_id.trim() === "") {
    throw new GoRuntimeError("Go runtime did not return a run ID", { code: "invalid_response" });
  }
  return candidate as RunStartResponse;
};

const readPrompt = (message: ThreadMessage | undefined): { prompt: string; capabilities: RuntimeInputCapability[] } => {
  if (!message) return { prompt: "", capabilities: ["text"] };
  const capabilities = new Set<RuntimeInputCapability>();
  const text: string[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      text.push(part.text);
      capabilities.add("text");
      continue;
    }
    if (part.type === "image") capabilities.add("image");
    else if (part.type === "file") {
      const mimeType = part.mimeType.toLowerCase();
      if (mimeType.startsWith("audio/")) capabilities.add("audio");
      else if (mimeType.startsWith("video/")) capabilities.add("video");
      else capabilities.add("file");
    }
  }
  if (capabilities.size === 0) capabilities.add("text");
  return { prompt: text.join(" ").trim(), capabilities: [...capabilities] };
};

const assistantText = (text: string): ChatModelRunResult => ({
  content: text ? [{ type: "text", text }] : [],
});

const assistantTextWithStatus = (text: string, status: NonNullable<ChatModelRunResult["status"]>): ChatModelRunResult => ({
  ...assistantText(text),
  status,
});

const appendEventText = (current: string, event: GoRuntimeEvent): string => {
  const next = typeof event.delta === "string" ? event.delta : event.text;
  if (!next) return current;
  if (typeof event.delta === "string") return current + next;
  // Providers occasionally send a complete text snapshot in `text` instead
  // of a delta. Avoid duplicating it when it already contains our prefix.
  if (next === current || next.startsWith(current)) return next;
  return current + next;
};

const eventValue = (event: GoRuntimeEvent, ...keys: string[]): unknown => {
  const record = event as unknown as Record<string, unknown>;
  for (const key of keys) {
    if (record[key] !== undefined) return record[key];
    if (event.metadata && event.metadata[key] !== undefined) return event.metadata[key];
  }
  return undefined;
};

const jsonArgs = (value: unknown): { args: Readonly<Record<string, unknown>>; argsText: string } => {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed as Readonly<Record<string, unknown>>, argsText: value };
    } catch {
      // Keep partial argument text while a provider is still streaming JSON.
    }
    return { args: {}, argsText: value };
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return { args: value as Readonly<Record<string, unknown>>, argsText: JSON.stringify(value) };
  }
  return { args: {}, argsText: value === undefined ? "{}" : JSON.stringify(value) };
};

const normalizeEventType = (event: GoRuntimeEvent, frameType?: string): string => {
  const type = (event.type || frameType || "").toLowerCase();
  return type === "run" && event.done ? "run.completed" : type;
};

async function* readReadableSse(response: Response, signal: AbortSignal): AsyncGenerator<SseFrame, void> {
  if (!response.body) throw new GoRuntimeError("Go runtime SSE response has no readable body", { code: "stream_unsupported", retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: SseFrame = { data: "" };
  const flush = function* (): Generator<SseFrame> {
    if (!frame.data && !frame.event && !frame.id) {
      frame = { data: "" };
      return;
    }
    const complete = frame;
    frame = { data: "" };
    yield complete;
  };
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      buffer += decoder.decode(result.value, { stream: true });
      let boundary = buffer.indexOf("\n");
      while (boundary >= 0) {
        let line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        if (line === "") {
          yield* flush();
        } else if (!line.startsWith(":")) {
          const separator = line.indexOf(":");
          const field = separator >= 0 ? line.slice(0, separator) : line;
          const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, "") : "";
          if (field === "id") frame.id = value;
          else if (field === "event") frame.event = value;
          else if (field === "data") frame.data = frame.data ? `${frame.data}\n${value}` : value;
        }
        boundary = buffer.indexOf("\n");
      }
      if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException("The operation was aborted", "AbortError");
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      // SSE permits a final event without a trailing blank line. Parse the
      // final line as a field, then flush it as the connection closes.
      const lines = buffer.split(/\r?\n/);
      for (const line of lines) {
        if (line.startsWith("id:")) frame.id = line.slice(3).trim();
        else if (line.startsWith("event:")) frame.event = line.slice(6).trim();
        else if (line.startsWith("data:")) frame.data = frame.data ? `${frame.data}\n${line.slice(5).replace(/^ /, "")}` : line.slice(5).replace(/^ /, "");
      }
    }
    yield* flush();
  } finally {
    try { await reader.cancel(); } catch { /* response already closed */ }
  }
}

async function* readEventSource(url: string, signal: AbortSignal, EventSourceCtor: EventSourceLike): AsyncGenerator<SseFrame, void> {
  const source = new EventSourceCtor(url);
  const queue: SseFrame[] = [];
  let wake: (() => void) | undefined;
  let failed: unknown;
  let closed = false;
  const eventNames = ["run.started", "message.delta", "tool.call", "run.completed", "run.error", "run.canceled", "run", "completed", "error", "canceled"];
  const push = (event: MessageEvent<string>, eventName?: string) => {
    queue.push({ id: event.lastEventId || undefined, event: eventName, data: event.data });
    wake?.();
    wake = undefined;
  };
  const listeners = eventNames.map((eventName) => {
    const listener = (event: Event) => push(event as MessageEvent<string>, eventName);
    source.addEventListener(eventName, listener);
    return [eventName, listener] as const;
  });
  source.onmessage = (event) => push(event);
  source.onerror = () => {
    failed = new GoRuntimeError("Go runtime SSE connection closed", { code: "stream_disconnected", retryable: true });
    wake?.();
    wake = undefined;
  };
  const onAbort = () => {
    closed = true;
    source.close();
    wake?.();
    wake = undefined;
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!closed) {
      if (signal.aborted) return;
      if (queue.length) {
        yield queue.shift()!;
        continue;
      }
      if (failed) throw failed;
      await new Promise<void>((resolve) => { wake = resolve; });
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    source.close();
    for (const [eventName, listener] of listeners) source.removeEventListener(eventName, listener);
  }
}

const parseEventFrame = (frame: SseFrame): GoRuntimeEvent | undefined => {
  try {
    const parsed = JSON.parse(frame.data) as GoRuntimeEvent;
    if (!parsed || typeof parsed !== "object") return undefined;
    return { ...parsed, id: parsed.id || frame.id, type: parsed.type || frame.event || "" };
  } catch {
    return undefined;
  }
};

async function* streamRun(options: {
  eventsUrl: string;
  signal: AbortSignal;
  fetchImpl: FetchLike;
  eventSourceImpl?: EventSourceLike;
  reconnectAttempts: number;
  reconnectDelayMs: number;
}): AsyncGenerator<GoRuntimeEvent, void> {
  let lastEventId = "";
  let attempt = 0;
  let terminal = false;
  while (!terminal) {
    if (options.signal.aborted) throw options.signal.reason instanceof Error ? options.signal.reason : new DOMException("The operation was aborted", "AbortError");
    try {
      const response = await options.fetchImpl(options.eventsUrl, {
        method: "GET",
        headers: { Accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) },
        signal: options.signal,
      });
      if (!response.ok) throw await responseError(response);
      const frames = response.body
        ? readReadableSse(response, options.signal)
        : options.eventSourceImpl
        ? readEventSource(options.eventsUrl, options.signal, options.eventSourceImpl)
        : (async function* (): AsyncGenerator<SseFrame> { throw new GoRuntimeError("SSE streaming is unsupported in this browser", { code: "stream_unsupported" }); })();
      let received = false;
      for await (const frame of frames) {
        const event = parseEventFrame(frame);
        if (!event) continue;
        received = true;
        if (event.id) lastEventId = event.id;
        const type = normalizeEventType(event, frame.event);
        if (["run.completed", "run.error", "run.canceled", "completed", "error", "canceled"].includes(type)) terminal = true;
        yield { ...event, type };
      }
      if (terminal) return;
      throw new GoRuntimeError(received ? "Go runtime SSE stream ended before completion" : "Go runtime SSE stream was empty", { code: "stream_disconnected", retryable: true });
    } catch (error) {
      if (options.signal.aborted) throw error;
      if (attempt >= options.reconnectAttempts) throw error;
      await delay(Math.max(0, options.reconnectDelayMs) * 2 ** attempt, options.signal);
      attempt += 1;
    }
  }
}

const customString = (options: RunOptions, key: string): string | undefined => {
  const value = options.runConfig.custom?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const customPositiveInt = (options: RunOptions, key: string): number | undefined => {
  const value = options.runConfig.custom?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
};

async function* runFallback(adapter: ChatModelAdapter, options: RunOptions): AsyncGenerator<ChatModelRunResult, void> {
  const result = adapter.run(options);
  if (typeof (result as AsyncIterable<ChatModelRunResult>)[Symbol.asyncIterator] === "function") {
    for await (const update of result as AsyncIterable<ChatModelRunResult>) yield update;
  } else {
    yield await result as ChatModelRunResult;
  }
}

/**
 * Build an assistant-ui adapter for the Go HTTP/SSE runtime. The adapter sends
 * only the prompt and model-routing metadata; provider credentials stay in the
 * Go process environment and never enter this bundle or localStorage.
 */
export function createGoRuntimeAdapter(options: GoRuntimeAdapterOptions = {}): ChatModelAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? defaultBaseUrl());
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = Math.max(250, options.timeoutMs ?? 8_000);
  const reconnectAttempts = Math.max(0, Math.floor(options.reconnectAttempts ?? 2));
  const reconnectDelayMs = Math.max(0, options.reconnectDelayMs ?? 250);
  const eventSourceImpl = options.eventSourceImpl ?? (typeof globalThis.EventSource === "function" ? globalThis.EventSource : undefined);

  return {
    async *run(runOptions) {
      const fallback = options.fallback;
      let controller: AbortController | undefined;
      let runId: string | undefined;
      // Once POST /runs has succeeded, the server owns the run and may have
      // already persisted user/output messages. Falling back to a local
      // adapter after an SSE disconnect would create a second, divergent
      // response in the same thread. Fallback is therefore limited to errors
      // encountered before a server run was created.
      let runtimeStarted = false;
      let cancelSent = false;
      let completed = false;
      let onParentAbort: (() => void) | undefined;
      let onRuntimeAbort: (() => void) | undefined;
      let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const parentSignal = runOptions.abortSignal;
      try {
        controller = new AbortController();
        onParentAbort = () => controller?.abort(parentSignal.reason);
        if (parentSignal.aborted) onParentAbort();
        else parentSignal.addEventListener("abort", onParentAbort, { once: true });
        timer = globalThis.setTimeout(() => controller?.abort(new DOMException("Go runtime request timed out", "TimeoutError")), timeoutMs);
        const cancel = () => {
          if (!runId || cancelSent) return;
          cancelSent = true;
          void fetchImpl(runtimeUrl(baseUrl, `/runs/${encodeURIComponent(runId)}/cancel`), { method: "POST", headers: { Accept: "application/json", "X-Request-ID": randomRequestId() } }).catch(() => undefined);
        };
        onRuntimeAbort = cancel;
        controller.signal.addEventListener("abort", onRuntimeAbort, { once: true });

        const latest = [...runOptions.messages].reverse().find((message) => message.role === "user");
        const { prompt, capabilities } = readPrompt(latest);
        if (!prompt) {
          if (fallback) {
            yield* runFallback(fallback, runOptions);
            return;
          }
          throw new GoRuntimeError("A prompt is required", { code: "invalid_request" });
        }
        const sessionId = options.sessionId ?? runOptions.unstable_threadId;
        const body: Record<string, unknown> = {
          version: RUNTIME_VERSION,
          prompt,
          input_capabilities: capabilities,
        };
        const provider = customString(runOptions, "provider") ?? options.provider;
        const model = customString(runOptions, "model") ?? options.model;
        const reasoningEffort = customString(runOptions, "reasoning_effort");
        const maxTokens = customPositiveInt(runOptions, "max_tokens");
        if (sessionId) body.session_id = sessionId;
        if (provider) body.provider = provider;
        if (model) body.model = model;
        if (options.streamingMode) body.streaming_mode = options.streamingMode;
        if (reasoningEffort) body.reasoning_effort = reasoningEffort;
        if (maxTokens) body.max_tokens = maxTokens;

        // Session-scoped sends let the API persist the user message and keep
        // the run attached to the same server session used for hydration.
        // Playground runs without a session still use the generic route.
        const startPath = sessionId ? `/sessions/${encodeURIComponent(sessionId)}/messages` : "/runs";
        const startResponse = await fetchImpl(runtimeUrl(baseUrl, startPath), {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json", "X-Request-ID": randomRequestId() },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!startResponse.ok) throw await responseError(startResponse);
        const start = parseRunStart(await startResponse.json());
        runId = start.run_id;
        runtimeStarted = true;
        const eventsUrl = start.events_url ? new URL(start.events_url, startResponse.url || runtimeUrl(baseUrl, startPath)).toString() : runtimeUrl(baseUrl, `/runs/${encodeURIComponent(runId)}/events`);
        let text = "";
        const toolCalls = new Map<string, ToolCallMessagePart<any>>();
        let lastToolCallId: string | undefined;
        const content = (): Array<{ type: "text"; text: string } | ToolCallMessagePart<any>> => [
          ...(text ? [{ type: "text" as const, text }] : []),
          ...toolCalls.values(),
        ];
        const emitContent = (status: NonNullable<ChatModelRunResult["status"]>) => ({ content: content(), status });
        for await (const event of streamRun({ eventsUrl, signal: controller.signal, fetchImpl, eventSourceImpl, reconnectAttempts, reconnectDelayMs })) {
          const type = normalizeEventType(event);
          if (type === "message.delta" || type === "run") {
            const next = appendEventText(text, event);
            if (next !== text) {
              text = next;
              if (options.streamingMode !== "buffered") yield emitContent({ type: "running" });
            }
          }
          if (type === "tool.call") {
            const toolCallId = String(eventValue(event, "tool_call_id", "toolCallId") || event.id || `tool-${toolCalls.size + 1}`);
            const toolName = String(eventValue(event, "tool_name", "toolName", "name") || "tool");
            const rawArgs = eventValue(event, "args", "arguments", "input");
            const { args, argsText } = jsonArgs(rawArgs);
            toolCalls.set(toolCallId, { type: "tool-call", toolCallId, toolName, args, argsText, isPreliminary: true });
            lastToolCallId = toolCallId;
            if (options.streamingMode !== "buffered") yield emitContent({ type: "running" });
          }
          if (type === "tool.result") {
            const toolCallId = String(eventValue(event, "tool_call_id", "toolCallId") || lastToolCallId || "");
            const previous = toolCalls.get(toolCallId);
            if (previous) {
              const result = eventValue(event, "result", "output", "text");
              toolCalls.set(toolCallId, { ...previous, result, isPreliminary: false });
            }
            if (options.streamingMode !== "buffered") yield emitContent({ type: "running" });
          }
          if (type === "run.error" || type === "error") {
            const message = event.error_message || "Go runtime failed to generate a response";
            completed = true;
            yield emitContent({ type: "incomplete", reason: "error", error: { code: event.error_code || "runtime_error", message } });
            return;
          }
          if (type === "run.canceled" || type === "canceled") {
            completed = true;
            yield emitContent({ type: "incomplete", reason: "cancelled" });
            return;
          }
          if (type === "run.completed" || type === "completed") {
            completed = true;
            yield emitContent({ type: "complete", reason: "stop" });
            return;
          }
        }
        throw new GoRuntimeError("Go runtime ended without a terminal event", { code: "stream_incomplete", retryable: true });
      } catch (error) {
        if (parentSignal.aborted) throw error;
        if (controller?.signal.aborted && timer !== undefined) {
          throw new GoRuntimeError("Go runtime request timed out", { code: "timeout", retryable: true });
        }
        if (fallback && !runtimeStarted && canUseLocalFallback(error)) {
          yield* runFallback(fallback, runOptions);
          return;
        }
        throw error;
      } finally {
        if (timer !== undefined) globalThis.clearTimeout(timer);
        if (onParentAbort) parentSignal.removeEventListener("abort", onParentAbort);
        // Aborting an unfinished run informs the Go runtime that the browser
        // stopped listening. A normal terminal completion must not issue a
        // late cancel request after the run has already completed.
        if (controller && !completed && !controller.signal.aborted) controller.abort();
        if (controller && onRuntimeAbort) controller.signal.removeEventListener("abort", onRuntimeAbort);
      }
    },
  };
}
