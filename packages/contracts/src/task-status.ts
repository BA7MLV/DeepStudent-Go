/**
 * CloudTask / RuntimeTask 的状态语义矩阵。
 *
 * 同一个 status 字符串在不同消费方有不同含义：这里把每个职责单独命名，
 * 避免再用一个含糊的 `active` 把「等待依赖」误判成「已结束」或「正在计算」。
 * 服务端（apps/api/src/cloud/tasks.ts 的 ACTIVE_TASK_STATUSES、同资源互斥）是这些语义的出处。
 */
export type TaskStatus = 'queued' | 'running' | 'waiting_user' | 'waiting_event' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** 已确已结束，不再接受停止、回答或恢复。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];
/** 排队、执行、等待用户输入、等待依赖事件：都还没有结束。 */
export const UNFINISHED_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running', 'waiting_user', 'waiting_event'];
/** 是否阻挡同资源下一项，遵循服务端既有调度语义（同资源互斥含 waiting_event）。 */
export const RESOURCE_OCCUPYING_TASK_STATUSES: readonly TaskStatus[] = UNFINISHED_TASK_STATUSES;
/** 真实计算中；等待用户或等待事件不算。 */
export const COMPUTING_TASK_STATUSES: readonly TaskStatus[] = ['queued', 'running'];
/** 聊天命令「回答问题」的合法状态：等待依赖（waiting_event）时没有可回答的输入。 */
export const ANSWERABLE_TASK_STATUSES: readonly TaskStatus[] = ['running', 'waiting_user'];

/** 参数取 `string`：部分快照 DTO 的 status 是宽松字符串；未知值不匹配任何谓词，按字面匹配。 */
export const isTaskTerminal = (status: string): boolean => (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
export const isTaskUnfinished = (status: string): boolean => (UNFINISHED_TASK_STATUSES as readonly string[]).includes(status);
export const taskOccupiesResource = (status: string): boolean => (RESOURCE_OCCUPYING_TASK_STATUSES as readonly string[]).includes(status);
export const isTaskComputing = (status: string): boolean => (COMPUTING_TASK_STATUSES as readonly string[]).includes(status);
export const taskAcceptsAnswer = (status: string): boolean => (ANSWERABLE_TASK_STATUSES as readonly string[]).includes(status);
