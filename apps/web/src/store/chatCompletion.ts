import { isTaskUnfinished } from '@wangke/contracts/task-status';

/** Only an observed unfinished -> terminal transition is new feedback. Initial
 * history, repeated snapshots and reconnects must not replay read completions. */
export class ChatCompletionTracker {
  private pending = new Set<string>();
  private settled = new Set<string>();
  observe(tasks: ReadonlyArray<{ id: string; status: string; input: Record<string, unknown> }>, complete: (sessionId: number) => void) {
    for (const task of tasks) {
      if (task.input.action === 'compressContext') continue;
      if (this.settled.has(task.id)) continue;
      if (isTaskUnfinished(task.status)) { this.pending.add(task.id); continue; }
      if (!['completed', 'failed', 'interrupted', 'cancelled'].includes(task.status)) continue;
      this.settled.add(task.id);
      if (!this.pending.delete(task.id) || task.status === 'cancelled') continue;
      const id = Number(task.input.sessionId);
      if (Number.isSafeInteger(id) && id > 0) complete(id);
    }
  }
  clear() { this.pending.clear(); this.settled.clear(); }
}
