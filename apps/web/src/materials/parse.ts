import { db } from '../store/db';
import { isDocxFile } from './docx';
import { isMarkdownFile } from './md';
import { isHtmlFile } from './html';
import type { MaterialFormat } from './reindex';

export type { MaterialFormat, MaterialParseProgress, MaterialParseResult } from './reindex';
export { unitKindOf } from './reindex';

const MATERIAL_EXTS = new Set(['pdf', 'docx', 'md', 'markdown', 'html', 'htm']);
const extOf = (name: string) => name.split('.').pop()?.toLowerCase() ?? '';
export function isMaterialFile(file: { name: string; type?: string }): boolean {
  return MATERIAL_EXTS.has(extOf(file.name)) || isLegacyDocFile(file) || file.type === 'application/pdf' ||
    isDocxFile(file) || isMarkdownFile(file) || isHtmlFile(file) || file.type === 'application/msword';
}
export function isLegacyDocFile(file: { name: string; type?: string }): boolean { return extOf(file.name) === 'doc'; }
export function detectMaterialFormat(file: { name: string; type?: string }): MaterialFormat {
  if (file.type === 'application/pdf' || extOf(file.name) === 'pdf') return 'pdf';
  if (isDocxFile(file)) return 'docx';
  if (isMarkdownFile(file)) return 'md';
  if (isHtmlFile(file)) return 'html';
  throw new Error(`无法识别的材料格式：${file.name}`);
}
/** Read-only confirmed projection; parsing/index writes are server tasks. */
export async function loadMaterialBlocks(materialId: string) {
  return db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
}
