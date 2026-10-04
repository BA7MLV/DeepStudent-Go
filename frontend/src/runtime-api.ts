/**
 * Small, browser-safe client for the versioned Go runtime HTTP API.
 *
 * The shell can still run without the Go process (for example on a static
 * preview), so callers should treat RuntimeApiError.unavailable as a signal to
 * keep using their local state and adapter fallback.
 */

export type RuntimeFetch = typeof fetch;

export type RuntimeApiOptions = {
  /** API base URL, normally `/api/v1` or an absolute local runtime URL. */
  baseUrl?: string;
  fetchImpl?: RuntimeFetch;
  signal?: AbortSignal;
};

export type RuntimeSession = {
  id: string;
  title?: string;
  created_at?: string;
  updated_at?: string;
};

export type RuntimeMessage = {
  id?: string;
  session_id?: string;
  run_id?: string;
  role: string;
  content: string;
  created_at?: string;
};

export type RuntimeRunStart = {
  run_id: string;
  session_id?: string;
  events_url?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  max_tokens?: number;
};

export type RuntimeSessionMessageInput = {
  prompt?: string;
  content?: string;
  provider?: string;
  model?: string;
  reasoning_effort?: string;
  max_tokens?: number;
  input_capabilities?: string[];
  input?: string[];
  streaming_mode?: "events" | "buffered";
};

type RuntimeErrorPayload = {
  error?: {
    code?: string;
    message?: string;
    request_id?: string;
    details?: unknown;
  };
};

const defaultBaseUrl = (): string => {
  const env = (import.meta as ImportMeta & { env?: Record<string, unknown> }).env;
  const configured = typeof env?.VITE_GO_RUNTIME_URL === "string" ? env.VITE_GO_RUNTIME_URL.trim() : "";
  return configured || "/api/v1";
};

export const normalizeRuntimeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "") || "/api/v1";

/** Resolve the runtime URL once per request so deployments can configure it at build time. */
export const runtimeApiBaseUrl = (value?: string): string => normalizeRuntimeBaseUrl(value ?? defaultBaseUrl());

export const runtimeApiUrl = (baseUrl: string | undefined, path: string): string => {
  const base = runtimeApiBaseUrl(baseUrl);
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
};

const randomRequestId = (): string => {
  const cryptoApi = typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto : undefined;
  return cryptoApi?.randomUUID() ?? `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export class RuntimeApiError extends Error {
  readonly status?: number;
  readonly code: string;
  readonly requestId?: string;
  /** True when no usable runtime API could be reached. */
  readonly unavailable: boolean;

  constructor(message: string, options: { status?: number; code?: string; requestId?: string; unavailable?: boolean } = {}) {
    super(message);
    this.name = "RuntimeApiError";
    this.status = options.status;
    this.code = options.code ?? "runtime_api_error";
    this.requestId = options.requestId;
    this.unavailable = options.unavailable ?? false;
  }
}

const parseError = async (response: Response): Promise<RuntimeApiError> => {
  let payload: RuntimeErrorPayload | undefined;
  try {
    payload = await response.json() as RuntimeErrorPayload;
  } catch {
    // Reverse proxies occasionally return HTML/plain text. Keep deployment
    // details out of the user-visible error and use the status code instead.
  }
  const detail = payload?.error;
  const status = response.status;
  return new RuntimeApiError(detail?.message || `Runtime API request failed (${status})`, {
    status,
    code: detail?.code || `http_${status}`,
    requestId: detail?.request_id,
    // A 404 is treated as unavailable for the shell because static previews
    // commonly answer `/api/v1` with their own not-found page. Resource-level
    // 404s are still handled by callers as an unavailable server, which keeps
    // startup hydration safely local without masking successful API responses.
    unavailable: status === 404 || status === 408 || status === 429 || status >= 500,
  });
};

const requestJSON = async <T>(path: string, init: RequestInit, options: RuntimeApiOptions): Promise<T> => {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await fetchImpl(runtimeApiUrl(options.baseUrl, path), {
      ...init,
      headers: {
        Accept: "application/json",
        "X-Request-ID": randomRequestId(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : "Runtime API is unavailable";
    throw new RuntimeApiError(message || "Runtime API is unavailable", { code: "network_unavailable", unavailable: true });
  }
  if (!response.ok) throw await parseError(response);
  try {
    return await response.json() as T;
  } catch {
    throw new RuntimeApiError("Runtime API returned an invalid response", { code: "invalid_response" });
  }
};

const encodeSessionId = (sessionId: string): string => encodeURIComponent(sessionId);

export async function listRuntimeSessions(options: RuntimeApiOptions = {}): Promise<RuntimeSession[]> {
  const payload = await requestJSON<{ sessions?: RuntimeSession[] } | RuntimeSession[]>("/sessions", { method: "GET" }, options);
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

export async function getRuntimeSessionMessages(sessionId: string, options: RuntimeApiOptions = {}): Promise<RuntimeMessage[]> {
  const payload = await requestJSON<{ messages?: RuntimeMessage[] } | RuntimeMessage[]>(`/sessions/${encodeSessionId(sessionId)}/messages`, { method: "GET" }, options);
  if (Array.isArray(payload)) return payload;
  return Array.isArray(payload.messages) ? payload.messages : [];
}

/** Create a stable server-side session before a new local chat sends its first message. */
export async function createRuntimeSession(session: { id: string; title?: string }, options: RuntimeApiOptions = {}): Promise<RuntimeSession> {
  const payload = await requestJSON<{ session?: RuntimeSession } | RuntimeSession>("/sessions", {
    method: "POST",
    body: JSON.stringify({ id: session.id, title: session.title ?? "" }),
  }, options);
  if ("session" in payload && payload.session) return payload.session;
  if ("id" in payload && typeof payload.id === "string") return payload;
  throw new RuntimeApiError("Runtime API did not return a session", { code: "invalid_response" });
}

/** Start a run through the session message route; the response is consumed by the SSE adapter. */
export async function postRuntimeSessionMessage(sessionId: string, message: RuntimeSessionMessageInput, options: RuntimeApiOptions = {}): Promise<RuntimeRunStart> {
  const payload = await requestJSON<RuntimeRunStart>(`/sessions/${encodeSessionId(sessionId)}/messages`, {
    method: "POST",
    body: JSON.stringify(message),
  }, options);
  if (!payload || typeof payload.run_id !== "string" || payload.run_id.trim() === "") {
    throw new RuntimeApiError("Runtime API did not return a run ID", { code: "invalid_response" });
  }
  return payload;
}

// Short aliases keep the client ergonomic for feature code while the
// Runtime-prefixed exports above remain unambiguous in generated bindings.
export const getSessions = listRuntimeSessions;
export const getSessionMessages = getRuntimeSessionMessages;
export const createSession = createRuntimeSession;
export const postSessionMessage = postRuntimeSessionMessage;
