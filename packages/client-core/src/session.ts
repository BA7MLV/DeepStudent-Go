import type { RuntimeTask } from '@wangke/contracts/client-runtime';
import type { RuntimeSessionProjection, SessionJournalFrame } from '@wangke/contracts/client-runtime';

/** A cursor belongs to this account Runtime incarnation. Incomplete baselines
 * and rejected event ranges never advance it; reconnect can replay safely. */
export class SessionJournalModel {
  cursor?: number;
  private value?: RuntimeSessionProjection;
  private baseline?: { cursor: number; value: RuntimeSessionProjection };
  constructor(private readonly sessionId?: number) {}
  reconnect() { this.baseline = undefined; }
  apply(frame: SessionJournalFrame): RuntimeSessionProjection | undefined {
    if (frame.type === 'resync-required') { this.baseline = undefined; return; }
    if (frame.type === 'baseline') {
      this.baseline = { cursor: frame.cursor, value: { session: frame.session, tasks: frame.tasks, rows: [], hasOlder: frame.hasOlder } };
      return;
    }
    if (frame.type === 'rows' || frame.type === 'ready') {
      if (!this.baseline || this.baseline.cursor !== frame.cursor) throw new Error('protocol_session_baseline');
      if (frame.type === 'rows') {
        const ids = new Set(this.baseline.value.rows.map(row => row.id));
        for (const row of frame.rows) {
          if (ids.has(row.id) || this.sessionId !== undefined && row.sessionId !== this.sessionId) throw new Error('protocol_session_row_identity');
          ids.add(row.id);
        }
        this.baseline.value.rows.push(...frame.rows); return;
      }
      this.value = this.baseline.value;
      this.baseline = undefined;
      return this.value;
    }
    if (!this.value || this.baseline || frame.baseCursor !== this.cursor || frame.cursor !== frame.baseCursor + frame.events.length
      || frame.events.some((event, index) => event.cursor !== frame.baseCursor + index + 1)) throw new Error('protocol_session_journal_gap');
    const rows = new Map(this.value.rows.map(row => [row.id, row]));
    for (const event of frame.events) {
      if (event.row && (event.row.id !== event.rowId || this.sessionId !== undefined && event.row.sessionId !== this.sessionId)) throw new Error('protocol_session_row_identity');
      if (event.row) rows.set(event.rowId, event.row); else rows.delete(event.rowId);
    }
    this.value = { ...this.value, session: frame.session, tasks: frame.tasks,
      rows: [...rows.values()].sort((a, b) => a.createdAt - b.createdAt || Number(a.role !== 'user') - Number(b.role !== 'user') || a.id - b.id) };
    return this.value;
  }
  commit(cursor: number) { this.cursor = cursor; }
}

export interface SessionMessage {
  key: string;
  role: 'user' | 'ai';
  content: string;
  rowId?: number;
  committedRowId?: number;
  taskId?: string;
  createdAt?: number;
  streaming?: boolean;
  syncPending?: boolean;
}
export interface SessionRow { id?: number; sessionId: number; createdAt: number; taskId?: string; role: string }

/** Conversation facts and reconciliation, independent of React, IndexedDB and
 * presentation payload types. The adapters only decode rows/render progress. */
export class SessionTimelineModel<Message extends SessionMessage, Row extends SessionRow> {
  private value: Message[] = [];
  private generation = 0;
  private disposed = false;
  private readonly commands = new Map<string, { status: 'pending' | 'accepted' | 'uncertain'; taskId?: string }>();
  constructor(readonly sessionId: number, private readonly convert: (row: Row) => Message) {}
  getSnapshot = () => this.value;
  invalidate() { return ++this.generation; }
  current(generation: number) { return !this.disposed && generation === this.generation; }
  begin(operationId: string) { if (this.disposed) throw new Error('session_disposed'); this.commands.set(operationId, { status: 'pending' }); }
  accept(operationId: string, taskId: string) { if (!this.disposed) this.commands.set(operationId, { status: 'accepted', taskId }); }
  uncertain(operationId: string) { if (!this.disposed) this.commands.set(operationId, { status: 'uncertain' }); }
  settle(operationId: string) { this.commands.delete(operationId); }
  pendingCommands() { return [...this.commands].map(([operationId, state]) => ({ operationId, ...state })); }
  reconcile(previous: Message[], incoming: Row[]): Message[] {
    if (this.disposed) throw new Error('session_disposed');
    const rows = new Map(incoming.filter(row => row.sessionId === this.sessionId).map(row => [row.id!, row]));
    const byTask = new Map([...rows.values()].filter(row => row.taskId).map(row => [`${row.taskId}:${row.role}`, row]));
    const messages: Message[] = [];
    for (const message of previous) {
      const id = message.rowId ?? message.committedRowId;
      const row = (id == null ? undefined : rows.get(id)) ?? (message.taskId ? byTask.get(`${message.taskId}:${message.role === 'ai' ? 'assistant' : 'user'}`) : undefined);
      if (row) {
        messages.push({ ...this.convert(row), key: message.key, streaming: false, syncPending: false });
        rows.delete(row.id!);
      } else if (message.rowId == null || message.syncPending || message.streaming) messages.push(message);
    }
    const seen = new Set(messages.flatMap(message => message.rowId == null ? [] : [message.rowId]));
    for (const row of [...rows.values()].filter(row => !seen.has(row.id!)).sort((a, b) => a.createdAt - b.createdAt || Number(a.role !== 'user') - Number(b.role !== 'user') || a.id! - b.id!)) {
      const index = messages.findIndex(message => (message.createdAt ?? Infinity) - row.createdAt > 0
        || message.createdAt === row.createdAt && (Number(message.role !== 'user') - Number(row.role !== 'user') > 0
          || (message.role === 'user') === (row.role === 'user') && (message.rowId ?? Infinity) > row.id!));
      messages.splice(index < 0 ? messages.length : index, 0, this.convert(row));
    }
    this.value = messages;
    return messages;
  }
  /** Stable optimistic/task identities also cover continue-in-place turns. */
  progress(previous: Message[], task: RuntimeTask, user: Message | undefined, answer: Message): Message[] {
    const messages = [...previous];
    if (user && !messages.some(message => message.key === user.key || message.taskId === task.id && message.role === 'user')) messages.push(user);
    const index = messages.findIndex(message => message.key === answer.key || message.taskId === task.id && message.role === 'ai'
      || task.input.action === 'continue' && message.rowId === task.input.rowId);
    if (index < 0) messages.push(answer);
    else messages[index] = { ...messages[index], ...answer, key: messages[index].key };
    this.value = messages;
    return messages;
  }
  dispose() { this.disposed = true; this.generation++; this.value = []; this.commands.clear(); }
}
