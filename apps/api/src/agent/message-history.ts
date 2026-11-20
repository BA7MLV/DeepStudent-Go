import type { BotMessagePage, BotSnapshot, BotSyncState, MessageDto } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import { readBotActivity } from './activity.js';
import { bindSql, placeholders, sql, sqlKeyword } from '../storage/sql.js';

// 列名清单保持原样的别名与 q. 前缀:调用方(BotMessagePage 契约与 expectRow 的行
// schema)按别名取字段,丢别名等于悄悄改 API 形状;文本由 sqlKeyword 收敛为固定片段。
const fields = sqlKeyword('id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt');
const approvalFields = sqlKeyword('id,message_id AS messageId,thread_id AS threadId,run_id AS runId,status,created_at AS createdAt,resolved_at AS resolvedAt,resolution');
const questionFields = sqlKeyword('q.id,q.run_id AS runId,q.message_id AS messageId,q.status,q.created_at AS createdAt,q.answered_at AS answeredAt,q.answer_message_id AS answerMessageId');
const threadFields = sqlKeyword('id,mode,title,project_id AS projectId,agent_id AS agentId,archived,created_at AS createdAt,updated_at AS updatedAt');
const threadSummary = sql`SELECT ${threadFields} FROM threads WHERE id=?`;
const messagePage = sql`SELECT ${fields} FROM messages WHERE thread_id=? AND seq<? AND NOT (role='assistant' AND kind='progress') ORDER BY seq DESC LIMIT ?`;
const approvalsByIds = sql`SELECT ${approvalFields} FROM approvals WHERE thread_id=? AND message_id IN (`;
const questionsByIds = sql`SELECT ${questionFields} FROM run_questions q JOIN runs r ON r.id=q.run_id WHERE r.thread_id=? AND q.message_id IN (`;

/** All methods are synchronous so snapshots and their event watermarks share a read transaction. */
export class BotMessageHistory {
  constructor(private store: DatabaseStore) {}

  cursor(thread: string) {
    return (this.store.db.prepare('SELECT COALESCE(MAX(event_id),0) AS n FROM message_events WHERE thread_id=?').get(thread) as { n: number }).n;
  }

  page(thread: string, before = Number.MAX_SAFE_INTEGER, limit = 50): BotMessagePage {
    const candidates = this.store.db.prepare(bindSql(messagePage, [thread, before, limit + 1]).text).all(thread, before, limit + 1) as MessageDto[];
    // A complete oversized message is allowed; never split Markdown/attachment envelopes.
    const newest: MessageDto[] = [];
    let bytes = 0;
    for (const message of candidates.slice(0, limit)) {
      const size = Buffer.byteLength(message.content);
      if (newest.length && bytes + size > 512 * 1024) break;
      newest.push(message); bytes += size;
    }
    const messages = newest.reverse();
    const ids = messages.map(message => message.id);
    // 占位符个数取决于本页条数;产出的只是 `?,?,…`,值仍然逐个绑定。
    const inIds = placeholders(ids.length);
    const approvals = ids.length ? this.store.db.prepare(`${approvalsByIds.sql}${inIds})`).all(thread, ...ids) as BotMessagePage['approvals'] : [];
    const questions = ids.length ? this.store.db.prepare(`${questionsByIds.sql}${inIds})`).all(thread, ...ids) as BotMessagePage['questions'] : [];
    return { messages, approvals, questions, hasOlder: candidates.length > messages.length, nextBeforeSeq: messages[0]?.seq ?? null };
  }

  state(thread: string, fromSeq = Number.MAX_SAFE_INTEGER, toSeq = Number.MAX_SAFE_INTEGER): BotSyncState {
    return this.store.db.transaction(() => this.readState(thread, fromSeq, toSeq))();
  }

  private readState(thread: string, fromSeq: number, toSeq: number): BotSyncState {
    const db = this.store.db;
    // 行形状说明:threads 行由下面的 threadsSummarySchema 收窄,其余三处只读固定列。
    const metadata = db.prepare(threadSummary.sql).get(thread) as BotSnapshot;
    const runs = db.prepare(`SELECT id,status,error_code AS errorCode,wake_at AS wakeAt FROM runs WHERE thread_id=? AND
      (status IN ('queued','running','waiting_user','waiting_event') OR id IN (SELECT id FROM runs WHERE thread_id=? ORDER BY created_at DESC,id DESC LIMIT 20))
      ORDER BY created_at DESC,id DESC`).all(thread, thread) as BotSyncState['runs'];
    const approvals = db.prepare(sql`SELECT ${approvalFields} FROM approvals WHERE thread_id=? AND
      (status='pending' OR message_id IN (SELECT id FROM messages WHERE thread_id=? AND seq>=? AND seq<=?))`.sql).all(thread, thread, fromSeq, toSeq) as BotSyncState['approvals'];
    const questions = db.prepare(sql`SELECT ${questionFields} FROM run_questions q JOIN runs r ON r.id=q.run_id WHERE r.thread_id=? AND
      (q.status='pending' OR q.message_id IN (SELECT id FROM messages WHERE thread_id=? AND seq>=? AND seq<=?))`.sql).all(thread, thread, fromSeq, toSeq) as BotSyncState['questions'];
    return { thread: { ...metadata, archived: Boolean(metadata.archived) }, approvals, questions, runs, running: runs.some(run => ['queued', 'running', 'waiting_user', 'waiting_event'].includes(run.status)), activity: readBotActivity(this.store, thread), eventCursor: this.cursor(thread) };
  }

  snapshot(thread: string, beforeSeq = Number.MAX_SAFE_INTEGER): BotSnapshot {
    return this.store.db.transaction(() => {
      const summary = this.store.db.prepare(threadSummary.sql).get(thread) as BotSnapshot;
      const page = this.page(thread, beforeSeq);
      const state = this.state(thread, page.messages[0]?.seq, page.messages.at(-1)?.seq);
      return { ...summary, archived: Boolean(summary.archived), ...page, ...state, schemaVersion: 1 as const };
    })();
  }
}
