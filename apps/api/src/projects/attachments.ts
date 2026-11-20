import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseBotAttachments } from '@wangke/contracts';
import type { ProjectRepository } from './repository.js';
import { ProjectError } from './files.js';
import { safeFileName } from '../cloud/file-names.js';
import { sql } from '../storage/sql.js';
import { expectRow, expectRows } from '../storage/row-schema.js';

type Source = { id: string; storage_name: string; original_name: string; sha256: string; created_at: string };
type Receipt = { project_id: string; path: string; status: 'pending' | 'done' };

/** 查询结果的行形状:files 的五列与 resource_attachments 的回执列。 */
const sourceRowSchema = {
  type: 'object',
  properties: { id: { type: 'string' }, storage_name: { type: 'string' }, original_name: { type: 'string' }, sha256: { type: 'string' }, created_at: { type: 'string' } },
  required: ['id', 'storage_name', 'original_name', 'sha256', 'created_at'],
} as const;
const contentRowSchema = { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] } as const;
const pathRowSchema = { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } as const;
const receiptRowSchema = {
  type: 'object',
  properties: { project_id: { type: 'string' }, path: { type: 'string' }, status: { type: 'string', enum: ['pending', 'done'] } },
  required: ['project_id', 'path', 'status'],
} as const;

/** 待导入来源:消息引用到的文件 + 已登记但未完成的回执。两条语句都是固定文本。 */
const pendingSources = sql`SELECT f.id,f.storage_name,f.original_name,f.sha256,f.created_at
  FROM threads t JOIN messages m ON m.thread_id=t.id JOIN files f
    ON f.owner_id=t.owner_id AND f.id=json_extract(CASE WHEN json_valid(m.content) THEN m.content ELSE '{}' END,'$.fileId')
  WHERE t.owner_id=? AND t.mode='bot' AND m.kind='attachment'
    AND NOT EXISTS (SELECT 1 FROM resource_attachments a WHERE a.owner_id=f.owner_id AND a.file_id=f.id AND a.status='done')
  UNION SELECT f.id,f.storage_name,f.original_name,f.sha256,f.created_at
  FROM resource_attachments a JOIN files f ON f.owner_id=a.owner_id AND f.id=a.file_id
  WHERE a.owner_id=? AND a.status='pending'`;
const legacyMessages = sql`SELECT m.content FROM messages m JOIN threads t ON t.id=m.thread_id
  WHERE t.owner_id=? AND t.mode='bot' AND m.role='user' AND instr(m.content,'Attachment fileId=')>0`;
const sourceLookup = sql`SELECT id,storage_name,original_name,sha256,created_at FROM files f WHERE id=? AND owner_id=?
  AND NOT EXISTS (SELECT 1 FROM resource_attachments a WHERE a.owner_id=f.owner_id AND a.file_id=f.id AND a.status='done')`;
const attachmentBatches = sql`SELECT m.content FROM messages m JOIN threads t ON t.id=m.thread_id
  WHERE t.owner_id=? AND t.mode='bot' AND m.kind='attachment' AND instr(m.content,'"attachments"')>0`;

/** Project committed Bot attachments into the real resource tree. The receipt is
 * durable even after a user moves/deletes the copy, so history never resurrects it.
 * Old Gateway text attachments are included, but unattached uploads are not. */
