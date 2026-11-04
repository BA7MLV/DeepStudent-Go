import { createExecutorRuntime, DurableCommands } from '@wangke/client-core';
import type { ExecutorCompletion, RuntimeJson, ExecutorResourceCommand } from '@wangke/contracts/client-runtime';
import { apiUrl } from '../api/base';
import { db } from '../store/db';
import { cloud } from './state';

let active: { taskId: string; token: string; runtime: ReturnType<typeof createExecutorRuntime> } | undefined;
export function executorRuntime() {
  const taskId = cloud.taskId, token = cloud.workerToken;
  if (!cloud.worker || !taskId || !token) throw new Error('executor_capability_missing');
  if (active?.taskId === taskId && active.token === token) return active.runtime;
  void active?.runtime.then(runtime => runtime.dispose()).catch(() => {});
  const runtime = createExecutorRuntime(taskId, { interactions: 'answer', transport: {
    fetch: (url, init) => fetch(apiUrl(typeof url === 'string' ? url : String(url)), { ...init, credentials: 'omit', headers: { ...init?.headers, authorization: `Bearer ${token}` } }),
    streamBaseUrl: new URL(apiUrl('/'), location.href).href,
    createWebSocket: url => new WebSocket(url, ['wangke-executor', token]),
  } });
  active = { taskId, token, runtime };
  return runtime;
}

export async function executeTaskResource(operation: ExecutorResourceCommand['operation']) {
  const database = db, taskId = cloud.taskId, owner = cloud.userId, token = cloud.workerToken;
  if (!cloud.worker || !cloud.permissionId) throw new Error('task_file_permission_required');
  const request = { operationId: `resource-${crypto.randomUUID()}`, permissionId: cloud.permissionId, operation };
  const key = `resource-command:${request.operationId}`;
  await database.table('_cloudMeta').put({ id: key, value: { operationId: request.operationId, request: { ...request, taskId }, state: 'uncertain', executorTaskId: taskId } });
  const runtime = await executorRuntime();
  const current = () => database === db && taskId === cloud.taskId && owner === cloud.userId && token === cloud.workerToken;
  if (!current()) throw new Error('client_account_changed');
  const result = await runtime.resourceCommand(request);
  if (!current()) throw new Error('client_account_changed');
  await database.transaction('rw', database.table('_cloudMeta'), async () => {
    await database.table('_cloudMeta').put({ id: `resource-completed:${request.operationId}`, value: { request, result, state: 'completed', executorTaskId: taskId } });
    await database.table('_cloudMeta').delete(key);
  });
  return result;
}

/** Terminal outcome is persisted before I/O. A lost response is reconciled under
 * the original task/credential, never converted into a second failure outcome. */
export async function completeExecutor(outcome: ExecutorCompletion['outcome']) {
  const taskId = cloud.taskId, token = cloud.workerToken, database = db;
  const runtime = await executorRuntime();
  const key = `executor-completion:${taskId}`;
  let command = (await database.table('_cloudMeta').get(key))?.value;
  if (!command) {
    const operationId = `executor-completion-${crypto.randomUUID()}`;
    command = { operationId, request: { taskId, operationId, outcome }, state: 'queued' };
    await database.table('_cloudMeta').put({ id: key, value: command });
  }
  const journal = new DurableCommands<ExecutorCompletion>({
    list: async () => { const stored = await database.table('_cloudMeta').get(key); return stored ? [stored.value] : []; },
    save: async value => { await database.table('_cloudMeta').put({ id: key, value }); },
    remove: async operationId => {
      const receipt = await runtime.receipt(operationId);
      await database.transaction('rw', database.table('_cloudMeta'), async () => {
        await database.table('_cloudMeta').put({ id: `executor-completed:${taskId}`, value: { ...command, receipt } });
        await database.table('_cloudMeta').delete(key);
      });
    },
  }, { receipt: runtime.receipt, send: runtime.complete, replaySafe: true,
    current: () => database === db && cloud.taskId === taskId && cloud.workerToken === token });
  await journal.drain();
}

export const reportExecutor = async (progress: Record<string, unknown>) => (await executorRuntime()).report(progress as { [key: string]: RuntimeJson });
