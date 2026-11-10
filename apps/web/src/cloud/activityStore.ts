import { create } from 'zustand';
import type { CloudTask } from '@wangke/contracts/cloud';
import { isTaskUnfinished } from '@wangke/contracts/task-status';

/** Fed by CloudActivity's existing transport, never a second polling loop. */
export const useCloudActivity = create<{ tasks: CloudTask[] | null; unavailable: boolean; dataRevision: number }>(() => ({
  tasks: null,
  unavailable: false,
  dataRevision: 0,
}));

export function isActiveTask(task: CloudTask): boolean {
  return isTaskUnfinished(task.status);
}
