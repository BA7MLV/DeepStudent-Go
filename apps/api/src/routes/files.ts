import type { FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from '../cloud/records.js';
import { receiveFile, byteRange, fileOperationId } from '../cloud/files.js';
import { ensureImageReference, attachmentFileInUse } from '../cloud/attachment-images.js';
import { migrateChatAttachmentReferences, migrateTerminalTaskAttachmentReferences } from '../cloud/attachment-migration.js';
import { fileRecordRowSchema, expectRow, expectRows, type FileRecordRow } from '../storage/row-schema.js';
import type { FastifyReply, FastifyRequest } from 'fastify';

/** 云文件条目的上传、列表、取用与删除,以及旧附件引用的迁移入口。
 * 下载路径先做归属与目录 containment 校验,再按 Range 返回 ——
 * 校验顺序决定是否会泄露他人的文件,保持原样。 */
export function registerFileRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore;
  records: CloudRecords;
  filesDir: string;
  maxFileBytes: number;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  session: (request: FastifyRequest) => { id: string } | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  bad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
}) {
  const { store, records, filesDir, maxFileBytes, requireAuth, session, checkOrigin, bad } = deps;
  function fileDto(row: FileRecordRow) {
    return { id: row.id, originalName: row.original_name, mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, createdAt: row.created_at };
  }
  app.get('/api/v1/files/config', async () => ({ maxFileBytes }));
  app.post<{ Querystring: { afterRevision?: string } }>('/api/v1/files/migrate-chat-attachments', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const afterRevision = request.query.afterRevision === undefined ? 0 : Number(request.query.afterRevision);
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0) return bad(reply, 400, 'invalid_migration_cursor');
    return migrateChatAttachmentReferences(store, records, filesDir, user.id, 20, afterRevision);
  });
  app.post<{ Querystring: { afterId?: string } }>('/api/v1/files/migrate-task-attachments', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    if (request.query.afterId !== undefined && request.query.afterId.length > 100) return bad(reply, 400, 'invalid_migration_cursor');
    return migrateTerminalTaskAttachmentReferences(store, filesDir, user.id, 20, request.query.afterId);
  });
  app.get('/api/v1/files', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    return { files: expectRows<FileRecordRow>(fileRecordRowSchema, store.db.prepare('SELECT * FROM files WHERE owner_id=? ORDER BY created_at DESC LIMIT 500').all(user.id), 'file_row_invalid').map(fileDto) };
  });
  app.post<{ Querystring: { operationId?: string } }>('/api/v1/files', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const body = request.body instanceof Readable ? request.body : null;
    const declaredSize = request.headers['content-length'] === undefined ? undefined : Number(request.headers['content-length']);
    if (!body || (declaredSize !== undefined && (!Number.isSafeInteger(declaredSize) || declaredSize < 1 || declaredSize > maxFileBytes))) return bad(reply, 413, 'file_too_large_or_invalid');
    const encodedName = request.headers['x-file-name'];
    const mimeHeader = request.headers['x-file-mime'];
    let originalName = typeof encodedName === 'string' ? encodedName : '';
    try { originalName = decodeURIComponent(originalName); } catch { return bad(reply, 400, 'invalid_file_name'); }
    if ((encodedName !== undefined && !originalName) || originalName.length > 255 || /[\u0000\\/]/.test(originalName)) return bad(reply, 400, 'invalid_file_name');
    const mimeType = typeof mimeHeader === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mimeHeader) ? mimeHeader.slice(0, 200) : 'application/octet-stream';
    if (request.query.operationId !== undefined) {
      const operationId = request.query.operationId;
      const admitted = store.db.prepare('SELECT digest,status,result FROM client_commands WHERE owner_id=? AND operation_id=?').get(user.id, operationId) as { digest: string; status: string; result: string } | undefined;
      if (!admitted) return bad(reply, 409, 'library_blob_not_admitted');
      const receipt = JSON.parse(admitted.result);
      if (receipt.operation?.kind !== 'importLibraryBlob') return bad(reply, 403, 'library_blob_not_admitted');
      if (admitted.status === 'completed') return reply.code(201).send(receipt.file);
      if (admitted.status !== 'pending' || receipt.phase !== 'admitted') return bad(reply, 409, 'library_blob_uncertain');
      const assertBlobPrincipal = () => {
        if (session(request)?.id !== user.id) throw new Error('library_import_account_changed');
      };
      assertBlobPrincipal();
      store.db.prepare('UPDATE client_commands SET result=? WHERE owner_id=? AND operation_id=?').run(JSON.stringify({ ...receipt, phase: 'receiving' }), user.id, operationId);
      try {
        const operation = receipt.operation;
        const file = await receiveFile(store, filesDir, user.id, body, 'cache-blob', operation.contentType || 'application/octet-stream', maxFileBytes, operation.size,
          assertBlobPrincipal, fileOperationId(user.id, operationId, 'library-import'));
        if (file.sha256 !== operation.sha256 || file.sizeBytes !== operation.size) throw new Error('library_blob_hash_mismatch');
        store.db.prepare("UPDATE client_commands SET status='completed',result=? WHERE owner_id=? AND operation_id=?").run(JSON.stringify({ ...receipt, phase: 'completed', file }), user.id, operationId);
        return reply.code(201).send(file);
      } catch (error) {
        store.db.prepare('UPDATE client_commands SET error=? WHERE owner_id=? AND operation_id=?').run(String(error), user.id, operationId);
        throw error;
      }
    }
    const file = await receiveFile(store, filesDir, user.id, body, originalName, mimeType, maxFileBytes, declaredSize);
    const metadata = /^image\/(png|jpeg|webp|gif)$/.test(file.mimeType)
      ? await ensureImageReference(store, filesDir, user.id, file.id, () => { if (session(request)?.id !== user.id) throw new Error('file_account_changed'); }) : {};
    return reply.code(201).send({ ...file, ...metadata });
  });
  app.get<{ Params: { id: string } }>('/api/v1/files/:id', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    const file = expectRow<FileRecordRow>(fileRecordRowSchema, store.db.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').get(request.params.id, user.id), 'file_row_invalid');
    if (!file) return bad(reply, 404, 'file_not_found');
    const previewOwner = store.db.prepare('SELECT f.owner_id FROM attachment_images a LEFT JOIN files f ON f.id=a.original_id WHERE a.preview_id=?').get(file.id) as { owner_id: string | null } | undefined;
    if (previewOwner && previewOwner.owner_id !== user.id) return bad(reply, 404, 'file_not_found');
    const resolved = path.resolve(filesDir, file.storage_name);
    if (!resolved.startsWith(`${path.resolve(filesDir)}${path.sep}`)) return bad(reply, 404, 'file_not_found');
    if (!fs.existsSync(resolved)) return bad(reply, 404, 'file_not_found');
    // Lazy <img> consumers can reuse bytes, but must reauthorize on every
    // revalidation. Never mark account-owned files public or immutable.
    const etag = `"${file.sha256}"`;
    reply.header('cache-control', 'private, no-cache').header('etag', etag);
    if (request.headers['if-none-match']?.split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag)) return reply.code(304).send();
    const filename = encodeURIComponent(file.original_name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    reply.header('content-disposition', `attachment; filename*=UTF-8''${filename}`);
    reply.type(file.mime_type);
    reply.header('accept-ranges', 'bytes');
    const ifRange = request.headers['if-range'];
    const range = byteRange(ifRange === undefined || ifRange === etag ? request.headers.range : undefined, file.size_bytes);
    if (range === false) return reply.code(416).header('content-range', `bytes */${file.size_bytes}`).send();
    if (range) {
      reply.code(206).header('content-range', `bytes ${range.start}-${range.end}/${file.size_bytes}`).header('content-length', range.end - range.start + 1);
      return reply.send(fs.createReadStream(resolved, range));
    }
    reply.header('content-length', file.size_bytes);
    return reply.send(fs.createReadStream(resolved));
  });
  app.delete<{ Params: { id: string } }>('/api/v1/files/:id', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const file = expectRow<FileRecordRow>(fileRecordRowSchema, store.db.prepare('SELECT * FROM files WHERE id=? AND owner_id=?').get(request.params.id, user.id), 'file_row_invalid');
    if (!file) return bad(reply, 404, 'file_not_found');
    if (attachmentFileInUse(store, user.id, file.id)) return bad(reply, 409, 'file_in_use');
    const preview = store.db.prepare('SELECT f.id,f.storage_name FROM attachment_images a JOIN files f ON f.id=a.preview_id WHERE a.original_id=? AND f.owner_id=?').get(file.id, user.id) as { id: string; storage_name: string } | undefined;
    store.db.prepare('DELETE FROM files WHERE id=? AND owner_id=?').run(file.id, user.id);
    fs.rmSync(path.join(filesDir, file.storage_name), { force: true });
    if (preview && !attachmentFileInUse(store, user.id, preview.id)) {
      store.db.prepare('DELETE FROM files WHERE id=? AND owner_id=?').run(preview.id, user.id);
      fs.rmSync(path.join(filesDir, preview.storage_name), { force: true });
    }
    return { deleted: true };
  });
}
