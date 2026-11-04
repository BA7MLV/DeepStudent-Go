import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LibraryImport } from '@wangke/contracts/resources';
import type { CloudMutation } from '@wangke/contracts/cloud';
import type { ResourceFiles } from '../projects/resources.js';

const definitions = {
  courses: ['videos', 'id', 'id name size mimeType duration createdAt status transcriptionPaused biliSource lastPosition finished fileDeleted pinned skillOverride folderId kind materialFormat unitCount lastUnit scanned empty htmlView dominantColor coverState'],
  folders: ['folders', 'id', 'id name createdAt parentId color'],
  files: ['files', 'id', 'id blob'],
  segments: ['segments', 'id', 'id videoId idx start end text status cues'],
  tracks: ['subtitleTracks', 'id', 'id videoId lang lanDoc primary cues'],
  blocks: ['materialBlocks', 'id', 'id materialId idx unit unitLabel text kind'],
  frames: ['frames', 'id', 'id videoId ts blob kind caption'],
  covers: ['covers', 'videoId', 'videoId blob w h ts source createdAt'],
  handouts: ['handouts', 'id', 'id videoId createdAt title blob outlineJson sectionsJson usedSkills readPos'],
  cards: ['cards', 'id', 'id videoId q a time status createdAt'],
  comments: ['comments', 'id', 'id videoId time author role text parentId createdAt'],
  danmakus: ['danmakus', 'id', 'id videoId time text'],
  sessions: ['chatSessions', 'id', 'id videoId title createdAt contextCourseIds projectFolderId skillIds pinnedSkillIds mcpServerIds pinned archived promptCacheKey contextCheckpoint contextOmissions'],
  messages: ['chats', 'id', 'id taskId videoId sessionId role content createdAt modelTrace modelRequests explicitSkillIds images attachments reasoning reasoningMs tools responseSegments quiz ask folderPlan resume interrupted interruptReason widget widgets legacyHtmlWorks widgetState widgetStates'],
  skills: ['skills', 'id', 'id name description body enabled builtin updatedAt mcpRequired'],
  references: ['skillRefs', 'id', 'id skillId path body'],
  annotations: ['materialInk', 'id', 'id materialId surface tool color width height points createdAt renderer nib opacity smoothing input anchor rects'],
  studyDays: ['studyDays', 'date', 'date seconds updatedAt'],
} as const;

/** Only an initial, create-only snapshot is admitted. All cross-references are
 * checked before admission; no permit/owner/placement or arbitrary table writes.
 * The SQL snapshot and durable admission commit together. Filesystem conversion
 * is journaled separately: a crash is inspectable, never automatic replay. */
