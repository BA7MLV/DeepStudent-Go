import type { ServerResponse } from 'node:http';
import type { DatabaseStore } from '../storage/database.js';

type Subscription = { thread: string; cursor: number; response: ServerResponse; authorized: () => boolean; blockedAt: number; checkedAt: number };
type EventRow = { event_id: number; thread_id: string; type: string; payload: string };

export function eventFrame(event: EventRow) {
  let payload = JSON.parse(event.payload);
  if (['message.accepted', 'message.updated', 'message.pending'].includes(event.type) && !('message' in payload)) payload = { message: payload };
  return `id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/** One bounded database sweep per server, not a polling timer per browser.
 * SQLite is the durable source; process notifications are not a correctness dependency. */
export class BotMessageStreams {
  private subscriptions = new Set<Subscription>();
  private timer?: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(private store: DatabaseStore) {}

  add(thread: string, cursor: number, response: ServerResponse, authorized: () => boolean) {
    if (this.closed || this.subscriptions.size >= 64) { response.end(); return; }
    const item: Subscription = { thread, cursor, response, authorized, blockedAt: 0, checkedAt: Date.now() };
    this.subscriptions.add(item);
    const remove = () => {
      this.subscriptions.delete(item);
      if (!this.subscriptions.size) { clearInterval(this.timer); this.timer = undefined; }
    };
    response.once('close', remove);
    response.on('drain', () => { item.blockedAt = 0; });
    response.write(': connected\n\n');
    this.sweep();
    if (!this.timer && this.subscriptions.size) this.timer = setInterval(() => this.sweep(), 250);
  }

  private sweep() {
    if (!this.subscriptions.size) return;
    try {
      const now = Date.now();
      for (const item of this.subscriptions) {
        // Recheck BEFORE sending any data (also revocation/deletion during a connection).
        if (!item.authorized() || item.blockedAt && now - item.blockedAt > 15_000) { item.response.end(); continue; }
        if (now - item.checkedAt >= 15_000 && !item.blockedAt) {
          item.checkedAt = now;
          if (!item.response.write(': heartbeat\n\n')) item.blockedAt = now;
        }
      }
      const ready = [...this.subscriptions].filter(item => !item.blockedAt && !item.response.writableEnded);
      if (!ready.length) return;
      const threads = [...new Set(ready.map(item => item.thread))];
      const minimum = Math.min(...ready.map(item => item.cursor));
      const rows = this.store.db.prepare(`SELECT event_id,thread_id,type,payload FROM message_events WHERE event_id>? AND thread_id IN (${threads.map(() => '?').join(',')}) ORDER BY event_id LIMIT 64`).all(minimum, ...threads) as EventRow[];
      for (const row of rows) {
        const frame = eventFrame(row);
        for (const item of ready) {
          if (item.blockedAt || item.response.writableEnded || row.event_id <= item.cursor) continue;
          if (item.thread === row.thread_id && !item.response.write(frame)) item.blockedAt = now;
          // Global IDs may skip unrelated threads. Advancing across them is safe.
          item.cursor = row.event_id;
        }
      }
    } catch {
      // A corrupt row/database failure must not spin forever or escape a timer.
      for (const item of this.subscriptions) item.response.end();
    }
  }

  close() {
    this.closed = true;
    clearInterval(this.timer); this.timer = undefined;
    for (const item of this.subscriptions) item.response.end();
    this.subscriptions.clear();
  }
}
