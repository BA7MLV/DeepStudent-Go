import Dexie from 'dexie';
import { db } from '../store/db';
import { getMaterialFile } from '../store/fileStore';
import { extractMdUnits, MD_MIME } from './md';
import { reindexMaterial } from './reindex';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { cloud } from '../cloud/state';
import { resourceCommand } from '../client/resources';
import { flushCloud } from '../cloud/sync';
import type { MaterialParseResult } from './reindex';

/** Ordinary Markdown persistence shared by editor and tools; no notebook schema. */
export async function saveMarkdownMaterial(id: string, text: string, expected?: string, name?: string,
  creation?: { folderId?: number; createOnly?: boolean }) {
  if (cloud.enabled) {
    const current = expected ?? await (await getMaterialFile(id))?.text() ?? '';
    const operation = { kind: 'saveMarkdown' as const, courseId: id, text, expected: current, ...(name ? { name } : {}), ...creation };
    const result = await resourceCommand(operation);
    await flushCloud();
    useLibraryRevision.getState().bump();
    return result as unknown as MaterialParseResult;
  }
  const result = await db.transaction('rw', [db.files, db.videos, db.materialBlocks, db.table('courseFiles')], async () => {
    const row = await db.videos.get(id);
    if (row && (row.kind !== 'material' || row.materialFormat !== 'md')) throw new Error('只能修改 Markdown 资料。');
    const file = await Dexie.waitFor(getMaterialFile(id));
    if (creation?.createOnly && (row || file)) throw new Error('文件已存在，请先 read，再用 edits 修改。');
    const current = file ? await Dexie.waitFor(file.text()) : '';
    if (expected !== undefined && current !== expected) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
    const blob = new Blob([text], { type: MD_MIME });
    if (!row) await db.videos.put({ id, name: name ?? id, folderId: creation?.folderId, kind: 'material', materialFormat: 'md',
      mimeType: MD_MIME, duration: 0, size: blob.size, status: 'new', coverState: 'pending', createdAt: Date.now() });
    await db.files.put({ id, blob });
    await db.videos.update(id, { size: blob.size, lastUnit: undefined, fileDeleted: undefined });
    return reindexMaterial(id, 'md', extractMdUnits(text), null);
  });
  useLibraryRevision.getState().bump();
  return result;
}
