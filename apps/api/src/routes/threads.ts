import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseBotAttachments, botMessageAdmissionError, botMessageAdmissionStatus } from '@wangke/contracts';
import type { ConversationMode, MessageRole } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import type { BotApplicationService } from '../agent/service.js';
import type { BotRunner } from '../agent/runner.js';
import type { ProjectRepository } from '../projects/repository.js';
import { sql, sqlFixed, sqlKeyword, sqlVariant } from '../storage/sql.js';
import { agentProfileRowSchema, expectRow, expectRows, messageRecordRowSchema, threadRowSchema, type AgentProfileRow, type MessageRecordRow, type ThreadRow } from '../storage/row-schema.js';

/** Bot 线程的目录、消息、快照、状态、停止、运行记录与发送入口。
 * 注册顺序与旧 server.ts 一致;发送入口的准入折叠(带 status 字段、
 * 折不出码才上抛)与幂等去重属于契约,原样保留。 */
export function registerThreadRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore;
  projects: ProjectRepository;
  botService: BotApplicationService;
  runner: BotRunner;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  bad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
  admissionBad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
  /** 已存在的默认 Agent 档案;只在创建 bot 线程时兜底。 */
  ensureDefaultAgent: (userId: string) => AgentProfileRow;
  messageKinds: ReadonlySet<string>;
}) {
  const { store, projects, botService, runner, requireAuth, checkOrigin, bad, admissionBad, ensureDefaultAgent, messageKinds } = deps;
  const now = () => new Date().toISOString();
  const idRowSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
  /** Agent 行只投影这五个字段;行在查询处已用 agentProfileRowSchema 收窄。 */
  function agentDto(row: Pick<AgentProfileRow, 'id' | 'name' | 'avatar' | 'role' | 'enabled'>) {
    return { id: row.id, name: row.name, avatar: row.avatar ?? null, role: row.role, enabled: Boolean(row.enabled) };
  }
  function ownedThread(userId: string, threadId: string) { return expectRow<ThreadRow>(threadRowSchema, store.db.prepare('SELECT * FROM threads WHERE id=? AND owner_id=?').get(threadId, userId), 'thread_row_invalid'); }
  const threadFields = sqlKeyword('id,mode,title,project_id AS projectId,agent_id AS agentId,archived,created_at AS createdAt,updated_at AS updatedAt');
  /** 只读线程摘要投影;`archived` 是 SQLite 的 0/1,由调用方转成布尔。 */
  type ThreadProjection = ThreadRow & { projectId: string | null; agentId: string | null; createdAt: string; updatedAt: string; preview?: string | null };
  /** 分页/全量列表共用的行形状:线程摘要 + 可选的最后一句话预览。 */
  const threadProjectionSchema = {
    type: 'object', additionalProperties: true,
    properties: { id: { type: 'string' }, mode: { type: 'string' }, title: { type: ['string', 'null'] }, projectId: { type: ['string', 'null'] },
      agentId: { type: ['string', 'null'] }, archived: { type: ['integer', 'boolean', 'null'] }, createdAt: { type: 'string' }, updatedAt: { type: 'string' }, preview: { type: ['string', 'null'] } },
    required: ['id', 'mode', 'createdAt', 'updatedAt'],
  } as const;
  /** 拍照式读取:只读线程摘要列并收窄行形状,summary/patch 两处共用同一语句。 */
  const threadSummary = (threadId: string) => expectRow<ThreadProjection>(threadProjectionSchema, store.db.prepare(sql`SELECT ${threadFields} FROM threads WHERE id=?`.sql).get(threadId), 'thread_row_invalid')!;
  app.get<{ Querystring: { projectId?: string; cursor?: string; limit?: string } }>('/api/v1/threads/page', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const { projectId, cursor } = request.query;
    if (projectId) projects.get(user.id, projectId);
    const limit = request.query.limit === undefined ? 50 : Number(request.query.limit);
    let before: { at: string; id: string } | undefined;
    if (cursor !== undefined) {
      try {
        if (cursor.length > 1000) throw new Error('invalid_cursor');
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (!value || typeof value.at !== 'string' || value.at.length > 100 || typeof value.id !== 'string' || !value.id || value.id.length > 200) throw new Error('invalid_cursor');
        before = value;
      } catch { return bad(reply, 400, 'invalid_thread_cursor'); }
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return bad(reply, 400, 'invalid_thread_cursor');
    const preview = sqlVariant("(SELECT substr(content,1,160) FROM messages WHERE thread_id=threads.id AND kind='text' ORDER BY seq DESC LIMIT 1) AS preview", 0);
    // 分页文本只随「有没有项目筛选 / 有没有游标」变化,两种都来自查询参数的存在性而非其内容;
    // 项目 id、游标三列与 limit 全部走绑定值。
    const pageQuery = sqlFixed(`SELECT ${threadFields.sql},${preview.sql} FROM threads WHERE owner_id=? AND mode='bot'
      AND ${projectId ? 'project_id=?' : 'project_id IS NULL'}`, projectId ? 2 : 1, [
      ...(before ? [sqlVariant('AND (updated_at<? OR (updated_at=? AND id>?))', 3)] : []),
      sqlVariant('ORDER BY updated_at DESC,id LIMIT ?', 1),
    ]);
    const rows = expectRows<ThreadProjection>(threadProjectionSchema,
      store.db.prepare(pageQuery.sql).all(user.id, ...(projectId ? [projectId] : []), ...(before ? [before.at, before.at, before.id] : []), limit + 1), 'thread_row_invalid');
    const page = rows.slice(0, limit), last = page.at(-1);
    return { threads: page.map(row => ({ ...row, archived: Boolean(row.archived) })), nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.updatedAt, id: last.id })).toString('base64url') : null };
  });
  app.get<{ Params: { id: string } }>('/api/v1/threads/:id/summary', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    return { ...threadSummary(thread.id), archived: Boolean(thread.archived) };
  });
  app.get<{ Querystring: { projectId?: string; agentId?: string } }>('/api/v1/threads', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const { projectId, agentId } = request.query;
    if (projectId) projects.get(user.id, projectId);
    if (agentId) projects.agent(user.id, agentId);
    // preview：最近一条文本消息，给会话列表显示「最后一句话」。走 messages(thread_id, seq) 唯一索引，每行一次索引查找。
    const preview = sqlVariant("(SELECT content FROM messages WHERE thread_id=threads.id AND kind='text' ORDER BY seq DESC LIMIT 1) AS preview", 0);
    // 两个筛选都只在其存在时追加,数量随存在性变化,值一律绑定。
    const listQuery = sqlFixed(`SELECT ${threadFields.sql},${preview.sql} FROM threads WHERE owner_id=?`, 1, [
      ...(projectId ? [sqlVariant('AND project_id=?', 1)] : []),
      ...(agentId ? [sqlVariant('AND agent_id=?', 1)] : []),
      sqlVariant('ORDER BY updated_at DESC,id'),
    ]);
    const rows = expectRows<ThreadProjection>(threadProjectionSchema, store.db.prepare(listQuery.sql).all(user.id, ...(projectId ? [projectId] : []), ...(agentId ? [agentId] : [])), 'thread_row_invalid');
    return { threads: rows.map(row => ({ ...row, archived: Boolean(row.archived), preview: typeof row.preview === 'string' ? row.preview.slice(0, 160) : null })) };
  });
  app.post<{ Body: { mode?: ConversationMode; title?: string; projectId?: string; agentId?: string } }>('/api/v1/threads', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    if (request.body?.mode !== 'chat' && request.body?.mode !== 'bot') return bad(reply, 400, 'invalid_mode');
    const projectId = request.body.projectId ?? null;
    if (projectId !== null && (typeof projectId !== 'string' || !projectId || request.body.mode !== 'bot')) return bad(reply, 400, 'invalid_project');
    const agentId = request.body.agentId ?? (request.body.mode === 'bot' ? ensureDefaultAgent(user.id).id : null);
    if (agentId !== null) projects.agent(user.id, agentId);
    if (projectId) projects.authorize(user.id, projectId, agentId);
    const id = crypto.randomUUID(); const timestamp = now(); const title = String(request.body.title ?? '').slice(0, 200) || null;
    store.transaction(() => {
      store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,project_id,agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id, user.id, request.body!.mode, title, projectId, agentId, timestamp, timestamp);
      if (request.body!.mode === 'bot') {
        store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(id, agentId, timestamp);
      }
    });
    return reply.code(201).send({ id, mode: request.body.mode, title, projectId, agentId, archived: false, createdAt: timestamp, updatedAt: timestamp });
  });
  app.patch<{ Params: { id: string }; Body: { title?: unknown; archived?: unknown } }>('/api/v1/threads/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    const body = request.body;
    if (!body || Object.keys(body).some(k => !['title', 'archived'].includes(k)) || (body.title !== undefined && (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200)) || (body.archived !== undefined && typeof body.archived !== 'boolean')) return bad(reply, 400, 'invalid_thread');
    store.db.prepare('UPDATE threads SET title=?,archived=?,updated_at=? WHERE id=?').run(body.title ?? thread.title, Number(body.archived ?? thread.archived), now(), thread.id);
    if (body.archived === true) {
      const runs = store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user')").all(thread.id) as Array<{ id: string }>;
      for (const run of runs) { store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=?").run(now(), run.id); runner.cancel(run.id); }
    }
    return { ...threadSummary(thread.id), archived: Boolean(body.archived ?? thread.archived) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/threads/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (runner.isThreadActive(thread.id) || store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user','paused')").get(thread.id) || store.db.prepare("SELECT 1 FROM cloud_tasks t JOIN runs r ON r.id=t.parent_run_id WHERE r.thread_id=? AND t.status IN ('queued','running','waiting_user')").get(thread.id)) return bad(reply, 409, 'thread_busy');
    store.transaction(() => {
      // Gateway study tasks keep a parent_run_id without cascading to runs;
      // remove those terminal child tasks before the thread's run history is
      // deleted, otherwise SQLite correctly rejects the thread deletion.
      store.db.prepare('DELETE FROM approvals WHERE thread_id=?').run(thread.id);
      store.db.prepare('DELETE FROM bot_operations WHERE step_id IN (SELECT id FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?))').run(thread.id);
      // Keep owner-level usage even after conversation deletion; deleting the
      // ledger here would allow a chat deletion to reset the daily budget.
      store.db.prepare('UPDATE bot_requests SET run_id=NULL,step_id=NULL WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread.id);
      store.db.prepare('DELETE FROM bot_artifacts WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread.id);
      store.db.prepare('DELETE FROM bot_summaries WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread.id);
      store.db.prepare('DELETE FROM cloud_tasks WHERE parent_run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread.id);
      store.db.prepare('DELETE FROM threads WHERE id=?').run(thread.id);
    });
    return { deleted: true };
   });
  app.post<{ Params: { id: string }; Body: { agentId?: string } }>('/api/v1/threads/:id/participants', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread || thread.mode !== 'bot') return bad(reply, 404, 'thread_not_found');
    if (thread.project_id) return bad(reply, 409, 'project_thread_single_agent');
    const agent = expectRow<AgentProfileRow>(agentProfileRowSchema, store.db.prepare('SELECT * FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(request.body?.agentId, user.id), 'agent_profile_row_invalid');
    if (!agent) return bad(reply, 404, 'agent_not_found');
    if ((expectRow<{ count: number }>({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, store.db.prepare('SELECT COUNT(*) AS count FROM thread_participants WHERE thread_id=?').get(thread.id), 'participant_count_invalid')?.count ?? 0) >= 8) return bad(reply, 409, 'participant_limit_reached');
    store.db.prepare('INSERT OR IGNORE INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(thread.id, agent.id, now());
    return agentDto(agent);
  });
  app.delete<{ Params: { id: string; agentId: string } }>('/api/v1/threads/:id/participants/:agentId', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (thread.project_id) return bad(reply, 409, 'project_thread_single_agent');
    const agent = store.db.prepare('SELECT id,name FROM agent_profiles WHERE id=? AND owner_id=?').get(request.params.agentId, user.id) as { id: string; name: string } | undefined;
    if (!agent) return bad(reply, 404, 'agent_not_found');
    const removed = store.db.prepare('DELETE FROM thread_participants WHERE thread_id=? AND agent_id=?').run(thread.id, agent.id);
    if (!removed.changes) return bad(reply, 404, 'participant_not_found');
    return { removed: true };
  });

  app.post<{ Params: { id: string }; Body: { clientNonce?: string; role?: MessageRole; kind?: string; content?: string; replyTo?: string; modelSelection?: import('@wangke/contracts/cloud').TaskModelSelection; target?: { kind?: string; runId?: string; questionId?: string } } }>('/api/v1/threads/:id/messages', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const thread = ownedThread(user.id, request.params.id); if (!thread) return bad(reply, 404, 'thread_not_found');
    if (thread.archived) return bad(reply, 409, 'thread_archived');
    if (thread.project_id) projects.authorize(user.id, thread.project_id, thread.agent_id);
    const b = request.body ?? {};
    const nonce = b.clientNonce;
    const kind = b.kind ?? 'text';
    // This endpoint accepts client-authored messages only. Server roles cannot be forged by a browser client.
    if (typeof nonce !== 'string' || nonce.length < 1 || nonce.length > 200 ||
        (b.role !== undefined && b.role !== 'user') || !messageKinds.has(kind) ||
        typeof b.content !== 'string' || b.content.length > 100000 ||
        (kind === 'attachment' && (() => {
          try {
            const parsed = parseBotAttachments(b.content);
            if (!parsed) return true;
            return parsed.files.some(value => {
              if (thread.project_id) {
                if (value.projectId !== thread.project_id || typeof value.projectPath !== 'string') return true;
                if (process.platform !== 'linux') projects.assertNoExecution(thread.project_id);
                const file = projects.files.open(thread.project_id, value.projectPath); fs.closeSync(file.fd); return false;
              }
              return typeof value.fileId !== 'string' || !store.db.prepare('SELECT 1 FROM files WHERE id=? AND owner_id=?').get(value.fileId, user.id);
            });
          } catch { return true; }
        })())) return bad(reply, 400, 'invalid_message');
    if (b.replyTo && !store.db.prepare('SELECT 1 FROM messages WHERE id=? AND thread_id=?').get(b.replyTo, thread.id)) return bad(reply, 400, 'invalid_reply_to');
    const makeDto = (row: MessageRecordRow, deduplicated = false) => ({ id: row.id, threadId: row.thread_id, clientNonce: row.client_nonce, seq: row.seq, role: row.role, kind: row.kind, content: row.content, replyTo: row.reply_to, createdAt: row.created_at, ...(deduplicated ? { deduplicated: true } : {}) });
    if (b.target !== undefined && (!b.target || !['run', 'question'].includes(b.target.kind ?? '') || (b.target.kind === 'run' ? typeof b.target.runId !== 'string' : typeof b.target.questionId !== 'string'))) return bad(reply, 400, 'invalid_target');
    try {
      const message = botService.send(user.id, thread.id, { clientNonce: nonce, kind, content: b.content!, replyTo: b.replyTo, modelSelection: b.modelSelection, target: b.target?.kind === 'run' ? { kind: 'run', runId: b.target.runId } : b.target?.kind === 'question' ? { kind: 'question', questionId: b.target.questionId } : undefined });
      if (thread.mode === 'bot') {
        // send() 的回执可能带 runId(同步入队);否则按触发消息找回。两者都只读 id,不存在就是没有 run。
        const receiptRunId = 'receipt' in message && message.receipt && typeof message.receipt === 'object' && 'runId' in message.receipt ? message.receipt.runId : undefined;
        const run = typeof receiptRunId === 'string' ? { id: receiptRunId } : expectRow<{ id: string }>(idRowSchema, store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id), 'run_row_invalid');
        if (run) runner.enqueue(run.id);
      }
      return reply.code(message.deduplicated ? 200 : 201).send(message);
    } catch (error: any) {
      // 准入类拒绝(含未配置模型)统一按契约折叠:具名错误类与旧式 message 码都要认,
      // 折不出码的才是真故障,原样上抛保持 500。
      const admission = botMessageAdmissionError(error, null);
      if (admission) return admissionBad(reply, botMessageAdmissionStatus(admission), admission);
      if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        const row = expectRow<MessageRecordRow>(messageRecordRowSchema, store.db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_nonce=?').get(thread.id, nonce), 'message_row_invalid');
        if (row) return makeDto(row, true);
      }
      throw error;
    }
  });

}
