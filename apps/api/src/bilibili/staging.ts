import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';

/** After task recovery, remove only staging directories belonging to known,
 * terminal Bilibili jobs. Never sweep other file uploads or unknown paths. */
export function cleanBiliStaging(store: DatabaseStore, filesDir: string) {
  const root = path.join(filesDir, '.bilibili-imports');
  if (!fs.existsSync(root) || !fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const match = /^([0-9a-f-]{36})-[a-zA-Z0-9]{6}$/.exec(entry.name);
    if (!entry.isDirectory() || !match) continue;
    const task = store.db.prepare("SELECT status FROM cloud_tasks WHERE id=? AND kind='bilibiliImport'").get(match[1]) as { status: string } | undefined;
    if (task && ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
  }
}
