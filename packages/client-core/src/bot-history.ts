import type { BotMessagePage, BotSyncState, MessageDto, ThreadDto } from '@wangke/contracts';

export const sameMessage = (a: MessageDto, b: MessageDto) => a === b || a.id === b.id && a.seq === b.seq && a.content === b.content && a.kind === b.kind && a.role === b.role && a.createdAt === b.createdAt && a.clientNonce === b.clientNonce && a.replyTo === b.replyTo;

/** Identity merge, preserving unchanged entities and settling optimistic nonce keys. */
export function mergeMessages(current: MessageDto[], incoming: MessageDto[]): MessageDto[] {
  if (!incoming.length) return current;
  const ids = new Map(current.map(message => [message.id, message]));
  const nonces = new Map(current.filter(message => message.clientNonce).map(message => [message.clientNonce, message]));
  if (incoming.every((message, index) => message.seq > (index ? incoming[index - 1].seq : current.at(-1)?.seq ?? -1))
    && !incoming.some(message => ids.has(message.id) || message.clientNonce && nonces.has(message.clientNonce))) return current.concat(incoming);
  let changed = false;
  for (const message of incoming) {
    const previous = ids.get(message.id) ?? (message.clientNonce ? nonces.get(message.clientNonce) : undefined);
    if (previous && sameMessage(previous, message)) continue;
    if (previous && previous.id !== message.id) ids.delete(previous.id);
    ids.set(message.id, message); changed = true;
    if (message.clientNonce) nonces.set(message.clientNonce, message);
  }
  return changed ? [...ids.values()].sort((a, b) => a.seq - b.seq) : current;
}

export function mergeById<T extends { id: string; status?: string }>(current: T[] = [], incoming: T[] = []): T[] {
  if (!incoming.length) return current;
  const map = new Map(current.map(item => [item.id, item]));
  let changed = false;
  for (const item of incoming) {
    const previous = map.get(item.id);
    // Approval/question resolution is irreversible, including late page/POST replies.
    if (previous?.status && previous.status !== 'pending' && item.status === 'pending') continue;
    if (previous && JSON.stringify(previous) === JSON.stringify(item)) continue;
    map.set(item.id, item); changed = true;
  }
  return changed ? [...map.values()] : current;
}

export interface BotThreadProjection extends ThreadDto {
  messages: MessageDto[];
  approvals?: BotSyncState['approvals'];
  questions?: BotSyncState['questions'];
  runs?: BotSyncState['runs'];
  running?: boolean;
}

/** Account/server-scoped Bot projection. No React, browser storage or carrier.
 * The adapter owns reading anchors/drafts; BotFollowModel owns transport scheduling.
 * A pending send is never evicted merely to satisfy a cache budget. */
