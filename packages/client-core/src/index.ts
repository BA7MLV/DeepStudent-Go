import { Context } from '@deepseek-ai/cordis';
import { installConnection, type ConnectionInstallOptions, type ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client';
import { apply as installGateway, RemoteSnapshotStream } from '@deepseek-ai/dsh-api-gateway/client';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';
import type { RuntimeRead, RuntimeJson, RuntimeSnapshot, RuntimeFrame, RuntimeCommand, RuntimeTask } from '@wangke/contracts/client-runtime';
import type { ClientLearningCommand, RuntimeRecordsPage } from '@wangke/contracts/client-runtime';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'client/record-conflict': { table: string; key: string | number; fields: string[] };
  }
}
import { applyRuntimePatch, reconcileRuntime } from '@wangke/contracts/runtime-projection';
import { SessionJournalModel } from './session.js';
export { BotHistoryModel, mergeMessages, mergeById, sameMessage } from './bot-history.js';
export { SessionQueueModel } from './session-queue.js';
export type { SessionQueueItem, SessionQueuePort } from './session-queue.js';
export type { BotThreadProjection } from './bot-history.js';
export { SessionTimelineModel } from './session.js';
export type { SessionMessage, SessionRow } from './session.js';
export { SessionStateModel, ConversationSessionModel } from './session-state.js';
export { BotFollowModel } from './bot-follow.js';
export { DurableCommands } from './durable-commands.js';
export type { DurableCommand, CommandJournal } from './durable-commands.js';
import type { RuntimeSessionProjection } from '@wangke/contracts/client-runtime';
import type { PreferencesCommand } from '@wangke/contracts/client-runtime';

export interface ModelSnapshot {
  readonly status: 'loading' | 'ready' | 'reconnecting' | 'error';
  readonly revision?: number;
  readonly data?: RuntimeJson;
  readonly error?: string;
}

/** A projection, not a transport or authority. Each retained resource owns one logical stream. */
export class RuntimeModel {
  private snapshot: ModelSnapshot = { status: 'loading' };
  private readonly listeners = new Set<() => void>();
  private stream?: RemoteSnapshotStream<RuntimeSnapshot, Exclude<RuntimeFrame, RuntimeSnapshot>>;
  private refs = 0;
  private disposed = false;
  private incarnation = 0;
  private stopState?: () => void;
  constructor(private readonly ctx: Context, readonly request: RuntimeRead,
    private readonly open?: (signal: AbortSignal) => AsyncIterable<RuntimeFrame>) {}
  getSnapshot = (): ModelSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  protected invalidatePendingReads() {}
  protected publish(next: ModelSnapshot) { if (next.status !== 'ready') this.invalidatePendingReads(); this.snapshot = next; for (const listener of this.listeners) listener(); }
  protected materialize(next: RuntimeJson) { return reconcileRuntime(this.snapshot.data, next); }
  protected updateData(frame: Exclude<RuntimeFrame, RuntimeSnapshot>) { return applyRuntimePatch(this.snapshot.data!, frame.changes); }
  acquire(): () => void {
    if (this.disposed) throw new Error('client_model_disposed');
    if (++this.refs === 1) this.start();
    let released = false;
    return () => { if (released) return; released = true; if (--this.refs === 0) this.stop(); };
  }
  private start() {
    const incarnation = ++this.incarnation;
    // A cached projection is not a baseline for this new stream incarnation.
    // Consumers may show it as stale, but must not act on it as freshly ready.
    this.publish({ ...this.snapshot, status: this.snapshot.data === undefined ? 'loading' : 'reconnecting', error: undefined });
    const current = () => incarnation === this.incarnation;
    const source = this.ctx.remote.$stream<RuntimeFrame>({
      name: `clientRuntime:${this.request.kind}`,
      open: signal => this.open ? this.open(signal) : this.ctx.remote.clientRuntime.watch(this.request, signal),
      ended: () => new Error('protocol_stream_ended'),
      carrierFailed: () => { if (current()) this.publish({ ...this.snapshot, status: 'reconnecting' }); },
    });
    this.stream = new RemoteSnapshotStream<RuntimeSnapshot, Exclude<RuntimeFrame, RuntimeSnapshot>>(source, {
      name: 'clientRuntime', isSnapshot: (frame): frame is RuntimeSnapshot => frame.type === 'snapshot',
      replace: frame => {
        if (!current()) return;
        this.publish({ status: 'ready', revision: frame.revision, data: this.materialize(frame.value) });
      },
      update: frame => {
        if (!current()) return;
        if (this.snapshot.data === undefined || frame.baseRevision !== this.snapshot.revision || frame.revision <= frame.baseRevision) throw new Error('protocol_revision_gap');
        this.publish({ status: 'ready', revision: frame.revision, data: this.updateData(frame) });
      },
      failed: error => { if (current()) this.publish({ ...this.snapshot, status: 'error', error: error instanceof Error ? error.message : 'remote_failed' }); },
    });
    const connection = this.ctx.get('connection') as ConnectionHandle;
    this.stopState = connection.state.subscribe(() => {
      if (current() && connection.state.getSnapshot() !== 'connected') this.publish({ ...this.snapshot, status: 'reconnecting' });
    });
    this.stream.start();
  }
  refresh() {
    if (this.disposed || this.refs === 0) return;
    // A protocol failure terminates RemoteSnapshotStream's consumer. Restarting
    // only its carrier cannot revive that consumer; create a new incarnation.
    if (this.snapshot.status === 'error') { this.stop(); this.start(); }
    else { this.invalidatePendingReads(); this.stream?.restart(); }
  }
  private stop() {
    this.invalidatePendingReads();
    ++this.incarnation;
    this.stopState?.(); this.stopState = undefined;
    const stream = this.stream; this.stream = undefined;
    void stream?.dispose();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.publish({ status: 'error', error: 'client_model_disposed' });
    this.stop(); this.listeners.clear();
  }
  diagnostics() { return { refs: this.refs, listeners: this.listeners.size, active: !!this.stream, revision: this.snapshot.revision }; }
}

