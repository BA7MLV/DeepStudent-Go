import { ReadableStream as NodeWebReadableStream } from 'node:stream/web';
import { Ajv, type AnySchema, type ValidateFunction } from 'ajv';

/** SQLite 读出来的行是外部数据：列可能因历史库缺列、`ANY` 声明或后续迁移而变成
 * null 以外的东西。这里统一在「查询结果」这个信任边界上做显式形状校验，业务代码
 * 拿到的就是已经收窄过的行类型，不必再用类型断言穿透。
 * 校验失败一律抛错而不是静默降级：把坏数据当成缺列继续跑会造成更隐蔽的数据损伤。 */
const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, ownProperties: true, allErrors: false, addUsedSchema: false });
const validators = new Map<AnySchema, ValidateFunction>();

/** undici 的 Response 与 @types/node 的 DOM 声明各有一份 ReadableStream。
 * 两者运行时是同一种流；这里做一次结构判断拿到 Node 流版本，交给
 * Readable.fromWeb，不是 Web 流则直接失败。 */
export function webBody(stream: unknown): NodeWebReadableStream {
  if (!(stream instanceof ReadableStream)) throw new Error('web_body_invalid');
  return stream as NodeWebReadableStream;
}

export type Row<T> = { [K in keyof T]: T[K] };

/** 把 `db.prepare(...).get()` 的返回值校验成 `T`；行不存在时仍然是 undefined。 */
export function expectRow<T>(schema: AnySchema, row: unknown, invalid: string): Row<T> | undefined {
  if (row === undefined || row === null) return undefined;
  let validate = validators.get(schema);
  if (!validate) { validate = ajv.compile(schema); validators.set(schema, validate); }
  if (!validate(row)) throw new Error(invalid);
  return row as T;
}

/** 把 `db.prepare(...).all()` 的返回值逐条校验成 `T`。 */
export function expectRows<T>(schema: AnySchema, rows: readonly unknown[], invalid: string): Row<T>[] {
  return rows.map(row => {
    const parsed = expectRow<T>(schema, row, invalid);
    if (!parsed) throw new Error(invalid);
    return parsed;
  });
}

const nullableString = { type: ['string', 'null'] } as const;
const nullableInteger = { type: ['integer', 'null'] } as const;

const properties = (value: Record<string, AnySchema>, required: string[]) => ({ type: 'object', properties: value, required, additionalProperties: true } as const);

/** `cloud_tasks` 全列（见 storage/database.ts 迁移 10/12/13/19/36 与 task-model 增量列）。 */
export interface CloudTaskRow {
  id: string;
  owner_id: string;
  nonce: string;
  kind: string;
  resource: string;
  input: string;
  status: string;
  progress: string | null;
  result: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  parent_run_id: string | null;
  parent_step_id: string | null;
  executor: 'node' | 'media' | string | null;
  worker_id: string | null;
  lease_expires_at: string | null;
  effects: string | null;
  model_snapshot: string | null;
  root_task_id: string | null;
}
export const cloudTaskRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, nonce: { type: 'string' }, kind: { type: 'string' },
  resource: { type: 'string' }, input: { type: 'string' }, status: { type: 'string' },
  progress: nullableString, result: nullableString, error: nullableString,
  created_at: { type: 'string' }, updated_at: { type: 'string' },
  parent_run_id: nullableString, parent_step_id: nullableString, executor: nullableString,
  worker_id: nullableString, lease_expires_at: nullableString, effects: nullableString,
  model_snapshot: nullableString, root_task_id: nullableString,
}, ['id', 'owner_id', 'nonce', 'kind', 'resource', 'input', 'status', 'created_at', 'updated_at']);

/** 列表投影会带上 `cloud_tasks t.*` 之外的计算列；缺列时任务是 null 而不是不存在。 */
export interface CloudTaskListRow extends CloudTaskRow {
  bot_name?: string | null;
  resource_name?: string | null;
}
export const cloudTaskListRowSchema = { ...cloudTaskRowSchema, required: ['id', 'kind', 'resource', 'status', 'input', 'created_at'] } as const;

