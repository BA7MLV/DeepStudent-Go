import { db, type FolderRow, type VideoRow } from '../store/db';
import { cloud } from '../cloud/state';
import { loadCollection } from '../client/collections';
import { readRecordKeys } from '../cloud/sync';
import { accountLifetime } from '../client/account-lifecycle';

export function folderAncestors(folders: FolderRow[], id: number | null): FolderRow[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const result: FolderRow[] = [];
  const seen = new Set<number>();
  while (id != null && !seen.has(id)) {
    seen.add(id);
    const folder = byId.get(id);
    if (!folder) break;
    result.unshift(folder);
    id = folder.parentId ?? null;
  }
  return result;
}

export function validFolderDrop(folders: FolderRow[], keys: string[], target: number | null) {
  if (!keys.length || (target != null && !folders.some((folder) => folder.id === target))) return false;
  const ancestors = new Set(folderAncestors(folders, target).map((folder) => folder.id));
  return keys.every((key) => key.startsWith('file:') ||
    (key.startsWith('folder:') && folders.some((folder) => folder.id === Number(key.slice(7))) && !ancestors.has(Number(key.slice(7)))));
}

/** Server validates and commits the whole mixed selection atomically. */
export async function moveLibraryItems(keys: string[], target: number | null) {
  const database = db, lifetime = cloud.enabled ? accountLifetime(cloud.userId) : undefined;
  const guard = () => { lifetime?.assertCurrent(); if (database !== db) throw new Error('client_account_changed'); };
  const folders = cloud.enabled ? await loadCollection<FolderRow>('folders', undefined) : await db.folders.toArray();
  guard();
  if (!validFolderDrop(folders, keys, target)) throw new Error('不能将文件夹移入自身或子文件夹');
  const placements = [];
  for (const key of new Set(keys)) {
    const row = key.startsWith('folder:') ? cloud.enabled ? (await readRecordKeys<FolderRow>('folders', [Number(key.slice(7))]))[0] : await db.folders.get(Number(key.slice(7)))
      : key.startsWith('file:') ? cloud.enabled ? (await readRecordKeys<VideoRow>('videos', [key.slice(5)]))[0] : await db.videos.get(key.slice(5)) : undefined;
    guard();
    if (!row) throw new Error('资料已不存在');
    const parent = ('parentId' in row ? row.parentId : 'folderId' in row ? row.folderId : null) ?? null;
    if (parent !== target) placements.push({ key, parent, target });
  }
  const moved = placements.length ? await (await import('../client/resources')).resourceCommand({ kind: 'moveLibrarySelection', placements }) as unknown as typeof placements : [];
  guard();
  await (await import('../cloud/sync')).flushCloud();
  return moved;
}

export async function undoLibraryMove(placements: Awaited<ReturnType<typeof moveLibraryItems>>) {
  if (placements.length) await (await import('../client/resources')).resourceCommand({ kind: 'moveLibrarySelection', placements: placements.map(item => ({ ...item, parent: item.target, target: item.parent })) });
  await (await import('../cloud/sync')).flushCloud();
}
