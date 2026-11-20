import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';

/** After task recovery, remove only staging directories belonging to known,
 * terminal Bilibili jobs. Never sweep other file uploads or unknown paths. */
export async function cleanBiliStaging(store: DatabaseStore, filesDir: string) {
  const root = path.join(filesDir, '.bilibili-imports');
  const stat = await fsp.lstat(root).catch(() => undefined);
  // 不存在、不是目录、或是符号链接:一律不动(与旧同步实现同一判定)。
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return;
  const entries = await fsp.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const match = /^([0-9a-f-]{36})-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const task = store.db.prepare("SELECT status FROM cloud_tasks WHERE id=? AND kind='bilibiliImport'").get(match[1]) as { status: string } | undefined;
    if (task && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
  }
}
