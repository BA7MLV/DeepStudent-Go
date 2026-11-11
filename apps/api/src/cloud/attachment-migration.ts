import crypto from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from './records.js';
import { receiveFile, fileOperationId } from './files.js';
import { ensureImageReference, ownedImagePath } from './attachment-images.js';

/** Explicit controlled writer only. No projection/read path calls this function.
 * Each record is installed only after every embedded image is durable and verified.
 * Failed rows remain byte-for-byte unchanged; already installed blobs are reused. */
export async function migrateChatAttachmentReferences(store: DatabaseStore, records: CloudRecords, directory: string, owner: string, limit = 20, afterRevision = 0) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('invalid_migration_limit');
  if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) throw new Error('invalid_migration_cursor');
  const rows = store.db.prepare(`SELECT record_key,value,revision FROM cloud_records WHERE owner_id=? AND table_name='chats'
    AND value IS NOT NULL AND revision>? AND instr(value,'data:image/')>0 ORDER BY revision LIMIT ?`).all(owner, afterRevision, limit) as { record_key: string; value: string; revision: number }[];
  const result = { migrated: 0, failed: 0, raced: 0 };
  for (const row of rows) {
    try {
      const before = JSON.parse(row.value);
      const after = await rewriteAttachmentImages(store, directory, owner, before);
      if (JSON.stringify(after) === JSON.stringify(before)) continue;
      store.transaction(() => {
        const current = store.db.prepare("SELECT value,revision FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key=?").get(owner, row.record_key) as { value: string; revision: number } | undefined;
        if (!current || current.value !== row.value || current.revision !== row.revision) { result.raced++; return; }
        records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: JSON.parse(row.record_key), before, after }]);
        result.migrated++;
      });
    } catch { result.failed++; }
  }
  return { ...result, nextRevision: rows.at(-1)?.revision ?? afterRevision };
}

/** Terminal task input is also history. Active inputs/checkpoints are not rewritten
 * underneath a running executor; their references are resolved on execution. */
export async function migrateTerminalTaskAttachmentReferences(store: DatabaseStore, directory: string, owner: string, limit = 20, afterId = '') {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || afterId.length > 100) throw new Error('invalid_migration_limit');
  const rows = store.db.prepare(`SELECT id,input,status FROM cloud_tasks WHERE owner_id=? AND kind='chat'
    AND status IN ('completed','failed','cancelled','interrupted') AND id>? AND instr(input,'data:image/')>0 ORDER BY id LIMIT ?`).all(owner, afterId, limit) as { id: string; input: string; status: string }[];
  const result = { migrated: 0, failed: 0, raced: 0 };
  for (const row of rows) {
    try {
      const before = JSON.parse(row.input), after = await rewriteAttachmentImages(store, directory, owner, before);
      const updated = JSON.stringify(after);
      if (updated === row.input) continue;
      const changed = store.db.prepare('UPDATE cloud_tasks SET input=? WHERE id=? AND owner_id=? AND input=? AND status=?').run(updated, row.id, owner, row.input, row.status);
      if (changed.changes) result.migrated++; else result.raced++;
    } catch { result.failed++; }
  }
  return { ...result, nextId: rows.at(-1)?.id ?? afterId };
}

async function rewriteAttachmentImages(store: DatabaseStore, directory: string, owner: string, before: unknown) {
  const install = async (url: string) => {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(url);
    if (!match || url.length > 44_000_000) throw new Error('invalid_legacy_image');
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.toString('base64') !== match[2]) throw new Error('invalid_legacy_base64');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = await receiveFile(store, directory, owner, Readable.from(bytes), 'history-image', match[1], 32_000_000, bytes.length, undefined, fileOperationId(owner, sha, 'history-image-v1'));
    const stored = store.db.prepare('SELECT storage_name,sha256 FROM files WHERE id=? AND owner_id=?').get(file.id, owner) as { storage_name: string; sha256: string };
    if (crypto.createHash('sha256').update(fs.readFileSync(ownedImagePath(directory, stored.storage_name))).digest('hex') !== sha) throw new Error('migration_file_verification_failed');
    return { serverId: file.id, ...await ensureImageReference(store, directory, owner, file.id) };
  };
  const walk = async (value: any): Promise<any> => {
    if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await walk(item)); return out; }
    if (!value || typeof value !== 'object') return value;
    const out: Record<string, any> = {};
    for (const [key, item] of Object.entries(value)) out[key] = await walk(item);
    if (typeof value.dataUrl === 'string' && value.dataUrl.startsWith('data:image/')) {
      // Preserve any existing original. Legacy dataUrl can be a lossy thumbnail.
      const inline = await install(value.dataUrl);
      if (typeof value.serverId === 'string') {
        const original = store.db.prepare('SELECT storage_name,sha256 FROM files WHERE id=? AND owner_id=?').get(value.serverId, owner) as { storage_name: string; sha256: string } | undefined;
        if (!original || crypto.createHash('sha256').update(fs.readFileSync(ownedImagePath(directory, original.storage_name))).digest('hex') !== original.sha256) throw new Error('migration_original_unavailable');
        Object.assign(out, await ensureImageReference(store, directory, owner, value.serverId));
      } else Object.assign(out, inline);
      delete out.dataUrl;
    }
    if (value.type === 'image_url' && typeof value.image_url?.url === 'string' && value.image_url.url.startsWith('data:image/')) {
      const image = await install(value.image_url.url);
      out.image_url = { ...out.image_url, url: `attachment-file:${image.serverId}` };
    }
    return out;
  };
  return walk(before);
}
