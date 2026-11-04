import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords } from '../cloud/records.js';
import { validateAskAnswer, askAnswerText } from '@wangke/study-core/ask-user';
import type { InteractionReconcile } from '@wangke/contracts/client-runtime';

export function interactionState(store: DatabaseStore, owner: string, taskId: string, sequence: number) {
  const command = store.db.prepare(`SELECT c.*,t.target,r.snapshot,r.phase,r.effects,r.attempt FROM cloud_task_commands c
    JOIN cloud_tasks task ON task.id=c.task_id JOIN executor_interaction_targets t ON t.command_id=c.id
    LEFT JOIN executor_interaction_recovery r ON r.command_id=c.id WHERE c.id=? AND c.task_id=? AND task.owner_id=?`).get(sequence, taskId, owner) as any;
  if (!command) throw new Error('interaction_not_found');
  return command;
}

/** Only successful, task-bound producer/resource receipts are effect evidence.
 * A changed projection alone is not evidence that this callback did the work. */
export function noteInteractionEffect(store: DatabaseStore, owner: string, taskId: string, operationId: string, kind: 'resource' | 'target', products?: any[], operation?: any) {
  const commands = store.db.prepare(`SELECT c.id FROM cloud_task_commands c JOIN executor_interaction_recovery r ON r.command_id=c.id WHERE c.task_id=? AND r.phase='executing' AND c.consumed=0`).all(taskId) as { id: number }[];
  for (const { id } of commands) {
    const command = interactionState(store, owner, taskId, id), snapshot = JSON.parse(command.snapshot);
    const effects = JSON.parse(command.effects);
    if (kind === 'resource') {
      if (command.action !== 'confirmPlan' || operation?.kind !== 'organizeCourses' || !isDeepStrictEqual(operation.folders, snapshot.folderPlan?.folders)) continue;
    } else {
      const product = products?.find(p => p.kind === 'conversationMessage' && p.value?.id === snapshot.id);
      if (!product || !isDeepStrictEqual(product.expected?.ask ?? product.expected?.folderPlan, snapshot.ask ?? snapshot.folderPlan)) continue;
      const row = product.value;
      if (command.action === 'answerAsk') {
        const answer = validateAskAnswer(snapshot.ask, JSON.parse(command.value));
        if (!isDeepStrictEqual(row.ask, { ...snapshot.ask, picked: askAnswerText(answer), answer })) continue;
      } else if (!isDeepStrictEqual(row.folderPlan, { ...snapshot.folderPlan, applied: command.action === 'confirmPlan' ? 1 : 2 })) continue;
    }
    if (!effects.some((effect: any) => effect.operationId === operationId && effect.kind === kind)) effects.push({ operationId, kind });
    store.db.prepare('UPDATE executor_interaction_recovery SET effects=? WHERE command_id=?').run(JSON.stringify(effects), id);
  }
}

export function inspectInteraction(store: DatabaseStore, owner: string, taskId: string, sequence: number) {
  const command = interactionState(store, owner, taskId, sequence);
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

export function reconcileInteraction(store: DatabaseStore, owner: string, request: InteractionReconcile) {
  return store.transaction(() => {
    const detail = inspectInteraction(store, owner, request.taskId, request.sequence);
    if (detail.observed !== request.observed) throw new Error('interaction_observation_changed');
    if (request.action === 'settle' && detail.disposition !== 'applied' || request.action === 'resume' && detail.disposition !== 'resumable') throw new Error('interaction_evidence_required');
    // Revoke the old realm before granting any explicit successor. No imported
    // checkpoint, client selector or old lease can write after this transaction.
    store.db.prepare("UPDATE cloud_tasks SET status='interrupted',worker_id=NULL,lease_expires_at=NULL,error='interaction_requires_reconciliation' WHERE id=? AND owner_id=?").run(request.taskId, owner);
    store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(request.taskId);
    if (request.action === 'settle') {
      store.db.prepare('UPDATE cloud_task_commands SET consumed=1 WHERE id=?').run(request.sequence);
      store.db.prepare("UPDATE executor_interaction_recovery SET phase='applied' WHERE command_id=?").run(request.sequence);
      store.db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify({ sequence: request.sequence, phase: 'applied' }), owner, `executor-interaction-${request.taskId}-${request.sequence}`);
    } else if (request.action === 'resume') {
      const input = JSON.parse(detail.task.input);
      if (detail.task.kind !== 'chat' || detail.task.resource !== `session:${input.sessionId}` || !detail.snapshot?.resume) throw new Error('interaction_checkpoint_missing');
      store.db.prepare("UPDATE executor_interaction_recovery SET phase='resumable',attempt=attempt+1 WHERE command_id=?").run(request.sequence);
      store.db.prepare("UPDATE cloud_tasks SET input=?,status='queued',error=NULL,executor='browser' WHERE id=?").run(JSON.stringify({ ...input, action: 'resumeInteraction', rowId: detail.snapshot.id, interactionSequence: request.sequence }), request.taskId);
    } else store.db.prepare("UPDATE executor_interaction_recovery SET phase='uncertain' WHERE command_id=?").run(request.sequence);
    return inspectInteraction(store, owner, request.taskId, request.sequence);
  });
}
