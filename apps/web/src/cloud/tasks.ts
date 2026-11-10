import { cloud, cloudRequest } from './state';
import { flushCloud } from './sync';
import { db } from '../store/db';
import { messageWidgets } from '../harness/widgetLayout';
import type { WidgetPayload } from '../harness/widgetRuntime';
import type { CloudTask, CloudTaskKind } from '@wangke/contracts/cloud';
import { taskAcceptsAnswer, taskOccupiesResource } from '@wangke/contracts/task-status';
import { liveQuery } from 'dexie';
import { create } from 'zustand';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';
import { flushPreferences } from './preferences';
import { drainLearning, type LearningCommandRow } from '../client/learning';

interface PendingTaskCommand { command: RuntimeTaskSubmit; createdAt: number }
export const usePendingTaskCommands = create<{ commands: PendingTaskCommand[] }>()(() => ({ commands: [] }));
const rememberUncertain = (command: RuntimeTaskSubmit, createdAt: number) => usePendingTaskCommands.setState(state => ({ commands: [...state.commands.filter(item => item.command.operationId !== command.operationId), { command, createdAt }] }));
const forgetUncertain = (operationId: string) => usePendingTaskCommands.setState(state => ({ commands: state.commands.filter(item => item.command.operationId !== operationId) }));

export async function submitCloudTask(kind: CloudTaskKind, resource: string, input: Record<string, unknown>, operationId: string = crypto.randomUUID()): Promise<CloudTask> {
  const account = cloud.userId;
  if (kind === 'chat' && typeof input.sessionId === 'number') {
    // Admission depends on server configuration and this session's metadata,
    // not on downloading every account record/blob into IndexedDB.
    await flushPreferences();
    if (account !== cloud.userId) throw new Error('client_account_changed');
    const database = db;
    const pending = () => database.table<LearningCommandRow>('_learningCommands').filter(row => row.state !== 'confirmed' && row.entities.includes(`session:${input.sessionId}`)).toArray();
    if ((await pending()).length) {
      if (account !== cloud.userId || database !== db) throw new Error('client_account_changed');
      await drainLearning([`session:${input.sessionId}`]);
      const unsettled = await pending();
      if (unsettled.length) throw new Error(unsettled[0].error ?? 'conversation_session_not_confirmed');
    }
  } else if (!(kind === 'handoutEdit' && input.action === 'persist')) await flushCloud();
  // A manual handout edit carries the original complete CAS baseline. Admission
  // checks that baseline transactionally on the server; hydrating the entire
  // account first adds no dependency and must not silently rebase the editor.
  if (account !== cloud.userId) throw new Error('client_account_changed');
  const { serverRuntime, isCurrentServerRuntime } = await import('../client/bootstrap');
  if (account !== cloud.userId) throw new Error('client_account_changed');
  const database = db;
  const runtime = await serverRuntime(account);
  const assertCurrent = () => {
    if (account !== cloud.userId || !cloud.enabled || !isCurrentServerRuntime(runtime) || runtime.signal.aborted) throw new Error('client_account_changed');
  };
  assertCurrent();
  const command = { operationId, kind, resource, input: JSON.parse(JSON.stringify(input)) };
  const id = `task-command:${operationId}`;
  const existing = await database.table('_cloudMeta').get(id);
  assertCurrent();
  if (existing && JSON.stringify(existing.command) !== JSON.stringify(command)) throw new Error('task_command_conflict');
  await database.table('_cloudMeta').put({ id, command, status: 'pending', createdAt: existing?.createdAt ?? Date.now() });
  try {
    assertCurrent();
    // Recovery checks admission before retrying; no second invocation of the
    // model or external tool is inferred from a missing network response.
    const receipt = existing ? await runtime.taskAdmission(operationId) : undefined;
    assertCurrent();
    const task = receipt?.status === 'accepted' ? receipt.task : await runtime.submitTask(command);
    assertCurrent();
    await database.table('_cloudMeta').put({ id, command, status: 'accepted', taskId: task.id, createdAt: existing?.createdAt ?? Date.now() });
    if (account === cloud.userId && isCurrentServerRuntime(runtime)) forgetUncertain(operationId);
    return task;
  } catch (error) {
    await database.table('_cloudMeta').put({ id, command, status: 'uncertain', createdAt: existing?.createdAt ?? Date.now() });
    if (account === cloud.userId && isCurrentServerRuntime(runtime)) rememberUncertain(command, existing?.createdAt ?? Date.now());
    throw error;
  }
}