/** DTO 只读这几列，且逐列都做了类型兜底；SQLite 边界已按本文件或会话边界校验过，
 * 因此传给 taskDto 的行只要求具备这些键，不再强制要求 `id/owner_id/非空` 等无关列。
 * 可选列用「可选属性」单独声明而不是继承 `CloudTaskRow`：后者要求每个键都出现，
 * 而只取部分列的 `SELECT` 里这些键根本不存在。 */
export type TaskDtoRow = Pick<CloudTaskRow, 'id' | 'kind' | 'resource' | 'status' | 'input' | 'created_at'> & {
  owner_id?: string; progress?: string | null; result?: string | null; error?: string | null; updated_at?: string;
  parent_run_id?: string | null; bot_name?: string | null; resource_name?: string | null; model_snapshot?: string | null;
  effects?: string | null; executor?: string | null;
};

/** DTO 真正依赖的列；缺列说明库结构与代码不一致，直接失败而不是生成半截任务对象。 */
const taskDtoRequired = {
  type: 'object', required: ['id', 'kind', 'resource', 'status', 'input', 'created_at'],
  // ajv strict 会把 required 里的每个键当成必须声明为属性;这里一次性列全 DTO 依赖的列。
  properties: {
    id: { type: 'string' }, kind: { type: 'string' }, resource: { type: 'string' }, status: { type: 'string' },
    input: { type: 'string' }, created_at: { type: 'string' },
  },
} as const;
/** 其余列可以缺省或为 NULL，但出现时必须是字符串。 */
const taskDtoOptional = ['owner_id', 'progress', 'result', 'error', 'updated_at', 'parent_run_id', 'bot_name', 'resource_name', 'model_snapshot', 'effects', 'executor'] as const;

/** 把 `cloud_tasks` 读出的行交给 DTO 前先收窄它的形状。 */
export function taskDtoRow(value: unknown): TaskDtoRow {
  const row = expectRow<TaskDtoRow>(taskDtoRequired, value, 'cloud_task_row_invalid')!;
  const raw: Record<string, unknown> = { ...row };
  for (const key of taskDtoOptional) if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== 'string') throw new Error('cloud_task_row_invalid');
  return row;
}

/** `gateway_accounts`（迁移 13；`received_at` 等列由后续迁移补在其它表上）。 */
export interface GatewayAccountRow {
  id: string;
  owner_id: string;
  channel: string;
  agent_id: string;
  enabled: number;
  preset: string;
  config: string;
  cursor: string | null;
  health: string;
  created_at: string;
}
export const gatewayAccountRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, channel: { type: 'string' }, agent_id: { type: 'string' },
  enabled: { type: 'integer' }, preset: { type: 'string' }, config: { type: 'string' }, cursor: nullableString,
  health: { type: 'string' }, created_at: { type: 'string' },
}, ['id', 'owner_id', 'channel', 'agent_id', 'enabled', 'preset', 'config', 'health', 'created_at']);

/** 列表投影只读这些列；`createdAt` 由 SQL 起别名。 */
export interface GatewayAccountListRow {
  id: string; channel: string; agentId: string; enabled: number; preset: string; health: string; createdAt: string;
}
export const gatewayAccountListRowSchema = properties({
  id: { type: 'string' }, channel: { type: 'string' }, agentId: { type: 'string' }, enabled: { type: 'integer' },
  preset: { type: 'string' }, health: { type: 'string' }, createdAt: { type: 'string' },
}, ['id', 'channel', 'agentId', 'enabled', 'preset', 'health', 'createdAt']);

export interface GatewayBindingRow {
  id: string;
  account_id: string;
  tenant: string;
  peer: string;
  chat: string;
  topic: string;
  thread_id: string;
  context: string | null;
  revoked: number;
  checkpoint: number;
}
export const gatewayBindingRowSchema = properties({
  id: { type: 'string' }, account_id: { type: 'string' }, tenant: { type: 'string' }, peer: { type: 'string' },
  chat: { type: 'string' }, topic: { type: 'string' }, thread_id: { type: 'string' }, context: nullableString,
  revoked: { type: 'integer' }, checkpoint: { type: 'integer' },
}, ['id', 'account_id', 'tenant', 'peer', 'chat', 'topic', 'thread_id', 'revoked']);

