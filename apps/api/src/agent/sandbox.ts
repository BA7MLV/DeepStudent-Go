import { agentHttpInit } from './http.js';

export type SandboxRequest = { owner: string; threadId: string; projectId?: string; executionId: string; command: string; network?: boolean; timeoutSeconds?: number; systemWrite?: boolean };
export function shellTimeoutSeconds(value?: number) {
  if (value === undefined) return 120;
  if (!Number.isInteger(value) || value < 1 || value > 600) throw new Error('invalid_shell_timeout');
  return value;
}
// Container deadline < broker watchdog (+10s) < HTTP deadline (+30s) < tool
// deadline (+40s), leaving room for Docker startup and confirmed cleanup.
export const shellToolTimeoutMs = (args: { timeoutSeconds?: number }) => shellTimeoutSeconds(args.timeoutSeconds) * 1000 + 40_000;
export type SandboxResult = { stdout: string; stderr: string; exitCode: number; terminationReason?: string; output?: { stdoutBytes: number; stderrBytes: number; stdoutTruncated: boolean; stderrTruncated: boolean; complete: boolean; limitBytes: number }; artifacts?: object; outputStorageError?: string };
export type SandboxOutputSink = (stream: 'stdout' | 'stderr', chunk: Uint8Array) => Promise<void>;
export type SandboxExecutor = (request: SandboxRequest, signal: AbortSignal, output?: SandboxOutputSink) => Promise<SandboxResult>;
export const sandboxFailureCodes = ['sandbox_unavailable', 'sandbox_not_configured', 'sandbox_busy', 'sandbox_cleanup_pending', 'sandbox_start_failed', 'sandbox_unauthorized', 'sandbox_invalid_request', 'sandbox_protocol_error'] as const;
export class SandboxFailure extends Error {
  constructor(readonly code: typeof sandboxFailureCodes[number], readonly terminationReason?: string) { super(code); }
}

async function brokerFailure(response: Response) {
  const body = await response.json().catch(() => ({})) as { error?: string; terminationReason?: string };
  const code = body.error === 'unauthorized' ? 'sandbox_unauthorized' : ['invalid_request', 'invalid_project_workspace'].includes(body.error ?? '') ? 'sandbox_invalid_request' : sandboxFailureCodes.includes(body.error as typeof sandboxFailureCodes[number]) ? body.error as typeof sandboxFailureCodes[number] : 'sandbox_unavailable';
  return new SandboxFailure(code, body.terminationReason);
}
export type SandboxCleanup = (executionId: string) => Promise<void>;
export type SandboxFileRequest = { threadId: string; projectId?: string; executionId: string; path: string };
export type SandboxFileReader = (request: SandboxFileRequest, signal: AbortSignal) => Promise<Uint8Array>;

/** Binary transfer is independent of shell stdout (which is deliberately truncated). */
export const readSandboxFile: SandboxFileReader = async (request, signal) => {
  const url = process.env.SANDBOX_URL, token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_unavailable');
  const response = await fetch(`${url}/files/read`, {
    method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(response.status === 404 ? 'workspace_file_not_found' : response.status === 413 ? 'workspace_file_too_large_or_empty' : response.status === 409 ? 'workspace_busy' : 'workspace_file_unavailable');
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('workspace_file_unavailable');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 20 * 1024 * 1024) throw new Error('workspace_file_too_large_or_empty');
      chunks.push(value);
    }
    if (!size) throw new Error('workspace_file_too_large_or_empty');
    return Buffer.concat(chunks);
  } finally { await reader.cancel(); }
};

// A disconnected execute request is not proof that its container has exited.
// The broker acknowledges cancellation only after removing the container.
export const cancelSandbox: SandboxCleanup = async executionId => {
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new Error('sandbox_not_configured');
  const response = await fetch(`${url}/cancel`, {
    method: 'POST', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ executionId }),
  });
  if (!response.ok) throw new Error('sandbox_cleanup_pending');
};

// Only the broker has Docker access. Neither the API nor model commands get its socket.
export const executeSandbox: SandboxExecutor = async (request, signal, output) => {
  const timeoutMs = shellTimeoutSeconds(request.timeoutSeconds) * 1000 + 30_000;
  const url = process.env.SANDBOX_URL;
  const token = process.env.SANDBOX_TOKEN;
  if (!url || !token) throw new SandboxFailure('sandbox_not_configured');
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const response = await fetch(`${url}/execute`, agentHttpInit({
    method: 'POST', signal: deadline,
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson', authorization: `Bearer ${token}` },
    body: JSON.stringify(request),
  }));
  if (!response.ok) throw await brokerFailure(response);
  // A rolling upgrade may still have an older, JSON-only broker.
  if (!response.headers.get('content-type')?.includes('application/x-ndjson')) return await response.json() as SandboxResult;
  if (!response.body) throw new SandboxFailure('sandbox_protocol_error');
  const reader = response.body.getReader();
  const decoder = new TextDecoder(); let pending = ''; let result: SandboxResult | undefined; let bytes = 0;
  const counts = { stdout: 0, stderr: 0 };
  try {
    for (;;) {
      deadline.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (line.length > 128 * 1024 || result) throw new SandboxFailure('sandbox_protocol_error');
        const event = JSON.parse(line);
        if (!event || typeof event !== 'object' || Array.isArray(event)) throw new SandboxFailure('sandbox_protocol_error');
        if (event.type === 'stdout' || event.type === 'stderr') {
          if (typeof event.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.data)) throw new SandboxFailure('sandbox_protocol_error');
          const chunk = Buffer.from(event.data, 'base64'); bytes += chunk.length;
          counts[event.type as 'stdout' | 'stderr'] += chunk.length;
          if (bytes > 16 * 1024 * 1024) throw new SandboxFailure('sandbox_protocol_error');
          await output?.(event.type, chunk);
        } else if (event.type === 'error' || event.error) {
          throw new SandboxFailure(sandboxFailureCodes.includes(event.error) ? event.error : 'sandbox_unavailable', event.terminationReason);
        } else if (event.type === 'result' && typeof event.stdout === 'string' && typeof event.stderr === 'string' && Number.isInteger(event.exitCode)) {
          const meta = event.output;
          if (!meta || meta.stdoutBytes !== counts.stdout || meta.stderrBytes !== counts.stderr || typeof meta.stdoutTruncated !== 'boolean' || typeof meta.stderrTruncated !== 'boolean' || typeof meta.complete !== 'boolean' || meta.limitBytes !== 16 * 1024 * 1024) throw new SandboxFailure('sandbox_protocol_error');
          const { type: _type, ...value } = event; result = value;
        } else throw new SandboxFailure('sandbox_protocol_error');
      }
      if (pending.length > 128 * 1024) throw new SandboxFailure('sandbox_protocol_error');
    }
    if (!result || pending || decoder.decode()) throw new SandboxFailure('sandbox_protocol_error');
    return result;
  } catch (error) {
    if (error instanceof SyntaxError) throw new SandboxFailure('sandbox_protocol_error');
    throw error;
  } finally { await reader.cancel().catch(() => {}); }
};