export class PluginCatalogModel extends RuntimeModel {
  constructor(ctx: Context) { super(ctx, { kind: 'catalog' }); }
}
export class PluginInstanceModel extends RuntimeModel {
  constructor(ctx: Context, request: Extract<RuntimeRead, { kind: 'plugin' | 'pluginQueries' }>) { super(ctx, request); }
}
export class TaskModel extends RuntimeModel {
  constructor(ctx: Context, taskId: string) { super(ctx, { kind: 'task', taskId }, signal => ctx.remote.clientRuntime.watchTask(taskId, signal)); }
  /** Cancelling this waiter never sends a server task cancellation command. */
  wait(signal?: AbortSignal, progress?: (task: RuntimeTask) => void): Promise<RuntimeTask> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let release: (() => void) | undefined, off: (() => void) | undefined, settled = false;
      const finish = (task?: RuntimeTask, error?: unknown) => {
        if (settled) return;
        settled = true; off?.(); release?.(); signal?.removeEventListener('abort', abort);
        if (error !== undefined) reject(error); else resolve(task!);
      };
      const abort = () => finish(undefined, signal?.reason ?? new Error('observation_cancelled'));
      const observe = () => {
        const snapshot = this.getSnapshot();
        if (snapshot.status === 'error') { finish(undefined, new Error(snapshot.error)); return; }
        if (snapshot.status !== 'ready' || snapshot.data === undefined) return;
        try {
          // Reuse the generated runtime codec for the materialized baseline too;
          // no task-specific handwritten parser or unvalidated generic assertion.
          const frame = TYPERT_REMOTE.methods['clientRuntime/watchTask'].result.create().parse({ type: 'snapshot', revision: snapshot.revision, value: snapshot.data });
          if (frame.type !== 'snapshot') throw new Error('protocol_task_baseline');
          progress?.(frame.value);
          if (frame.value.status === 'completed') finish(frame.value);
          else if (['failed', 'cancelled', 'interrupted'].includes(frame.value.status)) finish(undefined, new Error(frame.value.error || `task_${frame.value.status}`));
        } catch (error) { finish(undefined, error); }
      };
      off = this.subscribe(observe);
      release = this.acquire();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort(); else observe();
      if (settled) { off(); release(); }
    });
  }
}

