export interface SessionQueueItem<Attachment> {
  modelSelection?: import('@wangke/contracts/cloud').TaskModelSelection;
  thinkingLevel?: import('@wangke/contracts/cloud').ModelThinkingLevel;
  id: string;
  /** Stable command identity, also used after reload and explicit retry. */
  operationId?: string;
  state?: 'pending' | 'accepted' | 'uncertain';
  draftOwner?: string;
  action?: 'continue';
  rowId?: number;
  createdAt?: number;
  text: string;
  attachments?: Attachment[];
  explicitSkillIds?: number[];
}

export interface SessionQueuePort<Attachment> {
  failed?(error: unknown): void;
  persistence?: {
    save(sessionId: number, item: SessionQueueItem<Attachment>): Promise<void>;
    remove(sessionId: number, ids: string[]): Promise<void>;
    list(sessionId: number): Promise<SessionQueueItem<Attachment>[]>;
  };
  read(sessionId: number): {
    queued: SessionQueueItem<Attachment>[];
    loading: boolean;
    loaded: boolean;
    pendingAsk: unknown;
  };
  replace(sessionId: number, items: SessionQueueItem<Attachment>[]): void;
  nextId(): string;
  send(sessionId: number, item: SessionQueueItem<Attachment>): Promise<void>;
  steer(sessionId: number, item: SessionQueueItem<Attachment>): Promise<void>;
  attachmentId(attachment: Attachment): string;
  releaseAttachment(attachment: Attachment): Promise<void>;
}

/** Queue policy and attachment ownership, independent of the UI, storage and
 * execution carrier. The port must replace synchronously: a dispatch removes
 * its item before invoking a possibly reentrant executor. No uncertain send is
 * automatically put back into the queue or replayed. */
export class SessionQueueModel<Attachment> {
  static commands<A, R, T extends { id: string }>(journal: SessionCommandJournal<A, R>, port: ConstructorParameters<typeof SessionCommandQueue<A, R, T>>[1]) {
    return new SessionCommandQueue<A, R, T>(journal, port);
  }
  private writes: Promise<void> = Promise.resolve();
  private failure: unknown;
  private revisions = new Map<number, number>();
  private draining = new Set<number>();
  private lastEnqueued = 0;
  constructor(private readonly port: SessionQueuePort<Attachment>) {}

  private replace(sessionId: number, items: SessionQueueItem<Attachment>[]) {
    this.revisions.set(sessionId, (this.revisions.get(sessionId) ?? 0) + 1);
    this.port.replace(sessionId, items);
  }

  private persist(write: () => Promise<void>) {
    this.writes = this.writes.then(write).catch(error => { this.failure = error; this.port.failed?.(error); });
  }
  async flush() { await this.writes; if (this.failure) throw this.failure; }
  async restore(sessionId: number) {
    if (!this.port.persistence) return;
    const revision = this.revisions.get(sessionId);
    await this.flush();
    const queued = await this.port.persistence.list(sessionId);
    if (revision === this.revisions.get(sessionId)) {
      this.lastEnqueued = Math.max(this.lastEnqueued, ...queued.map(item => item.createdAt ?? 0));
      this.replace(sessionId, queued);
    }
  }

  enqueue(sessionId: number, text: string, attachments: Attachment[] = [], explicitSkillIds: number[] = [], existing?: SessionQueueItem<Attachment>): void {
    const next = text.trim();
    if (!next) return;
    const id = existing?.id ?? this.port.nextId();
    const createdAt = this.lastEnqueued = Math.max(Date.now(), this.lastEnqueued + 1);
    const item = { id, operationId: id, state: 'pending' as const, createdAt, ...existing, text: next, attachments, explicitSkillIds };
    this.replace(sessionId, [...this.port.read(sessionId).queued, item]);
    const persistence = this.port.persistence;
    if (persistence) this.persist(() => persistence.save(sessionId, item));
  }

  remove(sessionId: number, id: string): void {
    const items = this.port.read(sessionId).queued;
    const item = items.find(item => item.id === id);
    if (!item) return;
    if (item.state && item.state !== 'pending') return;
    const rest = items.filter(item => item.id !== id);
    this.replace(sessionId, rest);
    const persistence = this.port.persistence;
    if (persistence) this.persist(async () => { await persistence.remove(sessionId, [id]); await this.release([item], rest); });
    else void this.release([item], rest);
  }

  update(sessionId: number, id: string, text: string): void {
    const next = text.trim(), items = this.port.read(sessionId).queued;
    if (!next && !items.find(item => item.id === id)?.attachments?.length) {
      this.remove(sessionId, id);
      return;
    }
    const item = items.find(item => item.id === id);
    if (!item || item.state && item.state !== 'pending') return;
    const updated = { ...item, text: next };
    this.replace(sessionId, items.map(item => item.id === id ? updated : item));
    const persistence = this.port.persistence;
    if (persistence) this.persist(() => persistence.save(sessionId, updated));
  }

