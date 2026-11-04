import type { TaskContext } from '../src/cloud/execution.js';
import { TaskDelegationService } from '../src/cloud/delegation.js';

export class TaskWaitSuspended extends Error { constructor() { super('task_wait_suspended'); this.name = 'TaskWaitSuspended'; } }

export function delegationTool(context: TaskContext, name: string, args: Record<string, any>, callId: string) {
  context.checkActive();
  const service = new TaskDelegationService(context.store, context.configuration);
  if (name === 'models_discover') return { value: service.models(context.owner, args.query), waiting: false, ids: [] };
  if (args.action === 'wait') {
    if (!Array.isArray(args.taskIds) || !args.taskIds.length || args.taskIds.length > 8) throw new Error('invalid_task_ids');
    const ids = [...new Set(args.taskIds as string[])];
    const tasks = ids.map(id => context.store.db.prepare('SELECT t.id,t.status,t.result,t.error FROM cloud_tasks t JOIN task_delegations d ON d.task_id=t.id WHERE t.id=? AND t.owner_id=? AND d.parent_task_id=?').get(id, context.owner, context.task.id) as any);
    if (tasks.some(t => !t)) throw new Error('task_not_owned_by_parent');
    const waiting = tasks.some(t => !['completed','failed','cancelled','interrupted'].includes(t.status));
    return { value: { waiting, tasks: tasks.map(t => ({ ...t, result: t.result ? JSON.parse(t.result) : null })) }, waiting, ids };
  }
  const value = service.command(context.owner, { ...args,
    ...(['create','session.create','session.send'].includes(args.action) ? { operationId: `delegate:${context.task.id}:${callId}` } : {}),
    ...(['create','session.send'].includes(args.action) ? { parentTaskId: context.task.id } : {}),
    ...(args.action === 'session.create' ? { originTaskId: context.task.id } : {}),
  } as any);
  return { value, waiting: false, ids: [] };
}
