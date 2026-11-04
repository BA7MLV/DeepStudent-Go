import Dexie from 'dexie';
import type { OutboxRow } from './cache';
import { cloudDatabaseName } from '../store/db';
import { cloud } from './state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { encodeRecoveryValue } from './recovery-export';

const inspections = new WeakMap<object, () => boolean>();

/** Preserve expired/legacy executor transactions, including Blob bodies and
 * operation ids, without sending them with another task's capability.
 * The interactive database/outbox is not an input to this conversion. */
export async function quarantineExecutorOutbox(database: Dexie, taskId?: string) {
  if (!database.name.startsWith('wangke-cloud-executor-')) throw new Error('executor_recovery_database_denied');
  return database.transaction('rw', database.table('_cloudOutbox'), database.table('_cloudMeta'), async () => {
    const outbox = database.table<OutboxRow>('_cloudOutbox');
    const groups = new Map<string, OutboxRow[]>();
    for (const row of await outbox.orderBy('sequence').toArray()) {
      const group = groups.get(row.transaction) ?? []; group.push(row); groups.set(row.transaction, group);
    }
    let retained = 0;
    for (const [transaction, edits] of groups) {
      const id = `executor-recovery:${transaction}`;
      if (await database.table('_cloudMeta').get(id)) throw new Error('executor_recovery_identity_conflict');
      await database.table('_cloudMeta').add({ id, reason: edits.some(row => !row.executorTaskId) ? 'legacy-unscoped' : 'legacy-product-format',
        rows: edits, createdAt: Date.now(), status: 'requires-reconciliation' });
      await outbox.bulkDelete(edits.map(row => row.sequence!));
      retained += edits.length;
    }
    return retained;
  });
}

export async function listExecutorRecovery(owner: string) {
  const name = cloudDatabaseName(owner, true);
  if (!owner || owner !== cloud.userId || cloud.worker || !await Dexie.exists(name)) return [];
  const database = new Dexie(name);
  try {
    await database.open();
    const rows = (await database.table('_cloudMeta').toArray()).filter(row =>
      (row.id.startsWith('executor-execution:') || row.id.startsWith('executor-recovery:') || row.id.startsWith('resource-command:') || row.id.startsWith('executor-products:') || row.id.startsWith('executor-product-blob:') || row.id.startsWith('executor-reset:') || row.id.startsWith('executor-interaction:') && !row.value?.receipt) && row.status !== 'archived' || row.id.startsWith('executor-completion:'));
    return owner === cloud.userId && !cloud.worker ? rows : [];
  } finally { database.close(); }
}

export async function inspectExecutorRecovery(id: string) {
  const owner = cloud.userId, rows = await listExecutorRecovery(owner), row = rows.find(row => row.id === id);
  if (!row) throw new Error('executor_recovery_not_found');
  const runtime = await serverRuntime(owner);
  const operationId = (row.value?.operationId ?? row.value?.request?.operationId ?? (row.value?.command ? `executor-interaction-${row.value.taskId}-${row.value.command.sequence}` : undefined)) as string | undefined;
  const operationIds = (row.rows ?? []).map((edit: OutboxRow) => edit.id);
  const taskIds = [...new Set<string>((row.rows ?? []).flatMap((edit: OutboxRow) => edit.executorTaskId ? [edit.executorTaskId] : []))];
  const operation = row.value?.request?.operation;
  const command = row.value?.command;
  const [receipt, projection, observed] = await Promise.all([
    operationId ? runtime.receipt(operationId) : Promise.resolve(null),
    runtime.read({ kind: 'executorRecovery', ...(row.value?.taskId || row.value?.request?.taskId || taskIds.length === 1 ? { taskId: row.value?.taskId ?? row.value?.request?.taskId ?? taskIds[0] } : {}), operationIds }),
    command ? runtime.read({ kind: 'interactionRecovery', taskId: row.value.taskId, sequence: command.sequence }).then(result => result.value)
      : operation?.kind === 'saveMarkdown'
      ? runtime.read({ kind: 'courseDocument', courseId: operation.courseId }).then(result => ({ document: result.value }), error => ({ error: error instanceof Error ? error.message : String(error) }))
      : Promise.resolve(null),
  ]);
  if (owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  const detail = { row, receipt, server: projection.value, observed };
  inspections.set(detail, () => owner === cloud.userId && !cloud.worker && isCurrentServerRuntime(runtime));
  return detail;
}

/** Only a live inspection object grants the UI action. Server repeats owner,
 * task, snapshot CAS and effect classification; imported JSON is never a grant. */
export async function reconcileExecutorInteraction(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>, action: 'settle' | 'resume' | 'hold') {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const observed = detail.observed as { observed?: string } | null;
  if (!detail.row.value?.command || !observed?.observed) throw new Error('interaction_inspection_required');
  const runtime = await serverRuntime(cloud.userId);
  if (!current()) throw new Error('client_account_changed');
  const result = await runtime.reconcileInteraction({ taskId: detail.row.value.taskId, sequence: detail.row.value.command.sequence, observed: observed.observed, action });
  if (!current()) throw new Error('client_account_changed');
  inspections.delete(detail);
  return result;
}

/** Archive only after explicit inspection. Never transfers a token or replays a
 * possibly external task. Original Blobs, IDs and observed receipt are retained. */
export async function archiveExecutorRecovery(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>) {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const owner = cloud.userId, database = new Dexie(cloudDatabaseName(owner, true));
  try {
    await database.open();
    await database.transaction('rw', database.table('_cloudMeta'), async () => {
      if (!current()) throw new Error('client_account_changed');
      const row = await database.table('_cloudMeta').get(detail.row.id);
      if (!row || JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(row))) !== JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(detail.row)))) throw new Error('executor_recovery_changed');
      if (!current()) throw new Error('client_account_changed');
      await database.table('_cloudMeta').put({ ...row, status: 'archived', reconciliation: { receipt: detail.receipt, server: detail.server, observed: detail.observed }, archivedAt: Date.now() });
      if (row.id.startsWith('executor-completion:')) {
        await database.table('_cloudMeta').put({ ...row, id: row.id.replace('executor-completion:', 'executor-archived:'), status: 'archived', reconciliation: { receipt: detail.receipt, server: detail.server } });
        await database.table('_cloudMeta').delete(row.id);
      }
      if (!current()) throw new Error('client_account_changed');
    });
  } finally { database.close(); }
}

async function encodeExecutorRecovery(value: unknown): Promise<unknown> {
  if (value instanceof Blob) return { type: value.type, size: value.size, bytes: Array.from(new Uint8Array(await value.arrayBuffer())) };
  if (Array.isArray(value)) return Promise.all(value.map(encodeExecutorRecovery));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeExecutorRecovery(item)])));
  return value;
}

export async function exportExecutorRecovery(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>) {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const value = await encodeExecutorRecovery(detail);
  if (!current()) throw new Error('client_account_changed');
  return value;
}
