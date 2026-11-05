import { SessionTimelineModel, shareSessionValue, type SessionMessage, type SessionRow } from './session.js';

/** React/platform-free per-session presentation state. The browser adapter
 * injects scheduling; durable facts and optimistic commands share one owner. */
export class SessionStateModel<State extends object> {
  private listeners = new Set<() => void>();
  private pending?: () => void;
  private disposed = false;
  constructor(private value: State, private readonly schedule?: (publish: () => void) => () => void) {}
  getSnapshot = () => this.value;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  subscribeSelector<T>(selector: (state: State) => T, listener: () => void) {
    let previous = selector(this.value);
    return this.subscribe(() => { const next = selector(this.value); if (!Object.is(previous, next)) { previous = next; listener(); } });
  }
  set(patch: Partial<State>, deferred = false) {
    if (this.disposed || !Object.keys(patch).some(key => !Object.is(this.value[key as keyof State], patch[key as keyof State]))) return;
    const next = shareSessionValue(this.value, { ...this.value, ...patch });
    if (next === this.value) return;
    this.value = next;
    if (deferred && this.schedule) { this.pending ??= this.schedule(() => { this.pending = undefined; this.publish(); }); }
    else { this.pending?.(); this.pending = undefined; this.publish(); }
  }
  private publish() { for (const listener of this.listeners) listener(); }
  dispose() { this.disposed = true; this.pending?.(); this.pending = undefined; this.listeners.clear(); }
}

export class ConversationSessionModel<State extends object, Message extends SessionMessage, Row extends SessionRow> extends SessionStateModel<State> {
  readonly timeline: SessionTimelineModel<Message, Row>;
  constructor(readonly sessionId: number, initial: State, convert: (row: Row) => Message, schedule?: (publish: () => void) => () => void) {
    super(initial, schedule);
    this.timeline = new SessionTimelineModel(sessionId, convert);
  }
  override dispose() { this.timeline.dispose(); super.dispose(); }
}
