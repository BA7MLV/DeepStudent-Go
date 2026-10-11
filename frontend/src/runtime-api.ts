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

export type RuntimeReadiness = {
  status: string;
  request_id?: string;
};

export type RuntimeProviderConfig = {
  id: string;
  name?: string;
  model?: string;
  base_url?: string;
  api_key_env?: string;
  streaming?: boolean;
};

/** Agent execution mode exposed by the Go runtime configuration surface. */
export type RuntimeAgentMode = "auto" | "manual" | "external";

/** Credential-free agent process metadata returned by GET /config. */
export type RuntimeAgentConfig = {
  default_provider?: string;
  default_model?: string;
  pi_endpoint?: string;
  pi_skip_start?: boolean;
  pi_mode?: RuntimeAgentMode | string;
  pi_command?: string;
  pi_args?: string[];
  pi_cancel_timeout?: string;
  pi_status?: RuntimePiStatus;
};

export type RuntimeConfig = {
  default_provider: string;
  default_model?: string;
  runtime?: RuntimeAgentConfig;
  providers: Record<string, RuntimeProviderConfig>;
};

/** Fields accepted by PATCH /config. Secrets are intentionally absent. */
export type RuntimeConfigUpdate = {
  provider?: string;
  model?: string;
  base_url?: string;
  pi_endpoint?: string;
  pi_skip_start?: boolean;
  pi_mode?: RuntimeAgentMode | string;
  pi_command?: string;
  pi_args?: string[];
  pi_cancel_timeout?: string;
};

export type RuntimePiCandidate = {
  name: string;
  command: string;
  path: string;
  version?: string;
  sidecar_capable: boolean;
};

export type RuntimePiStatus = {
  configured_mode?: string;
  effective_mode?: string;
  state?: string;
  command?: string;
  args?: string[];
  endpoint?: string;
  reason?: string;
};

export type RuntimePiDiscovery = {
  candidates: RuntimePiCandidate[];
  current_mode?: string;
  configured_mode?: string;
  status?: RuntimePiStatus;
  request_id?: string;
};

export type RuntimeAttachment = {
  sha256: string;
  size: number;
  mime: string;
  filename?: string;
  workspace_ref: string;
  created_at?: string;
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
  if (configured) return configured;
  if (typeof window !== "undefined") {
    const shellRuntime = new URLSearchParams(window.location.search).get("runtime");
    if (shellRuntime?.trim()) return shellRuntime.trim();
  }
  const protocol = typeof window !== "undefined" ? window.location.protocol : "http:";
  return protocol !== "http:" && protocol !== "https:" ? "http://127.0.0.1:8080/api/v1" : "/api/v1";
};

export const normalizeRuntimeBaseUrl = (value: string): string => value.trim().replace(/\/+$/, "") || "/api/v1";

/** Resolve the runtime URL once per request so deployments can configure it at build time. */
export const runtimeApiBaseUrl = (value?: string): string => normalizeRuntimeBaseUrl(value ?? defaultBaseUrl());

export const runtimeApiUrl = (baseUrl: string | undefined, path: string): string => {
  const base = runtimeApiBaseUrl(baseUrl);
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
};

export async function getRuntimeReadiness(options: RuntimeApiOptions = {}): Promise<RuntimeReadiness> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const base = runtimeApiBaseUrl(options.baseUrl);
  const healthBase = base.endsWith("/api/v1") ? base.slice(0, -"/api/v1".length) : base;
  let response: Response;
  try {
    response = await fetchImpl(`${healthBase}/readyz`, {
      method: "GET",
      headers: { Accept: "application/json", "X-Request-ID": randomRequestId() },
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : "Runtime API is unavailable";
    throw new RuntimeApiError(message || "Runtime API is unavailable", { code: "network_unavailable", unavailable: true });
  }
  if (!response.ok) throw await parseError(response);
  try { return await response.json() as RuntimeReadiness; }
  catch { throw new RuntimeApiError("Runtime API returned an invalid readiness response", { code: "invalid_response" }); }
}

export async function getRuntimeConfig(options: RuntimeApiOptions = {}): Promise<RuntimeConfig> {
  return requestJSON<RuntimeConfig>("/config", { method: "GET" }, options);
}

/** Discover optional local Pi CLI sidecars without inspecting credentials. */
export async function getRuntimePiDiscovery(options: RuntimeApiOptions = {}): Promise<RuntimePiDiscovery> {
  const payload = await requestJSON<RuntimePiDiscovery>("/pi/discovery", { method: "GET" }, options);
  return {
    ...payload,
    candidates: Array.isArray(payload.candidates) ? payload.candidates : [],
  };
}

export async function updateRuntimeConfig(update: RuntimeConfigUpdate, options: RuntimeApiOptions = {}): Promise<RuntimeConfig> {
  return requestJSON<RuntimeConfig>("/config", {
    method: "PATCH",
    body: JSON.stringify(update),
  }, options);
}

export type RuntimeConfigTestResult = { ok: boolean; provider: string; model: string };

export async function testRuntimeConfig(update: Pick<RuntimeConfigUpdate, "provider" | "model" | "base_url">, options: RuntimeApiOptions = {}): Promise<RuntimeConfigTestResult> {
  return requestJSON<RuntimeConfigTestResult>("/config/test", {
    method: "POST",
    body: JSON.stringify(update),
  }, options);
}

/** Upload an immutable blob to the Go attachment boundary before a message is sent. */
export async function uploadRuntimeAttachment(file: File, options: RuntimeApiOptions = {}): Promise<RuntimeAttachment> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const form = new FormData();
  form.append("file", file, file.name);
  let response: Response;
  try {
    response = await fetchImpl(runtimeApiUrl(options.baseUrl, "/attachments"), {
      method: "POST",
      headers: { Accept: "application/json", "X-Request-ID": randomRequestId() },
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    const message = error instanceof Error ? error.message : "Runtime API is unavailable";
    throw new RuntimeApiError(message || "Runtime API is unavailable", { code: "network_unavailable", unavailable: true });
  }
  if (!response.ok) throw await parseError(response);
  const payload = await response.json() as { attachment?: RuntimeAttachment } | RuntimeAttachment;
  const attachment: RuntimeAttachment | undefined = "attachment" in payload
    ? (payload as { attachment?: RuntimeAttachment }).attachment
    : (payload as RuntimeAttachment);
  if (!attachment || typeof attachment.workspace_ref !== "string" || !attachment.workspace_ref.trim()) {
    throw new RuntimeApiError("Runtime API returned an invalid attachment", { code: "invalid_response" });
  }
  return attachment;
}

export const runtimeAttachmentUrl = (workspaceRefOrSHA: string, baseUrl?: string): string => {
  const value = workspaceRefOrSHA.trim().replace(/^workspace:\/\/attachments\//, "");
  return runtimeApiUrl(baseUrl, `/attachments/${encodeURIComponent(value)}`);
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