/** Read-only startup reconciliation. Missing admission is kept uncertain for an
 * explicit retry with the same stored operation, never silently re-enqueued. */
export async function reconcileTaskAdmissions(): Promise<string[]> {
  if (!cloud.enabled) return [];
  const account = cloud.userId;
  usePendingTaskCommands.setState({ commands: [] });
  const database = db;
  const { serverRuntime, isCurrentServerRuntime } = await import('../client/bootstrap');
  if (account !== cloud.userId) return [];
  const runtime = await serverRuntime(account);
  const current = () => account === cloud.userId && cloud.enabled && isCurrentServerRuntime(runtime) && !runtime.signal.aborted;
  if (!current()) return [];
  const commands = await database.table('_cloudMeta').where('id').startsWith('task-command:').toArray();
  const uncertain: string[] = [];
  for (const command of commands) {
    if (!current()) return [];
    if (!['pending', 'uncertain'].includes(command.status)) continue;
    const operationId = command.id.slice('task-command:'.length);
    const admission = await runtime.taskAdmission(operationId);
    if (!current()) return [];
    if (admission.status === 'accepted') {
      await database.table('_cloudMeta').put({ ...command, status: 'accepted', taskId: admission.task.id });
      if (!current()) return [];
      forgetUncertain(operationId);
    } else {
      uncertain.push(operationId);
      rememberUncertain(command.command, command.createdAt);
    }
  }
  return uncertain;
}

export async function retryPendingTaskCommand(operationId: string) {
  const account = cloud.userId;
  const database = db;
  const { serverRuntime, isCurrentServerRuntime } = await import('../client/bootstrap');
  const runtime = await serverRuntime(account);
  const assertCurrent = () => {
    if (account !== cloud.userId || database !== db || !cloud.enabled || !isCurrentServerRuntime(runtime) || runtime.signal.aborted) throw new Error('client_account_changed');
  };
  assertCurrent();
  // Lazy import avoids a tasks → queue → Server adapter → tasks startup cycle.
  // The adapter submits through submitCloudTask, NEVER through this retry entry.
  const { retryQueuedChatOperation } = await import('../client/chat-queue');
  assertCurrent();
  const queued = await retryQueuedChatOperation(operationId);
  assertCurrent();
  if (queued) { forgetUncertain(operationId); return queued; }
  const record = await database.table('_cloudMeta').get(`task-command:${operationId}`);
  assertCurrent();
  if (!record || !['pending', 'uncertain'].includes(record.status)) return;
  const command: RuntimeTaskSubmit = record.command;
  return submitCloudTask(command.kind, command.resource, command.input, command.operationId);
}
export async function runCloudTask<T>(kind: CloudTaskKind, resource: string, input: Record<string, unknown>, onProgress?: (p: any) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const task = await submitCloudTask(kind, resource, input);
  return waitCloudTask<T>(task, onProgress, signal);
}
/** Observe an already dispatched plugin task without submitting a second job. */
export async function waitCloudTask<T>(task: CloudTask, onProgress?: (p: any) => void, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  if (!cloud.enabled) throw new Error('server_task_observer_required');
  const account = cloud.userId;
  const { isCurrentServerRuntime, serverRuntime } = await import('../client/bootstrap');
  signal?.throwIfAborted();
  if (!cloud.enabled || cloud.userId !== account) throw new Error('client_account_changed');
  const runtime = await serverRuntime(account);
  signal?.throwIfAborted();
  const assertCurrent = () => {
    if (!isCurrentServerRuntime(runtime) || !cloud.enabled || cloud.userId !== runtime.identity.account) throw new Error('client_account_changed');
  };
  assertCurrent();
  // Serialize cache/widget work while the Model coalesces transient progress.
  // A detached view releases only its waiter; stopping a job is an explicit command.
  let work = Promise.resolve(), running = false, observing = true;
  let workFailure: { error: unknown } | undefined;
  let pending: CloudTask['progress'] | undefined;
  const observer = new AbortController();
  const observationSignal = AbortSignal.any([observer.signal, runtime.signal, ...(signal ? [signal] : [])]);
  try {
    const completed = await runtime.task(task.id).wait(observationSignal, current => {
      pending = current.progress;
      if (running) return;
      running = true;
      work = (async () => {
        try {
          while (pending !== undefined) {
            const progress = pending; pending = undefined;
            if (!observing || observationSignal.aborted) return;
            assertCurrent();
            if (progress && await syncTaskWidgets(progress) && observing && !observationSignal.aborted) {
              assertCurrent();
              onProgress?.(progress);
            }
          }
        } finally { running = false; }
      })();
      void work.catch(error => {
        workFailure ??= { error };
        // Cache/callback failure must reject this waiter now, not after a job
        // that may stay queued indefinitely. This never cancels the durable job.
        observer.abort(error);
      });
    });
    await work;
    if (workFailure) throw workFailure.error;
    observationSignal.throwIfAborted();
    assertCurrent();
    if (!await syncTaskWidgets(completed.progress)) await waitTaskWidgetOwner(completed.progress, observationSignal);
    assertCurrent();
    if (completed.kind === 'handoutEdit' && completed.input.action === 'persist') {
      const handoutId = (completed.result as { handoutId?: number } | null)?.handoutId;
      if (!Number.isSafeInteger(handoutId) || handoutId !== completed.input.handoutId) throw new Error('handout_receipt_invalid');
      await (await import('./sync')).readRecordKeys('handouts', [handoutId!]);
    } else await flushCloud();
    observationSignal.throwIfAborted();
    assertCurrent();
    return completed.result as T;
  } finally {
    observing = false; pending = undefined;
  }
}

