import Dexie from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { apiUrl } from '../api/base';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { flushCloud } from './sync';
import { migratePreferences, libraryPreferenceKeys } from './preferences';
import type { LibraryImport, ResourceCommand } from '@wangke/contracts/resources';
import { LIBRARY_IMPORT_FIELDS } from '@wangke/contracts/resources';
import { encodeRecoveryValue } from './recovery-export';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';

const sources = {
  courses: 'videos', folders: 'folders', files: 'files', segments: 'segments', tracks: 'subtitleTracks',
  blocks: 'materialBlocks', frames: 'frames', covers: 'covers', handouts: 'handouts', cards: 'cards',
  comments: 'comments', danmakus: 'danmakus', sessions: 'chatSessions', messages: 'chats',
  skills: 'skills', references: 'skillRefs', annotations: 'materialInk', studyDays: 'studyDays',
} as const;

/** An immutable source snapshot and operation identity survive every retry. The
 * old database (including its outbox) and OPFS are only read, never rewritten.
 * Unknown binary outcomes stop for inspection rather than retransmitting. */
export async function migrateLocalData(progress: (message: string) => void) {
  const owner = cloud.userId, database = db;
  const run = () => {
    if (owner !== cloud.userId || database !== db) throw new Error('client_account_changed');
    return importLocalData(progress);
  };
  if (!navigator.locks) throw new Error('此浏览器缺少安全导入所需的跨标签锁；请导出原库后在支持的浏览器显式转换');
  return navigator.locks.request(`library-import:${owner}`, run);
}

