import { Context } from '@deepseek-ai/cordis';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { RuntimeCommand, RuntimeJson, RuntimeRead, RuntimeSnapshot, RuntimeFrame, RuntimeTaskFrame, RuntimeTasksFrame, RuntimeReceipt, BotJournalFrame } from '@wangke/contracts/client-runtime';
import type { RuntimeRecordsPage, RuntimeRecordsCommit, RuntimeRecordsReceipt } from '@wangke/contracts/client-runtime';
import type { RuntimeSessionFrame } from '@wangke/contracts/client-runtime';
import type { SessionJournalRequest, SessionJournalFrame } from '@wangke/contracts/client-runtime';
import type { RuntimeTaskSubmit, RuntimeTask } from '@wangke/contracts/client-runtime';
import type { RuntimeTaskAdmission } from '@wangke/contracts/client-runtime';
import type { RuntimeFileIntent, RuntimeFileIntentsFrame } from '@wangke/contracts/client-runtime';
import type { PreferencesCommand, PreferencesProjection } from '@wangke/contracts/client-runtime';
import type { ResourceCommand } from '@wangke/contracts/resources';
import type { SavePluginLayout, SystemDocument } from '@wangke/contracts/system';
import type { ExecutorReport, ExecutorCompletion, ExecutorCompletionReceipt } from '@wangke/contracts/client-runtime';
import type { ExecutorArtifacts, ExecutorResourceCommand } from '@wangke/contracts/client-runtime';
import type { ClientLearningCommand } from '@wangke/contracts/client-runtime';
import type { ExecutorBlobAdmission } from '@wangke/contracts/client-runtime';
import type { ExecutorConversationReset, ExecutorConversationResetReceipt, ExecutorInteractionsFrame, ExecutorInteractionDelivery, ExecutorInteractionReceipt, ExecutorAuthorizationFrame } from '@wangke/contracts/client-runtime';

export interface ExecutorDomain {
  beginExecution(ctx: Context, taskId: string): Promise<RuntimeJson>;
  watchAuthorization(ctx: Context, taskId: string, permissionId: string, signal: AbortSignal): AsyncIterable<ExecutorAuthorizationFrame>;
  resetConversation(ctx: Context, request: ExecutorConversationReset): Promise<ExecutorConversationResetReceipt>;
  watchInteractions(ctx: Context, taskId: string, signal: AbortSignal): AsyncIterable<ExecutorInteractionsFrame>;
  deliverInteraction(ctx: Context, request: ExecutorInteractionDelivery): Promise<ExecutorInteractionReceipt>;
  admitBlob(ctx: Context, request: ExecutorBlobAdmission): Promise<RuntimeJson>;
  resourceCommand(ctx: Context, request: ExecutorResourceCommand): Promise<RuntimeJson>;
  commitArtifacts(ctx: Context, request: ExecutorArtifacts): Promise<RuntimeRecordsReceipt>;
  read(ctx: Context, taskId: string): Promise<RuntimeTask>;
  report(ctx: Context, request: ExecutorReport): Promise<{ leaseExpiresAt: string }>;
  complete(ctx: Context, request: ExecutorCompletion): Promise<ExecutorCompletionReceipt>;
  receipt(ctx: Context, taskId: string, operationId: string): Promise<RuntimeReceipt>;
}

/** Task/lease capability service, never an account principal.
 * @typert service executorRuntime
 */