export class TaskListModel extends RuntimeModel {
  private data?: RuntimeJson;
  private values?: RuntimeTask[];
  constructor(ctx: Context) { super(ctx, { kind: 'tasks' }, signal => ctx.remote.clientRuntime.watchTasks(signal)); }
  tasks(): RuntimeTask[] | undefined {
    const snapshot = this.getSnapshot();
    if (snapshot.data === undefined) return undefined;
    if (snapshot.data === this.data) return this.values;
    const frame = TYPERT_REMOTE.methods['clientRuntime/watchTasks'].result.create().parse({ type: 'snapshot', revision: snapshot.revision, value: snapshot.data });
    if (frame.type !== 'snapshot') throw new Error('protocol_tasks_baseline');
    this.data = snapshot.data;
    this.values = frame.value.tasks;
    return this.values;
  }
}

export class SessionModel extends RuntimeModel {
  private readonly journal: SessionJournalModel;
  private data?: RuntimeJson;
  private value?: RuntimeSessionProjection;
  constructor(ctx: Context, readonly sessionId: number) {
    const request = { kind: 'session' as const, sessionId };
    const journal = new SessionJournalModel(sessionId);
    let revision = 0;
    super(ctx, request, async function* (signal) {
      signal.throwIfAborted();
      journal.reconnect();
      let previous: RuntimeJson | undefined;
      for await (const frame of ctx.remote.clientRuntime.watchSessionJournal({ sessionId,
        ...(journal.cursor === undefined ? {} : { after: journal.cursor }) }, signal)) {
        signal.throwIfAborted();
        const value = journal.apply(frame);
        if (!value) continue;
        const next = value as unknown as RuntimeJson;
        const baseRevision = revision++;
        if (previous === undefined) yield { type: 'snapshot' as const, revision, value: next };
        // Internal materialized-frame handoff, not a second wire protocol or a
        // snapshot→diff→patch round trip. The journal already merged identities.
        else yield { type: 'delta' as const, baseRevision, revision, changes: [{ path: [], value: next }] };
        previous = next;
        // RemoteSnapshotStream applies the projection before requesting next.
        signal.throwIfAborted();
        journal.commit(frame.cursor);
      }
    });
    this.journal = journal;
  }
  protected override materialize(next: RuntimeJson) { return next; }
  protected override updateData(frame: Exclude<RuntimeFrame, RuntimeSnapshot>) { return frame.changes[0].value!; }
  protected override invalidatePendingReads() { this.journal.invalidatePages(); }
  beginPage() {
    return this.getSnapshot().status === 'ready' && this.diagnostics().active ? this.journal.beginPage() : undefined;
  }
  endPage(fence: ReturnType<SessionJournalModel['beginPage']>) { this.journal.endPage(fence); }
  prepend(page: RuntimeSessionProjection, fence: ReturnType<SessionJournalModel['beginPage']>) {
    const data = this.journal.prepend(page, fence);
    if (data) this.publish({ ...this.getSnapshot(), data: data as unknown as RuntimeJson });
  }
  projection(): RuntimeSessionProjection | undefined {
    const snapshot = this.getSnapshot();
    if (snapshot.data === undefined) return undefined;
    if (snapshot.data !== this.data) {
      // Journal frames were validated by the generated remote boundary already.
      // Re-parsing the full projection here would replace every nested identity.
      this.data = snapshot.data; this.value = snapshot.data as unknown as RuntimeSessionProjection;
    }
    return this.value;
  }
}

export class FileIntentsModel extends RuntimeModel {
  constructor(ctx: Context) { super(ctx, { kind: 'fileIntents' }, signal => ctx.remote.clientRuntime.watchFileIntents(signal)); }
  intents() {
    const snapshot = this.getSnapshot();
    if (snapshot.data === undefined) return undefined;
    const frame = TYPERT_REMOTE.methods['clientRuntime/watchFileIntents'].result.create().parse({ type: 'snapshot', revision: snapshot.revision, value: snapshot.data });
    return frame.type === 'snapshot' ? frame.value.intents : undefined;
  }
}