export function importBotAttachments(projects: ProjectRepository, filesDir: string, owner: string) {
  const db = projects.store.db;
  // Import is a managed synchronous writer, not a whole-conversation lock.
  // The runner's active workspace is not an exemption from sandbox leases.
  // Start with message references, not every upload (course frames can be numerous).
  const rows = expectRows<Source>(sourceRowSchema, db.prepare(pendingSources.sql).all(owner, owner), 'attachment_source_row_invalid');
  const sources = new Map(rows.map(row => [row.id, row]));
  const legacy = expectRows<{ content: string }>(contentRowSchema, db.prepare(legacyMessages.sql).all(owner), 'attachment_message_row_invalid');
  const lookup = db.prepare(sourceLookup.sql);
  const batches = expectRows<{ content: string }>(contentRowSchema, db.prepare(attachmentBatches.sql).all(owner), 'attachment_message_row_invalid');
  for (const message of batches) for (const file of parseBotAttachments(message.content)?.files ?? []) {
    if (!file.fileId || sources.has(file.fileId)) continue;
    const source = expectRow<Source>(sourceRowSchema, lookup.get(file.fileId, owner), 'attachment_source_row_invalid');
    if (source) sources.set(source.id, source);
  }
  for (const message of legacy) for (const match of message.content.matchAll(/Attachment fileId=([a-f0-9-]{36}),/g)) {
    if (sources.has(match[1])) continue;
    const source = expectRow<Source>(sourceRowSchema, lookup.get(match[1], owner), 'attachment_source_row_invalid');
    if (source) sources.set(source.id, source);
  }
  const allocate = (source: Source, projectId: string) => {
    const names = new Set(projects.files.list(projectId, '').map(f => f.name));
    for (const row of expectRows<{ path: string }>(pathRowSchema, db.prepare("SELECT path FROM resource_attachments WHERE owner_id=? AND project_id=? AND status='pending'").all(owner, projectId), 'attachment_receipt_row_invalid')) names.add(row.path);
    const name = safeFileName(source.original_name);
    const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = `${stem}${ext}`, n = 2;
    while (names.has(candidate)) candidate = `${stem} (${n++})${ext}`;
    return candidate;
  };
  for (const source of [...sources.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id))) {
    try {
      const filename = path.resolve(filesDir, source.storage_name);
      if (path.dirname(filename) !== path.resolve(filesDir) || !fs.existsSync(filename)) continue;
      let receipt = expectRow<Receipt>(receiptRowSchema, db.prepare('SELECT * FROM resource_attachments WHERE owner_id=? AND file_id=?').get(owner, source.id), 'attachment_receipt_row_invalid');
      if (!receipt) {
        // An attachment may already be a learning resource; do not create another copy.
        const mapped = expectRow<Pick<Receipt, 'project_id' | 'path'>>(receiptRowSchema, db.prepare("SELECT project_id,path FROM resource_files WHERE owner_id=? AND source_file=? AND revision<>'' LIMIT 1").get(owner, source.id), 'attachment_receipt_row_invalid');
        if (mapped) {
          db.prepare("INSERT INTO resource_attachments VALUES(?,?,?,?,'done')").run(owner, source.id, mapped.project_id, mapped.path);
          continue;
        }
        const workspace = projects.botWorkspace(owner);
        projects.writable(owner, workspace); projects.assertNoExecution(workspace);
        receipt = { project_id: workspace, path: allocate(source, workspace), status: 'pending' };
        db.prepare("INSERT INTO resource_attachments VALUES(?,?,?,?,'pending')").run(owner, source.id, workspace, receipt.path);
      }
      projects.writable(owner, receipt.project_id); projects.assertNoExecution(receipt.project_id);
      // Recover a crash between the atomic file installation and receipt commit.
      const entry = projects.files.list(receipt.project_id, '').find(f => f.path === receipt!.path);
      if (entry) {
        let matches = false;
        if (entry.kind === 'file') {
          const file = projects.files.open(receipt.project_id, receipt.path);
          // 进程内对已打开 fd 的位置读取:哈希校验必须与 open 返回的 inode 一致,
          // 若改成异步 readFile 会因 fd 的隐式位置变化引入竞态,故保留同步。
          try { matches = crypto.createHash('sha256').update(fs.readFileSync(file.fd)).digest('hex') === source.sha256; }
          finally { fs.closeSync(file.fd); }
        }
        if (!matches) {
          receipt.path = allocate(source, receipt.project_id);
          db.prepare('UPDATE resource_attachments SET path=? WHERE owner_id=? AND file_id=?').run(receipt.path, owner, source.id);
        } else {
          db.prepare("UPDATE resource_attachments SET status='done' WHERE owner_id=? AND file_id=?").run(owner, source.id);
          continue;
        }
      }
      projects.files.copy(receipt.project_id, receipt.path, filename);
      db.prepare("UPDATE resource_attachments SET status='done' WHERE owner_id=? AND file_id=?").run(owner, source.id);
    } catch (error) {
      // Keep the original upload and pending receipt for the next projection.
      if (!(error instanceof ProjectError) || error.code !== 'project_busy') throw error;
    }
  }
}
