import { Ajv, type ValidateFunction } from 'ajv';
import { BOT_MODEL_NOT_CONFIGURED_ERROR_NAME } from '@wangke/contracts';

/**
 * 未配置可用模型是用户可修复的配置缺失，必须映射成稳定的 4xx 准入拒绝，
 * 不能落到 Fastify 兜底成 500。类名同时发布在契约里
 * （BOT_MODEL_NOT_CONFIGURED_ERROR_NAME），REST/IM/脚本按名字识别，无需跨包 instanceof。
 */
export class BotModelNotConfiguredError extends Error {
  readonly code = 'model_not_configured';
  constructor() {
    super('model_not_configured');
    this.name = BOT_MODEL_NOT_CONFIGURED_ERROR_NAME;
  }
}

/**
 * prepare().get()/.all() 的结果是外部数据：列是否存在、类型如何都由数据库迁移决定，
 * 不能用 `as` 断言直接信任。这里用 ajv 在信任边界校验行形状，
 * 不符即抛出（代码/迁移缺陷），而不是静默透传成 undefined 或错误类型。
 */
const rowAjv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, ownProperties: true, allErrors: false, coerceTypes: false, useDefaults: false });
const rowValidators = new Map<string, ValidateFunction>();
function rowValidator(key: string, schema: object): ValidateFunction {
  const cached = rowValidators.get(key);
  if (cached) return cached;
  const validate = rowAjv.compile(schema);
  rowValidators.set(key, validate);
  return validate;
}
/** 行形状不符合预期是代码/迁移缺陷，不是客户端输入错误，所以抛出而不是返回空。 */
export function invalidDatabaseRow(key: string): never {
  throw new Error(`database_row_invalid:${key}`);
}
export function parseRow<T>(key: string, schema: object, value: unknown): T {
  if (!rowValidator(key, schema)(value)) invalidDatabaseRow(key);
  return value as T;
}
export function parseRows<T>(key: string, schema: object, values: readonly unknown[]): T[] {
  const validate = rowValidator(key, schema);
  for (const value of values) if (!validate(value)) invalidDatabaseRow(key);
  return values as T[];
}
export function optionalRow<T>(key: string, schema: object, value: unknown): T | undefined {
  // SQLite 的 .get() 不命中时给 undefined;null 只可能是调用方在表达
  // “这一行按语义不存在”(如 resolve() 里 cloud_permission_id 命中时跳过 run
  // 查找),与 undefined 同义,不是坏行。
  return value === undefined || value === null ? undefined : parseRow<T>(key, schema, value);
}

const nullableString = { type: ['string', 'null'] } as const;
export const THREAD_ROW_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    id: { type: 'string' }, mode: { type: 'string', enum: ['bot', 'chat'] }, title: nullableString,
    project_id: nullableString, agent_id: nullableString,
    // 线程级默认模型存的是 JSON 文本，parse 失败由调用方决定如何处理。
    default_model: nullableString,
    // 迁移前的老库可能是 NULL，语义等同于未归档。
    archived: { type: ['boolean', 'integer', 'null'] },
  },
  required: ['id', 'mode'],
};
const APPENDED_MESSAGE_PROPERTIES = {
  id: { type: 'string' }, threadId: { type: 'string' }, clientNonce: nullableString, seq: { type: 'integer' },
  role: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' }, replyTo: nullableString, createdAt: { type: 'string' },
} as const;
export const APPENDED_MESSAGE_ROW_SCHEMA = {
  type: 'object', additionalProperties: true, properties: APPENDED_MESSAGE_PROPERTIES,
  required: ['id', 'threadId', 'clientNonce', 'seq', 'role', 'kind', 'content', 'replyTo', 'createdAt'],
};
/**
 * `SELECT *` 的 messages 行：只约束后续真正读取的列。
 * task_command 允许 undefined（老库未回填）——`additionalProperties: true`
 * 下「缺失」与「null」语义一致，都由读代码按 falsy 处理。
 */
export const MESSAGE_ROW_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    id: { type: 'string' }, thread_id: { type: 'string' }, client_nonce: nullableString, seq: { type: 'integer' },
    role: { type: 'string' }, kind: { type: 'string' }, content: { type: 'string' }, reply_to: nullableString,
    created_at: { type: 'string' }, task_command: nullableString,
  },
  required: ['id', 'thread_id', 'client_nonce', 'seq', 'role', 'kind', 'content', 'created_at'],
};
export const SEQUENCE_ROW_SCHEMA = { type: 'object', properties: { seq: { type: 'integer' } }, required: ['seq'] };
export const MESSAGE_PAGE_ROW_SCHEMA = {
  type: 'object', additionalProperties: true, properties: APPENDED_MESSAGE_PROPERTIES,
  required: ['id', 'threadId', 'clientNonce', 'seq', 'role', 'kind', 'content', 'replyTo', 'createdAt'],
};
export const PARTICIPANT_ROW_SCHEMA = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] };
/** `SELECT r.*` / `SELECT *` 的 runs 行。 */
export const RUN_ROW_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    id: { type: 'string' }, thread_id: { type: 'string' }, mode: { type: 'string' }, status: { type: 'string' },
    created_at: { type: 'string' }, started_at: nullableString, completed_at: nullableString,
    wake_at: nullableString, error_code: nullableString,
  },
  required: ['id', 'thread_id', 'mode', 'status', 'created_at'],
};
export const RUN_ID_ROW_SCHEMA = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] };
export const APPROVAL_ROW_SCHEMA = {
  type: 'object', additionalProperties: true,
  properties: {
    id: { type: 'string' }, thread_id: { type: 'string' }, message_id: { type: 'string' }, run_id: nullableString,
    status: { type: 'string' }, created_at: { type: 'string' }, resolved_at: nullableString, resolution: nullableString,
    cloud_permission_id: nullableString,
  },
  required: ['id', 'thread_id', 'message_id', 'status', 'created_at'],
};
/** 仅校验列的值域；SELECT 里是否包含该列由 SQL 决定。 */
export const RUN_STATUS_SELECT_SCHEMA = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };

export type ThreadRow = { id: string; mode: 'bot' | 'chat'; title: string | null; project_id: string | null; agent_id: string | null; default_model: string | null; archived?: boolean | number | null };
export type AppendedMessageRow = { id: string; threadId: string; clientNonce: string | null; seq: number; role: string; kind: string; content: string; replyTo: string | null; createdAt: string };
export type MessageRow = { id: string; thread_id: string; client_nonce: string | null; seq: number; role: string; kind: string; content: string; reply_to: string | null; created_at: string; task_command?: string | null };
export type RunRow = { id: string; thread_id: string; mode: string; status: string; created_at: string; started_at?: string | null; completed_at?: string | null; wake_at?: string | null; error_code?: string | null };
export type ApprovalRow = { id: string; thread_id: string; message_id: string; run_id?: string | null; status: string; created_at: string; resolved_at?: string | null; resolution?: string | null; cloud_permission_id?: string | null };
export type ParticipantRow = { id: string; name: string };
