import crypto from 'node:crypto';
import { boardTaskTerminal, type BoardBotTask, type BoardTask } from '@wangke/contracts/board';
import type { DatabaseStore } from '../storage/database.js';
import { listOwnerTasks, taskDto, taskDtoRow } from '../cloud/tasks.js';
import type { BotApplicationService } from '../agent/service.js';
import { sql, type SqlText } from '../storage/sql.js';
import { cloudTaskRowSchema, expectRow, type CloudTaskRow } from '../storage/row-schema.js';

// RUN_SELECT 是本文件的固定查询骨架:sql`` 产出的 SqlText(bindings=0)可直接作为
// 片段参与下一次 sql`` 拼接 —— 不要再用 sqlKeyword 包一层,它会拒绝其中的字符串
// 字面量引号(如 status IN ('running','waiting_approval')),那是合法 SQL 而不是注入。
const RUN_SELECT = sql`SELECT r.id,r.thread_id,r.status,r.created_at,r.started_at,r.completed_at,r.error_code,r.step_count,
  t.title AS thread_title,a.name AS bot_name,substr(m.content,1,240) AS prompt,
  (SELECT tool FROM run_steps WHERE run_id=r.id AND status IN ('running','waiting_approval') ORDER BY created_at DESC,id DESC LIMIT 1) AS tool
  FROM runs r JOIN threads t ON t.id=r.thread_id
  LEFT JOIN messages m ON m.id=r.trigger_message_id AND m.thread_id=r.thread_id
  LEFT JOIN agent_profiles a ON a.id=t.agent_id AND a.owner_id=t.owner_id`;
const runById: SqlText = sql`${RUN_SELECT} WHERE t.owner_id=? AND r.id=? AND r.mode='bot'`;
const runByOwner = sql`${RUN_SELECT} WHERE t.owner_id=? AND r.mode='bot'
  ORDER BY CASE WHEN r.status IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,r.created_at DESC,r.id DESC LIMIT 200`;
const runByMessage = sql`${RUN_SELECT} WHERE t.owner_id=? AND r.thread_id=? AND r.trigger_message_id=? AND r.mode='bot'`;
const terminalReply = sql`SELECT m.id,m.kind,substr(m.content,1,4000) AS text,length(m.content)>4000 AS truncated
  FROM messages m WHERE m.thread_id=? AND m.role='assistant' AND m.kind IN ('text','attachment')
  AND (m.client_nonce LIKE ? OR EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id=? AND m.client_nonce IN ('bot:'||s.id||':message','bot:'||s.id||':attachment')))
  ORDER BY m.seq DESC LIMIT 1`;

/** run 状态在库里是 TEXT;这里按契约收窄,未知值沿用原文本(前端按非终态渲染)。 */
const runStatuses = new Set<BoardBotTask['status']>(['queued', 'running', 'waiting_user', 'waiting_event', 'completed', 'failed', 'cancelled', 'paused']);
function runStatus(value: string): BoardBotTask['status'] {
  // 库里的状态值域由 runs 表迁移决定;非已知值按「进行中」渲染,不把一个未知终态显示成已完成。
  return runStatuses.has(value as BoardBotTask['status']) ? (value as BoardBotTask['status']) : 'running';
}

/** RUN_SELECT 的行形状:只声明本类实际读取的列。 */
type RunRow = { id: string; thread_id: string; status: string; created_at: string; started_at: string | null; completed_at: string | null;
  error_code: string | null; step_count: number; thread_title: string | null; bot_name: string | null; prompt: string | null; tool: string | null };
type ReplyRow = { id: string; kind: string; text: string; truncated: number };

