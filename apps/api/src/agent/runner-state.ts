/** runner 拆分后各模块共享的状态、行形状与小型校验助手。
 * BotRunner 只保留调度编排;其余模块通过 RunnerState 访问同一份私有状态,
 * 对外 API 仍是 BotRunner 自己的方法。 */
import type { AgentPolicy } from '@wangke/contracts/cloud';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { ProjectRepository, ProjectThread } from '../projects/repository.js';
import { ProjectError } from '../projects/files.js';
import type { BotEventHook } from './events.js';
import type { BotSettingsTools } from './settings.js';
import type { McpManager } from '../mcp/manager.js';
import type { ProjectTools } from '../projects/tools.js';
import type { StudyTools } from './study.js';
import type { WebSearchService } from '../web-search/service.js';
import type { ModelMessage as Message } from './model.js';
import { expectRow, expectRows, runRowSchema, runWaitRowSchema, type RunRow, type RunWaitRow } from '../storage/row-schema.js';

export const now = () => new Date().toISOString();

/** 一次认领/执行用到的 run 快照。context_end_seq 只出现在复用上一段上下文时。 */
export type Run = { id: string; thread_id: string; context_json: string | null; step_count: number; trigger_message_id: string | null; context_end_seq?: number | null };
/** 认领队列:只取会用到的列,created_at 用于判定线程上更早的暂停 run。 */
export type QueuedRun = Run & Pick<RunRow, 'created_at' | 'thread_id'> & { trigger_message_id: string | null };

/** BotRunner 的构造选项。门面构造时原样存下,拆分模块按需读取。 */
export interface RunnerOptions {
  fetch?: typeof fetch;
  sandbox?: import('./sandbox.js').SandboxExecutor;
  sandboxFile?: import('./sandbox.js').SandboxFileReader;
  sandboxCleanup?: import('./sandbox.js').SandboxCleanup;
  configuration?: CloudConfiguration;
  study?: StudyTools;
  mcp?: McpManager;
  webSearch?: WebSearchService;
  projects?: ProjectRepository;
  onEvent?: BotEventHook;
}

/** 事件钩子与审计所需的最小依赖,拆分模块都从这里拿。 */
export interface BotDeps {
  readonly store: DatabaseStore;
  readonly options: RunnerOptions;
  readonly mcp?: McpManager;
  readonly projects?: ProjectRepository;
  readonly projectTools?: ProjectTools;
  readonly settingsTools?: BotSettingsTools;
  thread(id: string): ProjectThread;
  workspaceId(thread: ProjectThread): string | undefined;
  executionProjectId(thread: ProjectThread, requested?: unknown, capability?: 'read' | 'write'): string | undefined;
  policy(thread: ProjectThread, projectId?: string): AgentPolicy;
  managedTool(name: string): ProjectTools | BotSettingsTools | undefined;
  append(threadId: string, kind: string, content: string, nonce?: string): { id: string };
  save(run: Run, context: Message[]): void;
  finish(id: string, status: string): void;
}

/** persist 与门面之间共享的读写/认领辅助。 */
export interface BotFacade extends BotDeps {
  readonly fetcher: typeof fetch;
  readonly store: DatabaseStore;
  readonly sandbox: import('./sandbox.js').SandboxExecutor;
  readonly sandboxCleanup: import('./sandbox.js').SandboxCleanup;
  readonly active: Map<string, { threadId: string; scope: string; controller: AbortController }>;
  readonly tasks: Set<Promise<void>>;
  stopped: boolean;
  quiescing: boolean;
  draining: boolean;
  recoverNeeded: boolean;
  schedulerFailure(): void;
  recover(): void;
  consumeInputs(run: Run, context: Message[], supersededToolResult?: string, skippedCalls?: Array<{ id: string }>): void;
  pendingForegroundTasks(runId: string): boolean;
  observeWorkspaceResult(runId: string, tool: string, result: string): void;
  executeStudy(name: string, args: Record<string, unknown> | null, owner: string, run: Run, step: string, signal: AbortSignal): Promise<string>;
  runSandbox(request: Parameters<import('./sandbox.js').SandboxExecutor>[0], signal: AbortSignal): Promise<Awaited<ReturnType<import('./sandbox.js').SandboxExecutor>>>;
}

export { ProjectError };

