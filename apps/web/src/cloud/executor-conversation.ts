import type { ExecutorConversationReset, ExecutorConversationResetReceipt } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud, withToolPermission } from './state';
import { executorRuntime } from './executor-runtime';
import { flushCloud } from './sync';

export async function resetTaskConversation(mode: 'continue' | 'retry'): Promise<ExecutorConversationResetReceipt> {
  const database = db, taskId = cloud.taskId, token = cloud.workerToken;
  const runtime = await executorRuntime(), key = `executor-reset:${taskId}`;
  const current = () => database === db && taskId === cloud.taskId && token === cloud.workerToken;
  let saved = (await database.table('_cloudMeta').get(key))?.value as { request: Omit<ExecutorConversationReset, 'taskId'>; receipt?: ExecutorConversationResetReceipt; phase?: string } | undefined;
  if (saved && saved.request.mode !== mode) throw new Error('executor_reset_mode_changed');
  if (!saved) {
    const task = await runtime.read(), input = task.input;
    const prepare = async () => {
      saved = { request: { operationId: `executor-reset-${taskId}`, mode, ...(cloud.permissionId ? { permissionId: cloud.permissionId } : {}) }, phase: 'prepared' };
      await database.table('_cloudMeta').put({ id: key, value: saved });
    };
    if (mode === 'retry') return withToolPermission('write', { tool: 'reset_chat_result', sessionId: input.sessionId, rowId: input.rowId, mode }, async () => { await prepare(); return resetTaskConversation(mode); });
    await prepare();
  }
  if (!current() || !saved) throw new Error('executor_capability_changed');
  if (saved.phase === 'started') throw new Error('executor_reset_requires_reconciliation');
  const receipt = saved.receipt ?? await runtime.resetConversation(saved.request);
  if (!current()) throw new Error('executor_capability_changed');
  saved = { ...saved, receipt, phase: 'ready' };
  await database.table('_cloudMeta').put({ id: key, value: saved });
  await flushCloud(); // authoritative tombstones, never direct cache deletion
  if (!current()) throw new Error('executor_capability_changed');
  // Prevent a duplicate task invocation/reload from re-running the model after
  // a reset has already dispatched. Original result remains in SQL + this log.
  await database.table('_cloudMeta').put({ id: key, value: { ...saved, phase: 'started' } });
  return receipt;
}