export interface GatewayInboxRow {
  id: number;
  account_id: string;
  external_id: string;
  envelope: string;
  received_at: number;
  status: string;
  error: string | null;
}
export const gatewayInboxRowSchema = properties({
  id: { type: 'integer' }, account_id: { type: 'string' }, external_id: { type: 'string' }, envelope: { type: 'string' },
  received_at: { type: 'integer' }, status: { type: 'string' }, error: nullableString,
}, ['id', 'account_id', 'external_id', 'envelope', 'status']);

/** 收件箱行 + 账号/线程列（processInbox 的 JOIN 投影）。 */
export interface GatewayInboxWorkRow extends GatewayInboxRow {
  owner_id: string; agent_id: string; channel: string; position: number;
}
export const gatewayInboxWorkRowSchema = properties({
  id: { type: 'integer' }, account_id: { type: 'string' }, external_id: { type: 'string' }, envelope: { type: 'string' },
  received_at: { type: 'integer' }, status: { type: 'string' }, error: nullableString,
  owner_id: { type: 'string' }, agent_id: { type: 'string' }, channel: { type: 'string' }, position: { type: 'integer' },
}, ['id', 'account_id', 'envelope', 'status', 'owner_id', 'agent_id', 'channel']);

/** 投递队列行 + 绑定/账号列（deliver 的 JOIN 投影）。 */
export interface GatewayOutboxDeliveryRow {
  id: string; binding_id: string; payload: string; status: string; attempts: number; next_at: number; created_at: number;
  account_id: string; tenant: string; peer: string; chat: string; topic: string; context: string | null;
  owner_id: string; channel: string; config: string;
}
export const gatewayOutboxDeliveryRowSchema = properties({
  id: { type: 'string' }, binding_id: { type: 'string' }, payload: { type: 'string' }, status: { type: 'string' },
  attempts: { type: 'integer' }, next_at: { type: 'integer' }, created_at: { type: 'integer' },
  account_id: { type: 'string' }, tenant: { type: 'string' }, peer: { type: 'string' }, chat: { type: 'string' },
  topic: { type: 'string' }, context: nullableString, owner_id: { type: 'string' }, channel: { type: 'string' }, config: { type: 'string' },
}, ['id', 'binding_id', 'payload', 'status', 'attempts', 'created_at', 'account_id', 'tenant', 'peer', 'chat', 'topic', 'owner_id', 'channel', 'config']);

/** 单个投递的状态重试/丢弃投影。 */
export interface GatewayOutboxStatusRow { id: string; status: string }
export const gatewayOutboxStatusRowSchema = properties({ id: { type: 'string' }, status: { type: 'string' } }, ['id', 'status']);

export interface GatewayReminderRow { id: string; thread_id: string; timezone: string; next_at: number; interval_seconds: number | null; text: string }
export const gatewayReminderRowSchema = properties({
  id: { type: 'string' }, thread_id: { type: 'string' }, timezone: { type: 'string' }, next_at: { type: 'integer' },
  interval_seconds: nullableInteger, text: { type: 'string' },
}, ['id', 'thread_id', 'timezone', 'next_at', 'text']);

/** `agent_profiles`（见 storage/database.ts 迁移 17 与 server.ts 的默认 Agent 引导）。 */
export interface AgentProfileRow {
  id: string;
  owner_id: string;
  name: string;
  avatar: string | null;
  role: string;
  system_prompt: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}
export const agentProfileSummaryRowSchema = properties({
  id: { type: 'string' }, name: { type: 'string' }, avatar: nullableString, role: { type: 'string' }, enabled: { type: 'integer' },
}, ['id', 'name', 'role', 'enabled']);
export const agentProfileRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, name: { type: 'string' }, avatar: nullableString,
  role: { type: 'string' }, system_prompt: { type: 'string' }, enabled: { type: 'integer' },
  created_at: { type: 'string' }, updated_at: { type: 'string' },
}, ['id', 'owner_id', 'name', 'role', 'enabled']);

/** `files` 的完整行（含 server.ts 文件路由读取的 `sha256`）。 */
export interface FileRecordRow extends FileRow { sha256: string }
export const fileRecordRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, original_name: { type: 'string' }, mime_type: { type: 'string' },
  size_bytes: { type: 'integer' }, storage_name: { type: 'string' }, sha256: { type: 'string' }, created_at: { type: 'string' },
}, ['id', 'owner_id', 'original_name', 'mime_type', 'size_bytes', 'storage_name', 'sha256']);

