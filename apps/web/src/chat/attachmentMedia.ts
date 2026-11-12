import type { ChatAttachment } from './attachments';

/** Also accepts historical embedded images; a file reference alone is not a document. */
export type ImageAttachment = ChatAttachment & { previewServerId?: string; width?: number; height?: number };
export function isImageAttachment(file: ChatAttachment): boolean {
  return !!file.dataUrl || /^image\/(png|jpeg|webp|gif)$/i.test(file.mimeType) || /\.(png|jpe?g|webp|gif)$/i.test(file.name);
}
