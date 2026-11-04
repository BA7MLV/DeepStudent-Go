import type { ChatRow } from '../store/db';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';

/** Browser adapter: transport lifetime belongs to the account Runtime; this
 * translates the wire row envelope, not conversation ordering or deduplication. */
export function followServerSession(id: number, callbacks: {
  changed(page: { rows: ChatRow[]; hasOlder: boolean }): Promise<void>;
  failed(error: string): void;
}) {
  const owner = cloud.userId;
  let stopped = false, release: (() => void) | undefined, off: (() => void) | undefined;
  void serverRuntime(owner).then(runtime => {
    if (stopped || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
    const model = runtime.session(id);
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
          if (snapshot.status === 'error') { callbacks.failed(snapshot.error ?? 'session_unavailable'); continue; }
          if (snapshot.status !== 'ready') continue;
          const projection = model.projection();
          if (!projection) continue;
          const rows = projection.rows.map(row => {
            // The generated codec validates the envelope; business row extras
            // keep their existing schema/renderer semantics in the adapter.
            return { ...row.data, id: row.id, sessionId: row.sessionId, createdAt: row.createdAt, role: row.role, content: row.content } as unknown as ChatRow;
          });
          await callbacks.changed({ rows, hasOlder: projection.hasOlder });
        }
      })().catch(error => { if (current()) callbacks.failed(error instanceof Error ? error.message : String(error)); })
        .finally(() => { busy = false; if (pending && current()) refresh(); else pending = false; });
    };
    off = model.subscribe(refresh); release = model.acquire(); refresh();
  }).catch(error => { if (!stopped && owner === cloud.userId) callbacks.failed(error instanceof Error ? error.message : String(error)); });
  return () => { stopped = true; off?.(); release?.(); };
}
