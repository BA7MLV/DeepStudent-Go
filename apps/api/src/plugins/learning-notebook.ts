import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { applyAttempt, EMPTY_WRONGBOOK, parseWrongbook, questionId, writeQuestion, type Attempt, type QuestionSource } from '@wangke/study-core/wrongbook';
import type { QuizQuestion } from '@wangke/study-core/quiz';
import { extractMdUnits } from '@wangke/study-core/materials/markdown';
import { chunkUnits } from '@wangke/study-core/materials/chunk';
import { CloudRecords } from '../cloud/records.js';
import { receiveFile, fileOperationId } from '../cloud/files.js';
import { newRecordId, recordMutation } from '../cloud/execution.js';
import type { PluginService } from './service.js';
import { readLearningMarkdown } from './learning-files.js';

/** Same Markdown/FSRS domain as the existing notebook. Uploads are immutable;
 * the file pointer and its search index commit together, with an optimistic check. */
export async function deliverNotebookAttempt(service: PluginService, owner: string, question: QuizQuestion, source: QuestionSource, attempt: Attempt, existingId?: string) {
  const { store, learningOptions: { filesDir, resources } } = service, records = new CloudRecords(store), id = 'wrongbook.md';
  const beforeVideo = records.get(owner, 'videos', id), beforeFile = records.get(owner, 'files', id);
  if (!beforeVideo && (beforeFile || records.get(owner, 'courseFiles', id))) throw new Error('plugin_notebook_source_conflict');
  const mapped = store.db.prepare('SELECT project_id FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id);
  const before = beforeVideo ? readLearningMarkdown(store, filesDir, owner, id, resources).text : EMPTY_WRONGBOOK;
  const key = existingId ?? await questionId(question, source), entry = parseWrongbook(before).find(q => q.id === key);
  if (existingId && !entry) throw new Error('plugin_review_question_not_found');
  const nextEntry = applyAttempt(entry, key, question, source, attempt);
  if (!nextEntry || nextEntry === entry) return;
  const text = writeQuestion(before, nextEntry);
  if (mapped) {
    if (!resources) throw new Error('plugin_resource_service_unavailable');
    resources.saveText(owner, id, text, before);
    return;
  }
  const bytes = Buffer.from(text), hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const file = await receiveFile(store, filesDir, owner, Readable.from([bytes]), id, 'text/markdown', 4 * 1024 * 1024, bytes.length, undefined, fileOperationId(owner, attempt.id, hash));
  const blocks = chunkUnits(extractMdUnits(text), 'para');
  store.transaction(() => {
    if (!isDeepStrictEqual(records.get(owner, 'files', id), beforeFile) || !isDeepStrictEqual(records.get(owner, 'videos', id), beforeVideo) || store.db.prepare('SELECT 1 FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id)) throw new Error('plugin_notebook_revision_conflict');
    const oldBlocks = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='materialBlocks' AND value IS NOT NULL AND json_extract(value,'$.materialId')=?").all(owner, id) as { value: string }[];
    const video = { ...(beforeVideo ?? { id, name: id, kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', duration: 0, coverState: 'pending', createdAt: Date.now() }), size: bytes.length, status: 'transcribed' };
    records.apply(owner, [recordMutation('videos', id, beforeVideo, video), recordMutation('files', id, beforeFile, { id, blob: { $file: file.id } }),
      ...oldBlocks.map(r => { const row = JSON.parse(r.value); return recordMutation('materialBlocks', row.id, row, null); }),
      ...blocks.map(b => { const key = newRecordId(); return recordMutation('materialBlocks', key, null, { ...b, id: key, materialId: id }); })]);
  });
}