export class BotHistoryModel<T extends BotThreadProjection = BotThreadProjection> {
  private snapshot: Record<string, T> = {};
  private readonly listeners = new Set<() => void>();
  private readonly touched = new Map<string, number>();
  private readonly deferred = new Map<string, MessageDto[]>();
  private clock = 0;
  private disposed = false;
  constructor(readonly identity: Readonly<{ server: string; account: string; scope: string }>,
    private readonly limits = { threads: 8, bytes: 16 * 1024 * 1024 }) {
    this.identity = Object.freeze({ ...identity });
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    if (this.disposed) throw new Error('bot_model_disposed');
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  touch(id: string) { if (this.disposed) throw new Error('bot_model_disposed'); this.touched.set(id, ++this.clock); }
  update(value: Record<string, T> | ((current: Record<string, T>) => Record<string, T>), protectedIds: ReadonlySet<string> = new Set()) {
    if (this.disposed) throw new Error('bot_model_disposed');
    let next = typeof value === 'function' ? value(this.snapshot) : value;
    if (next === this.snapshot) return;
    for (const [id, detail] of Object.entries(next)) {
      if (detail === this.snapshot[id]) continue;
      const loaded = new Set(detail.messages.map(message => message.id));
      const approvals = detail.approvals?.filter(card => card.status === 'pending' || loaded.has(card.messageId));
      const questions = detail.questions?.filter(card => card.status === 'pending' || loaded.has(card.messageId));
      if (approvals?.length !== detail.approvals?.length || questions?.length !== detail.questions?.length) next = { ...next, [id]: { ...detail, approvals, questions } };
    }
    const added = new Set(Object.keys(next).filter(id => !this.snapshot[id]));
    let bytes = this.bytes(next), count = Object.keys(next).length;
    for (const [id, detail] of Object.entries(next).sort(([a], [b]) => (this.touched.get(a) ?? 0) - (this.touched.get(b) ?? 0))) {
      if (count <= this.limits.threads && bytes <= this.limits.bytes) break;
      if (protectedIds.has(id) || added.has(id) || detail.messages.some(message => message.id.startsWith('pending-'))) continue;
      // Never mutate the caller's record, including updater return values.
      next = { ...next };
      delete next[id]; count--; bytes -= this.threadBytes(detail);
    }
    this.snapshot = next;
    for (const id of this.touched.keys()) if (!next[id]) this.touched.delete(id);
    for (const id of this.deferred.keys()) if (!next[id]) this.deferred.delete(id);
    for (const listener of this.listeners) listener();
  }
  patch(id: string, update: (detail: T) => T, protectedIds?: ReadonlySet<string>) {
    this.update(old => {
      if (!old[id]) return old;
      const next = update(old[id]);
      return next === old[id] ? old : { ...old, [id]: next };
    }, protectedIds);
  }
  applyState(id: string, state: BotSyncState, protectedIds?: ReadonlySet<string>) {
    this.patch(id, old => ({ ...old, ...state.thread, runs: state.runs, running: state.running,
      approvals: mergeById(old.approvals, state.approvals), questions: mergeById(old.questions, state.questions) }), protectedIds);
  }
  /** Apply a durable message without moving a reader's window to the latest tail. */
  append(id: string, message: MessageDto, viewport: { follow: boolean; hasOlder: boolean; hasNewer: boolean }) {
    if (this.disposed) throw new Error('bot_model_disposed');
    const next = { follow: viewport.follow, hasOlder: viewport.hasOlder, hasNewer: viewport.hasNewer };
    if (message.role === 'assistant' && message.kind === 'progress') return next;
    if (!next.hasNewer) this.patch(id, old => {
      let messages = mergeMessages(old.messages, [message]);
      if (messages === old.messages) return old;
      if (messages.length > 1000 && next.follow) {
        const pending = messages.slice(0, -1000).filter(message => message.id.startsWith('pending-'));
        messages = pending.concat(messages.slice(-1000)); next.hasOlder = true;
      }
      else if (messages.length > 1000) { next.hasNewer = true; messages = old.messages; }
      return { ...old, messages, updatedAt: message.createdAt > old.updatedAt ? message.createdAt : old.updatedAt };
    }, new Set([id]));
    if (next.hasNewer) this.deferred.set(id, mergeMessages(this.deferred.get(id) ?? [], [message]).slice(-1000));
    return next;
  }
  prepend(id: string, page: BotMessagePage, hasNewer: boolean) {
    this.patch(id, old => {
      let messages = mergeMessages(old.messages, page.messages);
      if (messages.length > 1000) {
        messages = messages.slice(0, 1000).concat(messages.slice(1000).filter(message => message.id.startsWith('pending-')));
        hasNewer = true;
      }
      return { ...old, messages, approvals: mergeById(old.approvals, page.approvals), questions: mergeById(old.questions, page.questions) };
    }, new Set([id]));
    return { hasOlder: page.hasOlder, hasNewer };
  }
  latest(id: string, page: BotMessagePage) {
    const pageIds = new Set(page.messages.map(message => message.id));
    const latestSeq = page.messages.at(-1)?.seq ?? 0;
    this.patch(id, old => ({ ...old,
      messages: mergeMessages(mergeMessages(page.messages, this.deferred.get(id)?.filter(message => message.seq > latestSeq || pageIds.has(message.id)) ?? []),
        old.messages.filter(message => message.id.startsWith('pending-') || message.seq > latestSeq)),
      approvals: mergeById(old.approvals, page.approvals), questions: mergeById(old.questions, page.questions),
    }), new Set([id]));
    this.deferred.delete(id);
  }
  private threadBytes(detail: T) { return detail.messages.reduce((sum, message) => sum + message.content.length * 2, 0); }
  private bytes(details: Record<string, T>) { return Object.values(details).reduce((sum, detail) => sum + this.threadBytes(detail), 0); }
  diagnostics() { return { identity: this.identity, threads: Object.keys(this.snapshot).length, estimatedContentBytes: this.bytes(this.snapshot), listeners: this.listeners.size }; }
  dispose() { if (this.disposed) return; this.disposed = true; this.snapshot = {}; this.touched.clear(); this.deferred.clear(); for (const listener of this.listeners) listener(); this.listeners.clear(); }
}
