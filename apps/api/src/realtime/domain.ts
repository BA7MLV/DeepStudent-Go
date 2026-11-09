import crypto from 'node:crypto';
import { assembleRuntimeDomains, type RuntimeChange } from './runtime-domains.js';
import fs from 'node:fs';
import path from 'node:path';
import type { SavePluginLayout, SystemDocument } from '@wangke/contracts/system';
import { PLUGIN_LAYOUT_PATH } from '@wangke/contracts/plugins';
import type { Context } from '@deepseek-ai/cordis';
import { RemoteError, type PeerScope } from '@deepseek-ai/dsh-typert-protocol';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';
import type { RuntimeDomain } from '@wangke/remote-host';
import type { ResourceFiles } from '../projects/resources.js';
import type { ResourceCommand } from '@wangke/contracts/resources';
import { executeResourceCommand } from './resources.js';
import { recoverResourceWorkflow, resourceScope, resourceFailure, throwResourceFailure } from './resource-workflows.js';
import type { RuntimeRead, RuntimeSnapshot, RuntimeCommand, RuntimeJson, RuntimeFrame, RuntimeTaskFrame, RuntimeTasksFrame, RuntimeReceipt, BotJournalFrame } from '@wangke/contracts/client-runtime';
import { diffRuntime } from '@wangke/contracts/runtime-projection';
import type { DatabaseStore } from '../storage/database.js';
import type { PluginService } from '../plugins/service.js';
import { taskDto, listOwnerTasks } from '../cloud/tasks.js';
import { CloudRecords, CloudConflict } from '../cloud/records.js';
import type { RuntimeRecordsPage, RuntimeRecordsCommit, RuntimeRecordsReceipt } from '@wangke/contracts/client-runtime';
import type { RuntimeSessionFrame, RuntimeSessionProjection } from '@wangke/contracts/client-runtime';
import type { SessionJournalRequest, SessionJournalFrame, RuntimeSessionRow } from '@wangke/contracts/client-runtime';
import type { RuntimeTaskSubmit, RuntimeTask } from '@wangke/contracts/client-runtime';
import type { RuntimeTaskAdmission } from '@wangke/contracts/client-runtime';
import type { PreferencesCommand, PreferencesProjection } from '@wangke/contracts/client-runtime';
import { applyPreferences } from './preferences.js';
import type { RuntimeFileIntent, RuntimeFileIntentsFrame } from '@wangke/contracts/client-runtime';
import type { FileIntent } from '../storage/system-files.js';
import { SystemMaterials } from '../storage/system-materials.js';
import type { ClientLearningCommand } from '@wangke/contracts/client-runtime';
import { clientLearningMutations } from './client-learning.js';
import { cleanupBotJournal } from './journal-retention.js';
import { TaskDelegationService } from '../cloud/delegation.js';
import { CloudConfiguration } from '../cloud/config.js';
import type { DelegationCommand } from '@wangke/contracts/client-runtime';

import type {} from './errors.js';

