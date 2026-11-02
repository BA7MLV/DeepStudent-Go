import crypto from 'node:crypto';
import { boardTaskTerminal, type BoardBotTask, type BoardTask } from '@wangke/contracts/board';
import type { DatabaseStore } from '../storage/database.js';
import { listOwnerTasks, taskDto } from '../cloud/tasks.js';
import type { BotApplicationService } from '../agent/service.js';

const RUN_SELECT = `SELECT r.id,r.thread_id,r.status,r.created_at,r.started_at,r.completed_at,r.error_code,r.step_count,
  t.title AS thread_title,a.name AS bot_name,substr(m.content,1,240) AS prompt,
  (SELECT tool FROM run_steps WHERE run_id=r.id AND status IN ('running','waiting_approval') ORDER BY created_at DESC,id DESC LIMIT 1) AS tool
  FROM runs r JOIN threads t ON t.id=r.thread_id
  LEFT JOIN messages m ON m.id=r.trigger_message_id AND m.thread_id=r.thread_id
  LEFT JOIN agent_profiles a ON a.id=t.agent_id AND a.owner_id=t.owner_id`;

/** A view over the real run/task records, not a second execution state machine. */
export class BoardTasks {
  constructor(private store: DatabaseStore) {}
  private bot(row: any): BoardBotTask {
    // Match the exact run or its tool steps, never the latest reply in a shared conversation.
    const reply = boardTaskTerminal(row.status) ? this.store.db.prepare(`SELECT m.id,m.kind,substr(m.content,1,4000) AS text,length(m.content)>4000 AS truncated
      FROM messages m WHERE m.thread_id=? AND m.role='assistant' AND m.kind IN ('text','attachment')
      AND (m.client_nonce LIKE ? OR EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id=? AND m.client_nonce IN ('bot:'||s.id||':message','bot:'||s.id||':attachment')))
      ORDER BY m.seq DESC LIMIT 1`).get(row.thread_id, `bot:${row.id}:reply:%`, row.id) as any : undefined;
    return {
      id: `bot:${row.id}`, kind: 'bot', runId: row.id, threadId: row.thread_id,
      title: row.prompt ?? '', resourceName: row.thread_title ?? '',
      source: { kind: 'bot', ...(row.bot_name ? { name: row.bot_name } : {}) },
      status: row.status, createdAt: row.created_at, startedAt: row.started_at ?? null, completedAt: row.completed_at ?? null,
      stepCount: row.step_count, progress: row.tool ? { tool: row.tool } : null, error: row.error_code ?? null,
      result: reply ? { messageId: reply.id, kind: reply.kind, text: reply.text, truncated: Boolean(reply.truncated) } : null,
    };
  }
  list(owner: string): BoardTask[] {
    const runs = this.store.db.prepare(`${RUN_SELECT} WHERE t.owner_id=? AND r.mode='bot'
      ORDER BY CASE WHEN r.status IN ('completed','failed','cancelled') THEN 1 ELSE 0 END,r.created_at DESC,r.id DESC LIMIT 200`).all(owner);
    return [...listOwnerTasks(this.store, owner), ...runs.map(row => this.bot(row))]
      .sort((a, b) => Number(boardTaskTerminal(a.status)) - Number(boardTaskTerminal(b.status)) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)).slice(0, 200);
  }
  get(owner: string, id: unknown): BoardTask {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('invalid_task_id');
    if (id.startsWith('bot:')) {
      const row = this.store.db.prepare(`${RUN_SELECT} WHERE t.owner_id=? AND r.id=? AND r.mode='bot'`).get(owner, id.slice(4));
      if (row) return this.bot(row);
    } else {
      const row = this.store.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, owner);
      if (row) return taskDto(row);
    }
    throw new Error('task_not_found');
  }
  forMessage(owner: string, thread: string, message: string): BoardBotTask | undefined {
    const row = this.store.db.prepare(`${RUN_SELECT} WHERE t.owner_id=? AND r.thread_id=? AND r.trigger_message_id=? AND r.mode='bot'`).get(owner, thread, message);
    return row ? this.bot(row) : undefined;
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