/** 查询结果的行形状。本模块读的列很少,逐条声明比 `as any` 更能暴露迁移漂移。 */
export interface RunStepRow { id: string; run_id: string; status: string; tool: string; arguments: string; result: string | null }
export const runStepRowSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, run_id: { type: 'string' }, status: { type: 'string' }, tool: { type: 'string' }, arguments: { type: 'string' }, result: { type: ['string', 'null'] } },
  required: ['id', 'run_id', 'status', 'tool', 'arguments'],
} as const;
export interface RunContextRow { id: string; status: string; context_json: string | null }
export const runContextRowSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string' }, context_json: { type: ['string', 'null'] } },
  required: ['id', 'status'],
} as const;
export interface RunInputRow { message_id: string; seq: number; role: string; kind: string; content: string | null; reply_to: string | null }
export const runInputRowSchema = {
  type: 'object',
  properties: { message_id: { type: 'string' }, seq: { type: 'integer' }, role: { type: 'string' }, kind: { type: 'string' }, content: { type: ['string', 'null'] }, reply_to: { type: ['string', 'null'] } },
  required: ['message_id', 'seq', 'role', 'kind', 'content'],
} as const;
/** 子任务等待体:`run_waits` 的列 + 任务终态投影。 */
export interface WaitedTask { id: string; status: string; result: string | null; error: string | null }
export const waitedTaskSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string' }, result: { type: ['string', 'null'] }, error: { type: ['string', 'null'] } },
  required: ['id', 'status', 'result', 'error'],
} as const;
export interface CloudPermissionProjection { id: string; thread_id: string; capability: string; arguments: string }
export const cloudPermissionProjectionSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, thread_id: { type: 'string' }, capability: { type: 'string' }, arguments: { type: ['string', 'null'] } },
  required: ['id', 'thread_id', 'capability', 'arguments'],
} as const;
export interface TerminalTaskProjection { id: string; thread_id: string; parent_run_id: string; kind: string; status: string; result: string | null; error: string | null }
export const terminalTaskProjectionSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, thread_id: { type: 'string' }, parent_run_id: { type: 'string' }, kind: { type: 'string' }, status: { type: 'string' }, result: { type: ['string', 'null'] }, error: { type: ['string', 'null'] } },
  required: ['id', 'thread_id', 'parent_run_id', 'kind', 'status', 'result', 'error'],
} as const;
export const runStatusSchema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] } as const;
export interface ParentRunRow { id: string; status: string; context_json: string | null; trigger_message_id: string | null; model_snapshot: string | null; root_run_id: string | null }
export const parentRunRowSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, status: { type: 'string' }, context_json: { type: ['string', 'null'] }, trigger_message_id: { type: ['string', 'null'] }, model_snapshot: { type: ['string', 'null'] }, root_run_id: { type: ['string', 'null'] } },
  required: ['id', 'status', 'trigger_message_id'],
} as const;
export const runContextJsonSchema = { type: 'object', properties: { context_json: { type: ['string', 'null'] }, status: { type: 'string' } }, required: ['status'] } as const;

export function queuedRunRows(rows: readonly unknown[]): QueuedRun[] {
  return expectRows<QueuedRun>(runRowSchema, rows, 'run_row_invalid');
}

export function runWaitRows(rows: readonly unknown[]): RunWaitRow[] {
  return expectRows<RunWaitRow>(runWaitRowSchema, rows, 'run_wait_row_invalid');
}

export function pendingPermissionRows(rows: readonly unknown[]): CloudPermissionProjection[] {
  return expectRows<CloudPermissionProjection>(cloudPermissionProjectionSchema, rows, 'cloud_permission_row_invalid');
}

export function terminalTaskRows(rows: readonly unknown[]): TerminalTaskProjection[] {
  return expectRows<TerminalTaskProjection>(terminalTaskProjectionSchema, rows, 'cloud_task_row_invalid');
}

export function parentRunRow(row: unknown): ParentRunRow | undefined {
  return expectRow<ParentRunRow>(parentRunRowSchema, row, 'run_row_invalid');
}

/** 模型产出的 `function.arguments` 解析:失败不是异常,而是「无效参数」。
 * 只返回对象形状;需要字段时由调用方按 schema 校验,不做隐式断言。 */
export function toolArguments(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

/** 成品工具参数里的单个字段:模型输出没有类型保证,非预期类型一律当缺省,
 * 与「undefined 即未提供」的原有判断保持一致。 */
export function stringField(args: Record<string, unknown> | null, key: string): string | undefined {
  const value = args?.[key];
  return typeof value === 'string' ? value : undefined;
}
export function numberField(args: Record<string, unknown> | null, key: string): number | undefined {
  const value = args?.[key];
  return typeof value === 'number' ? value : undefined;
}
export function booleanField(args: Record<string, unknown> | null, key: string): boolean | undefined {
  const value = args?.[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** `?` 绑定值列表的类型别名:让「值只走绑定、不进 SQL 文本」在签名上可见。 */
export type Bindings = readonly (string | number | null)[];
