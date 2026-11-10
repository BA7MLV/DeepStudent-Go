import type Database from 'better-sqlite3';

/** Lightweight derived navigation facts. Message bodies remain in cloud_records.
 * All maintenance shares the record writer's transaction, including rollback. */
export function migrateSessionIndex(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS client_session_index (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    id INTEGER NOT NULL, video_id TEXT NOT NULL, title TEXT NOT NULL,
    pinned INTEGER NOT NULL, archived INTEGER NOT NULL, created_at INTEGER NOT NULL,
    activity INTEGER NOT NULL DEFAULT 0, has_user INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_id,id)
  );
  CREATE INDEX IF NOT EXISTS client_session_index_order ON client_session_index(
    owner_id,video_id,archived,pinned DESC,activity DESC,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS client_session_index_recent ON client_session_index(
    owner_id,video_id,archived,has_user,pinned DESC,activity DESC,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS client_session_index_created ON client_session_index(
    owner_id,video_id,archived,created_at DESC,id DESC);
  CREATE INDEX IF NOT EXISTS cloud_records_session_activity ON cloud_records(
    owner_id,table_name,json_extract(value,'$.sessionId'),json_extract(value,'$.createdAt') DESC)
    WHERE value IS NOT NULL;
  CREATE INDEX IF NOT EXISTS cloud_records_session_user ON cloud_records(
    owner_id,table_name,json_extract(value,'$.sessionId'),json_extract(value,'$.role'))
    WHERE value IS NOT NULL;
  CREATE TABLE IF NOT EXISTS client_session_index_scopes (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(owner_id,video_id)
  );`);
  const activity = (owner: string, id: string) => `COALESCE((SELECT json_extract(value,'$.createdAt') FROM cloud_records
    WHERE owner_id=${owner} AND table_name='chats' AND value IS NOT NULL AND json_extract(value,'$.sessionId')=${id}
    ORDER BY json_extract(value,'$.createdAt') DESC LIMIT 1),0)`;
  const hasUser = (owner: string, id: string) => `EXISTS(SELECT 1 FROM cloud_records WHERE owner_id=${owner}
    AND table_name='chats' AND value IS NOT NULL AND json_extract(value,'$.sessionId')=${id} AND json_extract(value,'$.role')='user')`;
  const upsert = (row: string) => `INSERT INTO client_session_index(owner_id,id,video_id,title,pinned,archived,created_at,activity,has_user)
    SELECT ${row}.owner_id,json_extract(${row}.value,'$.id'),COALESCE(json_extract(${row}.value,'$.videoId'),''),
      substr(COALESCE(json_extract(${row}.value,'$.title'),''),1,256),COALESCE(json_extract(${row}.value,'$.pinned'),0),
      COALESCE(json_extract(${row}.value,'$.archived'),0),COALESCE(json_extract(${row}.value,'$.createdAt'),0),
      ${activity(`${row}.owner_id`, `json_extract(${row}.value,'$.id')`)},
      ${hasUser(`${row}.owner_id`, `json_extract(${row}.value,'$.id')`)}
    WHERE ${row}.value IS NOT NULL AND ${row}.table_name='chatSessions' AND json_type(${row}.value,'$.id')='integer'
    ON CONFLICT(owner_id,id) DO UPDATE SET video_id=excluded.video_id,title=excluded.title,pinned=excluded.pinned,
      archived=excluded.archived,created_at=excluded.created_at,activity=excluded.activity,has_user=excluded.has_user
    WHERE (video_id,title,pinned,archived,created_at,activity,has_user) IS NOT
      (excluded.video_id,excluded.title,excluded.pinned,excluded.archived,excluded.created_at,excluded.activity,excluded.has_user);`;
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const sides = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    const changed = operation === 'UPDATE' ? `WHEN (OLD.table_name='chats' OR NEW.table_name='chats') AND (OLD.owner_id IS NOT NEW.owner_id OR OLD.table_name IS NOT NEW.table_name
      OR OLD.value IS NULL OR NEW.value IS NULL
      OR json_extract(OLD.value,'$.sessionId') IS NOT json_extract(NEW.value,'$.sessionId')
      OR json_extract(OLD.value,'$.role') IS NOT json_extract(NEW.value,'$.role')
      OR json_extract(OLD.value,'$.createdAt') IS NOT json_extract(NEW.value,'$.createdAt'))` : `WHEN ${operation === 'DELETE' ? 'OLD' : 'NEW'}.table_name='chats'`;
    // Content-only streaming edits never reread session history or invalidate nav.
    db.exec(`CREATE TRIGGER IF NOT EXISTS session_index_activity_${operation.toLowerCase()} AFTER ${operation} ON cloud_records
      ${changed} BEGIN ${sides.map(row => `UPDATE client_session_index SET
        activity=${activity(`${row}.owner_id`, `json_extract(${row}.value,'$.sessionId')`)},
        has_user=${hasUser(`${row}.owner_id`, `json_extract(${row}.value,'$.sessionId')`)}
        WHERE ${row}.table_name='chats' AND owner_id=${row}.owner_id AND id=json_extract(${row}.value,'$.sessionId');`).join('\n')} END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS session_index_metadata_${operation.toLowerCase()} AFTER ${operation} ON cloud_records
      WHEN ${sides.map(row => `${row}.table_name='chatSessions'`).join(' OR ')} BEGIN
      ${operation !== 'INSERT' ? `DELETE FROM client_session_index WHERE OLD.table_name='chatSessions' AND owner_id=OLD.owner_id
        AND id=json_extract(OLD.value,'$.id') ${operation === 'UPDATE' ? `AND (NEW.value IS NULL OR NEW.table_name IS NOT OLD.table_name OR NEW.owner_id IS NOT OLD.owner_id OR json_extract(NEW.value,'$.id') IS NOT json_extract(OLD.value,'$.id'))` : ''};` : ''}
      ${operation !== 'DELETE' ? upsert('NEW') : ''}
    END`);
    const row = operation === 'DELETE' ? 'OLD' : 'NEW';
    db.exec(`DROP TRIGGER IF EXISTS session_index_notify_${operation.toLowerCase()}`);
    const notify = (source: string) => `INSERT INTO client_session_index_scopes VALUES(${source}.owner_id,${source}.video_id,1)
        ON CONFLICT(owner_id,video_id) DO UPDATE SET version=version+1;
      INSERT INTO client_changes(owner_id,domain,entity) VALUES(${source}.owner_id,'session_index',${source}.video_id);`;
    db.exec(`CREATE TRIGGER session_index_notify_${operation.toLowerCase()} AFTER ${operation} ON client_session_index
      ${operation === 'UPDATE' ? 'WHEN (OLD.video_id,OLD.title,OLD.pinned,OLD.archived,OLD.created_at,OLD.activity,OLD.has_user) IS NOT (NEW.video_id,NEW.title,NEW.pinned,NEW.archived,NEW.created_at,NEW.activity,NEW.has_user)' : ''}
      BEGIN
        ${notify(row)}
        ${operation === 'UPDATE' ? `INSERT INTO client_session_index_scopes SELECT OLD.owner_id,OLD.video_id,1 WHERE OLD.video_id IS NOT NEW.video_id
          ON CONFLICT(owner_id,video_id) DO UPDATE SET version=version+1;
          INSERT INTO client_changes(owner_id,domain,entity) SELECT OLD.owner_id,'session_index',OLD.video_id WHERE OLD.video_id IS NOT NEW.video_id;` : ''}
      END`);
  }
  // One-time derived-data backfill; never performed on ordinary reads/reopens.
  db.transaction(() => {
    if (db.prepare("SELECT 1 FROM app_state WHERE key='session-index-v1'").get()) return;
    db.exec(`INSERT OR IGNORE INTO client_session_index
      SELECT s.owner_id,json_extract(s.value,'$.id'),COALESCE(json_extract(s.value,'$.videoId'),''),substr(COALESCE(json_extract(s.value,'$.title'),''),1,256),
        COALESCE(json_extract(s.value,'$.pinned'),0),COALESCE(json_extract(s.value,'$.archived'),0),COALESCE(json_extract(s.value,'$.createdAt'),0),
        ${activity('s.owner_id', "json_extract(s.value,'$.id')")},${hasUser('s.owner_id', "json_extract(s.value,'$.id')")}
      FROM cloud_records s WHERE s.table_name='chatSessions' AND s.value IS NOT NULL AND json_type(s.value,'$.id')='integer';`);
    db.prepare("INSERT INTO app_state(key,value) VALUES('session-index-v1','1')").run();
  })();
}
