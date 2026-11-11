import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import type { DatabaseStore } from '../storage/database.js';
import { receiveFile, fileOperationId } from './files.js';

export function attachmentImageSchema(db: DatabaseStore['db']) {
  db.exec(`CREATE TABLE IF NOT EXISTS attachment_images (
    original_id TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
    preview_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    width INTEGER NOT NULL, height INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS attachment_images_delete_preview BEFORE DELETE ON files BEGIN
      DELETE FROM files WHERE id IN (SELECT preview_id FROM attachment_images WHERE original_id=OLD.id);
    END`);
}

export function imageReference(store: DatabaseStore, owner: string, id: string) {
  return store.db.prepare(`SELECT a.preview_id AS previewServerId,a.width,a.height FROM attachment_images a
    JOIN files f ON f.id=a.original_id JOIN files p ON p.id=a.preview_id
    WHERE f.id=? AND f.owner_id=? AND p.owner_id=f.owner_id`).get(id, owner) as { previewServerId: string; width: number; height: number } | undefined;
}

/** Original bytes are immutable. A deterministic preview ID makes crash/retry safe. */
export async function ensureImageReference(store: DatabaseStore, directory: string, owner: string, id: string, checkActive = () => {}) {
  const known = imageReference(store, owner, id);
  if (known) { verifyStoredImage(store, directory, owner, known.previewServerId); return known; }
  const file = store.db.prepare('SELECT storage_name,mime_type FROM files WHERE id=? AND owner_id=?').get(id, owner) as { storage_name: string; mime_type: string } | undefined;
  if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.mime_type)) throw new Error('attachment_image_not_owned');
  const filename = ownedImagePath(directory, file.storage_name);
  const image = sharp(filename, { limitInputPixels: 40_000_000 });
  const metadata = await image.metadata();
  if (!metadata.width || !metadata.height) throw new Error('invalid_image_dimensions');
  const rotated = (metadata.orientation ?? 0) >= 5;
  const width = rotated ? metadata.height : metadata.width, height = rotated ? metadata.width : metadata.height;
  const bytes = await image.rotate().resize({ width: 640, height: 640, fit: 'inside', withoutEnlargement: true }).webp({ quality: 76 }).toBuffer();
  if (bytes.length > 1_000_000) throw new Error('attachment_preview_too_large');
  const preview = await receiveFile(store, directory, owner, Readable.from(bytes), 'preview.webp', 'image/webp', 1_000_000, bytes.length, checkActive, fileOperationId(owner, id, 'attachment-preview-v1'));
  verifyStoredImage(store, directory, owner, preview.id);
  checkActive();
  store.db.prepare('INSERT OR IGNORE INTO attachment_images VALUES(?,?,?,?)').run(id, preview.id, width, height);
  return imageReference(store, owner, id)!;
}

function verifyStoredImage(store: DatabaseStore, directory: string, owner: string, id: string) {
  const file = store.db.prepare('SELECT storage_name,sha256,size_bytes FROM files WHERE id=? AND owner_id=?').get(id, owner) as { storage_name: string; sha256: string; size_bytes: number } | undefined;
  if (!file || file.size_bytes > 1_000_000) throw new Error('attachment_preview_unavailable');
  const bytes = fs.readFileSync(ownedImagePath(directory, file.storage_name));
  if (bytes.length !== file.size_bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('attachment_preview_corrupt');
}

export function ownedImagePath(directory: string, storage: string) {
  const root = fs.realpathSync(directory), filename = fs.realpathSync(path.resolve(root, storage));
  if (path.dirname(filename) !== root) throw new Error('invalid_attachment_path');
  return filename;
}

export function attachmentFileInUse(store: DatabaseStore, owner: string, id: string) {
  const related = store.db.prepare('SELECT original_id,preview_id FROM attachment_images WHERE preview_id=? OR original_id=?').all(id, id) as { original_id: string; preview_id: string }[];
  for (const candidate of new Set([id, ...related.flatMap(row => [row.original_id, row.preview_id])])) {
    // Include internal model-trace references, not only visible attachment arrays.
    if (store.db.prepare('SELECT 1 FROM cloud_records WHERE owner_id=? AND value IS NOT NULL AND instr(value,?)>0 LIMIT 1').get(owner, candidate)
      || store.db.prepare('SELECT 1 FROM cloud_tasks WHERE owner_id=? AND instr(input,?)>0 LIMIT 1').get(owner, candidate)) return true;
  }
  return false;
}
