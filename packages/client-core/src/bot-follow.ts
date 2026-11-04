import type { BotActivityDto, BotSyncState, SseEvent } from '@wangke/contracts';
import { BotHistoryModel, mergeMessages, type BotThreadProjection } from './bot-history.js';

export interface BotFollowView {
  cursor: number; stateCursor: number; activityCursor: number;
  activity?: BotActivityDto | null; legacy: boolean; progress?: string;
  hasOlder: boolean; hasNewer: boolean; follow: boolean;
  anchor?: { key: string; offset: number };
}
export interface BotFollowPorts<T extends BotThreadProjection> {
  available(): boolean;
  current(): boolean;
  state(signal: AbortSignal): Promise<BotSyncState>;
  snapshot(signal: AbortSignal, before?: number): Promise<T & BotSyncState & { hasOlder: boolean }>;
  follow(after: number, receive: (event: SseEvent, cursor: number) => void, signal: AbortSignal, ready: () => void): Promise<void>;
  fatal(error: unknown): boolean;
  retryAfter(error: unknown): number;
  status(status: 'offline' | 'connecting' | 'live' | 'error'): void;
  announce(): void;
  changed(): void;
}

/** The domain owns cursor/state ordering, invalidation coalescing, backoff and
 * anchored recovery. Browser/HTTP/React are replaceable ports, not authorities. */
export class BotFollowModel<T extends BotThreadProjection> {
  private readonly control = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private legacyTimer?: ReturnType<typeof setInterval>;
  private flight = false;
  private dirty = false;
  private generation = 0;
  private stateFailures = 0;
  private failures = 0;
  private resyncs = 0;
  private announced = 0;
  constructor(private readonly history: BotHistoryModel<T>, private readonly id: string,
    private readonly view: BotFollowView, private readonly ports: BotFollowPorts<T>) {
    this.announced = history.getSnapshot()[id]?.messages.filter(message => !message.id.startsWith('pending-')).at(-1)?.seq ?? 0;
  }
  private get alive() { return !this.control.signal.aborted && this.ports.current(); }
  private pause(ms: number) {
    const signal = this.control.signal;
    return new Promise<void>(resolve => {
      if (signal.aborted) return resolve();
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
      const timer = setTimeout(done, ms);
      signal.addEventListener('abort', done, { once: true });
    });
  }
  private refresh = async () => {
    this.timer = undefined;
    if (!this.alive || !this.ports.available()) return;
    if (this.flight) { this.dirty = true; return; }
    this.flight = true; this.dirty = false;
    const generation = this.generation;
    try {
      const state = await this.ports.state(this.control.signal);
      if (this.alive) {
        if (generation !== this.generation) this.dirty = true;
        else if (state.eventCursor >= this.view.stateCursor) {
          this.view.stateCursor = state.eventCursor;
          if (state.eventCursor >= this.view.activityCursor) { this.view.activity = state.activity; this.view.activityCursor = state.eventCursor; }
          this.history.applyState(this.id, state, new Set([this.id])); this.ports.changed();
        }
        this.stateFailures = 0;
      }
    } catch (error) {
      if (this.ports.fatal(error)) { this.ports.status('error'); this.dispose(); }
      else if (this.alive) { this.dirty = true; this.stateFailures++; }
    } finally {
      this.flight = false;
      if (this.dirty && this.alive) this.timer = setTimeout(() => void this.refresh(), Math.min(30000, 200 * 2 ** Math.min(this.stateFailures, 7)));
    }
  };
  private invalidate() {
    this.generation++;
    if (!this.timer && !this.flight) this.timer = setTimeout(() => void this.refresh(), 80);
    else this.dirty = true;
  }
  private receive = (event: SseEvent, cursor: number) => {
    if (!this.alive) return;
    if (event.type === 'resync.required') throw new Error('sync_resync_required');
    if (cursor <= this.view.cursor) return;
    if (event.type === 'thread.state_invalidated') this.invalidate();
    if (event.type === 'thread.activity' && cursor > this.view.activityCursor) {
      this.view.activity = event.activity; this.view.activityCursor = cursor; this.ports.changed();
    }
    if ('message' in event) {
      const message = event.message;
      if (message.seq > this.announced && message.role === 'assistant' && message.kind !== 'progress') { this.announced = message.seq; this.ports.announce(); }
      if (message.role === 'assistant' && this.view.progress !== (message.kind === 'progress' ? message.content : undefined)) {
        this.view.progress = message.kind === 'progress' ? message.content : undefined; this.ports.changed();
      }
      Object.assign(this.view, this.history.append(this.id, message, this.view));
      if (this.view.legacy && (message.kind === 'approval' || message.kind === 'question')) this.invalidate();
    }
    this.view.cursor = cursor; this.failures = 0;
    this.ports.status(this.view.legacy ? 'connecting' : 'live');
  };
  private async connect() {
    while (this.alive) {
      if (!this.ports.available()) { this.ports.status('offline'); await this.pause(1000); continue; }
      this.ports.status('connecting');
      let retryAfter = 0;
      try {
        await this.ports.follow(this.view.cursor, this.receive, this.control.signal, () => { if (this.alive) this.ports.status('live'); });
      } catch (error) {
        if (!this.alive) break;
        if (this.ports.fatal(error)) {
          this.history.update(old => { const next = { ...old }; delete next[this.id]; return next; });
          this.ports.status('error'); this.dispose(); break;
        }
        retryAfter = this.ports.retryAfter(error);
        if (error instanceof Error && ['sync_resync_required', 'invalid_sync_event', 'sync_event_too_large'].includes(error.message)) {
          if (++this.resyncs > 2) { this.ports.status('error'); break; }
          try {
            const anchor = this.view.anchor;
            const message = !this.view.follow && anchor ? this.history.getSnapshot()[this.id]?.messages.find(item => item.id === anchor.key || `user-${item.clientNonce}` === anchor.key) : undefined;
            const before = message ? Math.min(Number.MAX_SAFE_INTEGER, message.seq + 25) : undefined;
            const snapshot = await this.ports.snapshot(this.control.signal, before);
            if (!this.alive) break;
            this.view.cursor = snapshot.eventCursor; this.view.stateCursor = snapshot.eventCursor;
            this.view.activity = snapshot.activity; this.view.activityCursor = snapshot.eventCursor;
            this.view.hasOlder = snapshot.hasOlder; this.view.hasNewer = Boolean(before);
            this.history.update(old => ({ ...old, [this.id]: { ...snapshot, messages: mergeMessages(snapshot.messages, old[this.id]?.messages.filter(item => item.id.startsWith('pending-')) ?? []) } }));
          } catch { if (this.alive) this.ports.status('error'); break; }
        }
      }
      if (!this.alive) break;
      this.ports.status('offline');
      await this.pause(Math.max(retryAfter, this.view.legacy ? 1800 : Math.min(30000, 500 * 2 ** Math.min(this.failures++, 6)) * (0.8 + Math.random() * 0.4)));
    }
  }
  start() {
    void this.refresh();
    if (this.view.legacy) this.legacyTimer = setInterval(() => void this.refresh(), 3000);
    void this.connect();
    return () => this.dispose();
  }
  dispose() { this.control.abort(); clearTimeout(this.timer); clearInterval(this.legacyTimer); }
}
