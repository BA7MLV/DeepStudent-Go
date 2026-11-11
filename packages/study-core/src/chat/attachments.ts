import type { ChatMessage } from '../api/modelClient.ts';

/** Portable message data. Originals remain in the authenticated file store. */
export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  serverId?: string;
  previewServerId?: string;
  width?: number;
  height?: number;
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
  description?: string;
}

export const MAX_CHAT_ATTACHMENTS = 8;
export const MAX_ATTACHMENT_TEXT = 12_000;

export function attachmentText(content: string, attachments: readonly ChatAttachment[] = []): string {
  return [content, ...attachments.map(file => [
    `附件：${file.name}`,
    file.text,
    file.description ? `图片内容：${file.description}` : '',
    file.truncated ? '（仅包含前 12000 字；需要全文检索请导入课程库。）' : '',
  ].filter(Boolean).join('\n'))].filter(Boolean).join('\n\n');
}

export function attachmentMessage(row: { role: 'user' | 'assistant'; content: string; attachments?: ChatAttachment[] }): ChatMessage {
  const text = attachmentText(row.content, row.attachments);
  const images = row.role === 'user' ? row.attachments?.filter(file => file.mimeType.startsWith('image/') && (file.serverId || file.dataUrl)) ?? [] : [];
  return {
    role: row.role,
    content: images.length ? [
      { type: 'text', text },
      ...images.map(file => ({ type: 'image_url' as const, image_url: { url: file.serverId ? `attachment-file:${file.serverId}` : file.dataUrl! } })),
    ] : text,
  };
}
