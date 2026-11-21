import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolDef } from '@wangke/study-core/model/client';
import type { ChatAttachment } from '@wangke/study-core/chat/attachments';
import { commitTask, recordMutation, type TaskContext } from '../src/cloud/execution.js';
import { fileOperationId, receiveFile } from '../src/cloud/files.js';
import { attachmentFileInUse } from '../src/cloud/attachment-images.js';
import { sandboxExportMaxBytes, streamSandboxExport } from '../src/agent/sandbox.js';
import { config } from '../src/config.js';
import { assertChatShellScope, chatShellWorkspace } from './chat-shell.js';

const MiB = 1024 * 1024;
const accountBytes = 4096 * MiB;
const accountCount = 512;
const active = new Map<string, number>();
const downloadMime = 'application/octet-stream';
const toolName = 'chat_publish_file';

export const chatPublishFileTool: ToolDef = { type: 'function', function: {
  name: toolName,
  description: '将当前会话 /workspace 下的一个已完成的普通文件保存为本条助手消息的下载附件。只发布用户需要的成品，不发布临时文件。成功后附件会自动出现，不要编写下载链接。单文件及每轮总计最多 512 MiB，部署可设更低的单文件上限。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string', minLength: 1, maxLength: 2048, description: '工作区相对路径或 /workspace/ 开头的路径。' },
  }, required: ['path'] },
} };

export function wrapChatPublish(context: TaskContext, assistantId: number, enabled: boolean, execute: (name: string, args: Record<string, unknown>) => Promise<string>) {
  return (name: string, args: Record<string, unknown>) => name === toolName && enabled ? publish(context, assistantId, args) : execute(name, args);
}