export function importLibrary(resources: ResourceFiles, owner: string, operationId: string, digest: string, library: LibraryImport) {
  const { store } = resources.projects, { db } = store, records = resources.records;
  const fail = (reason: string): never => { throw new Error(`library_import_${reason}`); };
  if (!/^[a-zA-Z0-9_-]{16,100}$/.test(library.sourceId) || Object.keys(library).some(key => !['sourceId', 'fileMappings'].includes(key) && !Object.hasOwn(definitions, key))) fail('schema');
  if (db.prepare("SELECT 1 FROM client_commands WHERE owner_id=? AND json_extract(result,'$.librarySource') IS NOT NULL").get(owner)) fail('already_admitted');
  const ids = new Map<string, Set<string | number>>();
  const mutations: CloudMutation[] = [];
  const checked = new Set<string>();
  const persistentFile = (id: string) => {
    if (checked.has(id)) return;
    const file = db.prepare('SELECT storage_name,sha256,size_bytes FROM files WHERE owner_id=? AND id=?').get(owner, id) as { storage_name: string; sha256: string; size_bytes: number } | undefined;
    if (!file) return fail('file_denied');
    const filename = path.resolve(resources.filesDir, file.storage_name);
    if (path.dirname(filename) !== path.resolve(resources.filesDir)) fail('file_denied');
    let fd: number;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch { return fail('file_bytes_unavailable'); }
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1 || before.size !== file.size_bytes) fail('file_bytes_mismatch');
      const hash = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
      let count: number;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
      const after = fs.fstatSync(fd);
      if (hash.digest('hex') !== file.sha256 || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail('file_bytes_mismatch');
      checked.add(id);
    } finally { fs.closeSync(fd); }
  };
  const checkFiles = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('$file' in value && (typeof value.$file !== 'string' || !records.ownedFile(owner, value.$file))) fail('file_denied');
    if ('$file' in value) persistentFile(value.$file as string);
    for (const child of Object.values(value)) checkFiles(child);
  };
  for (const [name, [table, keyField, fields]] of Object.entries(definitions)) {
    const values = library[name as keyof typeof definitions] as unknown as Record<string, any>[];
    if (!Array.isArray(values) || values.length > 100000) fail('schema');
    const known = new Set<string | number>(); ids.set(name, known);
    for (const value of values) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(field => !fields.split(' ').includes(field))) fail('schema');
      const row = value as Record<string, any>;
      const key = row[keyField];
      if (!(typeof key === 'string' && key.length > 0 && key.length <= 256 || typeof key === 'number' && Number.isSafeInteger(key) && key > 0) || known.has(key)) fail('identity');
      known.add(key); checkFiles(row);
      mutations.push({ id: crypto.randomUUID(), table, key, before: null, after: row });
    }
  }
  const has = (name: string, key: unknown) => ids.get(name)!.has(key as string | number);
  const mapped = new Set<string>();
  for (const mapping of library.fileMappings ?? []) {
    if (mapped.has(mapping.courseId) || !has('courses', mapping.courseId) || mapping.expected !== null) fail('file_mapping');
    mapped.add(mapping.courseId);
    const source = library.files.find(row => row.id === mapping.courseId);
    const file = db.prepare('SELECT sha256,size_bytes,mime_type FROM files WHERE owner_id=? AND id=?').get(owner, mapping.blob.$file) as { sha256: string; size_bytes: number; mime_type: string } | undefined;
    if (!source || source.blob.$file !== mapping.blob.$file || !file || file.sha256 !== mapping.sha256 || file.size_bytes !== mapping.size || file.mime_type !== (mapping.contentType || 'application/octet-stream')) fail('file_mapping');
  }
  for (const folder of library.folders) {
    const seen = new Set<number>([folder.id]); let parent = folder.parentId;
    while (parent != null) {
      if (!has('folders', parent) || seen.has(parent)) fail('folder_reference');
      seen.add(parent); parent = library.folders.find(row => row.id === parent)!.parentId;
    }
  }
  for (const course of library.courses) {
    if (course.folderId != null && !has('folders', course.folderId)) fail('folder_reference');
    if (course.skillOverride && [...course.skillOverride.pin, ...course.skillOverride.drop].some(id => !has('skills', id))) fail('skill_reference');
  }
  for (const name of ['segments', 'tracks', 'blocks', 'frames', 'covers', 'handouts', 'cards', 'comments', 'danmakus', 'annotations'] as const) {
    for (const row of library[name] as unknown as Record<string, any>[]) if (!has('courses', row.videoId ?? row.materialId)) fail('course_reference');
  }
  for (const session of library.sessions) {
    // Global library/assistant sessions have an established synthetic videoId.
    if (typeof session.videoId !== 'string') fail('session_reference');
    if (session.projectFolderId != null && !has('folders', session.projectFolderId)) fail('folder_reference');
    if (session.contextCourseIds?.some(id => !has('courses', id))) fail('course_reference');
    if (session.skillIds?.some(id => !has('skills', id))) fail('skill_reference');
    if (session.pinnedSkillIds?.some(id => !has('skills', id))) fail('skill_reference');
  }
  for (const message of library.messages) {
    const session = library.sessions.find(row => row.id === message.sessionId);
    if (!session || session.videoId !== message.videoId) fail('session_reference');
  }
  for (const reference of library.references) if (!has('skills', reference.skillId)) fail('skill_reference');
  for (const comment of library.comments) if (comment.parentId != null && !library.comments.some(row => row.id === comment.parentId && row.videoId === comment.videoId)) fail('comment_reference');
  for (const row of library.studyDays) if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(row.seconds) || row.seconds < 0 || row.seconds > 86400) fail('study_time');
  // No existing business rows or tombstones may be overwritten. Default skills
  // can coexist only if byte-identical; otherwise retain the snapshot for review.
  const sourceMetadata = library.courses.map(({ id, name, size, folderId }) => ({ id, name, size, ...(folderId === undefined ? {} : { folderId }) }));
  store.systemFiles.withOperation(owner, operationId, () => store.transaction(() => {
    if (db.prepare("SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name NOT IN ('preferences','skills','skillRefs','studyDays') LIMIT 1").get(owner)) fail('destination_not_empty');
    for (let i = mutations.length - 1; i >= 0; i--) {
      const op = mutations[i];
      if (op.table === 'studyDays') continue;
      if (db.prepare('SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, op.table, JSON.stringify(op.key))) {
        if (['skills', 'skillRefs'].includes(op.table) && isDeepStrictEqual(records.get(owner, op.table, op.key), op.after)) mutations.splice(i, 1);
        else fail('identity_conflict');
      }
    }
    db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status,result) VALUES(?,?,?,'pending',?)")
      .run(owner, operationId, digest, JSON.stringify({ librarySource: library.sourceId, phase: 'materializing', sourceMetadata }));
    records.apply(owner, mutations);
  }));
  try {
    resources.migrate(owner);
    const result = { librarySource: library.sourceId, imported: mutations.length, sourceMetadata, fileMappings: (library.fileMappings ?? []).map(mapping => ({ ...mapping, blob: { ...mapping.blob } })) };
    store.transaction(() => {
      db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify(result), owner, operationId);
      db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'resources',?)").run(owner, operationId);
    });
    return result;
  } catch (error) {
    db.prepare('UPDATE client_commands SET error=? WHERE owner_id=? AND operation_id=?').run(String(error), owner, operationId);
    throw error;
  }
}