/** 查询结果是外部数据:用类型守卫逐字段收窄,不再 `as any` 穿透。 */
function isRunRow(row: unknown): row is RunRow {
  if (!row || typeof row !== 'object') return false;
  const value = row as Record<string, unknown>;
  return typeof value.id === 'string' && typeof value.thread_id === 'string' && typeof value.status === 'string'
    && typeof value.created_at === 'string' && typeof value.step_count === 'number';
}
function isReplyRow(row: unknown): row is ReplyRow {
  if (!row || typeof row !== 'object') return false;
  const value = row as Record<string, unknown>;
  return typeof value.id === 'string' && typeof value.kind === 'string' && typeof value.text === 'string';
}

/** A view over the real run/task records, not a second execution state machine. */
export class BoardTasks {
  constructor(private store: DatabaseStore) {}
  private bot(row: RunRow): BoardBotTask {
    // Match the exact run or its tool steps, never the latest reply in a shared conversation.
    const candidate = boardTaskTerminal(row.status) ? this.store.db.prepare(terminalReply.sql).get(row.thread_id, `bot:${row.id}:reply:%`, row.id) : undefined;
    const reply = isReplyRow(candidate) ? candidate : undefined;
    return {
      id: `bot:${row.id}`, kind: 'bot', runId: row.id, threadId: row.thread_id,
      title: row.prompt ?? '', resourceName: row.thread_title ?? '',
      source: { kind: 'bot', ...(row.bot_name ? { name: row.bot_name } : {}) },
      status: runStatus(row.status), createdAt: row.created_at, startedAt: row.started_at ?? null, completedAt: row.completed_at ?? null,
      stepCount: row.step_count, progress: row.tool ? { tool: row.tool } : null, error: row.error_code ?? null,
      result: reply ? { messageId: reply.id, kind: reply.kind, text: reply.text, truncated: Boolean(reply.truncated) } : null,
    };
  }
  private runs(rows: unknown[]): BoardBotTask[] {
    return rows.filter(isRunRow).map(row => this.bot(row));
  }
  list(owner: string): BoardTask[] {
    return [...listOwnerTasks(this.store, owner), ...this.runs(this.store.db.prepare(runByOwner.sql).all(owner))]
      .sort((a, b) => Number(boardTaskTerminal(a.status)) - Number(boardTaskTerminal(b.status)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 200);
  }
  get(owner: string, id: unknown): BoardTask {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('invalid_task_id');
    if (id.startsWith('bot:')) {
      const row = this.store.db.prepare(runById.sql).get(owner, id.slice(4));
      if (isRunRow(row)) return this.bot(row);
    } else {
      const row = expectRow<CloudTaskRow>(cloudTaskRowSchema, this.store.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, owner), 'cloud_task_row_invalid');
      if (row) return taskDto(row);
    }
    throw new Error('task_not_found');
  }
  forMessage(owner: string, thread: string, message: string): BoardBotTask | undefined {
    const row = this.store.db.prepare(runByMessage.sql).get(owner, thread, message);
    return isRunRow(row) ? this.bot(row) : undefined;
  }
  start(owner: string, plugin: string, bots: BotApplicationService, args: Record<string, unknown>): BoardBotTask {
    if (typeof args.threadId !== 'string' || typeof args.prompt !== 'string' || !args.prompt.trim() || args.prompt.length > 12000 ||
      typeof args.clientNonce !== 'string' || !args.clientNonce || args.clientNonce.length > 100) throw new Error('invalid_bot_task');
    if (bots.thread(owner, args.threadId).mode !== 'bot') throw new Error('board_thread_not_found');
    const clientNonce = `board-task:${crypto.createHash('sha256').update(`${plugin}\0${args.clientNonce}`).digest('hex')}`;
    const previous = this.store.db.prepare('SELECT content FROM messages WHERE thread_id=? AND client_nonce=?').get(args.threadId, clientNonce) as { content: string } | undefined;
    if (previous && previous.content !== args.prompt) throw new Error('task_nonce_conflict');
    const message = bots.send(owner, args.threadId, { content: args.prompt, clientNonce });
    const task = this.forMessage(owner, args.threadId, message.id);
    if (!task) throw new Error('task_not_found');
    return task;
  }
}
