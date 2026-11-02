import { create } from 'zustand';
import type { CloudTask } from '@wangke/contracts/cloud';

/** Fed by CloudActivity's existing transport, never a second polling loop. */
export const useCloudActivity = create<{ tasks: CloudTask[] | null; unavailable: boolean }>(() => ({
  tasks: null,
  unavailable: false,
}));

export function isActiveTask(task: CloudTask): boolean {
  return task.status === 'queued' || task.status === 'running' || task.status === 'waiting_user';
}
