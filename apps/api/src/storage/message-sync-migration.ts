import type Database from 'better-sqlite3';

/** State invalidations commit in the SAME SQLite transaction as the mutation,
 * including runner recovery, direct SQL and writes from other store instances. */
const triggers = [
  ['bot_sync_run_insert', 'AFTER INSERT ON runs', 'NEW.thread_id'],
  ['bot_sync_run_update', 'AFTER UPDATE OF status,error_code,wake_at ON runs WHEN NEW.status IS NOT OLD.status OR NEW.error_code IS NOT OLD.error_code OR NEW.wake_at IS NOT OLD.wake_at', 'NEW.thread_id'],
  ['bot_sync_approval_insert', 'AFTER INSERT ON approvals', 'NEW.thread_id'],
  ['bot_sync_approval_update', 'AFTER UPDATE OF status ON approvals WHEN NEW.status IS NOT OLD.status', 'NEW.thread_id'],
  ['bot_sync_question_insert', 'AFTER INSERT ON run_questions', '(SELECT thread_id FROM runs WHERE id=NEW.run_id)'],
  ['bot_sync_question_update', 'AFTER UPDATE OF status ON run_questions WHEN NEW.status IS NOT OLD.status', '(SELECT thread_id FROM runs WHERE id=NEW.run_id)'],
  ['bot_sync_thread_update', 'AFTER UPDATE OF title,archived ON threads WHEN NEW.title IS NOT OLD.title OR NEW.archived IS NOT OLD.archived', 'NEW.id'],
].map(([name, clause, thread]) => ({ name, sql: `CREATE TRIGGER ${name} ${clause} BEGIN
  INSERT INTO message_events(id,thread_id,seq,type,payload,created_at)
  VALUES(lower(hex(randomblob(16))),${thread},0,'thread.state_invalidated','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END` }));

export function migrateMessageSync(db: Database.Database) {
  for (const { name, sql } of triggers) {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name) as { sql: string } | undefined;
    if (existing && existing.sql !== sql) throw new Error(`schema_trigger_untrusted_${name}`);
    if (!existing) {
      if (db.prepare('SELECT 1 FROM schema_migrations WHERE version=30').get()) throw new Error(`schema_trigger_missing_${name}`);
      db.exec(sql);
    }
  }
  db.prepare('INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(30,?)').run(new Date().toISOString());
}
