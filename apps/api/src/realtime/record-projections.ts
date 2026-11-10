import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CollectionPage, CourseMetadata, CoverCandidates, LatestHandout, ProjectionTable, RuntimeRead, RuntimeRecord, SessionIndexPage, SkillIndexPage, StudySummary } from '@wangke/contracts/client-runtime';
import type { DatabaseStore } from '../storage/database.js';

export const PROJECTION_PAGE_SIZE = 50;
export const PROJECTION_PAGE_BYTES = 512 * 1024;
// Preserve existing multi-MiB artifacts. One complete exceptional record is
// allowed; it is never truncated or followed by another row in that response.
export const PROJECTION_RECORD_BYTES = 16 * 1024 * 1024;
export const COVER_BACKFILL_PAGE = 100;
const tables = new Set<ProjectionTable>(['videos', 'files', 'segments', 'frames', 'handouts', 'chats', 'chatSessions',
  'skills', 'skillRefs', 'danmakus', 'folders', 'cards', 'subtitleTracks', 'materialBlocks', 'materialInk', 'covers', 'studyDays', 'courseFiles', 'comments']);
const parentRequired = new Set<ProjectionTable>(['segments', 'frames', 'handouts', 'chats', 'skillRefs', 'danmakus',
  'cards', 'subtitleTracks', 'materialBlocks', 'materialInk', 'comments']);
// The query and expression index must use exactly the same expression.
export const recordParentSql = `CASE table_name WHEN 'chats' THEN json_extract(value,'$.sessionId')
  WHEN 'skillRefs' THEN json_extract(value,'$.skillId')
  WHEN 'materialBlocks' THEN json_extract(value,'$.materialId')
  WHEN 'materialInk' THEN json_extract(value,'$.materialId') ELSE json_extract(value,'$.videoId') END`;
const roleSql = "CASE WHEN json_extract(value,'$.role')='user' THEN 0 ELSE 1 END";

/** Derived indexes and invalidation heads only. No authoritative records move. */
export function migrateRecordProjections(db: Database.Database) {
  db.exec(`CREATE INDEX IF NOT EXISTS cloud_records_parent_key ON cloud_records(owner_id,table_name,(${recordParentSql}),record_key);
    CREATE INDEX IF NOT EXISTS cloud_records_study_scalars ON cloud_records(owner_id,record_key,json_extract(value,'$.seconds'))
      WHERE table_name='studyDays' AND value IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cloud_records_ready_segments ON cloud_records(owner_id,json_extract(value,'$.videoId'))
      WHERE table_name='segments' AND json_extract(value,'$.status')=1 AND length(json_extract(value,'$.text'))>0;
    CREATE INDEX IF NOT EXISTS cloud_records_handout_latest ON cloud_records(owner_id,json_extract(value,'$.videoId'),json_extract(value,'$.createdAt') DESC,json_extract(value,'$.id') DESC)
      WHERE table_name='handouts' AND value IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cloud_records_frame_second ON cloud_records(owner_id,json_extract(value,'$.videoId'),CAST(json_extract(value,'$.ts') AS INTEGER),json_extract(value,'$.id') DESC)
      WHERE table_name='frames' AND value IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cloud_records_color_frame ON cloud_records(owner_id,json_extract(value,'$.videoId'),
      CASE WHEN json_extract(value,'$.kind')='slide' THEN 0 ELSE 1 END,json_extract(value,'$.ts'),record_key)
      WHERE table_name='frames' AND value IS NOT NULL;
    CREATE INDEX IF NOT EXISTS cloud_records_session_order ON cloud_records(owner_id,table_name,
      json_extract(value,'$.sessionId'),json_extract(value,'$.createdAt'),(${roleSql}),json_extract(value,'$.id'));
    CREATE TABLE IF NOT EXISTS client_collection_heads (
      owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      table_name TEXT NOT NULL, parent TEXT NOT NULL, version INTEGER NOT NULL,
      PRIMARY KEY(owner_id,table_name,parent)
    );`);
  for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
    const sides = operation === 'UPDATE' ? ['OLD', 'NEW'] : [operation === 'DELETE' ? 'OLD' : 'NEW'];
    for (const side of sides) {
      const parent = recordParentSql.replaceAll('table_name', `${side}.table_name`).replaceAll('value', `${side}.value`);
      db.exec(`CREATE TRIGGER IF NOT EXISTS collection_head_${operation.toLowerCase()}_${side.toLowerCase()}
        AFTER ${operation} ON cloud_records BEGIN
          INSERT INTO client_collection_heads VALUES(${side}.owner_id,${side}.table_name,'*',1)
            ON CONFLICT(owner_id,table_name,parent) DO UPDATE SET version=version+1;
          INSERT INTO client_collection_heads VALUES(${side}.owner_id,${side}.table_name,'parent:' || COALESCE(json_quote(${parent}),'null'),1)
            ON CONFLICT(owner_id,table_name,parent) DO UPDATE SET version=version+1;
        END`);
    }
  }
}

