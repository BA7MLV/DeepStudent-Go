import type { RuntimeTask } from '@wangke/contracts/client-runtime';

export const chatTaskActive = (task: Pick<RuntimeTask, 'status'>) => ['queued', 'running', 'waiting_user'].includes(task.status);

/** A saved checkpoint is recoverable, not evidence that its task has failed. */
export function chatTaskState(row: { content: string; interrupted?: boolean; interruptReason?: string; widget?: unknown; widgets?: unknown[]; ask?: unknown; folderPlan?: unknown }, task?: RuntimeTask) {
  const useful = !!row.content.trim() || !!row.widget || !!row.widgets?.length || !!row.ask || !!row.folderPlan;
  const active = !!task && chatTaskActive(task);
  const failed = task ? ['failed', 'interrupted'].includes(task.status) : !!row.interrupted;
  const reason = task?.error || row.interruptReason;
  return {
    content: !active && failed && !useful ? `回答失败：${reason || '未获得回答，请重试'}` : row.content,
    streaming: active, error: !active && failed && !useful,
    interrupted: !active && failed && useful,
    interruptReason: !active && failed ? reason : undefined,
    ...(active ? { processPhase: task?.progress?.phase === 'answer' ? 'answering' as const : task?.progress?.phase === 'tool' ? 'tool' as const : 'thinking' as const,
      processStartedAt: Date.parse(task!.createdAt) || Date.now() } : {}),
  };
}
