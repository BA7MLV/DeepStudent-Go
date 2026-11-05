import { MAX_CHAT_ATTACHMENTS, MAX_ATTACHMENT_TEXT, type ChatAttachment } from '@wangke/study-core/chat/attachments';
import type { TaskContext } from '../src/cloud/execution.js';

/** Extraction/thumbnail data comes from the composer, but an original must have
 * finished uploading to this account. Never fetch a client-provided URL/path. */
export function taskChatAttachments(context: TaskContext): ChatAttachment[] {
  const value = context.task.input.attachments;
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_ATTACHMENTS) throw new Error('附件格式错误或数量超过上限');
  let imageBytes = 0;
  const ids = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('附件格式错误');
    const file = item as Record<string, unknown>;
    if (typeof file.id !== 'string' || !file.id || file.id.length > 200 || ids.has(file.id)) throw new Error('附件标识无效');
    ids.add(file.id);
    if (typeof file.serverId !== 'string' || !file.serverId || file.serverId.length > 100) throw new Error('附件尚未上传成功，请重新上传');
    const original = context.store.db.prepare('SELECT original_name,mime_type,size_bytes FROM files WHERE id=? AND owner_id=?')
      .get(file.serverId, context.owner) as { original_name: string; mime_type: string; size_bytes: number } | undefined;
    if (!original) throw new Error('附件不存在或无权访问，请重新上传');
    if (file.text !== undefined && (typeof file.text !== 'string' || file.text.length > MAX_ATTACHMENT_TEXT)) throw new Error('附件正文超过上限，请重新上传或导入课程库');
    if (file.description !== undefined && (typeof file.description !== 'string' || file.description.length > MAX_ATTACHMENT_TEXT)) throw new Error('附件描述无效');
    if (file.truncated !== undefined && typeof file.truncated !== 'boolean') throw new Error('附件截断标记无效');
    if (file.dataUrl !== undefined) {
      if (typeof file.dataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(file.dataUrl)
        || !original.mime_type.startsWith('image/')) throw new Error('附件图片格式无效，请重新上传');
      imageBytes += file.dataUrl.length;
      if (imageBytes > 12_000_000) throw new Error('附件图片总大小超过上限，请压缩后重试');
    }
    if (!(typeof file.text === 'string' && file.text.trim()) && !file.dataUrl && !(typeof file.description === 'string' && file.description.trim())) {
      throw new Error('附件没有可读取的内容，请重新上传；扫描件请转为图片或导入课程库');
    }
    return {
      id: file.id, serverId: file.serverId, name: original.original_name, mimeType: original.mime_type, size: original.size_bytes,
      ...(typeof file.text === 'string' ? { text: file.text } : {}),
      ...(typeof file.dataUrl === 'string' ? { dataUrl: file.dataUrl } : {}),
      ...(typeof file.description === 'string' ? { description: file.description } : {}),
      ...(file.truncated === true ? { truncated: true } : {}),
    };
  });
}
