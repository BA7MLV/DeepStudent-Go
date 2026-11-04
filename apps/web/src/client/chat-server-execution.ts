import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';
import type { CloudTask } from '@wangke/contracts/cloud';
import { cloud, remoteTasks } from '../cloud/state';
import { db } from '../store/db';
import { submitCloudTask, cancelResourceTasks, commandChatTask } from '../cloud/tasks';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';

/** Server carrier only. There is deliberately no Local import or fallback on a
 * transport/auth/admission failure. Receipts reuse the existing task journal. */
export function createServerChatExecution() {
  const account = cloud.userId, database = db;
  const current = () => remoteTasks() && cloud.userId === account && database === db;
  const check = () => { if (!current()) throw new Error('client_account_changed'); };
  return {
    current,
    async receipt(operationId: string) {
      check();
      const runtime = await serverRuntime(account);
      check();
      if (!isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      const receipt = await runtime.taskAdmission(operationId);
      check();
      if (!isCurrentServerRuntime(runtime) || runtime.signal.aborted) throw new Error('client_account_changed');
      return receipt as { status: string; task?: CloudTask };
    },
    async submit(request: RuntimeTaskSubmit) {
      check();
      // Only the lock/claim winner may interrupt. An accepted-receipt recovery
      // must not cancel the very task it is recovering (or another tab's work).
      if (request.input.mode === 'steer' && typeof request.input.sessionId === 'number') {
        await stopServerChat(request.input.sessionId);
        check();
      }
      const task = await submitCloudTask(request.kind, request.resource, request.input, request.operationId);
      check();
      return task;
    },
  };
}

export const stopServerChat = (sessionId: number) => cancelResourceTasks(`session:${sessionId}`);
export const commandServerChat = commandChatTask;
