import fs from 'node:fs';
import crypto from 'node:crypto';
import { MAX_CHAT_ATTACHMENTS, MAX_ATTACHMENT_TEXT, type ChatAttachment } from '@wangke/study-core/chat/attachments';
import type { ChatMessage } from '@wangke/study-core/model/client';
import type { TaskContext } from '../src/cloud/execution.js';
import type { DatabaseStore } from '../src/storage/database.js';
import { imageReference, ownedImagePath } from '../src/cloud/attachment-images.js';

export function taskChatAttachments(context: TaskContext): ChatAttachment[] {
  return normalizeChatAttachments(context.store, context.owner, context.task.input.attachments);
}

/** Original metadata is authoritative; client previews and inline draft bytes are never persisted. */
export function normalizeChatAttachments(store: DatabaseStore, owner: string, value: unknown): ChatAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) throw new Error('附件格式错误或数量超过上限');
  const ids = new Set<string>();
  let imageBytes = 0;
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('附件格式错误');
    const file = item as Record<string, unknown>;
    if (typeof file.id !== 'string' || !file.id || file.id.length > 200 || ids.has(file.id)) throw new Error('附件标识无效');
    ids.add(file.id);
    if (typeof file.serverId !== 'string' || !file.serverId || file.serverId.length > 100) throw new Error('附件尚未上传成功，请重新上传');
    const original = store.db.prepare('SELECT original_name,mime_type,size_bytes FROM files WHERE id=? AND owner_id=?')
      .get(file.serverId, owner) as { original_name: string; mime_type: string; size_bytes: number } | undefined;
    if (!original) throw new Error('附件不存在或无权访问，请重新上传');
    for (const key of ['text', 'description']) if (file[key] !== undefined && (typeof file[key] !== 'string' || (file[key] as string).length > MAX_ATTACHMENT_TEXT)) throw new Error('附件正文或描述无效');
    if (file.truncated !== undefined && typeof file.truncated !== 'boolean') throw new Error('附件截断标记无效');
    const image = /^image\/(png|jpeg|webp|gif)$/.test(original.mime_type);
    if (image) {
      imageBytes += original.size_bytes;
      if (original.size_bytes > 32_000_000 || imageBytes > 64_000_000) throw new Error('attachment_image_budget_exceeded');
    }
    if (!image && !String(file.text ?? '').trim() && !String(file.description ?? '').trim()) throw new Error('附件没有可读取的内容');
    return {
      id: file.id, serverId: file.serverId, name: original.original_name, mimeType: original.mime_type, size: original.size_bytes,
      ...(image ? imageReference(store, owner, file.serverId) : {}),
      ...(typeof file.text === 'string' ? { text: file.text } : {}),
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
      ...(file.truncated === true ? { truncated: true } : {}),
    };
  });
}

/** Model boundary only: never persist the returned expanded messages. */
export function resolveAttachmentMessages(context: TaskContext, messages: ChatMessage[]): ChatMessage[] {
  let total = 0;
  const cache = new Map<string, string>();
  return messages.map(message => !Array.isArray(message.content) ? message : { ...message, content: message.content.map(part => {
    if (part.type !== 'image_url' || !part.image_url.url.startsWith('attachment-file:')) return part;
    const id = part.image_url.url.slice('attachment-file:'.length);
    let url = cache.get(id);
    if (!url) {
      context.checkActive();
      const file = context.store.db.prepare('SELECT storage_name,mime_type,size_bytes,sha256 FROM files WHERE id=? AND owner_id=?').get(id, context.owner) as { storage_name: string; mime_type: string; size_bytes: number; sha256: string } | undefined;
      if (!file || !/^image\/(png|jpeg|webp|gif)$/.test(file.mime_type) || file.size_bytes > 32_000_000) throw new Error('attachment_image_unavailable');
      total += file.size_bytes;
      if (total > 64_000_000) throw new Error('attachment_image_budget_exceeded');
      const bytes = fs.readFileSync(ownedImagePath(context.filesDir, file.storage_name));
      if (bytes.length !== file.size_bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('attachment_image_corrupt');
      url = `data:${file.mime_type};base64,${bytes.toString('base64')}`;
      cache.set(id, url);
    }
    return { ...part, image_url: { ...part.image_url, url } };
  }) });
}