export function recordsEpoch(store: DatabaseStore) {
  store.db.prepare('INSERT OR IGNORE INTO app_state(key,value) VALUES(?,?)').run('records-epoch', crypto.randomUUID());
  return (store.db.prepare('SELECT value FROM app_state WHERE key=?').get('records-epoch') as { value: string }).value;
}
function checkTable(table: string): asserts table is ProjectionTable {
  if (!tables.has(table as ProjectionTable)) throw new Error('invalid_projection_table');
}
function dto(row: { table_name: string; record_key: string; value: string | null; revision: number }): RuntimeRecord {
  return { table: row.table_name, key: JSON.parse(row.record_key), value: row.value === null ? null : JSON.parse(row.value), revision: row.revision };
}
type Cursor = { owner: string; table: ProjectionTable; parent: string; version: number; epoch: string; key: string };

export class RecordProjections {
  constructor(private readonly store: DatabaseStore) {}
  /** Keyset page of courses still needing a derived cover. Covers are facts:
   * an existing cover row excludes the course, and failure leaves no state so the
   * next page/run retries it. Scans only forward from the signed cursor. */
  coverCandidates(owner: string, request: Extract<RuntimeRead, { kind: 'coverCandidates' }>): CoverCandidates {
    const parent = '*';
    return this.store.db.transaction(() => {
      const epoch = recordsEpoch(this.store);
      const version = (this.store.db.prepare("SELECT version FROM client_collection_heads WHERE owner_id=? AND table_name='videos' AND parent='*'")
        .get(owner) as { version: number } | undefined)?.version ?? 0;
      let after = '';
      if (request.cursor !== undefined) {
        const cursor = this.decode(request.cursor);
        if (cursor.owner !== owner || cursor.table !== 'videos' || cursor.parent !== parent) throw new Error('projection_cursor_scope');
        if (cursor.epoch !== epoch || cursor.version !== version) throw new Error('projection_cursor_expired');
        after = cursor.key;
      }
      const rows = this.store.db.prepare(`SELECT v.record_key FROM cloud_records AS v INDEXED BY sqlite_autoindex_cloud_records_1
        WHERE v.owner_id=? AND v.table_name='videos' AND v.value IS NOT NULL AND v.record_key>?
        AND NOT EXISTS (SELECT 1 FROM cloud_records AS c
          WHERE c.owner_id=v.owner_id AND c.table_name='covers' AND c.record_key=v.record_key AND c.value IS NOT NULL)
        AND (json_extract(v.value,'$.coverState') IS NULL
          OR json_extract(v.value,'$.coverState') NOT IN ('skipped','done')
          OR (json_extract(v.value,'$.coverState')='done' AND json_extract(v.value,'$.materialFormat')='md'))
        ORDER BY v.record_key LIMIT ?`).all(owner, after, COVER_BACKFILL_PAGE + 1) as { record_key: string }[];
      const ids = rows.slice(0, COVER_BACKFILL_PAGE).map(row => JSON.parse(row.record_key)).filter((id): id is string => typeof id === 'string' && !!id);
      return { ids, version, epoch, ...(rows.length > COVER_BACKFILL_PAGE
        ? { next: this.encode({ owner, table: 'videos', parent, version, epoch, key: rows[COVER_BACKFILL_PAGE - 1].record_key }) } : {}) };
    })();
  }
  courseColorFrame(owner: string, videoId: string) {
    if (typeof videoId !== 'string' || !videoId || videoId.length > 256) throw new Error('invalid_course_color_scope');
    return this.store.db.transaction(() => {
      // Preserve the player's source: earliest slide, otherwise earliest frame.
      // The index chooses one key, without course-wide body materialization.
      const selected = this.store.db.prepare(`SELECT record_key FROM cloud_records INDEXED BY cloud_records_color_frame
        WHERE owner_id=? AND table_name='frames' AND value IS NOT NULL AND json_extract(value,'$.videoId')=?
        ORDER BY CASE WHEN json_extract(value,'$.kind')='slide' THEN 0 ELSE 1 END,json_extract(value,'$.ts'),record_key LIMIT 1`)
        .get(owner, videoId) as { record_key: string } | undefined;
      if (!selected) return { frame: null };
      const metadata = "json_object('blob',json_object('$file',json_extract(value,'$.blob.$file'),'type',json_extract(value,'$.blob.type')))";
      const where = "FROM cloud_records WHERE owner_id=? AND table_name='frames' AND record_key=? AND value IS NOT NULL";
      const bytes = (this.store.db.prepare(`SELECT length(CAST(${metadata} AS BLOB)) bytes ${where}`).get(owner, selected.record_key) as { bytes: number }).bytes;
      if (bytes > PROJECTION_PAGE_BYTES - 32) throw new Error('course_color_budget_exceeded');
      const frame = JSON.parse((this.store.db.prepare(`SELECT ${metadata} metadata ${where}`).get(owner, selected.record_key) as { metadata: string }).metadata);
      if (typeof frame.blob.$file !== 'string' || !frame.blob.$file) throw new Error('course_color_file_missing');
      return { frame };
    })();
  }
  courseMetadata(owner: string, request: Extract<RuntimeRead, { kind: 'courseMetadata' }>): CourseMetadata {
    // A folder plan is capped at 12 × 60 explicit course IDs. Never a scan of
    // the library; oversized names/refs fail before their bodies reach Node.
    if (!Array.isArray(request.ids) || request.ids.length > 720 || typeof request.covers !== 'boolean'
      || request.ids.some(id => typeof id !== 'string' || !id || id.length > 256)) throw new Error('invalid_course_metadata_scope');
    return this.store.db.transaction(() => {
      const course = "json_object('name',json_extract(value,'$.name'),'kind',CASE WHEN json_extract(value,'$.kind')='material' THEN 'material' ELSE 'video' END)";
      const cover = "json_object('source',json_extract(value,'$.source'),'blob',json_object('$file',json_extract(value,'$.blob.$file'),'type',json_extract(value,'$.blob.type')))";
      const condition = "FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=? AND value IS NOT NULL";
      const lengths = this.store.db.prepare(`SELECT length(CAST(CASE table_name WHEN 'videos' THEN ${course} ELSE ${cover} END AS BLOB)) bytes ${condition}`);
      const read = this.store.db.prepare(`SELECT CASE table_name WHEN 'videos' THEN ${course} ELSE ${cover} END metadata ${condition}`);
      const items: CourseMetadata['items'] = [];
      let bytes = 0;
      for (const id of new Set(request.ids)) {
        const key = JSON.stringify(id);
        const size = (lengths.get(owner, 'videos', key) as { bytes: number } | undefined)?.bytes ?? 0;
        const coverSize = request.covers ? (lengths.get(owner, 'covers', key) as { bytes: number } | undefined)?.bytes ?? 0 : 0;
        // Include escaped ID and DTO overhead in the preflight as well.
        bytes += size + coverSize + Buffer.byteLength(key) + 64;
        if (bytes > PROJECTION_PAGE_BYTES) throw new Error('course_metadata_budget_exceeded');
        items.push({ id, course: size ? JSON.parse((read.get(owner, 'videos', key) as { metadata: string }).metadata) : null,
          cover: coverSize ? JSON.parse((read.get(owner, 'covers', key) as { metadata: string }).metadata) : null });
      }
      const result = { items, epoch: recordsEpoch(this.store) };
      if (Buffer.byteLength(JSON.stringify(result)) > PROJECTION_PAGE_BYTES) throw new Error('course_metadata_budget_exceeded');
      return result;
    })();
  }
  skillIndex(owner: string, request: Extract<RuntimeRead, { kind: 'skillIndex' }>): SkillIndexPage {
    return this.store.db.transaction(() => {
      const epoch = recordsEpoch(this.store), parent = 'skillIndex';
      const version = (this.store.db.prepare("SELECT COALESCE(SUM(version),0) AS version FROM client_collection_heads WHERE owner_id=? AND table_name IN ('skills','skillRefs') AND parent='*'")
        .get(owner) as { version: number } | undefined)?.version ?? 0;
      const scope = { owner, table: 'skills' as const, parent, epoch, version };
      let key: string | undefined;
      if (request.cursor !== undefined) {
        const cursor = this.decode(request.cursor);
        if (cursor.owner !== owner || cursor.table !== 'skills' || cursor.parent !== parent) throw new Error('projection_cursor_scope');
        if (cursor.epoch !== epoch || cursor.version !== version) throw new Error('projection_cursor_expired');
        key = cursor.key;
      }
      // Explicit allowlist: neither bodies nor future large fields can leak into
      // discovery. SQLite only returns metadata for this one keyset page.
      const fields = ['id', 'name', 'description', 'enabled', 'builtin', 'updatedAt', 'mcpRequired', 'legacyIds', 'legacyNames'];
      const refParent = recordParentSql.replaceAll('table_name', 'refs.table_name').replaceAll('value', 'refs.value');
      const metadata = `json_object(${fields.map(field => `'${field}',json_extract(value,'$.${field}')`).join(',')},'refCount',
        (SELECT count(*) FROM cloud_records refs WHERE refs.owner_id=cloud_records.owner_id AND refs.table_name='skillRefs'
          AND (${refParent})=json_extract(cloud_records.value,'$.id') AND refs.value IS NOT NULL))`;
      const rows = this.store.db.prepare(`SELECT record_key,length(CAST(${metadata} AS BLOB)) AS bytes FROM cloud_records
        WHERE owner_id=? AND table_name='skills' AND value IS NOT NULL ${key === undefined ? '' : 'AND record_key>?'}
        ORDER BY record_key LIMIT ?`).all(owner, ...(key === undefined ? [] : [key]), PROJECTION_PAGE_SIZE + 1) as { record_key: string; bytes: number }[];
      const read = this.store.db.prepare(`SELECT ${metadata} AS metadata FROM cloud_records WHERE owner_id=? AND table_name='skills' AND record_key=?`);
      const skills: SkillIndexPage['skills'] = [];
      let bytes = 0;
      for (const row of rows.slice(0, PROJECTION_PAGE_SIZE)) {
        const size = row.bytes;
        if (size > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
        if (skills.length && bytes + size > PROJECTION_PAGE_BYTES) break;
        const item = JSON.parse((read.get(owner, row.record_key) as { metadata: string }).metadata);
        for (const field of ['mcpRequired', 'legacyIds', 'legacyNames']) if (item[field] === null) delete item[field];
        skills.push(item); bytes += size;
      }
      return { skills, epoch, version, ...(rows.length > skills.length ? { next: this.encode({ ...scope, key: rows[skills.length - 1].record_key }) } : {}) };
    })();
  }
  courseReadiness(owner: string, videoId: string) {
    if (!videoId || videoId.length > 256) throw new Error('invalid_course_scope');
    return this.store.db.transaction(() => ({
      hasMaterialText: !!this.store.db.prepare(`SELECT 1 FROM cloud_records
        WHERE owner_id=? AND table_name='materialBlocks' AND (${recordParentSql})=? AND value IS NOT NULL LIMIT 1`).get(owner, videoId),
      hasSubtitles: !!this.store.db.prepare(`SELECT 1 FROM cloud_records
        WHERE owner_id=? AND table_name='segments' AND json_extract(value,'$.videoId')=?
          AND json_extract(value,'$.status')=1 AND length(json_extract(value,'$.text'))>0 LIMIT 1`).get(owner, videoId),
    }))();
  }
  latestHandout(owner: string, videoId: string): LatestHandout {
    if (!videoId || videoId.length > 256) throw new Error('invalid_course_scope');
    return this.store.db.transaction(() => {
      const selected = this.store.db.prepare(`SELECT record_key,length(CAST(value AS BLOB)) AS bytes FROM cloud_records INDEXED BY cloud_records_handout_latest
        WHERE owner_id=? AND table_name='handouts' AND value IS NOT NULL AND json_extract(value,'$.videoId')=?
        ORDER BY json_extract(value,'$.createdAt') DESC,json_extract(value,'$.id') DESC LIMIT 1`).get(owner, videoId) as { record_key: string; bytes: number } | undefined;
      if (selected && selected.bytes > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
      const row = selected ? this.store.db.prepare("SELECT table_name,record_key,value,revision FROM cloud_records WHERE owner_id=? AND table_name='handouts' AND record_key=?")
        .get(owner, selected.record_key) as Parameters<typeof dto>[0] : undefined;
      const record = row ? dto(row) : null;
      if (record && Buffer.byteLength(JSON.stringify(record)) > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
      const media: LatestHandout['media'] = { courseName: '', frames: [] };
      if (record?.value) {
        // Read only figures referenced by this complete document. Frame captions
        // and historic/unreferenced frame bodies never cross the wire.
        const timestamps = new Set<number>();
        let sections: unknown;
        try { sections = JSON.parse(String(record.value.sectionsJson ?? '[]')); } catch { sections = []; }
        if (Array.isArray(sections)) for (const section of sections) {
          if (!Array.isArray(section?.blocks)) continue;
          for (const block of section.blocks) if (block?.type === 'figure' && Number.isFinite(block.ts) && block.ts >= 0) {
            timestamps.add(Math.floor(block.ts));
            if (timestamps.size > 256) throw new Error('handout_media_budget_exceeded');
          }
        }
        const metadata = "json_object('ts',json_extract(value,'$.ts'),'blob',json_extract(value,'$.blob'))";
        const where = "FROM cloud_records INDEXED BY cloud_records_frame_second WHERE owner_id=? AND table_name='frames' AND value IS NOT NULL AND json_extract(value,'$.videoId')=? AND CAST(json_extract(value,'$.ts') AS INTEGER)=? ORDER BY json_extract(value,'$.id') DESC LIMIT 1";
        const length = this.store.db.prepare(`SELECT length(CAST(${metadata} AS BLOB)) bytes ${where}`);
        const read = this.store.db.prepare(`SELECT ${metadata} metadata ${where}`);
        let bytes = 0;
        for (const timestamp of timestamps) {
          const size = (length.get(owner, videoId, timestamp) as { bytes: number } | undefined)?.bytes ?? 0;
          if (bytes + size > PROJECTION_PAGE_BYTES) throw new Error('handout_media_budget_exceeded');
          bytes += size;
          if (size) media.frames.push(JSON.parse((read.get(owner, videoId, timestamp) as { metadata: string }).metadata));
        }
        const name = this.store.db.prepare("SELECT json_extract(value,'$.name') name FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=? AND length(json_extract(value,'$.name'))<=16384")
          .get(owner, JSON.stringify(videoId)) as { name: string } | undefined;
        media.courseName = name?.name ?? '';
      }
      const result = { record, epoch: recordsEpoch(this.store), media };
      if (Buffer.byteLength(JSON.stringify(result)) > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
      return result;
    })();
  }
  sessionIndex(owner: string, request: Extract<RuntimeRead, { kind: 'sessionIndex' }>): SessionIndexPage {
    if (!request.videoId || request.videoId.length > 256) throw new Error('invalid_session_index_scope');
    return this.store.db.transaction(() => {
      const epoch = recordsEpoch(this.store);
      const version = (this.store.db.prepare('SELECT version FROM client_session_index_scopes WHERE owner_id=? AND video_id=?')
        .get(owner, request.videoId) as { version: number } | undefined)?.version ?? 0;
      const parent = JSON.stringify(['sessionIndex', request.videoId, request.archived, request.recentOnly]);
      let order: number[] | undefined, backwards = false;
      if (request.cursor !== undefined) {
        const cursor = this.decode(request.cursor);
        if (cursor.owner !== owner || cursor.table !== 'chatSessions' || cursor.parent !== parent) throw new Error('projection_cursor_scope');
        if (cursor.epoch !== epoch || cursor.version !== version) throw new Error('projection_cursor_expired');
        const position = JSON.parse(cursor.key);
        order = position.order; backwards = position.direction === 'before';
        if (!['before', 'after'].includes(position.direction) || !Array.isArray(order) || order.length !== 4 || !order.every(Number.isSafeInteger)) throw new Error('invalid_projection_cursor');
      }
      const where = `owner_id=? AND video_id=? AND archived=? ${request.recentOnly ? 'AND has_user=1' : ''}`;
      const parameters = [owner, request.videoId, Number(request.archived)];
      // Landing selection historically follows creation time, not sidebar
      // activity/pin order. Preserve it without fetching every navigation page.
      const latest = request.recentOnly ? undefined : this.store.db.prepare(`SELECT id FROM client_session_index
        WHERE owner_id=? AND video_id=? AND archived=? ORDER BY created_at DESC,id DESC LIMIT 1`).get(...parameters) as { id: number } | undefined;
      const rows = this.store.db.prepare(`SELECT id,video_id,title,pinned,archived,created_at,activity,has_user FROM client_session_index
        WHERE ${where} ${order ? `AND (pinned,activity,created_at,id)${backwards ? '>' : '<'}(?,?,?,?)` : ''}
        ORDER BY pinned ${backwards ? 'ASC' : 'DESC'},activity ${backwards ? 'ASC' : 'DESC'},created_at ${backwards ? 'ASC' : 'DESC'},id ${backwards ? 'ASC' : 'DESC'} LIMIT 50`)
        .all(...parameters, ...(order ?? [])) as {
          id: number; video_id: string; title: string; pinned: number; archived: number; created_at: number; activity: number; has_user: number;
        }[];
      const page = backwards ? rows.reverse() : rows, first = page[0], last = page.at(-1);
      const position = (row: typeof rows[number]) => [row.pinned, row.activity, row.created_at, row.id];
      const more = (row: typeof rows[number] | undefined, comparison: '<' | '>') => !!row && !!this.store.db.prepare(
        `SELECT 1 FROM client_session_index WHERE ${where} AND (pinned,activity,created_at,id)${comparison}(?,?,?,?) LIMIT 1`)
        .get(...parameters, ...position(row));
      const cursorFor = (row: typeof rows[number], direction: 'before' | 'after') => this.encode({ owner, table: 'chatSessions', parent, epoch, version,
        key: JSON.stringify({ direction, order: position(row) }) });
      return { epoch, version, ...(latest ? { latestId: latest.id } : {}), sessions: page.map(row => ({ id: row.id, videoId: row.video_id, title: row.title,
        pinned: !!row.pinned, archived: !!row.archived, createdAt: row.created_at, activity: row.activity, hasUser: !!row.has_user })),
        ...(more(last, '<') ? { next: cursorFor(last!, 'after') } : {}),
        ...(more(first, '>') ? { previous: cursorFor(first!, 'before') } : {}) };
    })();
  }
  keys(owner: string, request: Extract<RuntimeRead, { kind: 'recordKeys' }>) {
    if (!request.keys.length || request.keys.length > 100) throw new Error('projection_keys_limit');
    const seen = new Set<string>();
    for (const entry of request.keys) {
      checkTable(entry.table);
      if (typeof entry.key !== 'string' && typeof entry.key !== 'number'
        || typeof entry.key === 'string' && (!entry.key || entry.key.length > 256)
        || typeof entry.key === 'number' && (!Number.isSafeInteger(entry.key) || entry.key < 0)) throw new Error('invalid_projection_key');
      const id = JSON.stringify([entry.table, entry.key]);
      if (seen.has(id)) throw new Error('duplicate_projection_key');
      seen.add(id);
    }
    return this.store.db.transaction(() => {
      const query = this.store.db.prepare('SELECT table_name,record_key,value,revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?');
      const length = this.store.db.prepare('SELECT length(CAST(value AS BLOB)) AS bytes FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?');
      let bytes = 0;
      const records = request.keys.map(({ table, key }) => {
        const wireKey = JSON.stringify(key);
        const size = (length.get(owner, table, wireKey) as { bytes: number | null } | undefined)?.bytes ?? 0;
        if (bytes + size > PROJECTION_RECORD_BYTES) throw new Error('projection_keys_bytes_limit');
        const row = query.get(owner, table, wireKey) as Parameters<typeof dto>[0] | undefined;
        const record = row ? dto(row) : { table, key, value: null, revision: 0 };
        bytes += Buffer.byteLength(JSON.stringify(record));
        if (bytes > PROJECTION_RECORD_BYTES) throw new Error('projection_keys_bytes_limit');
        return record;
      });
      if (Buffer.byteLength(JSON.stringify(records)) > PROJECTION_RECORD_BYTES) throw new Error('projection_keys_bytes_limit');
      return { records, epoch: recordsEpoch(this.store) };
    })();
  }
  page(owner: string, request: Extract<RuntimeRead, { kind: 'collectionPage' }>): CollectionPage {
    checkTable(request.table);
    if (request.parent === undefined && parentRequired.has(request.table)) throw new Error('projection_parent_required');
    if (request.parent !== undefined && (typeof request.parent !== 'string' && typeof request.parent !== 'number'
      || typeof request.parent === 'string' && request.parent.length > 256
      || typeof request.parent === 'number' && !Number.isSafeInteger(request.parent))) throw new Error('invalid_projection_parent');
    const parent = request.parent === undefined ? '*' : `parent:${JSON.stringify(request.parent)}`;
    return this.store.db.transaction(() => {
      const epoch = recordsEpoch(this.store);
      const version = (this.store.db.prepare('SELECT version FROM client_collection_heads WHERE owner_id=? AND table_name=? AND parent=?')
        .get(owner, request.table, parent) as { version: number } | undefined)?.version ?? 0;
      const scope = { owner, table: request.table, parent, version, epoch };
      let key: string | undefined;
      if (request.cursor !== undefined) {
        const cursor = this.decode(request.cursor);
        if (cursor.owner !== owner || cursor.table !== scope.table || cursor.parent !== parent) throw new Error('projection_cursor_scope');
        if (cursor.epoch !== epoch || cursor.version !== version) throw new Error('projection_cursor_expired');
        key = cursor.key;
      }
      // Fetch lengths first: LIMIT 51 alone could copy 51 multi-MiB bodies into
      // JS before the response budget has a chance to stop iteration.
      const rows = this.store.db.prepare(`SELECT record_key,length(CAST(value AS BLOB)) AS bytes FROM cloud_records
        WHERE owner_id=? AND table_name=? AND value IS NOT NULL
        ${request.parent === undefined ? '' : `AND (${recordParentSql})=?`}
        ${key === undefined ? '' : 'AND record_key>?'} ORDER BY record_key LIMIT ?`)
        .all(owner, request.table, ...(request.parent === undefined ? [] : [request.parent]), ...(key === undefined ? [] : [key]), PROJECTION_PAGE_SIZE + 1) as { record_key: string; bytes: number }[];
      const read = this.store.db.prepare('SELECT table_name,record_key,value,revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?');
      const records: RuntimeRecord[] = [];
      let bytes = 0;
      for (const row of rows.slice(0, PROJECTION_PAGE_SIZE)) {
        if (records.length && bytes + row.bytes > PROJECTION_PAGE_BYTES) break;
        if (row.bytes > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
        const record = dto(read.get(owner, request.table, row.record_key) as Parameters<typeof dto>[0]), size = Buffer.byteLength(JSON.stringify(record));
        if (size > PROJECTION_RECORD_BYTES) throw new Error('projection_record_bytes_limit');
        if (records.length && bytes + size > PROJECTION_PAGE_BYTES) break;
        records.push(record); bytes += size;
      }
      return { records, version, epoch, ...(rows.length > records.length ? { next: this.encode({ ...scope, key: rows[records.length - 1].record_key }) } : {}) };
    })();
  }
  private secret() {
    this.store.db.prepare('INSERT OR IGNORE INTO app_state(key,value) VALUES(?,?)').run('projection-cursor-secret', crypto.randomBytes(32).toString('hex'));
    return (this.store.db.prepare('SELECT value FROM app_state WHERE key=?').get('projection-cursor-secret') as { value: string }).value;
  }
  private encode(cursor: Cursor) {
    const body = Buffer.from(JSON.stringify(cursor)).toString('base64url');
    return `${body}.${crypto.createHmac('sha256', this.secret()).update(body).digest('base64url')}`;
  }
  private decode(value: string): Cursor {
    if (value.length > 4096) throw new Error('invalid_projection_cursor');
    const parts = value.split('.');
    const expected = crypto.createHmac('sha256', this.secret()).update(parts[0]).digest('base64url');
    if (parts.length !== 2 || parts[1].length !== expected.length || !crypto.timingSafeEqual(Buffer.from(parts[1]), Buffer.from(expected))) throw new Error('invalid_projection_cursor');
    try {
      const cursor = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      if (typeof cursor.key !== 'string' || !Number.isSafeInteger(cursor.version)) throw new Error();
      return cursor;
    } catch { throw new Error('invalid_projection_cursor'); }
  }
  studySummary(owner: string): StudySummary {
    return this.store.db.transaction(() => {
      const stats = this.store.db.prepare(`SELECT coalesce(sum(json_extract(value,'$.seconds')),0) AS totalSeconds,
        count(*) AS activeDays FROM cloud_records INDEXED BY cloud_records_study_scalars WHERE owner_id=? AND table_name='studyDays'
        AND value IS NOT NULL AND json_extract(value,'$.seconds')>0`).get(owner) as Pick<StudySummary, 'totalSeconds' | 'activeDays'>;
      return { ...stats, snapshot: this.encode({ owner, table: 'studyDays', parent: '*', key: 'clear',
        epoch: recordsEpoch(this.store), version: this.studyVersion(owner) }) };
    })();
  }
  /** Called inside the same SQL transaction as deletion + durable receipt. */
  assertStudySnapshot(owner: string, token: string) {
    const snapshot = this.decode(token);
    if (snapshot.owner !== owner || snapshot.table !== 'studyDays' || snapshot.parent !== '*' || snapshot.key !== 'clear') throw new Error('study_snapshot_scope');
    if (snapshot.epoch !== recordsEpoch(this.store) || snapshot.version !== this.studyVersion(owner)) throw new Error('study_snapshot_changed');
  }
  private studyVersion(owner: string) {
    return (this.store.db.prepare("SELECT version FROM client_collection_heads WHERE owner_id=? AND table_name='studyDays' AND parent='*'")
      .get(owner) as { version: number } | undefined)?.version ?? 0;
  }
}
