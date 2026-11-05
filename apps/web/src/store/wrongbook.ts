import { liveQuery } from 'dexie';
import { db } from './db';
import type { QuizQuestion } from '../harness/quiz';
import { applyAttempt, EMPTY_WRONGBOOK, migrateWrongbook, parseWrongbook, questionId, writeQuestion,
  type Attempt, type QuestionSource, type WrongQuestion } from '../study/wrongbook';
import { WRONGBOOK_FILE_NAME, WRONGBOOK_MATERIAL_ID } from '../study/wrongbookFile';
import type { MaterialParseResult } from '../materials/reindex';
import { saveMarkdownMaterial } from '../materials/markdownFile';
import { getMaterialFile } from './fileStore';
import { followDocument } from '../client/resources';

/** One Markdown Blob is the only source of truth; no parallel question table. */
const FILE_ID = WRONGBOOK_MATERIAL_ID;
export async function readWrongbook(): Promise<string> {
  const file = await getMaterialFile(FILE_ID);
  return file ? file.text() : EMPTY_WRONGBOOK;
}
export function observeWrongbook(next: (markdown: string) => void, error: (e: unknown) => void) {
  {
    let stopped = false, off: (() => void) | undefined;
    // Do not create an empty wrongbook just by visiting its panel. The initial
    // records cache baseline precedes this view; creation follows committed data.
    const subscription = liveQuery(() => db.table('courseFiles').get(FILE_ID)).subscribe({
      next: row => {
        off?.(); off = undefined;
        if (stopped) return;
        if (!row) next(EMPTY_WRONGBOOK);
        else off = followDocument({ kind: 'courseDocument', courseId: FILE_ID }, document => next(document.text ?? EMPTY_WRONGBOOK), error);
      }, error,
    });
    return { unsubscribe() { stopped = true; off?.(); subscription.unsubscribe(); } };
  }
}

async function mutate(update: (markdown: string) => string, create = false): Promise<void> {
  {
    const markdown = await readWrongbook();
    const base = /<!-- wrongbook:v[12] -->/.test(markdown) ? migrateWrongbook(markdown) : `${markdown.trimEnd()}\n\n<!-- wrongbook:v2 -->\n`;
    const result = update(base);
    if (result !== markdown || create && !await db.videos.get(FILE_ID)) await saveMarkdownMaterial(FILE_ID, result, await getMaterialFile(FILE_ID) ? markdown : '', WRONGBOOK_FILE_NAME);
    return;
  }
}

/** Also registers legacy archives as ordinary library materials. No new empty file on startup. */
export async function ensureWrongbookMaterial(create = false): Promise<void> {
  {
    const file = await getMaterialFile(FILE_ID);
    if (!file && !create) return;
    const text = file ? await file.text() : EMPTY_WRONGBOOK;
    const migrated = text.includes('<!-- wrongbook:v1 -->') ? migrateWrongbook(text) : text;
    if (migrated !== text || !file) await saveMarkdownMaterial(FILE_ID, migrated, file ? text : '', WRONGBOOK_FILE_NAME);
    return;
  }
}

/** The ordinary Markdown editor writes the same file, not an OPFS or JSON shadow copy. */
export async function saveWrongbookMarkdown(markdown: string, expectedMarkdown: string): Promise<MaterialParseResult> {
  return saveMarkdownMaterial(FILE_ID, markdown, expectedMarkdown);
}

export async function recordWrongbookAttempt(question: QuizQuestion, source: QuestionSource, attempt: Attempt, existingId?: string): Promise<void> {
  const id = existingId ?? await questionId(question, source);
  await mutate((markdown) => {
    const entry = parseWrongbook(markdown).find((q) => q.id === id);
    if (existingId && !entry) throw new Error('复习的题目已不存在，请刷新错题本。');
    const updated = applyAttempt(entry, id, question, source, attempt);
    return updated && updated !== entry ? writeQuestion(markdown, updated) : markdown;
  });
}

export async function setWrongbookStatus(id: string, status: WrongQuestion['status']): Promise<void> {
  await mutate((markdown) => {
    const entry = parseWrongbook(markdown).find((q) => q.id === id);
    if (!entry) throw new Error('错题不存在。');
    return writeQuestion(markdown, { ...entry, status });
  });
}

/** Merge without silently overwriting another device's divergent review history. */
export async function importWrongbook(incoming: string): Promise<void> {
  incoming = migrateWrongbook(incoming);
  const imported = parseWrongbook(incoming);
  await mutate((markdown) => {
    const current = parseWrongbook(markdown);
    if (!current.length && markdown === EMPTY_WRONGBOOK) return incoming;
    for (const entry of imported) {
      const old = current.find((q) => q.id === entry.id);
      if (old && JSON.stringify(old) !== JSON.stringify(entry))
        throw new Error(`题目 ${entry.id} 的记录有冲突，未导入。请保留两份文件后核对。`);
    }
    return imported.reduce((md, entry) => current.some((q) => q.id === entry.id) ? md : writeQuestion(md, entry), markdown);
  });
}
