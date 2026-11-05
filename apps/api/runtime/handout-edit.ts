import fs from 'node:fs';
import { Readable } from 'node:stream';
import { buildHandoutDocx } from '@wangke/study-core/handout/docx';
import { collectFigureTimestamps } from '@wangke/study-core/handout/ir';
import type { HandoutImages } from '@wangke/study-core/handout/render';
import type { HandoutPersistResult } from '@wangke/contracts/cloud';
import { parseHandoutPersist, handoutEditBaseline } from '../src/cloud/handout-edit.js';
import { commitTask, taskCourseFile, taskFile, taskRows, type TaskContext } from '../src/cloud/execution.js';
import { receiveFile } from '../src/cloud/files.js';
import { imageStats, videoFrame } from './frame-port.js';

/** Rebuild on the server without rewriting either source bytes or the old DOCX.
 * File creation precedes SQL publication: a losing CAS can leave an unreferenced
 * upload, but can never replace the original artifact or publish a partial edit. */
export async function persistHandout(context: TaskContext): Promise<HandoutPersistResult> {
  context.checkActive();
  const receipt = context.store.db.prepare('SELECT result FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { result: string | null } | undefined;
  // The artifact receipt is committed with its record mutation. A replay returns
  // it, not the current handout (which a later task may have edited again).
  if (receipt?.result) return JSON.parse(receipt.result);
  const input = parseHandoutPersist(context.task.input);
  const { handout, course } = handoutEditBaseline(context.records, context.owner, input);
  const images: HandoutImages = new Map();
  const timestamps = collectFigureTimestamps(input.sections);
  const frames = taskRows(context, 'frames', 'videoId', input.videoId);
  for (const frame of frames.filter(f => timestamps.includes(Math.floor(f.ts)))) {
    try {
      const filename = taskFile(context, frame.blob);
      const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let bytes: Buffer;
      try { if (fs.fstatSync(fd).size > 4 * 1024 * 1024) throw new Error('frame_size_limit'); bytes = fs.readFileSync(fd); }
      finally { fs.closeSync(fd); }
      const dimensions = await imageStats(context, bytes);
      images.set(Math.floor(frame.ts), { data: bytes, ...dimensions, caption: String(frame.caption ?? '课程画面') });
    } catch { context.checkActive(); }
  }
  // Original video may be absent; retained indexed frames remain a valid source.
  const file = !course.fileDeleted && timestamps.length ? taskCourseFile(context, input.videoId) : null;
  try {
    if (file) for (const ts of timestamps) {
      try {
        const bytes = await videoFrame(context, file.fd, ts, 1600, 2);
        images.set(ts, { data: bytes, ...await imageStats(context, bytes), caption: images.get(ts)?.caption ?? '课程画面' });
      } catch { context.checkActive(); }
    }
    const document = await buildHandoutDocx({ title: String(handout.title), courseName: String(course.name), date: new Date(handout.createdAt).toISOString().slice(0, 10), summary: input.summary, sections: input.sections, images });
    context.checkActive();
    const bytes = Buffer.from(await document.arrayBuffer());
    const stored = await receiveFile(context.store, context.filesDir, context.owner, Readable.from([bytes]), 'handout.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 32 * 1024 * 1024);
    const sectionsJson = JSON.stringify(input.sections), outlineJson = JSON.stringify({ ...JSON.parse(input.expected.outlineJson), summary: input.summary });
    const result = { handoutId: input.handoutId, fileId: stored.id, sectionsJson, outlineJson };
    context.store.transaction(() => {
      context.checkActive();
      file?.assertCurrent();
      const { handout: current } = handoutEditBaseline(context.records, context.owner, input);
      if (current.title !== handout.title || current.createdAt !== handout.createdAt) throw new Error('handout_edit_conflict');
      // Read current only to preserve unrelated fields. Content baselines above
      // are always the user's original expected values, never this late read.
      commitTask(context, [{ id: `handout-persist:${context.task.id}`, table: 'handouts', key: input.handoutId, before: current, after: { ...current, blob: { $file: stored.id }, sectionsJson, outlineJson } }]);
      context.store.db.prepare('UPDATE cloud_tasks SET result=? WHERE id=? AND owner_id=?').run(JSON.stringify(result), context.task.id, context.owner);
    });
    return result;
  } finally { file?.close(); }
}
