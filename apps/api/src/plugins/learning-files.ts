import { constants } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords } from '../cloud/records.js';
import type { ResourceFiles } from '../projects/resources.js';

const textLimit = 4 * 1024 * 1024;

/** Reads the actual Markdown, not materialBlocks (a lossy search index).
 * 调用链(插件能力、学习任务投递)都在请求或任务执行中,所以走 fs/promises。 */
export async function readLearningMarkdown(store: DatabaseStore, filesDir: string, owner: string, id: string, resources?: ResourceFiles) {
  const records = new CloudRecords(store), course = records.get(owner, 'videos', id);
  if (!course || course.fileDeleted) throw new Error('plugin_material_not_found');
  if (course.kind !== 'material' || course.materialFormat !== 'md') throw new Error('plugin_markdown_required');
  const mapped = store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id) as { project_id: string; path: string } | undefined;
  let text: string;
  if (mapped) {
    if (!resources) throw new Error('plugin_resource_service_unavailable');
    // Canonical ownership/grants and live-project lease checks remain in ResourceFiles.
    const resolved = resources.course(owner, id);
    text = resources.projects.files.read(resolved.project_id, resolved.path).text;
  } else {
    const edited = records.get(owner, 'files', id), original = records.get(owner, 'courseFiles', id);
    const blob = edited?.blob?.$file ?? original?.fileId;
    const file = store.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(typeof blob === 'string' ? blob : '', owner) as { storage_name: string } | undefined;
    if (!file) throw new Error('plugin_material_file_not_found');
    const filename = path.resolve(filesDir, file.storage_name);
    if (path.dirname(filename) !== path.resolve(filesDir)) throw new Error('plugin_material_denied');
    // 与旧同步实现一致:不跟随符号链接、不阻塞在 FIFO 上,先验 nlink/大小再读全文。
    const handle = await fsp.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > textLimit) throw new Error('plugin_markdown_limit');
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
  }
  if (text.length > textLimit) throw new Error('plugin_markdown_limit');
  return { text, revision: crypto.createHash('sha256').update(text).digest('hex') };
}