async function importLocalData(progress: (message: string) => void) {
  const database = db, owner = cloud.userId;
  const check = () => { if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  const runtime = await serverRuntime(owner);
  const assertCurrent = () => { check(); if (!isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  const key = 'library-import';
  const save = async (value: any) => { assertCurrent(); await database.table('_cloudMeta').put({ id: key, value }); };
  let draft = (await database.table('_cloudMeta').get(key))?.value;
  if (draft?.state === 'completed') throw new Error('此浏览器数据已导入');
  if (!draft) {
    const legacy = new Dexie('wangke');
    await legacy.open();
    try {
      // A consistent IDB snapshot; OPFS is copied into this durable snapshot
      // before any network request. Nothing is inferred from old outbox effects.
      const snapshot = await legacy.transaction('r', legacy.tables, async () => {
        const entries = await Promise.all(Object.entries(sources).map(async ([name, table]) => [name, legacy.tables.some(t => t.name === table) ? await legacy.table(table).toArray() : []]));
        const archive = Object.fromEntries(await Promise.all(legacy.tables.map(async table => [table.name, await table.toArray()])));
        return { ...Object.fromEntries(entries), archive };
      });
      const files = new Map<string, Blob>(snapshot.files.map((row: any) => [row.id, row.blob]));
      const root = await navigator.storage?.getDirectory?.();
      for (const directory of ['videos', 'materials']) {
        const dir = await root?.getDirectoryHandle(directory).catch(() => null);
        if (!dir) continue;
        for await (const [id, handle] of (dir as any).entries()) if (handle.kind === 'file' && !files.has(id)) files.set(id, await handle.getFile());
      }
      snapshot.files = [...files].map(([id, blob]) => ({ id, blob }));
      draft = { operationId: `library-${crypto.randomUUID()}`, source: { sourceId: crypto.randomUUID(), ...snapshot }, deviceSettings: localStorage.getItem('wangke-settings'), state: 'snapshot', uploads: {} };
      await save(draft);
    } finally { legacy.close(); }
  }
  // If the SQL/files command response was lost, resolve its original receipt
  // before touching the snapshot or any Blob. Pending/uncertain is never replayed.
  for (const [name, fields] of Object.entries(LIBRARY_IMPORT_FIELDS)) {
    const unknown = draft.source[name].flatMap((row: object) => Object.keys(row).filter(key => !fields.split(' ').includes(key)));
    if (unknown.length) throw new Error(`旧库字段需显式转换：${name}.${[...new Set(unknown)].join('、')}；请先导出原始快照，原库保持不变`);
  }
  const references = draft.source.archive?.courseFiles ?? [];
  const preferenceRows = draft.source.archive?.preferences ?? [];
  if (preferenceRows.some((row: any) => !libraryPreferenceKeys.includes(row.id) || Object.keys(row).some(key => !['id', 'value'].includes(key)))) throw new Error('旧库偏好包含未声明字段，需显式转换；原始快照可完整导出');
  const knownTables = new Set([...Object.values(sources), 'courseFiles', 'preferences', '_cloudMeta', '_cloudBlobs', '_cloudOutbox', 'embeddings', 'materialEmbeddings']);
  if (Object.entries(draft.source.archive ?? {}).some(([name, rows]) => !knownTables.has(name) && (rows as unknown[]).length)) throw new Error('旧库包含未声明数据表，需显式转换；原始快照可完整导出');
  const mappings = draft.fileMappings ?? {};
  if (references.some((row: any) => !mappings[row.id])) throw new Error('旧库包含外部文件引用，请在“核对导入文件”中逐项选择持久字节并确认映射；原路径不会被当作服务器授权');
  const { archive: _archive, ...source } = draft.source;
  const librarySource = { ...source, files: [...source.files.filter((row: any) => !mappings[row.id]), ...Object.values(mappings).map((row: any) => ({ id: row.courseId, blob: row.blob }))],
    ...(references.length ? { fileMappings: Object.values(mappings) } : {}) };
  // Strict generated codec before network I/O: validates every declared nested
  // field instead of letting the projecting codec silently discard legacy data.
  const preview = async (value: any): Promise<any> => {
    if (value instanceof Blob) return { $file: 'preflight-blob', type: value.type };
    if (Array.isArray(value)) return Promise.all(value.map(preview));
    if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await preview(item)])));
    return value;
  };
  const candidate = { operationId: draft.operationId, operation: { kind: 'importLibrary', library: await preview(librarySource) } };
  const codec = TYPERT_REMOTE.methods['clientRuntime/resourceCommand'].parameters[0].codec;
  if (!codec || codec.mode !== 'strict') throw new Error('library_import_codec_unavailable');
  let validated: unknown;
  try { validated = codec.create().parse(candidate); }
  catch (error) { throw new Error(`旧库完整schema需显式转换（未上传任何新数据）：${String(error)}；原始快照可完整导出`); }
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  if (canonical(validated) !== canonical(candidate)) throw new Error('旧库包含codec未声明的嵌套字段，需显式转换；未上传任何新数据，原始快照可完整导出');
  if (draft.request) {
    const receipt = await runtime.receipt(draft.operationId); assertCurrent();
    if (receipt.status === 'completed') { await migratePreferences(draft.deviceSettings ?? null, preferenceRows); await save({ ...draft, state: 'completed' }); await flushCloud(); return; }
    if (receipt.status !== 'missing') throw new Error('旧库导入结果待核对；原始快照和命令已保留，不会重复导入');
    // A missing resource receipt does not prove that an effect never started.
    // This create-only import has its admission and SQL snapshot in one SQL
    // transaction; only its explicitly missing admission is safe to submit again.
  }
  const encode = async (value: any): Promise<any> => {
    if (value instanceof Blob) {
      const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
      const blobKey = `${hash}:${value.type}`;
      const old = draft.uploads[blobKey];
      if (old?.file) return { $file: old.file, type: value.type };
      if (old) {
        const receipt = await runtime.receipt(old.request.operationId); assertCurrent();
        if (receipt.status === 'completed') {
          const file = (receipt.value as any).file;
          if (!file?.id || file.sha256 !== hash || file.sizeBytes !== value.size) throw new Error('library_blob_receipt_mismatch');
          draft.uploads[blobKey] = { ...old, state: 'completed', file: file.id };
          await save(draft); return { $file: file.id, type: value.type };
        }
        if (receipt.status !== 'missing') throw new Error('旧库附件上传结果待核对；原 Blob 已保留，不会自动重传');
      }
      const request = old?.request ?? { operationId: `library-blob-${crypto.randomUUID()}`, operation: { kind: 'importLibraryBlob', sourceId: draft.source.sourceId, size: value.size, sha256: hash, contentType: value.type } };
      draft.uploads[blobKey] = { request, state: 'uncertain', blob: value };
      await save(draft);
      await runtime.resourceCommand(request); assertCurrent();
      progress('正在上传旧库附件…');
      const response = await fetch(apiUrl(`/api/v1/files?operationId=${encodeURIComponent(request.operationId)}`), { method: 'POST', credentials: 'include', headers: {
        'content-type': 'application/octet-stream', 'x-file-name': 'cache-blob', 'x-file-mime': value.type || 'application/octet-stream',
      }, body: value });
      if (!response.ok) throw new Error(`旧库附件上传失败（${response.status}），原数据已保留`);
      const file = await response.json(); assertCurrent();
      draft.uploads[blobKey] = { request, state: 'completed', file: file.id };
      await save(draft);
      return { $file: file.id, type: value.type };
    }
    if (Array.isArray(value)) { const result = []; for (const item of value) result.push(await encode(item)); return result; }
    if (value && typeof value === 'object') { const result: Record<string, any> = {}; for (const [name, item] of Object.entries(value)) if (item !== undefined) result[name] = await encode(item); return result; }
    return value;
  };
  if (!draft.request) {
    const library = await encode(librarySource) as LibraryImport;
    draft.request = { operationId: draft.operationId, operation: { kind: 'importLibrary', library } } satisfies ResourceCommand;
    await save(draft);
  }
  progress('正在提交旧库快照…');
  await runtime.resourceCommand(draft.request); assertCurrent();
  await migratePreferences(draft.deviceSettings ?? null, preferenceRows);
  await save({ ...draft, state: 'completed' });
  await flushCloud();
}

