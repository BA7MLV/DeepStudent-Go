import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import type { ConversationMode } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import type { BotApplicationService } from '../agent/service.js';
import type { BotRunner } from '../agent/runner.js';
import type { BotMessageHistory } from '../agent/message-history.js';
import { agentProfileSummaryRowSchema, approvalProjectionRowSchema, expectRow, expectRows, runRowSchema, threadRowSchema, type AgentProfileRow, type ApprovalProjectionRow, type RunRow, type ThreadRow } from '../storage/row-schema.js';
import { sql } from '../storage/sql.js';
import type { ProjectRepository } from '../projects/repository.js';

/** 单个会话的读取、消息同步、状态、停止、运行记录与运行取消,以及消息表情和审批。
 * 终态判定(例如「running」包含 waiting_event)直接决定前端输入框与重试入口,
 * 因此与旧 server.ts 保持同一顺序与同一查询。 */
export function registerConversationRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore;
  botService: BotApplicationService;
  runner: BotRunner;
  messageHistory: BotMessageHistory;
  projects: ProjectRepository;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  bad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
}) {
  const { store, botService, runner, messageHistory, projects, requireAuth, checkOrigin, bad } = deps;
  const now = () => new Date().toISOString();
  function ownedThread(userId: string, threadId: string) { return expectRow<ThreadRow>(threadRowSchema, store.db.prepare('SELECT * FROM threads WHERE id=? AND owner_id=?').get(threadId, userId), 'thread_row_invalid'); }
  /** Agent 行只投影这五个字段;行在查询处已用 agentProfileRowSchema 收窄。 */
  function agentDto(row: Pick<AgentProfileRow, 'id' | 'name' | 'avatar' | 'role' | 'enabled'>) {
    return { id: row.id, name: row.name, avatar: row.avatar ?? null, role: row.role, enabled: Boolean(row.enabled) };
  }
  function appendEvent(threadId: string, type: string, payload: unknown) {
    const seq = (store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM message_events WHERE thread_id=?').get(threadId) as { seq: number }).seq;
    store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, type, JSON.stringify(payload), now());
  }
  const runStatusListSchema = { type: 'object', properties: { id: { type: 'string' }, status: { type: 'string' } }, required: ['id', 'status'] } as const;
  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string } }>('/api/v1/threads/:id/snapshot', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    if (!ownedThread(user.id, request.params.id)) return bad(reply, 404, 'thread_not_found');
    const beforeSeq = request.query.beforeSeq === undefined ? Number.MAX_SAFE_INTEGER : Number(request.query.beforeSeq);
    if (!Number.isSafeInteger(beforeSeq) || beforeSeq < 1) return bad(reply, 400, 'invalid_message_cursor');
    return messageHistory.snapshot(request.params.id, beforeSeq);
  });
  app.get<{ Params: { id: string }; Querystring: { beforeSeq?: string; limit?: string } }>('/api/v1/threads/:id/messages', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    if (!ownedThread(user.id, request.params.id)) return bad(reply, 404, 'thread_not_found');
    const before = request.query.beforeSeq === undefined ? Number.MAX_SAFE_INTEGER : Number(request.query.beforeSeq);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return bad(reply, 400, 'invalid_message_cursor');
    return store.db.transaction(() => messageHistory.page(request.params.id, before, limit))();
  });
  app.get<{ Params: { id: string }; Querystring: { fromSeq?: string; toSeq?: string } }>('/api/v1/threads/:id/sync-state', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    if (!ownedThread(user.id, request.params.id)) return bad(reply, 404, 'thread_not_found');
    const from = request.query.fromSeq === undefined ? Number.MAX_SAFE_INTEGER : Number(request.query.fromSeq);
    const to = request.query.toSeq === undefined ? Number.MAX_SAFE_INTEGER : Number(request.query.toSeq);
    if (!Number.isSafeInteger(from) || from < 1 || !Number.isSafeInteger(to) || to < from) return bad(reply, 400, 'invalid_message_cursor');
    return messageHistory.state(request.params.id, from, to);
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const participants = expectRows<AgentProfileRow>(agentProfileSummaryRowSchema, store.db.prepare('SELECT a.* FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? ORDER BY p.joined_at').all(thread.id), 'agent_profile_row_invalid').map(agentDto);
    const approvals = store.db.prepare('SELECT id,message_id AS messageId,run_id AS runId,status,created_at AS createdAt,resolved_at AS resolvedAt,resolution FROM approvals WHERE thread_id=? ORDER BY created_at').all(thread.id);
    const questions = store.db.prepare(sql`SELECT q.id,q.run_id AS runId,q.message_id AS messageId,q.status,
      q.created_at AS createdAt,q.answered_at AS answeredAt,q.answer_message_id AS answerMessageId
      FROM run_questions q JOIN runs r ON r.id=q.run_id WHERE r.thread_id=? ORDER BY q.created_at`.sql).all(thread.id);
    const runs = store.db.prepare(sql`SELECT id,status,error_code AS errorCode,wake_at AS wakeAt
      FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 20`.sql).all(thread.id);
    // running：有没有排队或正在跑的任务，前端据此显示「正在输入」和已读。
    const running = Boolean(store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_event') LIMIT 1").get(thread.id));
    return { id: thread.id, mode: thread.mode, title: thread.title, projectId: thread.project_id, agentId: thread.agent_id, archived: Boolean(thread.archived), createdAt: thread.created_at, updatedAt: thread.updated_at, participants, approvals, questions, runs, running, messages: store.db.prepare('SELECT id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY seq').all(thread.id) };
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id/state', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const runs = expectRows<{ id: string; status: string }>(runStatusListSchema, store.db.prepare("SELECT id,status,error_code AS errorCode,wake_at AS wakeAt FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 20").all(thread.id), 'run_row_invalid');
    const questions = store.db.prepare("SELECT q.id,q.run_id AS runId,q.message_id AS messageId,q.status,q.created_at AS createdAt,q.answered_at AS answeredAt,q.answer_message_id AS answerMessageId FROM run_questions q JOIN runs r ON r.id=q.run_id WHERE r.thread_id=? ORDER BY q.created_at").all(thread.id);
    return { runs, questions, running: runs.some(run => ['queued','running','waiting_user','waiting_event'].includes(run.status)) };
  });
  app.post<{ Params: { id: string } }>('/api/v1/threads/:id/stop', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    return botService.stop(user.id, thread.id);
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id/runs', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    return { runs: botService.status(user.id, thread.id) };
  });
  app.post<{ Params: { id: string }; Body: { reaction?: string } }>('/api/v1/messages/:id/reactions', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const reaction = typeof request.body?.reaction === 'string' ? request.body.reaction.trim() : '';
    if (!/^(?:\p{Extended_Pictographic}|[+\-_*#]){1,8}$/u.test(reaction)) return bad(reply, 400, 'invalid_reaction');
    const message = store.db.prepare('SELECT m.id,m.thread_id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.owner_id=?').get(request.params.id, user.id) as { id: string; thread_id: string } | undefined;
    if (!message) return bad(reply, 404, 'message_not_found');
    const result = store.transaction(() => {
      const existing = store.db.prepare('SELECT 1 FROM message_reactions WHERE message_id=? AND user_id=? AND reaction=?').get(message.id, user.id, reaction);
      if (existing) { store.db.prepare('DELETE FROM message_reactions WHERE message_id=? AND user_id=? AND reaction=?').run(message.id, user.id, reaction); appendEvent(message.thread_id, 'message.reaction', { messageId: message.id, reaction, active: false }); return false; }
      store.db.prepare('INSERT INTO message_reactions(message_id,user_id,reaction,created_at) VALUES(?,?,?,?)').run(message.id, user.id, reaction, now());
      appendEvent(message.thread_id, 'message.reaction', { messageId: message.id, reaction, active: true });
      return true;
    });
    return { messageId: message.id, reaction, active: result };
  });

  app.get<{ Params: { id: string } }>('/api/v1/messages/:id/reactions', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const message = store.db.prepare('SELECT m.id FROM messages m JOIN threads t ON t.id=m.thread_id WHERE m.id=? AND t.owner_id=?').get(request.params.id, user.id) as { id: string } | undefined;
    if (!message) return bad(reply, 404, 'message_not_found');
    return { reactions: store.db.prepare('SELECT reaction,COUNT(*) AS count,MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine FROM message_reactions WHERE message_id=? GROUP BY reaction ORDER BY reaction').all(user.id, message.id) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/approvals/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const approval = expectRow<ApprovalProjectionRow>(approvalProjectionRowSchema, store.db.prepare('SELECT a.id,a.message_id AS messageId,a.thread_id AS threadId,a.run_id AS runId,a.status,a.created_at AS createdAt,a.resolved_at AS resolvedAt,a.resolution FROM approvals a JOIN threads t ON t.id=a.thread_id WHERE a.id=? AND t.owner_id=?').get(request.params.id, user.id), 'approval_row_invalid');
    if (!approval) return bad(reply, 404, 'approval_not_found');
    return approval;
  });
  app.post<{ Params: { id: string }; Body: { approved?: boolean; resolution?: string } }>('/api/v1/approvals/:id/resolve', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    if (typeof request.body?.approved !== 'boolean') return bad(reply, 400, 'invalid_approval_resolution');
    const resolution = typeof request.body.resolution === 'string' ? request.body.resolution.trim().slice(0, 2000) : '';
    const resolved = botService.resolve(user.id, request.params.id, request.body.approved, resolution);
    if ('error' in resolved) {
      const errorCode = resolved.error ?? 'approval_not_found';
      return bad(reply, errorCode === 'approval_not_found' ? 404 : 409, errorCode);
    }
    if (resolved.runId) runner.enqueue(resolved.runId);
    return resolved;
  });

  app.post<{ Body: { threadId?: string; mode?: ConversationMode } }>('/api/v1/runs', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.body?.threadId ?? '');
    if (!thread || (request.body?.mode && request.body.mode !== thread.mode)) return bad(reply, 404, 'thread_not_found');
    if (thread.archived) return bad(reply, 409, 'thread_archived');
    if (thread.project_id) projects.authorize(user.id, thread.project_id, thread.agent_id);
    const id = crypto.randomUUID(); const timestamp = now();
    store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(id, thread.id, thread.mode, 'queued', timestamp);
    if (thread.mode === 'bot') runner.enqueue(id);
    return reply.code(201).send({ id, threadId: thread.id, mode: thread.mode, status: 'queued', createdAt: timestamp, completedAt: null });
  });
  app.get<{ Params: { id: string } }>('/api/v1/runs/:id', async (request, reply) => { const user = requireAuth(request, reply); if (!user) return; const run = expectRow<RunRow>(runRowSchema, store.db.prepare('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(request.params.id, user.id), 'run_row_invalid'); if (!run) return bad(reply, 404, 'run_not_found'); return { id: run.id, threadId: run.thread_id, mode: run.mode, status: run.status, createdAt: run.created_at, startedAt: run.started_at ?? null, completedAt: run.completed_at ?? null, errorCode: run.error_code ?? null }; });
  app.post<{ Params: { id: string } }>('/api/v1/runs/:id/cancel', async (request, reply) => { if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user) return; return botService.cancelRun(user.id, request.params.id) ?? bad(reply, 404, 'run_not_found'); });

}