export class ExecutorRuntimeService extends TypertRemoteService {
  @Remote
  beginExecution(taskId: string): Promise<RuntimeJson> { return this.domain.beginExecution(this.ctx, taskId); }
  constructor(ctx: Context, private readonly domain: ExecutorDomain) { super(ctx, 'executorRuntime'); }
  @Remote({ mode: 'stream' })
  async *watchAuthorization(taskId: string, permissionId: string, signal: AbortSignal): AsyncIterable<ExecutorAuthorizationFrame> {
    yield* this.domain.watchAuthorization(this.ctx, taskId, permissionId, signal);
  }
  @Remote
  resetConversation(request: ExecutorConversationReset): Promise<ExecutorConversationResetReceipt> { return this.domain.resetConversation(this.ctx, request); }
  @Remote
  deliverInteraction(request: ExecutorInteractionDelivery): Promise<ExecutorInteractionReceipt> { return this.domain.deliverInteraction(this.ctx, request); }
  @Remote({ mode: 'stream' })
  async *watchInteractions(taskId: string, signal: AbortSignal): AsyncIterable<ExecutorInteractionsFrame> {
    yield* this.domain.watchInteractions(this.ctx, taskId, signal);
  }
  @Remote
  admitBlob(request: ExecutorBlobAdmission): Promise<RuntimeJson> { return this.domain.admitBlob(this.ctx, request); }
  @Remote
  resourceCommand(request: ExecutorResourceCommand): Promise<RuntimeJson> { return this.domain.resourceCommand(this.ctx, request); }
  @Remote
  commitArtifacts(request: ExecutorArtifacts): Promise<RuntimeRecordsReceipt> { return this.domain.commitArtifacts(this.ctx, request); }
  @Remote
  read(taskId: string): Promise<RuntimeTask> { return this.domain.read(this.ctx, taskId); }
  @Remote
  report(request: ExecutorReport): Promise<{ leaseExpiresAt: string }> { return this.domain.report(this.ctx, request); }
  @Remote
  complete(request: ExecutorCompletion): Promise<ExecutorCompletionReceipt> { return this.domain.complete(this.ctx, request); }
  @Remote
  receipt(taskId: string, operationId: string): Promise<RuntimeReceipt> { return this.domain.receipt(this.ctx, taskId, operationId); }
}

/** The API owns the implementation; this seam carries no credentials or database. */
export interface RuntimeDomain {
  reconcileInteraction(owner: string, request: import('@wangke/contracts/client-runtime').InteractionReconcile): Promise<RuntimeJson>;
  editLearning(owner: string, request: ClientLearningCommand): Promise<RuntimeRecordsReceipt>;
  savePluginLayout(owner: string, request: SavePluginLayout): Promise<SystemDocument>;
  resourceCommand(owner: string, request: ResourceCommand): Promise<RuntimeJson>;
  setPreferences(owner: string, request: PreferencesCommand): Promise<PreferencesProjection>;
  read(owner: string, request: RuntimeRead): Promise<RuntimeSnapshot>;
  watch(owner: string, request: RuntimeRead, signal: AbortSignal): AsyncIterable<RuntimeFrame>;
  watchTask(owner: string, taskId: string, signal: AbortSignal): AsyncIterable<RuntimeTaskFrame>;
  watchTasks(owner: string, signal: AbortSignal): AsyncIterable<RuntimeTasksFrame>;
  command(owner: string, request: RuntimeCommand): Promise<RuntimeJson>;
  receipt(owner: string, operationId: string): Promise<RuntimeReceipt>;
  watchBot(owner: string, threadId: string, after: number, signal: AbortSignal): AsyncIterable<BotJournalFrame>;
  recordsPage(owner: string, after: number): Promise<RuntimeRecordsPage>;
  watchRecords(owner: string, after: number, signal: AbortSignal): AsyncIterable<RuntimeRecordsPage>;
  commitRecords(owner: string, request: RuntimeRecordsCommit): Promise<RuntimeRecordsReceipt>;
  watchSession(owner: string, request: Extract<RuntimeRead, { kind: 'session' }>, signal: AbortSignal): AsyncIterable<RuntimeSessionFrame>;
  watchSessionJournal(owner: string, request: SessionJournalRequest, signal: AbortSignal): AsyncIterable<SessionJournalFrame>;
  submitTask(owner: string, request: RuntimeTaskSubmit): Promise<RuntimeTask>;
  taskAdmission(owner: string, operationId: string): Promise<RuntimeTaskAdmission>;
  fileIntent(owner: string, id: string): Promise<RuntimeFileIntent | null>;
  resolveFileIntent(owner: string, id: string, observed: string | null, action: 'retry' | 'discard'): Promise<RuntimeFileIntent>;
  watchFileIntents(owner: string, signal: AbortSignal): AsyncIterable<RuntimeFileIntentsFrame>;
  owner(ctx: Context): string;
}

/**
 * Account-authorized facade over existing domain services.
 * @typert service clientRuntime
 */
export class ClientRuntimeService extends TypertRemoteService {
  @Remote
  reconcileInteraction(request: import('@wangke/contracts/client-runtime').InteractionReconcile): Promise<RuntimeJson> { return this.domain.reconcileInteraction(this.domain.owner(this.ctx), request); }
  @Remote
  editLearning(request: ClientLearningCommand): Promise<RuntimeRecordsReceipt> { return this.domain.editLearning(this.domain.owner(this.ctx), request); }
  @Remote
  savePluginLayout(request: SavePluginLayout): Promise<SystemDocument> { return this.domain.savePluginLayout(this.domain.owner(this.ctx), request); }
  @Remote
  resourceCommand(request: ResourceCommand): Promise<RuntimeJson> { return this.domain.resourceCommand(this.domain.owner(this.ctx), request); }
  private readonly domain: RuntimeDomain;
  constructor(ctx: Context, domain: RuntimeDomain) {
    super(ctx, 'clientRuntime');
    this.domain = domain;
  }