type Change = RuntimeChange;
interface Observer { owner: string; request: RuntimeRead; wake(): void }
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Existing plugin authorization is executed on every baseline, update and command. */
export class ClientRuntimeDomain implements RuntimeDomain {
  async delegation(owner: string, command: DelegationCommand): Promise<RuntimeJson> {
    try {
      if (!this.configuration) throw new Error('delegation_unavailable');
      return new TaskDelegationService(this.store, this.configuration).command(owner, command);
    }
    catch (error) { throw this.failure(error); }
  }
  private readonly observers = new Set<Observer>();
  private readonly journals = new Set<{ owner: string; thread: string; wake(): void }>();
  private readonly peers = new WeakMap<PeerScope, () => string | undefined>();
  private readonly inflight = new Map<string, Promise<RuntimeJson>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private cursor: number;
  private retainedAt = 0;
  private readonly fileWatcher?: fs.FSWatcher;
  private fileWake?: ReturnType<typeof setTimeout>;
  private readonly domains: ReturnType<typeof assembleRuntimeDomains>;
  constructor(private readonly store: DatabaseStore, private readonly plugins: PluginService,
    private readonly submit?: (owner: string, request: RuntimeTaskSubmit) => unknown,
    private readonly resources?: ResourceFiles,
     private readonly configuration?: CloudConfiguration) {
    this.domains = assembleRuntimeDomains({ store, plugins, resources, canonical,
      recordsPage: (owner, after) => this.recordsPage(owner, after),
      sessionProjection: (owner, request) => this.sessionProjection(owner, request) });
    this.cursor = this.revision();
    // Task progress is persisted about every 100 ms. A second 100 ms gate here
    // made the browser see 100–200 ms gaps; an idle pump is one indexed read.
    this.timer = setInterval(() => this.pump(), 25);
    this.timer.unref();
    if (resources) {
      // Files remain authoritative even when changed by a local sandbox/tool.
      // This watches identities only: every awakened read reruns authorization
      // and the safe filesystem walker. No browser polling or file payload bus.
      this.fileWatcher = fs.watch(resources.projects.files.root, { recursive: true }, () => {
        if (this.fileWake) return;
        this.fileWake = setTimeout(() => {
          this.fileWake = undefined;
          const affected = [...this.observers].filter(observer => ['resources', 'catalog'].includes(observer.request.kind));
          this.store.transaction(() => {
            for (const owner of new Set(affected.map(observer => observer.owner))) {
              this.store.db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'resources','filesystem')").run(owner);
            }
          });
          for (const observer of affected) observer.wake();
        }, 50);
        this.fileWake.unref();
      });
      this.fileWatcher.unref();
      this.fileWatcher.on('error', error => console.error('resource_filesystem_watch_failed', error));
    }
  }
  admit(peer: PeerScope, identity: () => string | undefined) { this.peers.set(peer, identity); }
  owner(ctx: Context): string {
    const peer = ctx.invocation?.peer;
    const owner = peer && !peer.signal.aborted && this.peers.get(peer)?.();
    if (!owner) throw new RemoteError('client/unauthenticated', 'Authentication expired', {});
    return owner;
  }
  private revision() { return (this.store.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM client_changes').get() as { n: number }).n; }
  private matches(request: RuntimeRead, change: Change): boolean {
    return this.domains.matches(request, change);
  }
  private pump() {
    try {
      const now = Date.now();
      if (now - this.retainedAt >= 60000) {
        // Invalidation rows have no replay payload. A missing invalidation range
        // always rebuilds active snapshot baselines; Bot journal data is untouched.
        this.store.db.prepare('DELETE FROM client_changes WHERE revision <= ?').run(Math.max(0, this.revision() - 100000));
        this.store.transaction(() => {
          this.store.db.prepare('UPDATE client_session_cursors SET floor=MAX(floor,cursor-10000)').run();
          this.store.db.prepare(`DELETE FROM client_session_events WHERE cursor <= (SELECT floor FROM client_session_cursors c
            WHERE c.owner_id=client_session_events.owner_id AND c.session_id=client_session_events.session_id)`).run();
        });
        // The Bot journal is replay bandwidth, not storage. Advancing floors keeps
        // reconnect replay bounded; stale cursors resync from the messages table.
        cleanupBotJournal(this.store, new Set([...this.journals].map(observer => observer.thread)));
        this.retainedAt = now;
      }
      const changes = this.store.db.prepare('SELECT * FROM client_changes WHERE revision>? ORDER BY revision LIMIT 512').all(this.cursor) as Change[];
      if (!changes.length) return;
      const gap = changes[0].revision > this.cursor + 1;
      this.cursor = changes.at(-1)!.revision;
      for (const observer of this.observers) if (gap || changes.some(change => change.owner_id === observer.owner && this.matches(observer.request, change))) observer.wake();
      for (const observer of this.journals) if (gap || changes.some(change => change.owner_id === observer.owner && (change.domain === 'threads' && change.entity === observer.thread || change.domain === 'message_events' && change.entity === observer.thread))) observer.wake();
    } catch { for (const observer of [...this.observers, ...this.journals]) observer.wake(); }
  }
  async read(owner: string, request: RuntimeRead): Promise<RuntimeSnapshot> {
    try {
      // Capture before reading: a concurrent async result may only cause a redundant
      // replacement, never skip a committed change. watch attaches before this call.
      const revision = this.revision();
      const value = await this.domains.read(owner, request);
      // Domains may return optional undefined members; wire JSON omits them exactly as HTTP did.
      return TYPERT_REMOTE.methods['clientRuntime/read'].result.create().parse({ type: 'snapshot', revision, value: JSON.parse(JSON.stringify(value)) });
    } catch (error) { throw this.failure(error); }
  }
  async *watch(owner: string, request: RuntimeRead, signal: AbortSignal): AsyncIterable<RuntimeFrame> {
    if (this.observers.size >= 512) throw new RemoteError('client/domain', 'Subscription quota exceeded', { code: 'subscription_limit' });
    let pending = true, resume: (() => void) | undefined;
    const wake = () => { pending = true; resume?.(); resume = undefined; };
    const observer = { owner, request, wake };
    this.observers.add(observer);
    signal.addEventListener('abort', wake, { once: true });
    let previous: RuntimeSnapshot | undefined;
    let directoryWatcher: fs.FSWatcher | undefined;
    try {
      let watchedProject = request.kind === 'resources' ? request.projectId : undefined;
      if (this.resources && request.kind === 'courseDocument') watchedProject = this.resources.course(owner, request.courseId).project_id;
      if (this.resources && watchedProject) {
        this.resources.projects.get(owner, watchedProject);
        // Darwin's recursive root watcher can coalesce a newly created project
        // directory before it starts observing its children. Pin an active
        // directory watcher before publishing its first baseline as well.
        directoryWatcher = fs.watch(path.join(this.resources.projects.files.root, watchedProject), { recursive: true }, () => {
          this.store.db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'resources','filesystem')").run(owner);
          wake();
        });
        directoryWatcher.unref();
        directoryWatcher.on('error', error => console.error('resource_directory_watch_failed', error));
      }
      if (request.kind === 'systemDocument' || request.kind === 'systemDirectory') {
        // The authorized read creates/validates the owner's safe system tree.
        if (request.kind === 'systemDocument') new SystemMaterials(this.store).read(owner, request.path);
        else new SystemMaterials(this.store).list(owner, request.path, request.offset, request.query);
        const account = crypto.createHash('sha256').update(owner).digest('hex');
        directoryWatcher = fs.watch(path.join(this.store.systemFiles.root, account), { recursive: true }, () => {
          this.store.db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'systemDocument',?)").run(owner, request.path);
          wake();
        });
        directoryWatcher.unref();
        directoryWatcher.on('error', error => console.error('system_document_watch_failed', error));
      }
      while (!signal.aborted) {
        if (!pending) await new Promise<void>(resolve => { resume = resolve; });
        if (signal.aborted) break;
        pending = false;
        // Snapshot invalidations coalesce into one bounded flag. No persistent
        // journal frame is discarded: journal domains use their own durable log.
        const next = await this.observedRead(owner, request, signal);
        if (!next || signal.aborted) break;
        if (!previous) yield next;
        else if (next.revision > previous.revision) yield { type: 'delta', baseRevision: previous.revision, revision: next.revision, changes: diffRuntime(previous.value, next.value) };
        previous = next;
      }
    } finally { directoryWatcher?.close(); this.observers.delete(observer); signal.removeEventListener('abort', wake); }
  }
  private observedRead(owner: string, request: RuntimeRead, signal: AbortSignal): Promise<RuntimeSnapshot | undefined> {
    if (signal.aborted) return Promise.resolve(undefined);
    // A provider may never settle. Cancelling its observation must still remove
    // the stream/observer promptly, and a later rejection must remain handled.
    return new Promise((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); resolve(undefined); };
      signal.addEventListener('abort', abort, { once: true });
      void this.read(owner, request).then(value => {
        signal.removeEventListener('abort', abort);
        resolve(signal.aborted ? undefined : value);
      }, error => {
        signal.removeEventListener('abort', abort);
        if (signal.aborted) resolve(undefined); else reject(error);
      });
    });
  }
  command(owner: string, request: RuntimeCommand): Promise<RuntimeJson> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId)) return Promise.reject(new RemoteError('gateway/bad-request', 'Invalid operation id', {}));
    const digest = crypto.createHash('sha256').update(canonical(request)).digest('hex');
    const key = `${owner}:${request.operationId}`;
    const old = this.store.db.prepare('SELECT * FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string; error: string } | undefined;
    if (old && old.digest !== digest) return Promise.reject(new RemoteError('client/conflict', 'Operation id reused with different content', {}));
    if (old?.status === 'completed') return this.receipt(owner, request.operationId).then(receipt => {
      if (receipt.status === 'completed') return receipt.value;
      throw new RemoteError('client/uncertain', 'File intent requires reconciliation; the handler will not be repeated', {});
    });
    if (old?.status === 'failed') return Promise.reject(new RemoteError('client/domain', 'Previous command failed', { code: old.error }));
    const flight = this.inflight.get(key);
    if (flight) return flight;
    if (old) return Promise.reject(new RemoteError('client/uncertain', 'Command outcome requires reconciliation; it will not be repeated', {}));
    const run = (async () => {
      this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status) VALUES(?,?,?,'pending')").run(owner, request.operationId, digest);
      let dispatched = false;
      let committed = false;
      try {
        const invoke = request.target === 'action'
          ? this.plugins.prepareNamedInvocation(owner, request.pluginId, request.instanceId, request.revision, request.method, request.args)
          : this.plugins.prepareInvocation(owner, request.pluginId, request.instanceId, request.revision, request.method, request.args);
        dispatched = true;
        if (invoke.atomic === 'sqlite') {
          let value: RuntimeJson = null;
          try {
            this.store.systemFiles.withOperation(owner, request.operationId, () => this.store.db.transaction(() => {
              const result = invoke();
              if (result && typeof (result as { then?: unknown }).then === 'function') throw new Error('atomic_handler_must_be_synchronous');
              value = TYPERT_REMOTE.methods['clientRuntime/command'].result.create().parse(JSON.parse(JSON.stringify(result ?? null)));
              this.store.db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify(value), owner, request.operationId);
            })());
            committed = true;
          } catch (error) { dispatched = false; throw error; }
          // The SQL result and conditional filesystem intents are durable together.
          // Never pretend the following fsync is part of SQLite's atomic commit.
          this.store.systemFiles.flush({ owner, id: request.operationId });
          return value;
        }
        const result = await invoke();
        const value = TYPERT_REMOTE.methods['clientRuntime/command'].result.create().parse(JSON.parse(JSON.stringify(result ?? null)));
        this.store.db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify(value), owner, request.operationId);
        return value;
      } catch (error) {
        const failure = this.failure(error);
        if (!committed) this.store.db.prepare('UPDATE client_commands SET status=?,error=? WHERE owner_id=? AND operation_id=?').run(dispatched ? 'pending' : 'failed', failure instanceof RemoteError && 'code' in failure.details ? failure.details.code : 'command_failed', owner, request.operationId);
        if (dispatched) throw new RemoteError('client/uncertain', 'Handler started but its outcome requires reconciliation; it will not be repeated', {});
        throw failure;
      }
    })().finally(() => { this.inflight.delete(key); });
    this.inflight.set(key, run);
    return run;
  }
  async receipt(owner: string, operationId: string): Promise<RuntimeReceipt> {
    if (this.resources) recoverResourceWorkflow(this.resources, owner, operationId);
    const receipt = await this.commandReceipt(owner, operationId);
    return this.resources && operationId.startsWith('resource-') ? { ...receipt, resourceScope: resourceScope(this.resources, owner) } : receipt;
  }
  private async commandReceipt(owner: string, operationId: string): Promise<RuntimeReceipt> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) throw new RemoteError('gateway/bad-request', 'Invalid operation id', {});
    const row = this.store.db.prepare('SELECT status,result,error FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, operationId) as { status: string; result: string; error: string } | undefined;
    if (!row) return { status: 'missing' };
    if (row.status === 'completed') {
      if (this.store.systemFiles.operationOutcome(owner, operationId) === 'pending') {
        try { this.store.systemFiles.flush({ owner, id: operationId }); } catch { /* Durable intent reports its own conflict/pending state below. */ }
      }
      const outcome = this.store.systemFiles.operationOutcome(owner, operationId);
      if (outcome === 'discarded') return { status: 'failed', code: 'file_intent_discarded' };
      if (outcome !== 'applied') return { status: 'uncertain', code: `file_intent_${outcome}` };
      return { status: 'completed', value: JSON.parse(row.result) };
    }
    if (row.status === 'failed') return { status: 'failed', code: row.error };
    if (!this.inflight.has(`${owner}:${operationId}`)) return { status: 'uncertain', code: row.error || 'interrupted' };
    return { status: 'pending' };
  }
  private fileIntentDto(intent: FileIntent): RuntimeFileIntent {
    return { id: intent.id, path: intent.path, content: intent.content, expected: intent.expected, observed: intent.observed, current: this.store.systemFiles.current(intent.owner_id, intent.path),
      status: intent.status, createdAt: intent.created_at, completedAt: intent.completed_at, successorId: intent.successor_id };
  }
  async fileIntent(owner: string, id: string): Promise<RuntimeFileIntent | null> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(id)) throw new RemoteError('gateway/bad-request', 'Invalid intent id', {});
    const intent = this.store.systemFiles.reconcile(owner, id);
    return intent ? this.fileIntentDto(intent) : null;
  }
  async *watchFileIntents(owner: string, signal: AbortSignal): AsyncIterable<RuntimeFileIntentsFrame> {
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchFileIntents'].result.create();
    for await (const frame of this.watch(owner, { kind: 'fileIntents' }, signal)) yield codec.parse(frame);
  }
  async resolveFileIntent(owner: string, id: string, observed: string | null, action: 'retry' | 'discard'): Promise<RuntimeFileIntent> {
    await this.fileIntent(owner, id);
    try {
      const receipt = this.store.systemFiles.resolve(owner, id, observed, action);
      if (!receipt) throw new Error('system_file_intent_not_found');
      return this.fileIntentDto(receipt);
    } catch (error) { throw this.failure(error); }
  }
  async *watchBot(owner: string, thread: string, after: number, signal: AbortSignal): AsyncIterable<BotJournalFrame> {
    if (!Number.isSafeInteger(after) || after < 0 || !thread || thread.length > 200) throw new RemoteError('gateway/bad-request', 'Invalid journal cursor', {});
    if (this.journals.size >= 512) throw new RemoteError('client/domain', 'Subscription quota exceeded', { code: 'subscription_limit' });
    const authorized = () => {
      if (!this.store.db.prepare("SELECT 1 FROM threads WHERE id=? AND owner_id=? AND mode='bot'").get(thread, owner)) throw new RemoteError('client/forbidden', 'Thread unavailable', {});
    };
    authorized();
    let pending = true, resume: (() => void) | undefined, cursor = after;
    const wake = () => { pending = true; resume?.(); resume = undefined; };
    const observer = { owner, thread, wake };
    // Observe before replay: commits between the baseline read and stream open
    // remain in the durable log and commits during replay cannot lose a wakeup.
    this.journals.add(observer);
    signal.addEventListener('abort', wake, { once: true });
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchBot'].result.create();
    try {
      const floor = (this.store.db.prepare('SELECT cursor FROM client_journal_floors WHERE owner_id=? AND thread_id=?').get(owner, thread) as { cursor: number } | undefined)?.cursor ?? 0;
      const latest = (this.store.db.prepare('SELECT COALESCE(MAX(event_id),0) AS cursor FROM message_events WHERE thread_id=?').get(thread) as { cursor: number }).cursor;
      if (after < floor || after > latest) {
        yield { type: 'event', cursor: after, event: { type: 'resync.required' } };
        return;
      }
      yield { type: 'ready', cursor };
      while (!signal.aborted) {
        if (!pending) await new Promise<void>(resolve => { resume = resolve; });
        if (signal.aborted) break;
        pending = false;
        authorized();
        const retained = (this.store.db.prepare('SELECT cursor FROM client_journal_floors WHERE owner_id=? AND thread_id=?').get(owner, thread) as { cursor: number } | undefined)?.cursor ?? 0;
        if (cursor < retained) { yield { type: 'event', cursor, event: { type: 'resync.required' } }; return; }
        const rows = this.store.db.prepare('SELECT event_id,type,payload FROM message_events WHERE thread_id=? AND event_id>? ORDER BY event_id LIMIT 64').all(thread, cursor) as { event_id: number; type: string; payload: string }[];
        // One bounded batch is retained while the mux consumer is backpressured.
        for (const row of rows) {
          if (signal.aborted) break;
          authorized();
          let payload = JSON.parse(row.payload);
          if (['message.accepted', 'message.updated', 'message.pending'].includes(row.type) && !('message' in payload)) payload = { message: payload };
          yield codec.parse({ type: 'event', cursor: row.event_id, event: { ...payload, type: row.type } });
          cursor = row.event_id;
        }
        if (rows.length === 64) pending = true;
      }
    } finally { this.journals.delete(observer); signal.removeEventListener('abort', wake); }
  }
  async *watchTask(owner: string, taskId: string, signal: AbortSignal): AsyncIterable<RuntimeTaskFrame> {
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchTask'].result.create();
    for await (const frame of this.watch(owner, { kind: 'task', taskId }, signal)) yield codec.parse(frame);
  }
  async *watchTasks(owner: string, signal: AbortSignal): AsyncIterable<RuntimeTasksFrame> {
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchTasks'].result.create();
    for await (const frame of this.watch(owner, { kind: 'tasks' }, signal)) yield codec.parse(frame);
  }
  async recordsPage(owner: string, after: number): Promise<RuntimeRecordsPage> {
    if (!Number.isSafeInteger(after) || after < 0) throw new RemoteError('gateway/bad-request', 'Invalid records cursor', {});
    // Record pages never run project migration, attachment installation or
    // workspace cleanup. A busy file must not gate login or record feeds.
    const records = new CloudRecords(this.store).list(owner, after);
    const highWater = (this.store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='cloud_records'").get() as { seq: number } | undefined)?.seq ?? 0;
    return TYPERT_REMOTE.methods['clientRuntime/recordsPage'].result.create().parse({ records, cursor: records.at(-1)?.revision ?? Math.min(after, highWater), more: records.length === 200,
      epoch: this.recordsEpoch, highWater, reset: after > highWater });
  }
  private readonly recordsEpoch = crypto.randomUUID();
  async submitTask(owner: string, request: RuntimeTaskSubmit): Promise<RuntimeTask> {
    if (!this.submit) throw new Error('task_admission_unavailable');
    try { return TYPERT_REMOTE.methods['clientRuntime/submitTask'].result.create().parse(this.submit(owner, request)); }
    catch (error) {
      if (error instanceof Error && error.message === 'task_nonce_conflict') throw new RemoteError('client/conflict', 'Task operation id reused with different content', {});
      throw this.failure(error);
    }
  }
  async taskAdmission(owner: string, operationId: string): Promise<RuntimeTaskAdmission> {
    if (!operationId || operationId.length > 100) throw new RemoteError('gateway/bad-request', 'Invalid task operation id', {});
    const row = this.store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, operationId);
    return TYPERT_REMOTE.methods['clientRuntime/taskAdmission'].result.create().parse(row ? { status: 'accepted', task: taskDto(row) } : { status: 'missing' });
  }
  private sessionProjection(owner: string, request: Extract<RuntimeRead, { kind: 'session' }>): RuntimeSessionProjection {
    if (!Number.isSafeInteger(request.sessionId) || request.sessionId <= 0 || request.before && request.after) throw new Error('invalid_session');
    const session = new CloudRecords(this.store).get(owner, 'chatSessions', request.sessionId);
    if (!session) throw new Error('session_not_found');
    const marker = request.before ?? request.after;
    if (marker && (!Number.isSafeInteger(marker.id) || !Number.isFinite(marker.createdAt))) throw new Error('invalid_session_cursor');
    const comparison = request.before ? '<' : '>=';
    const markerRow = marker ? new CloudRecords(this.store).get(owner, 'chats', marker.id) : undefined;
    const markerRole = marker?.role ?? (markerRow?.sessionId === request.sessionId ? markerRow.role : undefined);
    const roleOrder = "CASE WHEN json_extract(value,'$.role')='user' THEN 0 ELSE 1 END";
    const rows = this.store.db.prepare(`SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats'
      AND json_extract(value,'$.sessionId')=?
      ${marker ? `AND (json_extract(value,'$.createdAt'),${roleOrder},json_extract(value,'$.id')) ${comparison} (?,?,?)` : ''}
      ORDER BY json_extract(value,'$.createdAt') DESC,${roleOrder} DESC,json_extract(value,'$.id') DESC LIMIT ?`)
      .all(owner, request.sessionId, ...(marker ? [marker.createdAt, markerRole === 'user' ? 0 : 1, marker.id] : []), request.after ? 501 : 41) as { value: string }[];
    if (request.after && rows.length > 500) throw new Error('session_window_limit');
    const hasOlder = !request.after && rows.length > 40;
    return { session, rows: rows.slice(0, request.after ? 500 : 40).reverse().map(row => {
      const data = JSON.parse(row.value);
      return { id: data.id, sessionId: data.sessionId, createdAt: data.createdAt, role: data.role, content: data.content, ...(data.taskId ? { taskId: data.taskId } : {}), data };
    }), hasOlder,
      tasks: listOwnerTasks(this.store, owner, 'session', request.sessionId)
        .map(task => TYPERT_REMOTE.methods['clientRuntime/submitTask'].result.create().parse(task)) };
  }
  async *watchSession(owner: string, request: Extract<RuntimeRead, { kind: 'session' }>, signal: AbortSignal): AsyncIterable<RuntimeSessionFrame> {
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchSession'].result.create();
    for await (const frame of this.watch(owner, request, signal)) yield codec.parse(frame);
  }
  async *watchSessionJournal(owner: string, request: SessionJournalRequest, signal: AbortSignal): AsyncIterable<SessionJournalFrame> {
    if (!Number.isSafeInteger(request.sessionId) || request.sessionId <= 0
      || request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) throw new Error('invalid_session_cursor');
    if (this.observers.size >= 512) throw new Error('subscription_limit');
    const codec = TYPERT_REMOTE.methods['clientRuntime/watchSessionJournal'].result.create();
    let pending = true, resume: (() => void) | undefined, cursor = request.after;
    const wake = () => { pending = true; resume?.(); resume = undefined; };
    const observer = { owner, request: { kind: 'session' as const, sessionId: request.sessionId }, wake };
    this.observers.add(observer);
    signal.addEventListener('abort', wake, { once: true });
    const rowDto = (data: any): RuntimeSessionRow => ({ id: data.id, sessionId: data.sessionId, createdAt: data.createdAt,
      role: data.role, content: data.content, ...(data.taskId ? { taskId: data.taskId } : {}), data });
    const state = () => this.sessionProjection(owner, { kind: 'session', sessionId: request.sessionId });
    try {
      while (!signal.aborted) {
        if (!pending) await new Promise<void>(resolve => { resume = resolve; });
        if (signal.aborted) break;
        pending = false;
        // Everything before the first yield is synchronous SQLite I/O. Attach
        // before capture; writes during chunk delivery are replayed after it.
        const { projection, latest, floor, batch, gap, rows } = this.store.db.transaction(() => {
        const projection = state(); // Also rechecks ownership/deletion on every wake.
        const head = this.store.db.prepare('SELECT cursor,floor FROM client_session_cursors WHERE owner_id=? AND session_id=?')
          .get(owner, request.sessionId) as { cursor: number; floor: number } | undefined;
        const latest = head?.cursor ?? 0, floor = head?.floor ?? 0;
        const batch = cursor === undefined ? [] : this.store.db.prepare(`SELECT cursor,row_id,value FROM client_session_events
          WHERE owner_id=? AND session_id=? AND cursor>? ORDER BY cursor LIMIT 64`).all(owner, request.sessionId, cursor) as { cursor: number; row_id: number; value: string | null }[];
        const gap = cursor !== undefined && (cursor < floor || cursor > latest
          || cursor < latest && (!batch.length || batch[0].cursor !== cursor + 1)
          || batch.some((event, index) => event.cursor !== cursor! + index + 1));
          // First paint stays paged. A lost range explicitly repairs the entire
          // loaded timeline, never silently replaces it with forty latest rows.
          const rows = gap ? (this.store.db.prepare(`SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats'
            AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt'),
              CASE WHEN json_extract(value,'$.role')='user' THEN 0 ELSE 1 END,json_extract(value,'$.id')`)
            .all(owner, request.sessionId) as { value: string }[]).map(row => rowDto(JSON.parse(row.value))) : projection.rows;
          return { projection, latest, floor, batch, gap, rows };
        })();
        if (cursor === undefined || gap) {
          if (gap) yield { type: 'resync-required', cursor: latest, reason: cursor! < floor ? 'cursor-expired' : 'journal-gap' };
          yield codec.parse({ type: 'baseline', cursor: latest, session: projection.session, tasks: projection.tasks, hasOlder: gap ? false : projection.hasOlder });
          for (let index = 0; index < rows.length && !signal.aborted; index += 64) {
            state();
            yield codec.parse({ type: 'rows', cursor: latest, rows: rows.slice(index, index + 64) });
          }
          if (signal.aborted) break;
          state();
          yield { type: 'ready', cursor: latest };
          cursor = latest;
          pending = true;
          continue;
        }
        const next = batch.at(-1)?.cursor ?? cursor;
        yield codec.parse({ type: 'events', baseCursor: cursor, cursor: next,
          events: batch.map(event => ({ cursor: event.cursor, rowId: event.row_id, row: event.value ? rowDto(JSON.parse(event.value)) : null })),
          session: projection.session, tasks: projection.tasks });
        cursor = next;
        if (cursor < latest) pending = true;
      }
    } finally { this.observers.delete(observer); signal.removeEventListener('abort', wake); }
  }
  async *watchRecords(owner: string, after: number, signal: AbortSignal): AsyncIterable<RuntimeRecordsPage> {
    if (this.observers.size >= 512) throw new RemoteError('client/domain', 'Subscription quota exceeded', { code: 'subscription_limit' });
    let pending = true, initial = true, resume: (() => void) | undefined;
    const wake = () => { pending = true; resume?.(); resume = undefined; };
    const observer = { owner, request: { kind: 'records' as const, after }, wake };
    this.observers.add(observer);
    signal.addEventListener('abort', wake, { once: true });
    try {
      while (!signal.aborted) {
        if (!pending) await new Promise<void>(resolve => { resume = resolve; });
        if (signal.aborted) break;
        pending = false;
        const page = await this.recordsPage(owner, after);
        if (signal.aborted) break;
        if (initial || page.records.length) yield page;
        initial = false;
        after = page.cursor;
        if (page.more) pending = true;
      }
    } finally { this.observers.delete(observer); signal.removeEventListener('abort', wake); }
  }
  async setPreferences(owner: string, request: PreferencesCommand): Promise<PreferencesProjection> {
    return this.atomicCommand(owner, request.operationId, { kind: 'preferences.set', ...request }, () => applyPreferences(this.store, owner, request));
  }
  async savePluginLayout(owner: string, request: SavePluginLayout): Promise<SystemDocument> {
    return this.atomicCommand(owner, request.operationId, { kind: 'plugins.layout.save', ...request },
      () => {
        try { return this.plugins.files.save(owner, PLUGIN_LAYOUT_PATH, request.content, request.expected, request.revision); }
        catch (error) {
          if (error instanceof Error && error.message === 'system_revision_conflict') throw new RemoteError('client/conflict', 'Plugin layout revision changed', {});
          throw error;
        }
      });
  }
  async resourceCommand(owner: string, request: ResourceCommand): Promise<RuntimeJson> {
    if (!this.resources) throw new Error('resource_domain_unavailable');
    try { return executeResourceCommand(this.resources, owner, request); }
    catch (error) {
      if (error instanceof RemoteError) throw error;
      throwResourceFailure(resourceFailure(error).code);
    }
  }
  /** Only synchronous SQL + durable file intents may use this transaction. */
  private async atomicCommand<T>(owner: string, operationId: string, payload: unknown, run: () => T): Promise<T> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(operationId)) throw new RemoteError('gateway/bad-request', 'Invalid operation id', {});
    const digest = crypto.createHash('sha256').update(canonical(payload)).digest('hex');
    try {
      const result = this.store.systemFiles.withOperation(owner, operationId, () => this.store.db.transaction(() => {
        const old = this.store.db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, operationId) as { digest: string; status: string; result: string } | undefined;
        if (old) {
          if (old.digest !== digest) throw new RemoteError('client/conflict', 'Operation id reused with different content', {});
          if (old.status !== 'completed') throw new RemoteError('client/uncertain', 'Command requires reconciliation', {});
          return JSON.parse(old.result) as T;
        }
        const value = run();
        this.store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'completed',?)").run(owner, operationId, digest, JSON.stringify(value));
        return value;
      })());
      const receipt = await this.receipt(owner, operationId);
      if (receipt.status !== 'completed') throw new RemoteError('client/uncertain', 'Command file intent requires reconciliation', {});
      return result;
    } catch (error) { throw this.failure(error); }
  }
  async commitRecords(owner: string, request: RuntimeRecordsCommit): Promise<RuntimeRecordsReceipt> {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(request.operationId) || !request.mutations.length || request.mutations.length > 20000) throw new RemoteError('gateway/bad-request', 'Invalid record transaction', {});
    const digest = crypto.createHash('sha256').update(canonical({ kind: 'records', ...request })).digest('hex');
    try {
      // SQL, operation deduplication and file intents commit together; a stored
      // SQL result is not yet proof that the conditional filesystem effect won.
      const result = this.store.systemFiles.withOperation(owner, request.operationId, () => this.store.db.transaction(() => {
        const old = this.store.db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, request.operationId) as { digest: string; status: string; result: string } | undefined;
        if (old) {
          if (old.digest !== digest) throw new RemoteError('client/conflict', 'Operation id reused with different content', {});
          if (old.status !== 'completed') throw new RemoteError('client/uncertain', 'Transaction requires reconciliation', {});
          return JSON.parse(old.result) as RuntimeRecordsReceipt;
        }
        // Endpoint retained for old receipt consumers (including native during
        // its migration). It can no longer admit a new arbitrary table write.
        throw new Error('domain_command_required');
      })());
      const receipt = await this.receipt(owner, request.operationId);
      if (receipt.status === 'completed') return result;
      if (receipt.status === 'failed') throw new RemoteError('client/domain', 'File intent was explicitly discarded', { code: receipt.code });
      throw new RemoteError('client/uncertain', 'Record file intent requires reconciliation', {});
    } catch (error) { throw this.failure(error); }
  }
  async editLearning(owner: string, request: ClientLearningCommand): Promise<RuntimeRecordsReceipt> {
    if (!request.edits.length || request.edits.length > 20000) throw new RemoteError('gateway/bad-request', 'Invalid learning edits', {});
    return this.atomicCommand(owner, request.operationId, { kind: 'learning', edits: request.edits }, () => {
      const records = new CloudRecords(this.store);
      // Preserve the original transaction through skill package staging. Applying
      // each row separately can resync pending files against disk between the
      // definition and its references, tombstoning the not-yet-installed package.
      return records.apply(owner, clientLearningMutations(records, owner, request.edits));
    });
  }
  private failure(error: unknown) {
    if (error instanceof RemoteError) return error;
    if (error instanceof CloudConflict) return new RemoteError('client/record-conflict', 'Record changes require reconciliation', { table: error.table, key: error.key, fields: error.fields });
    const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'domain_failed';
    return new RemoteError('client/domain', 'Domain request failed', { code });
  }
  diagnostics() { return { subscriptions: this.observers.size + this.journals.size, revision: this.cursor, commands: this.inflight.size }; }
  close() { clearInterval(this.timer); clearTimeout(this.fileWake); this.fileWatcher?.close(); for (const observer of [...this.observers, ...this.journals]) observer.wake(); }
}
