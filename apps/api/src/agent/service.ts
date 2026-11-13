import crypto from 'node:crypto';
import fs from 'node:fs';
import { parseBotAttachments } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import type { BotRunner } from './runner.js';
import type { ProjectRepository } from '../projects/repository.js';
import type { TaskModelSelection } from '@wangke/contracts/cloud';
import { isDeepStrictEqual } from 'node:util';
import { validateTaskModelSelection } from './task-model.js';
const now = () => new Date().toISOString();
type AppendedMessage = { id: string; threadId: string; clientNonce: string | null; seq: number; role: string; kind: string; content: string; replyTo: string | null; createdAt: string };
/** Shared, owner-scoped entry point for Web and IM. No synthetic HTTP credentials. */
export class BotApplicationService {
  constructor(readonly store: DatabaseStore, readonly runner: BotRunner, private readonly projects?: ProjectRepository) {}
  thread(owner: string, id: string): any {
    const row = this.store.db.prepare('SELECT * FROM threads WHERE id=? AND owner_id=?').get(id, owner);
    if (!row) throw new Error('thread_not_found');
    return row;
  }
  create(owner: string, mode: 'bot' | 'chat', title: string | null, agent?: string) {
    return this.store.transaction(() => {
      if (agent && !this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=? AND enabled=1').get(agent, owner)) throw new Error('agent_not_found');
      const id = crypto.randomUUID(), timestamp = now();
      this.store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,agent_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, owner, mode, title, agent ?? null, timestamp, timestamp);
      if (agent) this.store.db.prepare('INSERT INTO thread_participants(thread_id,agent_id,joined_at) VALUES(?,?,?)').run(id, agent, timestamp);
      return { id, mode, title, createdAt: timestamp, updatedAt: timestamp };
    });
  }
  append(threadId: string, role: string, kind: string, content: string, nonce: string | null = null, replyTo: string | null = null) {
    return this.store.transaction(() => {
    if (nonce) {
      const saved = this.store.db.prepare('SELECT id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt FROM messages WHERE thread_id=? AND client_nonce=?').get(threadId, nonce) as AppendedMessage | undefined;
      if (saved) return saved;
    }
    const seq = (this.store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE thread_id=?').get(threadId) as any).seq;
    const id = crypto.randomUUID(), timestamp = now();
    const dto = { id, threadId, clientNonce: nonce, seq, role, kind, content, replyTo, createdAt: timestamp };
    this.store.db.prepare('INSERT INTO messages(id,thread_id,client_nonce,seq,role,kind,content,reply_to,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id, threadId, nonce, seq, role, kind, content, replyTo, timestamp);
    this.store.db.prepare('INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), threadId, seq, 'message.accepted', JSON.stringify(dto), timestamp);
    this.store.db.prepare('UPDATE threads SET updated_at=? WHERE id=?').run(timestamp, threadId);
    return dto;
    });
  }
  send(owner: string, threadId: string, input: { clientNonce: string; kind?: string; content: string; replyTo?: string; modelSelection?: TaskModelSelection; target?: { kind: 'run' | 'question'; runId?: string; questionId?: string } }) {
    const thread = this.thread(owner, threadId);
    if (thread.archived) throw new Error('thread_archived');
    if (thread.project_id) {
      if (!this.projects) throw new Error('project_access_denied');
      this.projects.authorize(owner, thread.project_id, thread.agent_id);
    }
    if (!input.clientNonce || input.clientNonce.length > 200 || typeof input.content !== 'string' || input.content.length > 100000) throw new Error('invalid_message');
    const acceptedCommand = { kind: input.kind ?? 'text', content: input.content, replyTo: input.replyTo ?? null, modelSelection: validateTaskModelSelection(input.modelSelection) ?? null, target: input.target ?? null };
    if (input.kind === 'attachment') {
      const parsed = parseBotAttachments(input.content);
      if (!parsed) throw new Error('invalid_message');
      for (const attachment of parsed.files) if (thread.project_id) {
        if (attachment.projectId !== thread.project_id || typeof attachment.projectPath !== 'string') throw new Error('invalid_message');
        if (process.platform !== 'linux') this.projects!.assertNoExecution(thread.project_id);
        const file = this.projects!.files.open(thread.project_id, attachment.projectPath); fs.closeSync(file.fd);
      } else if (!attachment.fileId || !this.store.db.prepare('SELECT 1 FROM files WHERE id=? AND owner_id=?').get(attachment.fileId, owner)) throw new Error('invalid_message');
    }
    const message = this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT * FROM messages WHERE thread_id=? AND client_nonce=?').get(threadId, input.clientNonce) as any;
      if (old) {
        if (old.task_command ? !isDeepStrictEqual(JSON.parse(old.task_command), acceptedCommand) : old.content !== input.content || old.kind !== acceptedCommand.kind || (old.reply_to ?? null) !== acceptedCommand.replyTo || acceptedCommand.modelSelection !== null || acceptedCommand.target !== null) throw new Error('message_nonce_conflict');
        const run = this.store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=? UNION SELECT run_id AS id FROM run_inputs WHERE message_id=?').get(old.id, old.id) as { id: string } | undefined;
        return { id: old.id, threadId, clientNonce: old.client_nonce, seq: old.seq, role: old.role, kind: old.kind, content: old.content, replyTo: old.reply_to, createdAt: old.created_at, deduplicated: true, ...(run ? { receipt: { messageId: old.id, runId: run.id, disposition: 'deduplicated' } } : {}) };
      }
      const dto = this.append(threadId, 'user', input.kind ?? 'text', input.content, input.clientNonce, input.replyTo ?? null);
      this.store.db.prepare('UPDATE messages SET task_command=? WHERE id=?').run(JSON.stringify(acceptedCommand), dto.id);
      if (thread.mode === 'bot') {
        const requested = new Set(Array.from(input.content.matchAll(/@([^\s@,，。！？!?]{1,64})/g), m => m[1].toLocaleLowerCase()));
        const agents = this.store.db.prepare('SELECT a.id,a.name FROM agent_profiles a JOIN thread_participants p ON p.agent_id=a.id WHERE p.thread_id=? AND a.enabled=1').all(threadId) as any[];
        for (const a of agents) if (requested.has(a.name.toLocaleLowerCase())) this.store.db.prepare('INSERT OR IGNORE INTO message_mentions(message_id,agent_id,created_at) VALUES(?,?,?)').run(dto.id, a.id, dto.createdAt);
        let targetRun: any;
        if (input.target?.kind === 'run') targetRun = this.store.db.prepare("SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND r.thread_id=? AND t.owner_id=?").get(input.target.runId, threadId, owner);
        else if (input.target?.kind === 'question') targetRun = this.store.db.prepare("SELECT r.* FROM run_questions q JOIN runs r ON r.id=q.run_id JOIN threads t ON t.id=r.thread_id WHERE q.id=? AND q.status='pending' AND r.thread_id=? AND t.owner_id=?").get(input.target.questionId, threadId, owner);
        else if (input.replyTo) targetRun = this.store.db.prepare("SELECT r.* FROM runs r JOIN messages m ON m.id=r.trigger_message_id WHERE m.id=? AND r.thread_id=? AND r.status IN ('queued','running','waiting_user','waiting_event') UNION SELECT r.* FROM run_questions q JOIN runs r ON r.id=q.run_id WHERE q.message_id=? AND r.thread_id=? AND q.status='pending'").get(input.replyTo, threadId, input.replyTo, threadId);
        if (input.target && (!targetRun || ['completed', 'failed', 'cancelled'].includes(targetRun.status))) throw new Error('target_expired');
        if (targetRun) {
          if (acceptedCommand.modelSelection) throw new Error('task_model_requires_new_attempt');
          if (targetRun.status === 'waiting_user' && input.target?.kind === 'run') throw new Error('target_waiting_for_specific_answer');
          this.store.db.prepare('INSERT INTO run_inputs(message_id,run_id,source_seq,created_at) VALUES(?,?,?,?)').run(dto.id, targetRun.id, dto.seq, dto.createdAt);
           if (input.target?.kind === 'question') {
            const changed = this.store.db.prepare("UPDATE run_questions SET status='answered',answer_message_id=?,answered_at=? WHERE id=? AND status='pending'").run(dto.id, dto.createdAt, input.target.questionId);
            if (!changed.changes) throw new Error('question_already_answered');
             this.store.db.prepare("UPDATE runs SET status='queued',completed_at=NULL,error_code=NULL WHERE id=? AND status='waiting_user'").run(targetRun.id);
           } else if (targetRun.status === 'waiting_event') {
             // An explicit user supplement is a durable wake signal. The
             // outstanding wait remains recorded and will later inject its
             // terminal result into the current context; it must not erase
             // this newly accepted input or revive a cancelled run.
             this.store.db.prepare("UPDATE runs SET status='queued',completed_at=NULL,error_code=NULL WHERE id=? AND status='waiting_event'").run(targetRun.id);
           }
          return { ...dto, deduplicated: false, receipt: { messageId: dto.id, runId: targetRun.id, disposition: input.target?.kind === 'question' ? 'answered' : 'appended' } };
        }
         const runId = crypto.randomUUID();
         this.store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at,trigger_message_id) VALUES(?,?,?,?,?,?)').run(runId, threadId, 'bot', 'queued', dto.createdAt, dto.id);
         try {
           this.runner.freezeModel(runId, owner, input.modelSelection, thread.default_model ? JSON.parse(thread.default_model) : undefined);
         } catch (error) {
           // 还没配模型时不要在发消息这一步把整条消息打回 500:消息已经接受了,
           // 让 runner 在真正执行冻结时抛 model_not_configured,失败记进 runs.error_code。
           if (!(error instanceof Error) || error.message !== 'model_not_configured') throw error;
         }
        return { ...dto, deduplicated: false, receipt: { messageId: dto.id, runId, disposition: 'created' } };
      }
      return { ...dto, deduplicated: false };
    });
    this.runner.enqueue(); return message;
  }
  stop(owner: string, threadId: string) {
    this.thread(owner, threadId);
    const runs = this.store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND (status IN ('queued','running','waiting_user','waiting_event','paused') OR id IN (SELECT parent_run_id FROM cloud_tasks WHERE status IN ('queued','running','waiting_user')))").all(threadId) as any[];
    this.store.transaction(() => {
      this.store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE thread_id=? AND status IN ('queued','running','waiting_user','waiting_event','paused')").run(now(), threadId);
      if (runs.length) this.append(threadId, 'assistant', 'text', '任务已停止。');
    });
    for (const run of runs) this.runner.cancel(run.id);
    return { stopped: runs.length };
  }
  resolve(owner: string, id: string, approved: boolean, resolution = '', exactThread?: string): any {
    const result = this.store.transaction(() => {
      const a = this.store.db.prepare('SELECT a.* FROM approvals a JOIN threads t ON t.id=a.thread_id WHERE a.id=? AND t.owner_id=?').get(id, owner) as any;
      if (!a || (exactThread && a.thread_id !== exactThread)) return { error: 'approval_not_found' };
      if (a.status !== 'pending') {
        // Project/grant revocation cancels pending Bot work defensively. A
        // racing UI approval may arrive after that cancellation; acknowledge
        // this specific terminal state without reviving or approving it.
        if (a.status === 'rejected' && a.resolution === 'Run cancelled') return { id, messageId: a.message_id, threadId: a.thread_id, runId: a.run_id ?? null, status: a.status, createdAt: a.created_at, resolvedAt: a.resolved_at, resolution: a.resolution };
        return { error: 'approval_already_resolved' };
      }
      const status = approved ? 'approved' : 'rejected', timestamp = now();
      this.store.db.prepare('UPDATE approvals SET status=?,resolved_at=?,resolution=? WHERE id=? AND status=\'pending\'').run(status, timestamp, resolution || null, id);
      if (a.cloud_permission_id) this.store.db.prepare("UPDATE cloud_permissions SET status=?,resolved_at=? WHERE id=? AND owner_id=? AND status='pending'").run(status, timestamp, a.cloud_permission_id, owner);
      const run = (a.cloud_permission_id ? null : a.run_id ? this.store.db.prepare("SELECT id FROM runs WHERE id=? AND status='waiting_user'").get(a.run_id) : this.store.db.prepare("SELECT id FROM runs WHERE thread_id=? AND status='waiting_user' ORDER BY created_at DESC LIMIT 1").get(a.thread_id)) as any;
      if (run) {
        this.append(a.thread_id, 'user', 'text', `Approval ${status}: ${resolution || status}`, `approval:${id}:${status}`, a.message_id);
        this.store.db.prepare("UPDATE runs SET status='queued',completed_at=NULL,error_code=NULL WHERE id=? AND status='waiting_user'").run(run.id);
      }
      return { id, messageId: a.message_id, threadId: a.thread_id, runId: a.run_id ?? run?.id ?? null, status, createdAt: a.created_at, resolvedAt: timestamp, resolution: resolution || null };
    });
    this.runner.enqueue(); return result;
  }
  status(owner: string, threadId: string) {
    this.thread(owner, threadId);
    return this.store.db.prepare('SELECT id,status,step_count AS stepCount,wake_at AS wakeAt,error_code AS errorCode FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 50').all(threadId);
  }
  cancelRun(owner: string, id: string): any {
    const row = this.store.db.prepare('SELECT r.* FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(id, owner) as any;
    if (!row) return null;
    this.store.transaction(() => {
      const changed = this.store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=? AND status NOT IN ('completed','failed','cancelled')").run(now(), id);
       if (changed.changes) this.append(row.thread_id, 'assistant', 'text', '任务已取消。');
    });
    this.runner.cancel(id);
    const updated = this.store.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as any;
    return { id, threadId: updated.thread_id, mode: updated.mode, status: updated.status, createdAt: updated.created_at, startedAt: updated.started_at ?? null, completedAt: updated.completed_at ?? null, errorCode: updated.error_code ?? null };
  }
}