  clear(sessionId: number): void {
    const items = this.port.read(sessionId).queued;
    const removed = items.filter(item => !item.state || item.state === 'pending');
    const retained = items.filter(item => item.state && item.state !== 'pending');
    this.replace(sessionId, retained);
    const persistence = this.port.persistence;
    if (persistence) this.persist(async () => { await persistence.remove(sessionId, removed.map(item => item.id)); await this.release(removed, retained); });
    else void this.release(removed, retained);
  }

  async sendNow(sessionId: number, id: string): Promise<void> {
    await this.flush();
    const items = this.port.read(sessionId).queued;
    const item = items.find(item => item.id === id);
    if (!item) return;
    this.replace(sessionId, items.filter(item => item.id !== id));
    await this.port.steer(sessionId, { ...item, text: item.text || '请分析这些附件。' });
  }

  drain(sessionId: number): void {
    if (this.draining.has(sessionId)) return;
    const view = this.port.read(sessionId);
    if (view.loading || !view.loaded || view.pendingAsk || !view.queued.length) return;
    const [next, ...rest] = view.queued;
    if (next.state && next.state !== 'pending') return;
    this.draining.add(sessionId);
    this.replace(sessionId, rest);
    const send = () => this.port.send(sessionId, next);
    try {
      void (this.port.persistence ? this.flush().then(send, error => {
        this.replace(sessionId, [next, ...this.port.read(sessionId).queued]);
        throw error;
      }) : send()).then(() => {
        this.draining.delete(sessionId);
        this.drain(sessionId);
      }, () => { this.draining.delete(sessionId); });
    } catch { this.draining.delete(sessionId); }
  }

  async release(items: SessionQueueItem<Attachment>[], retained: SessionQueueItem<Attachment>[] = []): Promise<void> {
    const keep = new Set(retained.flatMap(item => (item.attachments ?? []).map(this.port.attachmentId)));
    const files = new Map<string, Attachment>();
    for (const item of items) for (const file of item.attachments ?? []) {
      const id = this.port.attachmentId(file);
      if (!keep.has(id)) files.set(id, file);
    }
    await Promise.allSettled([...files.values()].map(file => this.port.releaseAttachment(file)));
  }
}

export interface SessionCommandRecord<Attachment, Request> {
  sessionId: number;
  item: SessionQueueItem<Attachment>;
  request?: Request;
  state: 'pending' | 'accepted' | 'uncertain';
  taskId?: string;
  attempt?: number;
}
/** atomic() is an IO port: it must serialize read/modify/write across realms.
 * A claim is never timed out. A dead claimant is uncertain, not safe to replay. */
export interface SessionCommandJournal<Attachment, Request> {
  atomic<T>(operationId: string, change: (record: SessionCommandRecord<Attachment, Request> | undefined) => { record?: SessionCommandRecord<Attachment, Request>; value: T }): Promise<T>;
}

export class SessionCommandQueue<Attachment, Request, Task extends { id: string }> {
  constructor(private readonly journal: SessionCommandJournal<Attachment, Request>, private readonly port: {
    current(): boolean;
    receipt(operationId: string): Promise<{ status: string; task?: Task }>;
    submit(request: Request, operationId: string): Promise<Task>;
    prepare?(request: Request, item: SessionQueueItem<Attachment>): Request;
  }) {}

  async execute(sessionId: number, item: SessionQueueItem<Attachment>, request: Request, explicitRetry = false): Promise<Task> {
    const operationId = item.operationId ?? item.id;
    const check = () => { if (!this.port.current()) throw new Error('client_account_changed'); };
    check();
    // Admission lookup is read-only even when this realm did not win the claim.
    const previous = await this.journal.atomic(operationId, record => ({ record, value: record }));
    check();
    if (previous?.state !== 'pending' && previous) {
      const receipt = await this.port.receipt(operationId);
      check();
      if (receipt.status === 'accepted' && receipt.task) {
        await this.accept(operationId, receipt.task.id);
        return receipt.task;
      }
      if (!explicitRetry || receipt.status !== 'missing') throw new Error('task_admission_uncertain');
    }
    const claimed = await this.journal.atomic(operationId, record => {
      check();
      if (record && record.state !== 'pending' && (!explicitRetry || record.state === 'accepted' || record.attempt !== previous?.attempt)) return { record, value: undefined };
      const next = { item, ...record, sessionId, request: record?.request ?? (this.port.prepare?.(request, record?.item ?? item) ?? request), state: 'uncertain' as const, attempt: (record?.attempt ?? 0) + 1 };
      return { record: next, value: next };
    });
    check();
    if (!claimed) throw new Error('task_admission_uncertain');
    // The claim is durable BEFORE external IO. Crashes on either side of submit
    // therefore require receipt recovery or explicit original-command retry.
    const task = await this.port.submit(claimed.request!, operationId);
    check();
    await this.accept(operationId, task.id);
    return task;
  }

  private accept(operationId: string, taskId: string) {
    return this.journal.atomic(operationId, record => ({ record: record ? { ...record, state: 'accepted', taskId } : record, value: undefined }));
  }
}
