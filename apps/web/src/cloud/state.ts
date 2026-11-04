/** No React/store imports: storage and API entrypoints can consult this without cycles. */
import { apiUrl } from '../api/base';
export const cloud = {
  enabled: false,
  userId: '',
  worker: false,
  taskId: '',
  workerToken: '' as string,
  permissionId: undefined as string | undefined,
  maxSteps: 100,
  acceptedPlugins: [] as string[],
  taskSignal: undefined as AbortSignal | undefined,
};
export const remoteTasks = () => cloud.enabled && !cloud.worker;

export async function cloudRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  // GET is safe to replay and is used for task polling. Do not blindly retry
  // POST/DELETE: task creation and cancellation may have reached the server
  // even when the browser lost the response.
  const replayable = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  const signal = init.signal ?? undefined;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const response = await fetch(apiUrl(`/api/v1/cloud${path}`), {
        credentials: 'include', ...init,
        headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(cloud.workerToken ? { authorization: `Bearer ${cloud.workerToken}` } : {}), ...init.headers },
      });
      const body = await response.json().catch(() => ({}));
      if (response.ok) return body as T;
      const retryable = replayable && (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500);
      if (!retryable || attempt >= 2) {
        if (response.status === 401 && !cloud.worker) window.dispatchEvent(new Event('cloud-session-expired'));
        throw Object.assign(new Error(body.error || `HTTP ${response.status}`), { status: response.status, detail: body });
      }
      await waitForCloudRetry(response.headers.get('retry-after'), attempt, signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = (error as { status?: unknown } | null)?.status;
      const transient = replayable && (status === undefined && /failed to fetch|load failed|network|socket|econnreset|econnaborted|etimedout|timed out|socket hang up|connection.*closed/i.test(message));
      if (!transient || attempt >= 2) throw error;
      await waitForCloudRetry(undefined, attempt, signal);
    }
  }
}

async function waitForCloudRetry(retryAfter: string | null | undefined, attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const seconds = retryAfter == null ? NaN : Number(retryAfter);
  const retryAfterMs = Number.isFinite(seconds)
    ? seconds * 1000
    : retryAfter && !Number.isNaN(Date.parse(retryAfter)) ? Date.parse(retryAfter) - Date.now() : undefined;
  const delay = retryAfterMs == null
    ? Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250)
    : Math.min(30_000, Math.max(0, retryAfterMs));
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delay);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function requestToolPermission(capability: 'read' | 'write' | 'remove' | 'shell', args: unknown) {
  if (!cloud.worker) return;
  let permissionId: string | undefined;
  for (;;) {
    cloud.taskSignal?.throwIfAborted();
    const result = await cloudRequest<{ id?: string; status: string }>(`/tasks/${cloud.taskId}/authorize`, {
      method: 'POST', body: JSON.stringify({ capability, arguments: args, permissionId }), signal: cloud.taskSignal,
    });
    cloud.taskSignal?.throwIfAborted();
    if (result.status === 'approved') return result.id;
    if (result.status !== 'pending') throw new Error('该操作未获授权');
    permissionId = result.id;
    if (!permissionId) throw new Error('executor_permission_identity_missing');
    const runtime = await (await import('./executor-runtime')).executorRuntime();
    const status = await runtime.waitAuthorization(permissionId, cloud.taskSignal);
    if (status !== 'approved') throw new Error('该操作未获授权');
  }
}

export async function withToolPermission<T>(capability: 'read' | 'write' | 'remove', args: unknown, execute: () => Promise<T>): Promise<T> {
  if (!cloud.worker) return execute();
  const id = await requestToolPermission(capability, args);
  cloud.taskSignal?.throwIfAborted();
  const previous = cloud.permissionId;
  cloud.permissionId = id;
  try { return await execute(); }
  finally {
    // Commit all writes bearing this permit before closing it. A later tool invocation
    // needs a fresh approval, even when it happens to have the same arguments.
    try { await (await import('./sync')).flushCloud(); }
    finally {
      cloud.permissionId = previous;
      if (id) await cloudRequest(`/tasks/${cloud.taskId}/authorize/finish`, { method: 'POST', body: JSON.stringify({ permissionId: id }) });
    }
  }
}
