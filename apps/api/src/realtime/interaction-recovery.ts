import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords } from '../cloud/records.js';

/** Historical browser interaction evidence is read-only. It cannot grant a
 * successor lease, consume an old command, or requeue an uncertain effect. */
export function inspectInteraction(store: DatabaseStore, owner: string, taskId: string, sequence: number) {
  const command = store.db.prepare(`SELECT c.*,t.target,r.snapshot,r.phase,r.effects,r.attempt FROM cloud_task_commands c
    JOIN cloud_tasks task ON task.id=c.task_id JOIN executor_interaction_targets t ON t.command_id=c.id
    LEFT JOIN executor_interaction_recovery r ON r.command_id=c.id WHERE c.id=? AND c.task_id=? AND task.owner_id=?`).get(sequence, taskId, owner) as any;
  if (!command) throw new Error('interaction_not_found');
  const task = store.db.prepare('SELECT status,worker_id,lease_expires_at,input,resource,kind FROM cloud_tasks WHERE owner_id=? AND id=?').get(owner, taskId) as any;
  const snapshot = command.snapshot ? JSON.parse(command.snapshot) : null;
  const current = snapshot ? new CloudRecords(store).get(owner, 'chats', snapshot.id) : null;
  const effects = (JSON.parse(command.effects ?? '[]') as { operationId: string; kind: string }[]).map(effect => {
    const row = store.db.prepare('SELECT status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, effect.operationId) as any;
    return { ...effect, receipt: row ? { status: row.status, result: JSON.parse(row.result ?? 'null') } : null };
  });
  const target = effects.some(e => e.kind === 'target' && e.receipt?.status === 'completed');
  const resource = effects.some(e => e.kind === 'resource' && e.receipt?.status === 'completed');
  const disposition = target && (command.action !== 'confirmPlan' || resource) ? 'applied'
    : snapshot && command.phase === 'started' && effects.length === 0 && isDeepStrictEqual(snapshot, current) ? 'resumable' : 'uncertain';
  const value = { taskId, sequence, action: command.action, value: JSON.parse(command.value), phase: command.phase ?? 'legacy-unknown', attempt: command.attempt ?? 0, snapshot, current, effects, disposition, task };
  const observed = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return { ...value, observed };
}
