import crypto from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteError, type PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import type { ExecutorDomain } from '@wangke/remote-host';
import type { ExecutorCompletion, ExecutorReport, ExecutorCompletionReceipt, RuntimeReceipt, RuntimeTask } from '@wangke/contracts/client-runtime';
import type { DatabaseStore } from '../storage/database.js';
import { workerTokens, workerTokenHash } from '../cloud/workerAuth.js';
import { taskDto } from '../cloud/tasks.js';
import type { ExecutorArtifacts, RuntimeRecordsReceipt } from '@wangke/contracts/client-runtime';
import { CloudRecords, CloudConflict } from '../cloud/records.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { ExecutorResourceCommand } from '@wangke/contracts/client-runtime';
import type { ResourceFiles } from '../projects/resources.js';
import { executeResourceCommand } from './resources.js';
import { taskProductMutations } from './task-products.js';
import { taskFilePermit } from './task-file-permit.js';
import type { ExecutorBlobAdmission, RuntimeJson } from '@wangke/contracts/client-runtime';
import type { ExecutorConversationReset, ExecutorConversationResetReceipt, LearningMessage, ExecutorInteraction, ExecutorInteractionsFrame, ExecutorInteractionDelivery, ExecutorInteractionReceipt } from '@wangke/contracts/client-runtime';
import { watchInteractionWake } from '../cloud/interaction-wake.js';
import type { ExecutorAuthorizationFrame } from '@wangke/contracts/client-runtime';
import { inspectInteraction, noteInteractionEffect } from './interaction-recovery.js';

