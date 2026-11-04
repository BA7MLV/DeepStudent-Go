import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { installClientNotifications } from '../realtime/migration.js';

/** References only: cards and notebook files remain the authoritative domain records. */
export function ensureLearningResults(store: DatabaseStore) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS plugin_learning_tasks (
    task_id TEXT PRIMARY KEY REFERENCES cloud_tasks(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL, instance_id TEXT NOT NULL, action_id TEXT NOT NULL,
    material_id TEXT NOT NULL, request TEXT NOT NULL, result TEXT, delivered_at TEXT, error TEXT);
    CREATE TABLE IF NOT EXISTS plugin_learning_receipts (
    task_id TEXT PRIMARY KEY REFERENCES cloud_tasks(id) ON DELETE CASCADE,
    artifacts TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_practice_snapshots (
    row_id INTEGER PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL, instance_id TEXT NOT NULL, material_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plugin_practice_submissions (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    row_id INTEGER NOT NULL, question_index INTEGER NOT NULL, delivered_at TEXT, error TEXT);`);
  // These tables are initialized after the core database migration. Install
  // their durable notifications here, including on databases already at v34.
  installClientNotifications(store.db, [
    ['plugin_learning_tasks', 'ROW.owner_id', 'ROW.task_id'],
    ['plugin_learning_receipts', '(SELECT owner_id FROM cloud_tasks WHERE id=ROW.task_id)', 'ROW.task_id'],
    ['plugin_practice_snapshots', 'ROW.owner_id', 'CAST(ROW.row_id AS TEXT)'],
    ['plugin_practice_submissions', 'ROW.owner_id', 'ROW.id'],
  ]);
}
export function learningCards(store: DatabaseStore, owner: string, materialId: string): Record<string, any>[] {
  return (store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards' AND value IS NOT NULL AND json_extract(value,'$.videoId')=? ORDER BY record_key").all(owner, materialId) as { value: string }[]).map(r => JSON.parse(r.value));
}
export function cardsRevision(cards: Record<string, any>[]) {
  return crypto.createHash('sha256').update(JSON.stringify(cards)).digest('hex');
}
/** Called inside the same SQLite transaction as domain mutations. */
export function recordLearningReceipt(store: DatabaseStore, taskId: string, artifacts: unknown) {
  store.db.prepare('INSERT OR IGNORE INTO plugin_learning_receipts(task_id,artifacts,created_at) VALUES(?,?,?)').run(taskId, JSON.stringify(artifacts), new Date().toISOString());
}
/** Startup + timer retry, not a page watch or best-effort completion event. */
export function reconcileLearningResults(store: DatabaseStore) {
  const rows = store.db.prepare(`SELECT l.task_id,r.artifacts FROM plugin_learning_tasks l
    JOIN plugin_learning_receipts r ON r.task_id=l.task_id WHERE l.delivered_at IS NULL LIMIT 100`).all() as { task_id: string; artifacts: string }[];
  for (const row of rows) {
    try {
      store.transaction(() => {
        JSON.parse(row.artifacts);
        store.db.prepare('UPDATE plugin_learning_tasks SET result=?,delivered_at=?,error=NULL WHERE task_id=? AND delivered_at IS NULL').run(row.artifacts, new Date().toISOString(), row.task_id);
      });
    } catch {
      store.db.prepare("UPDATE plugin_learning_tasks SET error='result_delivery_failed' WHERE task_id=?").run(row.task_id);
    }
  }
}