async function publish(context: TaskContext, assistantId: number, args: Record<string, unknown>) {
  const sessionId = assertChatShellScope(context);
  if (Object.keys(args).some(key => key !== 'path') || typeof args.path !== 'string' || args.path.length > 2048 || /[\\\u0000-\u001f\u007f]/.test(args.path)) throw new Error('invalid_workspace_path');
  const relative = args.path.startsWith('/workspace/') ? args.path.slice(11) : args.path;
  if (relative.split('/').some(part => !part || part === '.' || part === '..' || Buffer.byteLength(part) > 255)) throw new Error('invalid_workspace_path');
  const name = path.posix.basename(relative);
  const { owner, task, store } = context;
  const current = () => {
    const row = context.records.get(owner, 'chats', assistantId);
    if (!row || row.role !== 'assistant' || row.sessionId !== sessionId || row.taskId !== task.id) throw new Error('chat_publish_message_unavailable');
    return row;
  };
  const allowed = () => {
    assertChatShellScope(context);
    current();
    const { read, write } = context.configuration.taskPolicy(owner, task.id);
    if (read === 'deny' || write === 'deny') throw new Error('chat_publish_permission_denied');
    return read === 'ask' || write === 'ask' ? 'ask' : 'allow';
  };
  const decision = allowed();
  const id = fileOperationId(owner, task.id, `chat-export:${relative}`);
  const previous = () => (current().attachments as ChatAttachment[] | undefined) ?? [];
  const receipt = (file: ChatAttachment) => JSON.stringify({ published: true, name: file.name, sizeBytes: file.size });
  const existing = previous().find(file => file.serverId === id);
  if (existing) return receipt(existing);

  const permission = crypto.randomUUID();
  const cap = 'chat_publish_file';
  const serialized = JSON.stringify({ path: relative });
  const db = store.db;
  db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,created_at,status) VALUES(?,?,?,?,?,?,?)')
    .run(permission, owner, task.id, cap, serialized, new Date().toISOString(), decision === 'ask' ? 'pending' : 'consumed');
  try {
    if (decision === 'ask') {
      db.prepare("UPDATE cloud_tasks SET status='waiting_user' WHERE id=? AND status='running'").run(task.id);
      for (;;) {
        allowed();
        const entry = db.prepare('SELECT status FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability=? AND arguments=?')
          .get(permission, owner, task.id, cap, serialized) as { status: string } | undefined;
        if (entry?.status === 'approved') {
          if (!db.prepare("UPDATE cloud_permissions SET status='consumed' WHERE id=? AND status='approved'").run(permission).changes) throw new Error('permission_already_consumed');
          break;
        }
        if (entry?.status !== 'pending') throw new Error('chat_publish_permission_rejected');
        await delay(100, undefined, { signal: context.signal });
      }
      db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(task.id);
    }
    const authorized = () => {
      if (allowed() === 'ask' && decision === 'allow') throw new Error('chat_publish_permission_revoked');
    };
    authorized();
    context.configuration.audit(owner, 'permission.consumed', { id: permission, taskId: task.id, capability: cap });
    const files = previous();
    const budget = sandboxExportMaxBytes - files.reduce((total, file) => total + file.size, 0);
    if (files.length >= 8 || budget < 1) throw new Error('chat_publish_turn_quota_exceeded');
    const storage = () => db.prepare("SELECT count(*) AS count,coalesce(sum(size_bytes),0) AS bytes FROM files WHERE owner_id=? AND storage_name GLOB 'chat-export-*.bin'")
      .get(owner) as { count: number; bytes: number };
    const usage = storage();
    const preferred = Math.min(config().maxFileBytes, budget, sandboxExportMaxBytes);
    if (usage.count >= accountCount || usage.bytes + preferred > accountBytes) {
      await reclaimChatExports(context);
    }
    const { bavail, bsize } = await fs.statfs(context.filesDir);
    authorized();
    if (active.has(owner) || active.size >= 2) throw new Error('chat_publish_busy');
    const currentUsage = storage();
    const limit = Math.min(preferred, accountBytes - currentUsage.bytes);
    if (currentUsage.count >= accountCount || limit < 1) throw new Error('chat_publish_account_quota_exceeded');
    if (bavail * bsize - [...active.values()].reduce((sum, bytes) => sum + bytes, 0) < limit + 256 * MiB) throw new Error('chat_publish_disk_low');
    active.set(owner, limit);
    const abort = new AbortController();
    const signal = AbortSignal.any([context.signal, abort.signal]);
    try {
      const { size, stream } = await streamSandboxExport({ path: relative, threadId: chatShellWorkspace(owner, sessionId), executionId: permission, limit }, signal);
      let published: ChatAttachment | undefined;
      await receiveFile(store, context.filesDir, owner, stream, name, downloadMime, limit, size, authorized, id, {
        signal, commit(file) {
          const row = current();
          published = { id, serverId: id, name: file.originalName, mimeType: file.mimeType, size: file.sizeBytes };
          commitTask(context, [recordMutation('chats', assistantId, row, { ...row, attachments: [...(row.attachments ?? []), published] })]);
        },
      });
      if (!published) throw new Error('chat_publish_message_unavailable');
      return receipt(published);
    } finally {
      abort.abort();
      active.delete(owner);
    }
  } finally {
    db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND status='consumed'").run(permission);
    db.prepare("UPDATE cloud_permissions SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(permission);
    db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(task.id);
  }
}

async function reclaimChatExports(context: TaskContext) {
  const { store, owner, filesDir } = context;
  const files = store.db.prepare("SELECT id,storage_name FROM files WHERE owner_id=? AND storage_name GLOB 'chat-export-*.bin'").all(owner) as { id: string; storage_name: string }[];
  const removed = store.db.transaction(() => files.filter(file => {
    if (file.storage_name !== `chat-export-${file.id}.bin` || !/^[a-f0-9-]{36}$/.test(file.id) || attachmentFileInUse(store, owner, file.id)) return false;
    return store.db.prepare('DELETE FROM files WHERE owner_id=? AND id=?').run(owner, file.id).changes > 0;
  }))();
  for (const file of removed) await fs.rm(path.join(filesDir, file.storage_name), { force: true }).catch(() => {});
}