/** A server receipt is durable remotely, but an iframe's owner must also exist
 * in this browser's cache before its state/session bridge can be opened. */
export async function syncTaskWidgets(progress: CloudTask['progress']): Promise<boolean> {
  if (await taskWidgetsReady(progress)) return true;
  if (typeof progress?.rowId !== 'number') return false;
  await (await import('./sync')).readRecordKeys('chats', [progress.rowId]);
  return taskWidgetsReady(progress);
}

async function taskWidgetsReady(progress: CloudTask['progress']): Promise<boolean> {
  const widgets = progress?.widgets as WidgetPayload[] | undefined;
  const rowId = progress?.rowId;
  if (!Array.isArray(widgets) || !widgets.length) return true;
  if (typeof rowId !== 'number') return false;
  const row = await db.chats.get(rowId);
  const cached = row ? messageWidgets(row) : [];
  return widgets.every(widget => cached.some(item => item.id === widget.id && item.html === widget.html));
}

/** Bounded cache observation, not a second server task poll. */
async function waitTaskWidgetOwner(progress: CloudTask['progress'], signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); subscription.unsubscribe(); signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(); };
    const abort = () => finish(signal?.reason ?? new Error('observation_cancelled'));
    const timer = setTimeout(() => finish(new Error('作品消息尚未同步到本机，请刷新后重试预览')), 15_000);
    const subscription = liveQuery(() => taskWidgetsReady(progress)).subscribe({ next: ready => { if (ready) finish(); }, error: finish });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
export async function cancelResourceTasks(resource: string, kind?: CloudTaskKind) {
  const { tasks } = await cloudRequest<{ tasks: CloudTask[] }>('/tasks');
  await Promise.all(tasks.filter(t => t.resource === resource && (!kind || t.kind === kind) && taskOccupiesResource(t.status)).map(t => cloudRequest(`/tasks/${t.id}/cancel`, { method: 'POST' })));
}
export async function commandChatTask(sessionId: number | null, action: string, value?: unknown, taskId?: string): Promise<boolean> {
  const owner = cloud.userId;
  const { tasks } = await cloudRequest<{ tasks: CloudTask[] }>('/tasks');
  if (owner !== cloud.userId) throw new Error('client_account_changed');
  const task = tasks.find(t => (!taskId || t.id === taskId) && t.resource === `session:${sessionId}` && taskAcceptsAnswer(t.status));
  if (!task) return false;
  await cloudRequest(`/tasks/${task.id}/commands`, { method: 'POST', body: JSON.stringify({ action, value, nonce: crypto.randomUUID() }) });
  return true;
}