/** Account/server identity belongs to the root, never to a global numeric-id cache. */
export async function createClientRuntime(identity: { server: string; account: string; scope: string }, options: ConnectionInstallOptions,
  assemble?: (ctx: Context) => Promise<void>) {
  const ctx = new Context();
  const models = new Map<string, RuntimeModel>();
  const lifetime = new AbortController();
  let disposed = false;
  try {
    await ctx.plugin(TypertRegistry);
    installConnection(ctx, options);
    await ctx.plugin(installGateway);
    await ctx.remote.$mount(TYPERT_REMOTE);
    await assemble?.(ctx);
  } catch (error) { await ctx.fiber.dispose(); throw error; }
  const model = <T extends RuntimeModel>(key: string, create: () => T): T => {
    if (disposed) throw new Error('client_runtime_disposed');
    let value = models.get(key);
    if (!value) { value = create(); models.set(key, value); }
    return value as T;
  };
  const connection = ctx.get('connection') as ConnectionHandle;
  return {
    identity: Object.freeze({ ...identity }),
    signal: lifetime.signal,
    catalog: () => model('catalog', () => new PluginCatalogModel(ctx)),
    tasks: () => model('tasks', () => new TaskListModel(ctx)),
    fileIntents: () => model('fileIntents', () => new FileIntentsModel(ctx)),
    fileIntent: async (id: string) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.fileIntent(id);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    resolveFileIntent: async (id: string, observed: string | null, action: 'retry' | 'discard') => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.resolveFileIntent(id, observed, action);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    session: (sessionId: number) => model(`session:${sessionId}`, () => new SessionModel(ctx, sessionId)),
    sessionPage: async (sessionId: number, before?: { createdAt: number; id: number; role?: string }) => {
      if (disposed) throw new Error('client_runtime_disposed');
      // Bind the request to the exact retained model BEFORE opening HTTP.
      // Never look up/create a different observation when its response arrives.
      const target = before ? model(`session:${sessionId}`, () => new SessionModel(ctx, sessionId)) : undefined;
      const fence = target?.beginPage();
      try {
        const result = await ctx.remote.clientRuntime.read({ kind: 'session', sessionId, ...(before ? { before } : {}) });
        if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
        if (disposed) throw new Error('client_runtime_disposed');
        const frame = TYPERT_REMOTE.methods['clientRuntime/watchSession'].result.create().parse(result.value);
        if (frame.type !== 'snapshot') throw new Error('protocol_session_baseline');
        target?.prepend(frame.value, fence);
        return frame.value;
      } finally { target?.endPage(fence); }
    },
    task: (taskId: string) => model(`task:${taskId}`, () => new TaskModel(ctx, taskId)),
    plugin: (request: Extract<RuntimeRead, { kind: 'plugin' | 'pluginQueries' }>) => model(JSON.stringify(request), () => new PluginInstanceModel(ctx, request)),
    read: async (request: RuntimeRead) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.read(request);
      if (disposed) throw new Error('client_runtime_disposed');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    },
    resources: (request: Extract<RuntimeRead, { kind: 'resources' | 'resourceTrash' }>) => model(JSON.stringify(request), () => new RuntimeModel(ctx, request)),
    document: (request: Extract<RuntimeRead, { kind: 'courseDocument' | 'systemDocument' | 'systemDirectory' }>) => model(JSON.stringify(request), () => new RuntimeModel(ctx, request)),
    savePluginLayout: async (request: import('@wangke/contracts/system').SavePluginLayout) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.savePluginLayout(request);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    },
    resourceCommand: async (request: import('@wangke/contracts/resources').ResourceCommand) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.resourceCommand(request);
      if (disposed) throw new Error('client_runtime_disposed');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, detail: result.error.details });
      return result.value;
    },
    preferences: () => model('preferences', () => new RuntimeModel(ctx, { kind: 'preferences' })),
    permissions: () => model('permissions', () => new RuntimeModel(ctx, { kind: 'permissions' })),
    setPreferences: async (request: PreferencesCommand) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.setPreferences(request);
      if (disposed) throw new Error('client_runtime_disposed');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, detail: result.error.details });
      return result.value;
    },
    command: async (request: RuntimeCommand) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.command(request);
      if (disposed) throw new Error('client_runtime_disposed');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    },
    receipt: async (operationId: string) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.receipt(operationId);
      if (disposed) throw new Error('client_runtime_disposed');
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      return result.value;
    },
    botJournal: (threadId: string, after: number, signal: AbortSignal) => {
      if (disposed) throw new Error('client_runtime_disposed');
      return ctx.remote.clientRuntime.watchBot(threadId, after, signal);
    },
    recordsPage: async (after: number) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.recordsPage(after);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    delegation: async (request: import('@wangke/contracts/client-runtime').DelegationCommand) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.delegation(request);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    submitTask: async (request: RuntimeTaskSubmit) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.submitTask(request);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    taskAdmission: async (operationId: string) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.taskAdmission(operationId);
      if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code });
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    editLearning: async (request: ClientLearningCommand) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const result = await ctx.remote.clientRuntime.editLearning(request);
      if (!result.ok) {
        if (result.error.code === 'client/record-conflict') throw Object.assign(new Error('sync_conflict'), { code: result.error.code, detail: result.error.details });
        throw Object.assign(new Error(result.error.message), { code: result.error.code, detail: result.error.details });
      }
      if (disposed) throw new Error('client_runtime_disposed');
      return result.value;
    },
    followRecords: (sink: { cursor(): Promise<number>; apply(page: RuntimeRecordsPage, signal: AbortSignal): Promise<void>; failed(error: unknown): void }) => {
      if (disposed) throw new Error('client_runtime_disposed');
      const open = () => ctx.remote.$stream<RuntimeRecordsPage>({
        name: 'records',
        open: async function* (signal) {
          const cursor = await sink.cursor();
          if (signal.aborted || disposed) return;
          yield* ctx.remote.clientRuntime.watchRecords(cursor, signal);
        },
        ended: () => new Error('protocol_records_ended'),
      });
      let source = open(), stopped = false, failures = 0;
      let retry: (() => void) | undefined;
      const stop = () => { stopped = true; void source.dispose(); retry?.(); };
      lifetime.signal.addEventListener('abort', stop, { once: true });
      const done = () => stopped || disposed;
      // Background sync heals itself: back off (1s → 30s) and resume from the
      // sink's committed cursor. An explicit restart (online, user flush) skips the wait.
      const backoff = () => new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); if (retry === wake) retry = undefined; resolve(); };
        const timer = setTimeout(wake, Math.min(30_000, 1_000 * 2 ** failures++));
        retry = wake;
      });
      void (async () => {
        try {
          while (!done()) {
            try {
              for await (const item of source) {
                // Disposal is terminal. Continuing an acknowledgement-driven source
                // without accepting its final frame can spin during pagehide and
                // prevent the browser from committing the next document.
                if (done() || source.signal.aborted) break;
                if (item.signal.aborted) continue;
                try {
                  await sink.apply(item.value, item.signal);
                  if (!item.signal.aborted) { item.accept(); failures = 0; }
                } catch (error) {
                  if (done() || source.signal.aborted) break;
                  if (item.signal.aborted) continue;
                  // A failure is not a license to skip the frame or its cursor:
                  // reopen from the last committed cursor after the backoff.
                  sink.failed(error);
                  await backoff();
                  if (!done()) source.restart();
                }
              }
            } catch (error) {
              // The transport gave up (e.g. repeated carrier loss). Recreate the
              // logical stream instead of freezing the cache until a reload.
              if (!done()) sink.failed(error);
            }
            if (done()) break;
            await backoff();
            if (done()) break;
            void source.dispose();
            source = open();
          }
        } finally { lifetime.signal.removeEventListener('abort', stop); await source.dispose(); }
      })();
      return { dispose: stop, restart: () => { if (retry) retry(); else source.restart(); } };
    },
    diagnostics: () => ({ identity, generation: connection.generation.getSnapshot()?.id,
      state: connection.state.getSnapshot(), models: [...models.values()].map(value => value.diagnostics()) }),
    dispose: async () => { if (disposed) return; disposed = true; lifetime.abort(new Error('client_runtime_disposed')); for (const value of models.values()) value.dispose(); models.clear(); await ctx.fiber.dispose(); },
  };
}
export type ClientRuntime = Awaited<ReturnType<typeof createClientRuntime>>;