export async function listLibraryFileMappings(): Promise<{ id: string; reference: unknown; mapped: { sha256: string; size: number } | null }[]> {
  const draft = (await db.table('_cloudMeta').get('library-import'))?.value;
  return (draft?.source.archive?.courseFiles ?? []).map((reference: any) => ({ id: String(reference.id), reference, mapped: draft.fileMappings?.[reference.id] ? { sha256: draft.fileMappings[reference.id].sha256, size: draft.fileMappings[reference.id].size } : null }));
}

/** A picked File is an explicit copy, not a grant to fetch an arbitrary URL or
 * adopt a foreign server fileId. Lock + exact source CAS binds it to the snapshot. */
export async function mapLibraryFile(id: string, expectedReference: unknown, blob: Blob) {
  const database = db, owner = cloud.userId;
  if (!navigator.locks || !blob.size) throw new Error('安全映射需要跨标签锁和非空文件');
  const sha256 = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
  return navigator.locks.request(`library-import:${owner}`, async () => {
    if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
    await database.transaction('rw', database.table('_cloudMeta'), async () => {
      const row = await database.table('_cloudMeta').get('library-import'), draft = row?.value;
      const reference = draft?.source.archive?.courseFiles?.find((row: any) => row.id === id);
      if (!reference || JSON.stringify(reference) !== JSON.stringify(expectedReference) || draft.request || draft.state === 'completed') throw new Error('library_file_mapping_changed');
      if (!draft.source.courses.some((course: any) => course.id === id)) throw new Error('library_file_course_missing');
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
      await database.table('_cloudMeta').put({ ...row, value: { ...draft, fileMappings: { ...draft.fileMappings, [id]: { courseId: id, expected: null, sourceReference: reference, blob, sha256, size: blob.size, contentType: blob.type } } } });
    });
  });
}

/** Export includes untouched transactions/operation IDs and all nested Blobs.
 * It is data for review, never an authorization to replay an old side effect. */
export async function exportLibraryImport() {
  const database = db, owner = cloud.userId;
  const draft = (await database.table('_cloudMeta').get('library-import'))?.value;
  if (!draft) throw new Error('尚无旧库导入快照，请先尝试导入');
  const value = await encodeRecoveryValue({ version: 1, owner, draft });
  if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a'); link.href = url; link.download = `library-import-${draft.operationId}.json`; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
