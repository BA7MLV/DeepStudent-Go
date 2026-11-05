import { create } from 'zustand';
import { db } from './db';
import { runCloudTask } from '../cloud/tasks';
import { taskModelChoice } from './taskModel';
import { accountLifecycle } from '../client/account-lifecycle';

interface ContextRow { id?: number; rowId?: number; role: string; content: string }
interface HistoryRow { role: string; content: string; resume?: unknown; interrupted?: boolean }
export interface CompressionState {
  phase: 'idle' | 'compressing' | 'success' | 'unchanged' | 'error';
  message: string; omitted: ReadonlyMap<number, string>; attempt: string; revision: number;
}
export const EMPTY_COMPRESSION: CompressionState = { phase: 'idle', message: '', omitted: new Map(), attempt: '', revision: 0 };
export const useContextCompressionStore = create<{ sessions: Record<number, CompressionState> }>(() => ({ sessions: {} }));
const pending = new Map<number, Promise<void>>();
let generation = 0;
accountLifecycle.onDisposed(() => {
  generation++; pending.clear(); useContextCompressionStore.setState({ sessions: {} });
});
function patch(id: number, value: Partial<CompressionState>) {
  useContextCompressionStore.setState(state => ({ sessions: { ...state.sessions, [id]: { ...(state.sessions[id] ?? EMPTY_COMPRESSION), ...value } } }));
}
/** Preview only: the server independently applies its durable omission plan.
 * Content equality invalidates an omission after editing; the latest two turns stay. */
export function retainedContext<T extends ContextRow>(rows: T[], state = EMPTY_COMPRESSION): T[] {
  let protectedFrom = 0, turns = 0;
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].role === 'user' && ++turns === 2) { protectedFrom = i; break; }
  return rows.filter((row, i) => {
    const id = row.id ?? row.rowId;
    return i >= protectedFrom || id == null || state.omitted.get(id) !== row.content;
  });
}
function waitFor(job: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return job;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    job.then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
  });
}
/** Submit a server-owned compression command. Never execute Jev/model IO or
 * write conversation rows/checkpoints in the browser, even on server failure. */
export async function prepareSessionHistory<T extends HistoryRow & ContextRow>(
  sessionId: number, rows: T[], budget: number, query: string, _config: { contextCompression: boolean },
  options: { signal?: AbortSignal; force?: boolean; onStart?: () => void; onCompressed?: (turns: number) => void } = {},
): Promise<T[]> {
  const database = db, owner = accountLifecycle.current(), epoch = generation;
  const current = () => database === db && generation === epoch && (!owner || owner.current());
  const check = () => { options.signal?.throwIfAborted(); if (!current()) throw new Error('client_account_changed'); };
  check();
  while (pending.has(sessionId)) { await waitFor(pending.get(sessionId)!, options.signal); check(); }
  // Freeze the original complete history baseline, not a later/latest read after admission.
  const expected = rows.map(row => {
    const id = row.id ?? row.rowId;
    if (id == null) throw new Error('context_history_not_committed');
    return { id, content: row.content };
  });
  const previous = useContextCompressionStore.getState().sessions[sessionId] ?? EMPTY_COMPRESSION;
  const attempt = JSON.stringify([budget, query, expected]);
  if (!options.force && previous.attempt === attempt) return retainedContext(rows, previous);
  let settle!: () => void;
  const job = new Promise<void>(resolve => { settle = resolve; }); pending.set(sessionId, job);
  patch(sessionId, { phase: 'compressing', message: '正在由服务器压缩上下文…', attempt, revision: previous.revision + 1 });
  try {
    options.onStart?.();
    const selection = taskModelChoice(sessionId);
    const result = await runCloudTask('chat', `session:${sessionId}`, {
      action: 'compressContext', sessionId, budget, query, force: !!options.force, expected,
      ...(selection ? { modelSelection: JSON.parse(JSON.stringify(selection)) } : {}),
    }, undefined, options.signal) as { omitted: [number, string][]; removedTokens: number; phase: 'success' | 'unchanged'; message: string };
    check();
    if (!result || !Array.isArray(result.omitted) || !['success', 'unchanged'].includes(result.phase)
      || result.omitted.some(item => !Array.isArray(item) || !Number.isSafeInteger(item[0]) || typeof item[1] !== 'string')) throw new Error('context_compression_result_invalid');
    const omitted = new Map(result.omitted);
    patch(sessionId, { omitted, phase: result.phase, message: result.message, attempt });
    options.onCompressed?.(result.omitted.length);
    return retainedContext(rows, { ...previous, omitted });
  } catch (error) {
    if (current()) patch(sessionId, { phase: options.signal?.aborted ? 'idle' : 'error', message: options.signal?.aborted ? '已取消压缩' : `${error instanceof Error ? error.message : String(error)}，已保留原上下文`, attempt: '' });
    throw error;
  } finally { if (pending.get(sessionId) === job) pending.delete(sessionId); settle(); }
}