export class ExecutorRuntimeDomain implements ExecutorDomain {
  private readonly peers = new WeakMap<PeerScope, string>();
  constructor(private readonly store: DatabaseStore, private readonly configuration: CloudConfiguration, private readonly leaseMs = 30000, private readonly resources?: ResourceFiles) {}
  admit(peer: PeerScope, token: string) { this.peers.set(peer, token); }
  private identity(ctx: Context, taskId: string) {
    const peer = ctx.invocation?.peer, token = peer && !peer.signal.aborted && this.peers.get(peer);
    const worker = token && workerTokens.get(token);
    if (!worker || worker.expiresAt <= Date.now() || worker.taskId !== taskId) throw new RemoteError('client/forbidden', 'Executor task capability unavailable', {});
    return { worker, hash: workerTokenHash(token) };
  }
  private active(ctx: Context, taskId: string) {
    const identity = this.identity(ctx, taskId);
    const task = this.store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND id=?').get(identity.worker.id, taskId) as any;
    if (!task || task.worker_id !== identity.hash || !['running', 'waiting_user'].includes(task.status) || !Number.isFinite(Date.parse(task.lease_expires_at)) || Date.parse(task.lease_expires_at) <= Date.now()) throw new RemoteError('client/domain', 'Executor lease expired', { code: 'worker_lease_expired' });
    if (task.parent_run_id && this.store.db.prepare("SELECT 1 FROM runs WHERE id=? AND status IN ('cancelled','failed','paused')").get(task.parent_run_id)) throw new RemoteError('client/forbidden', 'Parent task inactive', {});
    if (['qa', 'artifactEdit'].includes(task.kind) && this.configuration.taskPolicy(identity.worker.id, task.id).read === 'deny') throw new RemoteError('client/forbidden', 'Task read permission revoked', {});
    return { ...identity, task };
  }
  async read(ctx: Context, taskId: string): Promise<RuntimeTask> {
    const { task } = this.active(ctx, taskId);
    if (task.kind === 'chat' && JSON.parse(task.input).action !== 'resumeInteraction' && this.store.db.prepare(`SELECT 1 FROM cloud_task_commands c JOIN executor_interaction_recovery r ON r.command_id=c.id WHERE c.task_id=? AND c.consumed=0 AND r.phase IN ('started','executing','uncertain')`).get(taskId)) throw new RemoteError('client/conflict', 'executor_interaction_requires_reconciliation', {});
    return taskDto(task) as RuntimeTask;
  }
  /** A server-side fence survives both page and host death. A lost admission is
   * uncertain, not permission to invoke a model/tool a second time. */
  async beginExecution(ctx: Context, taskId: string): Promise<RuntimeJson> {
    return this.store.transaction(() => {
      const { worker, hash, task } = this.active(ctx, taskId);
      if (!['qa', 'artifactEdit'].includes(task.kind)) throw new RemoteError('client/forbidden', 'Execution fence task denied', {});
      const input = JSON.parse(task.input), records = new CloudRecords(this.store);
      if (task.kind === 'qa') {
        const session = records.get(worker.id, 'chatSessions', input.sessionId);
        if (task.resource !== `session:${input.sessionId}` || !session || session.videoId !== input.videoId || !records.get(worker.id, 'videos', input.videoId)) throw new RemoteError('client/forbidden', 'QA scope denied', {});
      }
      if (task.parent_run_id && this.configuration.taskPolicy(worker.id, taskId).read !== 'allow' || this.configuration.taskPolicy(worker.id, taskId).read === 'deny') throw new RemoteError('client/forbidden', 'Task read permission denied', {});
      const operationId = `executor-execution-${taskId}`;
      if (this.store.db.prepare('SELECT 1 FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, operationId)) return { phase: 'uncertain' };
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)").run(worker.id, operationId, this.binding(taskId, hash) + 'execution', JSON.stringify({ taskId, kind: task.kind, resource: task.resource, phase: 'started' }));
      return { phase: 'admitted' };
    });
  }
  async *watchAuthorization(ctx: Context, taskId: string, permissionId: string, signal: AbortSignal): AsyncIterable<ExecutorAuthorizationFrame> {
    let wake: (() => void) | undefined, dirty = true, previous: string | undefined;
    const notify = () => { dirty = true; wake?.(); }, off = watchInteractionWake(this.store, taskId, notify);
    signal.addEventListener('abort', notify);
    try {
      while (!signal.aborted) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || signal.aborted) resolve(); });
        wake = undefined; dirty = false;
        if (signal.aborted) break;
        const { worker } = this.active(ctx, taskId);
        const row = this.store.db.prepare('SELECT status FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=?').get(permissionId, worker.id, taskId) as { status: ExecutorAuthorizationFrame['status'] } | undefined;
        if (!row) throw new RemoteError('client/forbidden', 'Permission task scope denied', {});
        if (row.status !== previous) { previous = row.status; yield { permissionId, status: row.status }; }
        if (row.status !== 'pending') return;
      }
    } finally { off(); signal.removeEventListener('abort', notify); }
  }
  async resetConversation(ctx: Context, request: ExecutorConversationReset): Promise<ExecutorConversationResetReceipt> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId)) throw new RemoteError('gateway/bad-request', 'Invalid reset identity', {});
    const { worker, hash } = this.identity(ctx, request.taskId);
    const digest = this.binding(request.taskId, hash) + 'reset:' + JSON.stringify(request);
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT digest,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, request.operationId) as any;
      if (old) {
        if (old.digest !== digest) throw new RemoteError('client/conflict', 'Reset identity changed', {});
        return JSON.parse(old.result);
      }
      const { task } = this.active(ctx, request.taskId), input = JSON.parse(task.input);
      if (task.kind !== 'chat' || !['continue', 'retry'].includes(input.action) || task.resource !== `session:${input.sessionId}` || !Number.isSafeInteger(input.rowId)) throw new RemoteError('client/forbidden', 'Chat reset task scope denied', {});
      if (request.mode !== input.action) throw new RemoteError('client/forbidden', 'Reset mode differs from admitted action', {});
      // One reset per task, even if a caller invents another operation id.
      const prior = this.store.db.prepare('SELECT result FROM client_commands WHERE owner_id=? AND digest LIKE ?').get(worker.id, this.binding(task.id, hash) + 'reset:%') as any;
      if (prior) throw new RemoteError('client/conflict', 'Task result already reset', {});
      const records = new CloudRecords(this.store), session = records.get(worker.id, 'chatSessions', input.sessionId);
      const rows = (this.store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt'),json_extract(value,'$.id')").all(worker.id, input.sessionId) as { value: string }[]).map(row => JSON.parse(row.value) as LearningMessage);
      const index = rows.findIndex(row => row.id === input.rowId), target = rows[index];
      if (!session || !target || target.sessionId !== input.sessionId || target.videoId !== session.videoId || index !== rows.length - 1 && !(target.role === 'user' && index === rows.length - 2)) throw new RemoteError('client/forbidden', 'Only the admitted terminal result may reset', {});
      const user = target.role === 'user' ? target : rows.slice(0, index).reverse().find(row => row.role === 'user');
      if (!user || user.role !== 'user') throw new RemoteError('client/forbidden', 'Original question missing', {});
      const removed = request.mode === 'retry' ? rows.slice(rows.indexOf(user)) : [];
      if (request.mode === 'continue' && (target.role !== 'assistant' || !target.interrupted)) throw new RemoteError('client/forbidden', 'Result is not interrupted', {});
      if (request.mode === 'retry') {
        const permit = request.permissionId && this.store.db.prepare("SELECT arguments FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability='write' AND status='consumed'").get(request.permissionId, worker.id, task.id) as { arguments: string } | undefined;
        if (!permit || this.configuration.taskPolicy(worker.id, task.id).write === 'deny' || permit.arguments !== JSON.stringify({ tool: 'reset_chat_result', sessionId: input.sessionId, rowId: input.rowId, mode: 'retry' })) throw new RemoteError('client/forbidden', 'Exact reset permission required', {});
        records.apply(worker.id, removed.map(row => ({ id: `${request.operationId}:${row.id}`, table: 'chats', key: row.id, before: row as any, after: null })));
        this.store.db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND status='consumed'").run(request.permissionId);
      }
      const result: ExecutorConversationResetReceipt = { mode: request.mode, sessionId: input.sessionId, target, user, removed };
      // Original rows, attachments, tool traces and snapshots stay in this receipt.
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?)").run(worker.id, request.operationId, digest, JSON.stringify(result));
      return result;
    });
  }
  async *watchInteractions(ctx: Context, taskId: string, signal: AbortSignal): AsyncIterable<ExecutorInteractionsFrame> {
    const initial = this.active(ctx, taskId);
    if (initial.task.kind !== 'chat') throw new RemoteError('client/forbidden', 'Interactions require a chat task', {});
    let wake: (() => void) | undefined, dirty = true, cursor = 0, baseline = true;
    const notify = () => { dirty = true; wake?.(); };
    const off = watchInteractionWake(this.store, taskId, notify);
    signal.addEventListener('abort', notify);
    try {
      while (!signal.aborted) {
        if (!dirty) await new Promise<void>(resolve => { wake = resolve; if (dirty || signal.aborted) resolve(); });
        wake = undefined; dirty = false;
        if (signal.aborted) break;
        const { worker, task } = this.active(ctx, taskId);
        const rows = this.store.db.prepare(`SELECT c.id,c.nonce,c.action,c.value,t.target FROM cloud_task_commands c JOIN executor_interaction_targets t ON t.command_id=c.id WHERE c.task_id=? AND c.consumed=0 AND c.id>? ORDER BY c.id LIMIT 64`).all(taskId, cursor) as any[];
        const commands: ExecutorInteraction[] = rows.map(row => {
          const recovery = this.store.db.prepare('SELECT attempt FROM executor_interaction_recovery WHERE command_id=?').get(row.id) as any;
          return { sequence: row.id, nonce: row.nonce, action: row.action, value: JSON.parse(row.value), target: row.target, ...(recovery?.attempt ? { attempt: recovery.attempt } : {}) };
        });
        if (rows.length) cursor = rows.at(-1).id;
        // Recheck exact credential/task/lease before every payload, never account Cookie.
        if (worker.taskId !== task.id) throw new RemoteError('client/forbidden', 'Interaction scope changed', {});
        if (baseline || rows.length) yield { type: baseline ? 'baseline' : 'commands', taskId, cursor, commands };
        baseline = false;
        if (rows.length === 64) dirty = true;
      }
    } finally { off(); signal.removeEventListener('abort', notify); }
  }
  async deliverInteraction(ctx: Context, request: ExecutorInteractionDelivery): Promise<ExecutorInteractionReceipt> {
    const { worker, hash } = this.identity(ctx, request.taskId);
    if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) throw new RemoteError('gateway/bad-request', 'Invalid interaction sequence', {});
    const operationId = `executor-interaction-${request.taskId}-${request.sequence}`, digest = this.binding(request.taskId, hash) + `interaction:${request.sequence}`;
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, operationId) as any;
      const recovery = this.store.db.prepare('SELECT phase FROM executor_interaction_recovery WHERE command_id=?').get(request.sequence) as any;
      const { task } = this.active(ctx, request.taskId);
      const resuming = recovery?.phase === 'resumable' && JSON.parse(task.input).interactionSequence === request.sequence;
      if (old && old.digest !== digest && !resuming) throw new RemoteError('client/forbidden', 'Interaction belongs to another lease', {});
      if (old?.status === 'completed') return JSON.parse(old.result);
      const command = this.store.db.prepare('SELECT c.id,c.action,t.target FROM cloud_task_commands c JOIN executor_interaction_targets t ON t.command_id=c.id WHERE c.id=? AND c.task_id=?').get(request.sequence, task.id) as any;
      if (task.kind !== 'chat' || !command) throw new RemoteError('client/forbidden', 'Interaction task denied', {});
      if (request.phase === 'begin') {
        if (old && !resuming) return JSON.parse(old.result);
        const first = this.store.db.prepare('SELECT MIN(id) AS id FROM cloud_task_commands WHERE task_id=? AND consumed=0').get(task.id) as any;
        const view = JSON.parse(task.progress ?? '{}').view;
        const target = command.action === 'answerAsk' ? view?.pendingAsk?.messageKey : view?.pendingPlan?.messageKey;
        if (first.id !== request.sequence || target !== command.target) throw new RemoteError('client/conflict', 'Interaction baseline is not ready', {});
        const result: ExecutorInteractionReceipt = { sequence: request.sequence, phase: 'started' };
        const rowId = /^row:(\d+)$/.exec(command.target);
        const snapshot = rowId && new CloudRecords(this.store).get(worker.id, 'chats', Number(rowId[1]));
        if (!snapshot || snapshot.sessionId !== JSON.parse(task.input).sessionId) throw new RemoteError('client/forbidden', 'Interaction snapshot missing', {});
        if (resuming) {
          this.store.db.prepare("UPDATE client_commands SET digest=?,status='pending',result=? WHERE owner_id=? AND operation_id=?").run(digest, JSON.stringify(result), worker.id, operationId);
          this.store.db.prepare("UPDATE executor_interaction_recovery SET phase='started' WHERE command_id=?").run(request.sequence);
        } else {
          this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)").run(worker.id, operationId, digest, JSON.stringify(result));
          this.store.db.prepare("INSERT INTO executor_interaction_recovery(command_id,snapshot,phase) VALUES(?,?,'started')").run(request.sequence, JSON.stringify(snapshot));
        }
        return result;
      }
      if (!old) throw new RemoteError('client/conflict', 'Interaction not begun', {});
      if (request.phase === 'executing') {
        if (recovery?.phase !== 'started') throw new RemoteError('client/conflict', 'Interaction already dispatched', {});
        this.store.db.prepare("UPDATE executor_interaction_recovery SET phase='executing' WHERE command_id=?").run(request.sequence);
        return { sequence: request.sequence, phase: 'started' };
      }
      if (request.phase === 'applied' && inspectInteraction(this.store, worker.id, task.id, request.sequence).disposition !== 'applied') throw new RemoteError('client/conflict', 'Committed interaction effect receipt required', {});
      const result: ExecutorInteractionReceipt = { sequence: request.sequence, phase: request.phase };
      this.store.db.prepare('UPDATE executor_interaction_recovery SET phase=? WHERE command_id=?').run(request.phase, request.sequence);
      this.store.db.prepare("UPDATE client_commands SET status=?,result=? WHERE owner_id=? AND operation_id=?").run(request.phase === 'uncertain' ? 'pending' : 'completed', JSON.stringify(result), worker.id, operationId);
      if (request.phase !== 'uncertain') this.store.db.prepare('UPDATE cloud_task_commands SET consumed=1 WHERE id=?').run(request.sequence);
      return result;
    });
  }
  async admitBlob(ctx: Context, request: ExecutorBlobAdmission): Promise<RuntimeJson> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId) || !/^[a-f0-9]{64}$/.test(request.sha256) || !Number.isSafeInteger(request.size) || request.size < 1 || request.contentType.length > 200) throw new RemoteError('gateway/bad-request', 'Invalid product blob', {});
    const { worker, hash } = this.identity(ctx, request.taskId);
    const digest = this.binding(request.taskId, hash) + 'blob:' + crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT digest,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, request.operationId) as { digest: string; result: string } | undefined;
      if (old) { if (old.digest !== digest) throw new RemoteError('client/conflict', 'Blob content or lease changed', {}); return JSON.parse(old.result); }
      const { task } = this.active(ctx, request.taskId);
      if (!['cover', 'handout', 'handoutEdit', 'transcribe', 'material', 'chat', 'qa'].includes(task.kind) || task.parent_run_id && this.configuration.taskPolicy(worker.id, task.id).write !== 'allow') throw new RemoteError('client/forbidden', 'Product blob task denied', {});
      const input = JSON.parse(task.input), records = new CloudRecords(this.store);
      if (['chat', 'qa'].includes(task.kind)) {
        if (!Number.isSafeInteger(input.sessionId) || task.resource !== `session:${input.sessionId}` || !records.get(worker.id, 'chatSessions', input.sessionId)) throw new RemoteError('client/forbidden', 'Product blob session denied', {});
      } else {
        const course = typeof input.videoId === 'string' && records.get(worker.id, 'videos', input.videoId);
        if (!course || course.fileDeleted || task.resource !== `course:${input.videoId}`) throw new RemoteError('client/forbidden', 'Product blob course denied', {});
        if (task.kind === 'cover' && !['image/png', 'image/jpeg', 'image/webp'].includes(request.contentType)) throw new RemoteError('client/forbidden', 'Cover blob media denied', {});
      }
      const value = { operation: { kind: 'executorProductBlob', ...request }, phase: 'admitted' };
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)").run(worker.id, request.operationId, digest, JSON.stringify(value));
      return value;
    });
  }
  async resourceCommand(ctx: Context, request: ExecutorResourceCommand) {
    const identity = this.identity(ctx, request.taskId);
    if (this.resources && this.store.db.prepare('SELECT 1 FROM client_commands WHERE owner_id=? AND operation_id=?').get(identity.worker.id, request.operationId)) {
      return executeResourceCommand(this.resources, identity.worker.id, request, this.binding(request.taskId, identity.hash));
    }
    const { worker, hash, task } = this.active(ctx, request.taskId);
    if (!this.resources || !['chat', 'qa'].includes(task.kind) || !['saveMarkdown', 'organizeCourses'].includes(request.operation.kind)) throw new RemoteError('client/forbidden', 'Unsupported task file operation', {});
    const permit = this.store.db.prepare("SELECT arguments FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability='write' AND status='consumed'").get(request.permissionId, worker.id, task.id) as { arguments: string } | undefined;
    if (!permit || this.configuration.taskPolicy(worker.id, task.id).write === 'deny' || !taskFilePermit(new CloudRecords(this.store), worker.id, task.input, request.operation, permit.arguments)) throw new RemoteError('client/forbidden', 'Task file permission required', {});
    noteInteractionEffect(this.store, worker.id, task.id, request.operationId, 'resource', undefined, request.operation);
    return executeResourceCommand(this.resources, worker.id, request, this.binding(task.id, hash));
  }
  async commitArtifacts(ctx: Context, request: ExecutorArtifacts): Promise<RuntimeRecordsReceipt> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId) || !request.products.length || request.products.length > 20000) throw new RemoteError('gateway/bad-request', 'Invalid artifact transaction', {});
    const { worker, hash } = this.identity(ctx, request.taskId);
    const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
    const digest = this.binding(request.taskId, hash) + 'artifacts:' + crypto.createHash('sha256').update(canonical(request.products)).digest('hex');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT digest,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, request.operationId) as { digest: string; result: string } | undefined;
      if (old) {
        if (old.digest !== digest) throw new RemoteError('client/conflict', 'Artifact content or lease changed', {});
        return JSON.parse(old.result);
      }
      const { task } = this.active(ctx, request.taskId);
      if (task.parent_run_id && this.configuration.taskPolicy(worker.id, task.id).write !== 'allow') throw new RemoteError('client/forbidden', 'Parent write permission required', {});
      const records = new CloudRecords(this.store);
      let result: RuntimeRecordsReceipt;
      const reset = this.store.db.prepare("SELECT result FROM client_commands WHERE owner_id=? AND digest LIKE ? AND status='completed'").get(worker.id, this.binding(task.id, hash) + 'reset:%') as { result: string } | undefined;
      const continuation = reset && JSON.parse(reset.result) as ExecutorConversationResetReceipt | undefined;
      try { result = records.apply(worker.id, taskProductMutations(records, worker.id, task, request.products, continuation?.mode === 'continue' ? continuation.target : undefined)); }
      catch (error) {
        if (error instanceof CloudConflict) throw new RemoteError('client/record-conflict', 'Artifact conflict', { table: error.table, key: error.key, fields: error.fields });
        if (error instanceof Error && /^(artifact_|invalid_artifact)/.test(error.message)) throw new RemoteError('client/forbidden', error.message, {});
        throw error;
      }
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?)")
        .run(worker.id, request.operationId, digest, JSON.stringify(result));
      noteInteractionEffect(this.store, worker.id, task.id, request.operationId, 'target', request.products);
      return result;
    });
  }
  async report(ctx: Context, request: ExecutorReport) {
    const { worker } = this.active(ctx, request.taskId);
    const leaseExpiresAt = new Date(Date.now() + this.leaseMs).toISOString();
    this.store.transaction(() => {
      this.store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=?,progress=?,updated_at=? WHERE id=?').run(leaseExpiresAt, JSON.stringify(request.progress), new Date().toISOString(), request.taskId);
      const view = request.progress.view as { pendingAsk?: unknown; pendingPlan?: unknown } | undefined;
      if (view) {
        const approval = this.store.db.prepare("SELECT 1 FROM cloud_permissions WHERE task_id=? AND status='pending'").get(request.taskId);
        this.store.db.prepare('UPDATE cloud_tasks SET status=? WHERE id=?').run(view.pendingAsk || view.pendingPlan || approval ? 'waiting_user' : 'running', request.taskId);
      }
    });
    worker.expiresAt = Date.parse(leaseExpiresAt);
    return { leaseExpiresAt };
  }
  private binding(taskId: string, hash: string) { return `executor:${taskId}:${hash}:`; }
  async receipt(ctx: Context, taskId: string, operationId: string): Promise<RuntimeReceipt> {
    const { worker, hash } = this.identity(ctx, taskId);
    const row = this.store.db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, operationId) as { digest: string; status: string; result: string } | undefined;
    if (!row) return { status: 'missing' };
    if (!row.digest.startsWith(this.binding(taskId, hash))) throw new RemoteError('client/forbidden', 'Completion belongs to another lease', {});
    if (row.status !== 'completed') return { status: 'uncertain', code: 'resource_requires_reconciliation' };
    return { status: 'completed', value: JSON.parse(row.result) };
  }
  async complete(ctx: Context, request: ExecutorCompletion): Promise<ExecutorCompletionReceipt> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId)) throw new RemoteError('gateway/bad-request', 'Invalid completion operation id', {});
    const { worker, hash } = this.identity(ctx, request.taskId);
    const outcome = request.outcome.status === 'completed' ? { status: 'completed', result: request.outcome.result } : { status: 'failed', error: request.outcome.error.slice(0, 1000) };
    const digest = this.binding(request.taskId, hash) + crypto.createHash('sha256').update(JSON.stringify(outcome)).digest('hex');
    return this.store.transaction(() => {
      const old = this.store.db.prepare('SELECT digest,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(worker.id, request.operationId) as { digest: string; result: string } | undefined;
      if (old) {
        if (old.digest !== digest) throw new RemoteError('client/conflict', 'Completion content or lease changed', {});
        return JSON.parse(old.result);
      }
      this.active(ctx, request.taskId);
      const value: ExecutorCompletionReceipt = { taskId: request.taskId, status: outcome.status as 'completed' | 'failed' };
      this.store.db.prepare("UPDATE cloud_tasks SET status=?,result=?,error=?,lease_expires_at=NULL,worker_id=NULL,updated_at=? WHERE id=?")
        .run(value.status, value.status === 'completed' ? JSON.stringify(outcome.result) : null, value.status === 'failed' ? outcome.error : null, new Date().toISOString(), request.taskId);
      this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id=? AND status IN ('pending','approved','consumed')").run(request.taskId);
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?)").run(worker.id, request.operationId, digest, JSON.stringify(value));
      // Keep only the original short-lived credential for receipt lookup. Active
      // methods still fail after worker_id is cleared. No token/lease transfer.
      return value;
    });
  }
}
