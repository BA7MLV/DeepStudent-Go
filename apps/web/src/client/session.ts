import type { ChatRow } from '../store/db';
import type { RuntimeTask } from '@wangke/contracts/client-runtime';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { accountLifecycle } from './account-lifecycle';

/** Browser adapter: transport lifetime belongs to the account Runtime; this
 * translates the wire row envelope, not conversation ordering or deduplication. */
export function followServerSession(id: number, callbacks: {
  changed(page: { rows: ChatRow[]; hasOlder: boolean; tasks: RuntimeTask[] }): Promise<void>;
  failed(error: string): void;
}) {
  const owner = cloud.userId;
  const lifetime = accountLifecycle.current();
  let stopped = false, release: (() => void) | undefined, off: (() => void) | undefined;
  let replay = () => {};
  let readyResolve!: () => void, readyReject!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  void serverRuntime(owner).then(runtime => {
    if (stopped || owner !== cloud.userId || lifetime && !lifetime.current() || !isCurrentServerRuntime(runtime)) return;
    const model = runtime.session(id);
    const decoded = new WeakMap<object, ChatRow>();
    let pending = false, busy = false;
    const current = () => !stopped && owner === cloud.userId && isCurrentServerRuntime(runtime) && !runtime.signal.aborted;
    const refresh = () => {
      if (!current()) { pending = false; return; }
      pending = true;
      if (busy || stopped) return;
      busy = true;
      void (async () => {
        while (pending && current()) {
          pending = false;
          const snapshot = model.getSnapshot();
          if (snapshot.status === 'error') { callbacks.failed(snapshot.error ?? 'session_unavailable'); readyReject(new Error(snapshot.error)); continue; }
          if (snapshot.status !== 'ready') continue;
          const projection = model.projection();
          if (!projection) continue;
          const rows = projection.rows.map(row => {
            // The generated codec validates the envelope; business row extras
            // keep their existing schema/renderer semantics in the adapter.
            let value = decoded.get(row);
            if (!value) { value = { ...row.data, id: row.id, sessionId: row.sessionId, createdAt: row.createdAt, role: row.role, content: row.content } as unknown as ChatRow; decoded.set(row, value); }
            return value;
          });
          await callbacks.changed({ rows, hasOlder: projection.hasOlder, tasks: projection.tasks });
          readyResolve();
        }
      })().catch(error => { readyReject(error); if (current()) callbacks.failed(error instanceof Error ? error.message : String(error)); })
        .finally(() => { busy = false; if (pending && current()) refresh(); else pending = false; });
    };
    replay = refresh;
    off = model.subscribe(refresh); release = model.acquire(); refresh();
  }).catch(error => { readyReject(error); if (!stopped && owner === cloud.userId && (!lifetime || lifetime.current())) callbacks.failed(error instanceof Error ? error.message : String(error)); });
  return Object.assign(() => { stopped = true; off?.(); release?.(); readyReject(new Error('session_released')); }, { refresh: () => replay(), ready });
}
