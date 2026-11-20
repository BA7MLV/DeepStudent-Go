import type { DatabaseStore } from '../storage/database.js';
import { sql } from '../storage/sql.js';
import { config } from '../config.js';

/** Events retained per thread beyond the floor. Live consumers replay from a
 * cursor inside this window; anything older heals through snapshot resync. */
export const journalWindow = () => config().botJournalEventWindow;

/** Bounded work per pass keeps a small server responsive; the 60s cadence catches up. */
const THREADS_PER_PASS = 32;
const EVENTS_PER_THREAD = 4000;

/** Advance journal floors and trim superseded events. The durable messages table
 * remains the source of truth; a cursor below the floor heals via resync.required. */
export function cleanupBotJournal(store: DatabaseStore, protectedThreads: ReadonlySet<string> = new Set()) {
  const window = journalWindow();
  store.transaction(() => {
    // 三条语句都是固定文本(用 sql 校验形态);窗口大小、线程数与删除上限全部走绑定值,
    // 绑定个数与文本里的 `?` 一一对应。
    const rows = store.db.prepare(sql`SELECT t.owner_id AS owner, t.id AS thread, MAX(e.event_id) AS latest
      FROM threads t JOIN message_events e ON e.thread_id=t.id
      GROUP BY t.id
      HAVING MAX(e.event_id) - COALESCE((SELECT f.cursor FROM client_journal_floors f WHERE f.owner_id=t.owner_id AND f.thread_id=t.id), 0) > ?
      LIMIT ?`.sql).all(window, THREADS_PER_PASS) as Array<{ owner: string; thread: string; latest: number }>;
    for (const row of rows) {
      if (protectedThreads.has(row.thread)) continue;
      const floor = row.latest - window;
      store.db.prepare(sql`INSERT INTO client_journal_floors(owner_id,thread_id,cursor) VALUES(?,?,?)
        ON CONFLICT(owner_id,thread_id) DO UPDATE SET cursor=excluded.cursor WHERE excluded.cursor>client_journal_floors.cursor`.sql).run(row.owner, row.thread, floor);
      store.db.prepare(sql`DELETE FROM message_events WHERE event_id IN
        (SELECT event_id FROM message_events WHERE thread_id=? AND event_id<=? ORDER BY event_id LIMIT ?)`.sql).run(row.thread, floor, EVENTS_PER_THREAD);
    }
  });
}