  @Remote
  setPreferences(request: PreferencesCommand): Promise<PreferencesProjection> {
    return this.domain.setPreferences(this.domain.owner(this.ctx), request);
  }

  @Remote
  fileIntent(id: string): Promise<RuntimeFileIntent | null> {
    return this.domain.fileIntent(this.domain.owner(this.ctx), id);
  }

  @Remote({ mode: 'stream' })
  async *watchFileIntents(signal: AbortSignal): AsyncIterable<RuntimeFileIntentsFrame> {
    for await (const frame of this.domain.watchFileIntents(this.domain.owner(this.ctx), signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote
  resolveFileIntent(id: string, observed: string | null, action: 'retry' | 'discard'): Promise<RuntimeFileIntent> {
    return this.domain.resolveFileIntent(this.domain.owner(this.ctx), id, observed, action);
  }

  @Remote
  taskAdmission(operationId: string): Promise<RuntimeTaskAdmission> {
    return this.domain.taskAdmission(this.domain.owner(this.ctx), operationId);
  }

  @Remote
  submitTask(request: RuntimeTaskSubmit): Promise<RuntimeTask> {
    return this.domain.submitTask(this.domain.owner(this.ctx), request);
  }

  @Remote
  recordsPage(after: number): Promise<RuntimeRecordsPage> {
    return this.domain.recordsPage(this.domain.owner(this.ctx), after);
  }

  @Remote
  commitRecords(request: RuntimeRecordsCommit): Promise<RuntimeRecordsReceipt> {
    return this.domain.commitRecords(this.domain.owner(this.ctx), request);
  }

  @Remote({ mode: 'stream' })
  async *watchSessionJournal(request: SessionJournalRequest, signal: AbortSignal): AsyncIterable<SessionJournalFrame> {
    for await (const frame of this.domain.watchSessionJournal(this.domain.owner(this.ctx), request, signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote({ mode: 'stream' })
  async *watchSession(request: Extract<RuntimeRead, { kind: 'session' }>, signal: AbortSignal): AsyncIterable<RuntimeSessionFrame> {
    for await (const frame of this.domain.watchSession(this.domain.owner(this.ctx), request, signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote({ mode: 'stream' })
  async *watchRecords(after: number, signal: AbortSignal): AsyncIterable<RuntimeRecordsPage> {
    for await (const page of this.domain.watchRecords(this.domain.owner(this.ctx), after, signal)) {
      this.domain.owner(this.ctx);
      yield page;
    }
  }

  @Remote
  read(request: RuntimeRead): Promise<RuntimeSnapshot> {
    return this.domain.read(this.domain.owner(this.ctx), request);
  }

  @Remote({ mode: 'stream' })
  async *watch(request: RuntimeRead, signal: AbortSignal): AsyncIterable<RuntimeFrame> {
    for await (const frame of this.domain.watch(this.domain.owner(this.ctx), request, signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote
  command(request: RuntimeCommand): Promise<RuntimeJson> {
    return this.domain.command(this.domain.owner(this.ctx), request);
  }

  @Remote
  receipt(operationId: string): Promise<RuntimeReceipt> {
    return this.domain.receipt(this.domain.owner(this.ctx), operationId);
  }

  @Remote({ mode: 'stream' })
  async *watchBot(threadId: string, after: number, signal: AbortSignal): AsyncIterable<BotJournalFrame> {
    for await (const frame of this.domain.watchBot(this.domain.owner(this.ctx), threadId, after, signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote({ mode: 'stream' })
  async *watchTasks(signal: AbortSignal): AsyncIterable<RuntimeTasksFrame> {
    for await (const frame of this.domain.watchTasks(this.domain.owner(this.ctx), signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }

  @Remote({ mode: 'stream' })
  async *watchTask(taskId: string, signal: AbortSignal): AsyncIterable<RuntimeTaskFrame> {
    for await (const frame of this.domain.watchTask(this.domain.owner(this.ctx), taskId, signal)) {
      this.domain.owner(this.ctx);
      yield frame;
    }
  }
}