/** `messages` 的完整行（server.ts 的回执去重与 DTO 重建）。 */
export interface MessageRecordRow {
  id: string;
  thread_id: string;
  client_nonce: string | null;
  seq: number;
  role: string;
  kind: string;
  content: string;
  reply_to: string | null;
  created_at: string;
}
export const messageRecordRowSchema = properties({
  id: { type: 'string' }, thread_id: { type: 'string' }, client_nonce: nullableString, seq: { type: 'integer' },
  role: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' }, reply_to: nullableString, created_at: { type: 'string' },
}, ['id', 'thread_id', 'seq', 'role', 'kind', 'content', 'created_at']);

/** 会话鉴权行：cookie 会话与 API token 共用 `{ id, name }` 的调用方形状。
 * `password_hash` 只在密码登录那次查询里出现；缺省时 `verifyPassword` 走 dummy hash 的失败路径。 */
export interface AuthUserRow { id: string; name: string; password_hash?: string; session_id?: string | null; token_id?: string | null }
export const authUserRowSchema = properties({ id: { type: 'string' }, name: { type: 'string' }, password_hash: { type: 'string' }, session_id: nullableString, token_id: nullableString }, ['id', 'name']);

/** `approvals` 的单条投影（GET /approvals/:id 原样回传）。 */
export interface ApprovalProjectionRow {
  id: string; messageId: string; threadId: string; runId: string | null; status: string;
  createdAt: string; resolvedAt: string | null; resolution: string | null;
}
export const approvalProjectionRowSchema = properties({
  id: { type: 'string' }, messageId: { type: 'string' }, threadId: { type: 'string' }, runId: nullableString,
  status: { type: 'string' }, createdAt: { type: 'string' }, resolvedAt: nullableString, resolution: nullableString,
}, ['id', 'messageId', 'threadId', 'status', 'createdAt']);

export interface ThreadRow {
  id: string;
  owner_id: string | null;
  mode: string;
  title: string | null;
  default_model: string | null;
  archived: number;
  project_id: string | null;
  agent_id: string | null;
  mcp_server_ids: string | null;
  skill_ids: string | null;
  created_at: string;
  updated_at: string;
}
export const threadRowSchema = properties({
  id: { type: 'string' }, owner_id: nullableString, mode: { type: 'string' }, title: nullableString,
  default_model: nullableString, archived: { type: 'integer' }, project_id: nullableString, agent_id: nullableString,
  mcp_server_ids: nullableString, skill_ids: nullableString, created_at: { type: 'string' }, updated_at: { type: 'string' },
}, ['id', 'mode', 'archived', 'created_at', 'updated_at']);

export interface RunRow {
  id: string;
  thread_id: string;
  mode: string;
  status: string;
  error_code: string | null;
  trigger_message_id: string | null;
  root_run_id: string | null;
  model_snapshot: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}
export const runRowSchema = properties({
  id: { type: 'string' }, thread_id: { type: 'string' }, mode: { type: 'string' }, status: { type: 'string' },
  error_code: nullableString, trigger_message_id: nullableString, root_run_id: nullableString, model_snapshot: nullableString,
  created_at: { type: 'string' }, started_at: nullableString, completed_at: nullableString,
}, ['id', 'thread_id', 'mode', 'status', 'created_at']);

/** `task_delegations`（见 storage/task-model.ts）。 */
export interface TaskDelegationRow {
  task_id: string;
  owner_id: string;
  parent_task_id: string | null;
  parent_run_id: string | null;
  root_id: string;
  dependencies: string;
  promoted_session_id: number | null;
  delivery: string;
}
export const taskDelegationRowSchema = properties({
  task_id: { type: 'string' }, owner_id: { type: 'string' }, parent_task_id: nullableString, parent_run_id: nullableString,
  root_id: { type: 'string' }, dependencies: { type: 'string' }, promoted_session_id: nullableInteger, delivery: { type: 'string' },
}, ['task_id', 'owner_id', 'root_id', 'dependencies', 'delivery']);

