import { Ajv, type ValidateFunction } from 'ajv';

/** 历史浏览器交互证据的行是 SQLite 读出来的外部数据。只读路径不能因为一条旧行
 * 形状不符就悄悄继续：校验失败必须报错，交给上层按「证据不可用」处理。
 * 这里每个可选列都允许缺失，兼容更早版本写入的行。 */
const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, ownProperties: true, allErrors: false, addUsedSchema: false });

export interface InteractionCommandRow {
  id: number;
  task_id: string;
  owner_id: string;
  nonce: string;
  action: string;
  value: string;
  consumed: number;
  target: string;
  snapshot: string | null;
  phase: string | null;
  effects: string | null;
  attempt: number | null;
}
export const interactionCommandRowSchema = {
  type: 'object',
  required: ['id', 'task_id', 'action', 'target'],
  properties: {
    id: { type: 'integer' }, task_id: { type: 'string' }, owner_id: { type: 'string' }, nonce: { type: 'string' },
    action: { type: 'string' }, value: { type: ['string', 'null'] }, consumed: { type: 'integer' },
    target: { type: 'string' }, snapshot: { type: ['string', 'null'] }, phase: { type: ['string', 'null'] },
    effects: { type: ['string', 'null'] }, attempt: { type: ['integer', 'null'] },
  },
  additionalProperties: true,
} as const;

export interface InteractionTaskRow {
  status: string;
  worker_id: string | null;
  lease_expires_at: string | null;
  input: string;
  resource: string;
  kind: string;
}
export const interactionTaskRowSchema = {
  type: 'object',
  required: ['status', 'input', 'resource', 'kind'],
  properties: {
    status: { type: 'string' }, worker_id: { type: ['string', 'null'] }, lease_expires_at: { type: ['string', 'null'] },
    input: { type: 'string' }, resource: { type: 'string' }, kind: { type: 'string' },
  },
  additionalProperties: true,
} as const;

export interface ClientCommandRow {
  status: string;
  result: string | null;
}
export const clientCommandRowSchema = {
  type: 'object',
  required: ['status'],
  properties: { status: { type: 'string' }, result: { type: ['string', 'null'] } },
  additionalProperties: true,
} as const;

const compiled: { command?: ValidateFunction<InteractionCommandRow>; task?: ValidateFunction<InteractionTaskRow>; client?: ValidateFunction<ClientCommandRow> } = {};

export function interactionCommandRow(row: unknown): InteractionCommandRow | undefined {
  if (row === undefined || row === null) return undefined;
  compiled.command ??= ajv.compile<InteractionCommandRow>(interactionCommandRowSchema);
  if (!compiled.command(row)) throw new Error('interaction_command_row_invalid');
  return row;
}
export function interactionTaskRow(row: unknown): InteractionTaskRow | undefined {
  if (row === undefined || row === null) return undefined;
  compiled.task ??= ajv.compile<InteractionTaskRow>(interactionTaskRowSchema);
  if (!compiled.task(row)) throw new Error('interaction_task_row_invalid');
  return row;
}
export function clientCommandRow(row: unknown): ClientCommandRow | undefined {
  if (row === undefined || row === null) return undefined;
  compiled.client ??= ajv.compile<ClientCommandRow>(clientCommandRowSchema);
  if (!compiled.client(row)) throw new Error('client_command_row_invalid');
  return row;
}
