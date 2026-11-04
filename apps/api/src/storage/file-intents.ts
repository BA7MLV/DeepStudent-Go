import type Database from 'better-sqlite3';

/** Durable receipts survive successful flushes as well as external conflicts. */
export function migrateFileIntents(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS system_file_intents (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    path TEXT NOT NULL, content TEXT, expected TEXT, observed TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending','applied','conflict','superseded','discarded')),
    created_at TEXT NOT NULL, completed_at TEXT, resolution TEXT, successor_id TEXT, operation_id TEXT
  );
  CREATE INDEX IF NOT EXISTS system_file_intents_owner ON system_file_intents(owner_id,path,created_at);`);
  const columns = db.prepare('PRAGMA table_info(system_file_entries)').all() as { name: string }[];
  if (!columns.some(column => column.name === 'intent_id')) db.exec('ALTER TABLE system_file_entries ADD COLUMN intent_id TEXT');
  const intentColumns = db.prepare('PRAGMA table_info(system_file_intents)').all() as { name: string }[];
  for (const name of ['resolution', 'successor_id', 'operation_id']) if (!intentColumns.some(column => column.name === name)) db.exec(`ALTER TABLE system_file_intents ADD COLUMN ${name} TEXT`);
  db.exec('CREATE INDEX IF NOT EXISTS system_file_intents_operation ON system_file_intents(owner_id,operation_id)');
  // Preserve pre-migration unflushed bytes and CAS expectations exactly.
  db.exec(`UPDATE system_file_entries SET intent_id=lower(hex(randomblob(16))) WHERE pending<>0 AND intent_id IS NULL;
    INSERT OR IGNORE INTO system_file_intents(id,owner_id,path,content,expected,status,created_at)
      SELECT intent_id,owner_id,path,content,expected,'pending',strftime('%Y-%m-%dT%H:%M:%fZ','now')
      FROM system_file_entries WHERE pending<>0;`);
}