/** `task_session_commands`（见 storage/task-model.ts）。 */
export interface TaskSessionCommandRow {
  owner_id: string;
  operation_id: string;
  request: string;
  session_id: number;
}
export const taskSessionCommandRowSchema = properties({
  owner_id: { type: 'string' }, operation_id: { type: 'string' }, request: { type: 'string' }, session_id: { type: 'integer' },
}, ['owner_id', 'operation_id', 'request', 'session_id']);

/** `task_agent_checkpoints`（见 storage/task-model.ts）。 */
export interface TaskAgentCheckpointRow {
  task_id: string;
  payload: string;
  wait_ids: string;
}
export const taskAgentCheckpointRowSchema = properties({
  task_id: { type: 'string' }, payload: { type: 'string' }, wait_ids: { type: 'string' },
}, ['task_id', 'payload', 'wait_ids']);

/** `files`（见 storage/database.ts 迁移 3）。 */
export interface FileRow {
  id: string;
  owner_id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  storage_name: string;
  created_at: string;
}
export const fileRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, original_name: { type: 'string' }, mime_type: { type: 'string' },
  size_bytes: { type: 'integer' }, storage_name: { type: 'string' }, created_at: { type: 'string' },
}, ['id', 'owner_id', 'original_name', 'mime_type', 'size_bytes', 'storage_name']);

export interface RunWaitRow {
  id: string;
  run_id: string;
  step_id: string;
  task_ids: string;
  status: string;
  created_at: string;
}
export interface SessionMarkerRow { role: string | null }
export const sessionMarkerRowSchema = properties({ role: nullableString }, []);
export const runWaitRowSchema = properties({
  id: { type: 'string' }, run_id: { type: 'string' }, step_id: { type: 'string' }, task_ids: { type: 'string' },
  status: { type: 'string' }, created_at: { type: 'string' },
}, ['id', 'run_id', 'step_id', 'task_ids', 'status']);

/** `plugin_learning_tasks` + `cloud_tasks`（学习类插件任务回执）。 */
export interface PluginLearningTaskRow {
  task_id: string;
  owner_id: string;
  plugin_id: string;
  instance_id: string;
  action_id: string;
  material_id: string;
  request: string;
  result: string | null;
  delivered_at: string | null;
  error: string | null;
}
export const pluginLearningTaskRowSchema = properties({
  task_id: { type: 'string' }, owner_id: { type: 'string' }, plugin_id: { type: 'string' }, instance_id: { type: 'string' },
  action_id: { type: 'string' }, material_id: { type: 'string' }, request: { type: 'string' },
  result: nullableString, delivered_at: nullableString, error: nullableString,
}, ['task_id', 'owner_id', 'plugin_id', 'instance_id', 'action_id', 'material_id', 'request']);

/** `plugin_learning_tasks` 的 `l.*` 与 `cloud_tasks` 的 `t.*` 在 task_id/owner_id/error 上重名；
 * 下面的具名 schema 就是这些 JOIN 一起读出时的契约，避免各调用点各猜一遍列形状。 */
export const cloudTaskWithRequestSchema = { ...cloudTaskRowSchema, required: [...cloudTaskRowSchema.required, 'request'], properties: { ...cloudTaskRowSchema.properties, request: { type: 'string' } } } as const;

/** practice.extract 回执投影：`l.*` + `t.input/t.status/t.progress`。 */
export const practiceExtractionRowSchema = { ...pluginLearningTaskRowSchema,
  required: [...pluginLearningTaskRowSchema.required, 'input', 'status', 'progress'],
  properties: { ...pluginLearningTaskRowSchema.properties, input: { type: 'string' }, status: { type: 'string' }, progress: nullableString } } as const;

/** `plugin_practice_submissions`（见 plugins/learning-results.ts）。 */
export interface PracticeSubmissionRow {
  id: string;
  owner_id: string;
  row_id: number;
  question_index: number;
  delivered_at: string | null;
  error: string | null;
}
export const practiceSubmissionRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, row_id: { type: 'integer' }, question_index: { type: 'integer' },
  delivered_at: nullableString, error: nullableString,
}, ['id', 'owner_id', 'row_id', 'question_index']);
