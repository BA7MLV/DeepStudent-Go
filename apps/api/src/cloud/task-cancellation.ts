import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords } from './records.js';

/** All cancellation entry points revoke commit authority before aborting transports. */
export function cancelOwnerTask(store: DatabaseStore, owner: string, taskId: string) {
  store.transaction(() => {
    if (!store.db.prepare('SELECT 1 FROM cloud_tasks WHERE id=? AND owner_id=?').get(taskId, owner)) throw new Error('task_not_found');
    store.db.prepare('INSERT OR IGNORE INTO task_root_cancellations VALUES(?,?)').run(owner, taskId);
    const children = store.db.prepare('SELECT task_id FROM task_delegations WHERE owner_id=? AND (parent_task_id=? OR root_id=?) UNION SELECT id AS task_id FROM cloud_tasks WHERE owner_id=? AND root_task_id=?').all(owner, taskId, taskId, owner, taskId) as { task_id: string }[];
    const records = new CloudRecords(store);
    for (const id of [taskId, ...children.map(row => row.task_id)]) {
      const changed = store.db.prepare("UPDATE cloud_tasks SET status='cancelled',updated_at=? WHERE id=? AND owner_id=? AND status IN ('queued','running','waiting_user','waiting_event')").run(new Date().toISOString(), id, owner);
      if (!changed.changes) continue;
      store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(id);
      const row = store.db.prepare('SELECT input,progress FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, owner) as { input: string; progress: string | null };
      const progress = row.progress ? JSON.parse(row.progress) : {};
      const answer = typeof progress.rowId === 'number' ? records.get(owner, 'chats', progress.rowId) : null;
      if (!answer || answer.taskId !== id || answer.sessionId !== JSON.parse(row.input).sessionId) continue;
      const stopped = { ...answer };
      delete stopped.interrupted; delete stopped.interruptReason;
      records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: answer.id, before: answer, after: stopped }]);
    }
  });
}
