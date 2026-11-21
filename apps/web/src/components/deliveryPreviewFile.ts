export type DeliveryPreviewKind = 'text' | 'markdown' | 'html' | 'docx' | 'pptx' | 'legacy';

export interface DeliveryPreviewFile {
  name: string;
  url: string;
  kind: DeliveryPreviewKind;
  size?: number;
}

export function deliveryPreviewKind(name: string, mime = ''): DeliveryPreviewKind | undefined {
  if (/\.(doc|ppt)$/i.test(name) || /^(application\/msword|application\/vnd\.ms-powerpoint)$/i.test(mime)) return 'legacy';
  if (/\.docx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (/\.pptx$/i.test(name) || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return 'pptx';
  if (/\.html?$/i.test(name) || /^text\/html\b/i.test(mime)) return 'html';
  if (/\.(md|markdown)$/i.test(name) || /^text\/markdown\b/i.test(mime)) return 'markdown';
  if (/\.(txt|csv|tsv|json|log|ya?ml)$/i.test(name) || /^text\//i.test(mime)) return 'text';
}
