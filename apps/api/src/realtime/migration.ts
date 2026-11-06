import type Database from 'better-sqlite3';

export function installClientNotifications(db: Database.Database, definitions: readonly (readonly [string, string, string])[]) {
  for (const [table, owner, entity] of definitions) for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    const ownerSql = owner.replaceAll('ROW.', `${row}.`);
    const changed = operation === 'UPDATE' && ['resource_files', 'resource_folders'].includes(table)
      ? ` AND (${(db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(column => `OLD."${column.name}" IS NOT NEW."${column.name}"`).join(' OR ')})`
      : '';
    if (changed) db.exec(`DROP TRIGGER IF EXISTS client_${table}_${operation.toLowerCase()}`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS client_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
      WHEN ${ownerSql} IS NOT NULL${changed} BEGIN
        INSERT INTO client_changes(owner_id,domain,entity) VALUES (${ownerSql},'${table}',${entity.replaceAll('ROW.', `${row}.`)});
      END`);
  }
}

/** Notifications share the writer's SQLite transaction; they contain identities, never payloads. */
export function migrateClientRuntime(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS executor_interaction_recovery (
    command_id INTEGER PRIMARY KEY REFERENCES cloud_task_commands(id) ON DELETE CASCADE,
    snapshot TEXT NOT NULL, phase TEXT NOT NULL, effects TEXT NOT NULL DEFAULT '[]', attempt INTEGER NOT NULL DEFAULT 0
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS executor_interaction_targets (
    command_id INTEGER PRIMARY KEY REFERENCES cloud_task_commands(id) ON DELETE CASCADE,
    target TEXT NOT NULL
  )`);
  const installed = !!db.prepare('SELECT 1 FROM schema_migrations WHERE version=34').get();
  if (!installed) {
  db.exec(`
    CREATE TABLE client_changes (
      revision INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      domain TEXT NOT NULL, entity TEXT NOT NULL
    );
    CREATE INDEX client_changes_scope ON client_changes(owner_id,revision);
    CREATE TABLE client_commands (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      operation_id TEXT NOT NULL, digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','completed','failed')),
      result TEXT, error TEXT,
      PRIMARY KEY(owner_id,operation_id)
    );
  `);
  installClientNotifications(db, [
    ['system_file_entries', 'ROW.owner_id', 'ROW.path'],
    ['cloud_tasks', 'ROW.owner_id', 'ROW.id'],
    ['cloud_records', 'ROW.owner_id', "ROW.table_name || ':' || ROW.record_key"],
    ['threads', 'ROW.owner_id', 'ROW.id'],
    ['projects', 'ROW.owner_id', 'ROW.id'],
    ['resource_trash', 'ROW.owner_id', 'ROW.project_id'],
    ['runs', '(SELECT owner_id FROM threads WHERE id=ROW.thread_id)', 'ROW.id'],
  ]);
  db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(34,?)').run(new Date().toISOString());
  }
  // Chat progress is a high-frequency append-only signal. The open conversation
  // is already woken by client_session_tasks; making the global task watcher
  // reread its 200-row list on every token batch was pure amplification. Other
  // task kinds keep the normal domain so their job UI still receives progress.
  db.exec('DROP TRIGGER IF EXISTS client_cloud_tasks_update');
  db.exec(`CREATE TRIGGER client_cloud_tasks_update AFTER UPDATE ON cloud_tasks
    WHEN NEW.owner_id IS NOT NULL
    BEGIN
      INSERT INTO client_changes(owner_id,domain,entity) VALUES(
        NEW.owner_id,
        CASE WHEN NEW.kind='chat'
          AND OLD.status IS NEW.status
          AND OLD.error IS NEW.error
          AND OLD.result IS NEW.result
          AND OLD.executor IS NEW.executor
          THEN 'cloud_task_progress' ELSE 'cloud_tasks' END,
        NEW.id);
    END`);
  db.exec(`CREATE TABLE IF NOT EXISTS resource_command_scopes (
    owner_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, scope TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS resource_workflows (
    owner_id TEXT NOT NULL, operation_id TEXT NOT NULL, request TEXT, binding TEXT NOT NULL DEFAULT '',
    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id,operation_id),
    FOREIGN KEY(owner_id,operation_id) REFERENCES client_commands(owner_id,operation_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS resource_fact_versions (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stream TEXT NOT NULL, course_id TEXT NOT NULL, kind TEXT NOT NULL, sequence INTEGER NOT NULL,
    PRIMARY KEY(owner_id,stream,course_id,kind)
  );`);
  // Also repair the notification closure in already-created schema34 databases.
  installClientNotifications(db, [['cloud_permissions', 'ROW.owner_id', 'ROW.id']]);
  db.exec(`CREATE TABLE IF NOT EXISTS client_journal_floors (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    cursor INTEGER NOT NULL CHECK(cursor>=0), PRIMARY KEY(owner_id,thread_id)
  )`);
  // These are invalidations, not replacements for the Bot durable event journal.
  db.exec(`CREATE TABLE IF NOT EXISTS client_session_cursors (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL, cursor INTEGER NOT NULL DEFAULT 0,
    floor INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(owner_id,session_id)
  );
  CREATE TABLE IF NOT EXISTS client_session_events (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    session_id INTEGER NOT NULL, cursor INTEGER NOT NULL,
    row_id INTEGER NOT NULL, value TEXT,
    PRIMARY KEY(owner_id,session_id,cursor)
  );`);
  for (const operation of ['INSERT', 'DELETE']) {
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    db.exec(`CREATE TRIGGER IF NOT EXISTS session_journal_${operation.toLowerCase()} AFTER ${operation} ON cloud_records
      WHEN ${row}.table_name='chats' AND ${row}.value IS NOT NULL
        AND json_type(${row}.value,'$.sessionId')='integer'
      BEGIN
        INSERT INTO client_session_cursors(owner_id,session_id,cursor) VALUES(${row}.owner_id,json_extract(${row}.value,'$.sessionId'),1)
          ON CONFLICT(owner_id,session_id) DO UPDATE SET cursor=cursor+1;
        INSERT INTO client_session_events(owner_id,session_id,cursor,row_id,value)
          SELECT ${row}.owner_id,json_extract(${row}.value,'$.sessionId'),cursor,
            json_extract(${row}.value,'$.id'),${operation === 'DELETE' ? 'NULL' : `${row}.value`}
          FROM client_session_cursors WHERE owner_id=${row}.owner_id AND session_id=json_extract(${row}.value,'$.sessionId');
      END`);
  }
  installClientNotifications(db, [
    ['resource_files', 'ROW.owner_id', 'ROW.course_id'],
    ['resource_folders', 'ROW.owner_id', 'CAST(ROW.folder_id AS TEXT)'],
    ['agent_profiles', 'ROW.owner_id', 'ROW.id'],
    ['message_events', '(SELECT owner_id FROM threads WHERE id=ROW.thread_id)', 'ROW.thread_id'],
    ['run_steps', '(SELECT t.owner_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=ROW.run_id)', 'ROW.run_id'],
    ['messages', '(SELECT owner_id FROM threads WHERE id=ROW.thread_id)', 'ROW.thread_id'],
  ]);
  // Route by the affected session while OLD is still available. Looking the
  // row up later loses deletes/tombstones (CloudRecords replaces via DELETE +
  // INSERT), and task terminal/deletion notifications need the same guarantee.
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const rows = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    for (const row of rows) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS client_session_records_${operation.toLowerCase()}_${row.toLowerCase()}
        AFTER ${operation} ON cloud_records WHEN ${row}.table_name IN ('chats','chatSessions') BEGIN
          INSERT INTO client_changes(owner_id,domain,entity)
          SELECT ${row}.owner_id,'chat_session',CAST(CASE WHEN ${row}.table_name='chatSessions'
            THEN json_extract(${row}.record_key,'$') ELSE json_extract(${row}.value,'$.sessionId') END AS TEXT)
          WHERE ${row}.table_name='chatSessions' OR json_type(${row}.value,'$.sessionId')='integer';
        END`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS client_session_tasks_${operation.toLowerCase()}_${row.toLowerCase()}
        AFTER ${operation} ON cloud_tasks WHEN ${row}.kind='chat' AND json_type(${row}.input,'$.sessionId')='integer' BEGIN
          INSERT INTO client_changes(owner_id,domain,entity) VALUES (${row}.owner_id,'chat_session',CAST(json_extract(${row}.input,'$.sessionId') AS TEXT));
        END`);
    }
  }
}
