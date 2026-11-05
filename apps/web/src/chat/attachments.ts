export { type ChatAttachment, MAX_CHAT_ATTACHMENTS, MAX_ATTACHMENT_TEXT, attachmentText, attachmentMessage } from '@wangke/study-core/chat/attachments';
export const CHAT_FILE_ACCEPT = '.pdf,.docx,.txt,.md,.markdown,.csv,.json,.html,.htm,.log,.yaml,.yml';
export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export function attachmentSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
