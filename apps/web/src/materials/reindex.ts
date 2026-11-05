import type { UnitKind } from './units';

export type MaterialFormat = 'pdf' | 'docx' | 'md' | 'html';
export interface MaterialParseProgress {
  phase: 'read' | 'extract'; done: number; total: number; message: string;
}
export interface MaterialParseResult {
  unitCount: number;
  blockCount: number;
  totalChars: number;
  scanned: boolean;
  empty: boolean;
}
export function unitKindOf(format: MaterialFormat): UnitKind { return format === 'pdf' ? 'page' : 'para'; }
