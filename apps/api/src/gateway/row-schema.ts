import type { AnySchema } from 'ajv';

/** gateway/core.ts 自己发起的投影/队列/提醒查询的结果行契约。
 *
 * 与 storage/row-schema.ts 同理：SQLite 读出来的行是外部数据，列可能因历史库缺列或
 * 后续迁移而变成 null 以外的东西。storage/ 那一份只覆盖了 JOIN 过账号/绑定的公共投影；
 * 这里补上 core 里零散查询所需的具名 schema，让调用点用 expectRow/expectRows 收窄，
 * 不再整行断言。校验失败抛错而不是静默降级，避免把坏行当成缺列继续跑。
 */
const properties = (value: Record<string, AnySchema>, required: string[]) => ({ type: 'object', properties: value, required, additionalProperties: true } as const);
const nullableString = { type: ['string', 'null'] } as const;

/** `gateway_bindings` 未撤销的整行（project 的游标推进按 id/thread_id/checkpoint 读取）。
 * 账号侧列一律 NULL 允许：只有旧库/测试直插的行才缺少 channel 来源。 */
export interface GatewayBindingCursorRow {
  id: string;
  account_id: string;
  thread_id: string;
  checkpoint: number;
  revoked: number;
}
export const gatewayBindingCursorRowSchema = properties({
  id: { type: 'string' }, account_id: { type: 'string' }, tenant: { type: 'string' }, peer: { type: 'string' },
  chat: { type: 'string' }, topic: { type: 'string' }, thread_id: { type: 'string' }, context: nullableString,
  revoked: { type: 'integer' }, checkpoint: { type: 'integer' },
}, ['id', 'account_id', 'thread_id', 'checkpoint']);

/** `message_events`（迁移 3）：投影只读事件游标与载荷。 */
export interface MessageEventRow {
  event_id: number;
  thread_id: string;
  seq: number;
  type: string;
  payload: string;
  created_at: string;
}
export const messageEventRowSchema = properties({
  event_id: { type: 'integer' }, id: { type: 'string' }, thread_id: { type: 'string' }, seq: { type: 'integer' },
  type: { type: 'string' }, payload: { type: 'string' }, created_at: { type: 'string' },
}, ['event_id', 'thread_id', 'type', 'payload']);

/** `gateway_projection_failures` 的单事件重试时刻（迁移 14）。 */
export interface GatewayProjectionFailureRow { binding_id: string; event_id: number; error: string; next_at: number }
export const gatewayProjectionFailureRowSchema = properties({
  binding_id: { type: 'string' }, event_id: { type: 'integer' }, error: { type: 'string' }, next_at: { type: 'integer' },
}, ['binding_id', 'event_id', 'next_at']);

/** approval 投影：只关心它是否仍 pending 以及消息序号（approvals ⋈ messages）。 */
export interface GatewayApprovalRow { id: string; status: string; seq: number }
export const gatewayApprovalRowSchema = properties({
  id: { type: 'string' }, status: { type: 'string' }, seq: { type: 'integer' },
}, ['id', 'status', 'seq']);

/** `bot_reminders`（迁移 13）到点唤醒的整行。 */
export interface BotReminderRow {
  id: string;
  owner_id: string;
  thread_id: string;
  text: string;
  timezone: string;
  next_at: number;
  interval_seconds: number | null;
  status: string;
}
export const botReminderRowSchema = properties({
  id: { type: 'string' }, owner_id: { type: 'string' }, thread_id: { type: 'string' }, text: { type: 'string' },
  timezone: { type: 'string' }, next_at: { type: 'integer' }, interval_seconds: { type: ['integer', 'null'] },
  status: { type: 'string' }, created_at: { type: 'string' },
}, ['id', 'thread_id', 'text', 'timezone', 'next_at', 'status']);

/** `retry`/`discard` 与 `deliver` 都按 outbox 整行 + 绑定/账号列工作；
 * 这里只补充它们实际依赖的可变列，账号/绑定列沿用 storage 的投递投影。 */
export interface GatewayOutboxOwnerRow { status: string; attempts: number }
export const gatewayOutboxOwnerRowSchema = properties({
  id: { type: 'string' }, binding_id: { type: 'string' }, payload: { type: 'string' }, status: { type: 'string' },
  attempts: { type: 'integer' }, next_at: { type: 'integer' }, created_at: { type: 'integer' }, seq: { type: 'integer' },
}, ['status']);
