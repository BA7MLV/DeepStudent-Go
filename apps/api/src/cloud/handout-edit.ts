import type { HandoutPersistInput } from '@wangke/contracts/cloud';
import type { CloudRecords } from './records.js';

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max = 100000): value is string => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const keys = (value: Record<string, unknown>, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
const strings = (value: unknown, max: number): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= max && value.every(v => text(v));
const invalid = (): never => { throw new Error('invalid_handout_persist'); };

/** Strict persisted IR, not the model-output salvage parser: never drop unknown
 * blocks or turn malformed client edits into apparently successful data loss. */
export function parseHandoutPersist(value: Record<string, unknown>): HandoutPersistInput {
  if (Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024) return invalid();
  if (value.action !== 'persist' || !keys(value, ['action', 'videoId', 'handoutId', 'sections', 'summary', 'expected', '_pluginProviders']) || !text(value.videoId, 256) || !value.videoId || !Number.isSafeInteger(value.handoutId) || Number(value.handoutId) <= 0 || !text(value.summary)) return invalid();
  const expected = value.expected;
  if (!record(expected) || !keys(expected, ['sectionsJson', 'outlineJson', 'blob']) || !text(expected.sectionsJson, 750000) || !text(expected.outlineJson, 750000) || !record(expected.blob) || !keys(expected.blob, ['$file', 'type']) || !text(expected.blob.$file, 200) || !expected.blob.$file || expected.blob.type !== undefined && !text(expected.blob.type, 200)) return invalid();
  try { if (!Array.isArray(JSON.parse(expected.sectionsJson)) || !record(JSON.parse(expected.outlineJson))) return invalid(); } catch { return invalid(); }
  const sections = value.sections;
  if (!Array.isArray(sections) || !sections.length || sections.length > 128 || Buffer.byteLength(JSON.stringify(sections)) > 750000) return invalid();
  let blocks = 0, figures = 0;
  for (const section of sections) {
    if (!record(section) || !keys(section, ['heading', 'blocks']) || !text(section.heading, 1000) || !Array.isArray(section.blocks) || !section.blocks.length) return invalid();
    for (const block of section.blocks) {
      if (++blocks > 2048 || !record(block)) return invalid();
      switch (block.type) {
        case 'lead': case 'para': case 'note': case 'h2':
          if (!keys(block, ['type', 'text']) || !text(block.text)) return invalid(); break;
        case 'list':
          if (!keys(block, ['type', 'ordered', 'items']) || typeof block.ordered !== 'boolean' || !strings(block.items, 500)) return invalid(); break;
        case 'table':
          if (!keys(block, ['type', 'caption', 'header', 'rows']) || block.caption !== undefined && !text(block.caption) || !strings(block.header, 20) || !Array.isArray(block.rows) || !block.rows.length || block.rows.length > 100 || block.rows.some((row: unknown) => !strings(row, 20) || row.length !== block.header.length)) return invalid(); break;
        case 'figure':
          if (++figures > 100 || !keys(block, ['type', 'ts', 'caption']) || !Number.isFinite(block.ts) || block.ts < 0 || block.ts > 7 * 86400 || block.caption !== undefined && !text(block.caption)) return invalid(); break;
        default: return invalid();
      }
    }
  }
  return value as unknown as HandoutPersistInput;
}

/** Reused at admission, before rendering, and inside the final SQL transaction.
 * Original document bytes are immutable file records; no client paths accepted. */
export function handoutEditBaseline(records: CloudRecords, owner: string, input: HandoutPersistInput) {
  const course = records.get(owner, 'videos', input.videoId);
  const handout = records.get(owner, 'handouts', input.handoutId);
  if (!course || !handout || handout.videoId !== input.videoId || !records.ownedFile(owner, input.expected.blob.$file)) throw new Error('handout_not_found');
  if (handout.sectionsJson !== input.expected.sectionsJson || handout.outlineJson !== input.expected.outlineJson || handout.blob?.$file !== input.expected.blob.$file) throw new Error('handout_edit_conflict');
  return { course, handout };
}
