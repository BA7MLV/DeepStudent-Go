import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { cancelResourceTasks } from '../cloud/tasks';
import { isJobActive, useJobStore } from '../store/jobs';
import { runTranscription } from './transcribe';
import { isCancel } from '../utils/cancel';
import { formatCaughtError } from '../utils/errorText';

/** Observers only; the server owns execution, concurrency and durable queueing. */
const signals = new Map<string, AbortController>();
export function startTranscription(videoId: string, opts: { resume?: boolean } = {}): void {
  const state = useJobStore.getState();
  if (isJobActive(state.jobs[videoId])) return;
  state.upsert(videoId, { phase: 'queued', message: opts.resume ? '等待续跑…' : '排队中…', done: 0, total: 0, error: undefined, actionError: undefined, resume: !!opts.resume });
  void runOne(videoId);
}

export function cancelTranscription(videoId: string): void {
  useJobStore.getState().upsert(videoId, { actionError: undefined });
  const database = db, owner = cloud.userId;
  void cancelResourceTasks(`course:${videoId}`, 'transcribe').then(async () => {
    if (database !== db || owner !== cloud.userId) return;
    await (await import('../client/resources')).resourceCommand({ kind: 'pauseTranscription', courseId: videoId });
    if (database === db && owner === cloud.userId) { signals.get(videoId)?.abort(); markCanceled(videoId); }
  }).catch(e => { if (database === db && owner === cloud.userId) useJobStore.getState().upsert(videoId, { actionError: formatCaughtError(e) }); });
}
function markCanceled(videoId: string): void {
  useJobStore.getState().upsert(videoId, { phase: 'canceled', message: '已取消' });
}

async function runOne(videoId: string): Promise<void> {
  const database = db, owner = cloud.userId;
  const controller = new AbortController();
  signals.set(videoId, controller);
  const current = () => database === db && owner === cloud.userId && signals.get(videoId) === controller;
  try {
    await runTranscription(videoId, p => {
      if (!current() || controller.signal.aborted || p.phase === 'done') return;
      useJobStore.getState().upsert(videoId, { phase: p.phase, message: p.message, done: p.done, total: p.total });
    }, { signal: controller.signal });
    if (!current()) return;
    useJobStore.getState().upsert(videoId, { phase: 'done', message: '字幕生成完成' });
    window.setTimeout(() => {
      if (database === db && owner === cloud.userId && useJobStore.getState().jobs[videoId]?.phase === 'done') useJobStore.getState().drop(videoId);
    }, 2000);
  } catch (e) {
    if (!current()) return;
    if (isCancel(e) || controller.signal.aborted) { markCanceled(videoId); return; }
    const text = formatCaughtError(e);
    useJobStore.getState().upsert(videoId, { phase: 'error', message: '转写失败', error: text });
  } finally { if (signals.get(videoId) === controller) signals.delete(videoId); }
}

export async function resumePendingTranscriptions(): Promise<void> {
  // Cloud execution/queue recovery is durable on the server. Activity's shared
  // tasks model already restores progress; a partial business cache must never
  // infer which courses to submit again (potentially charging a second run).
  if (cloud.enabled) return;
  const database = db, owner = cloud.userId;
  const rows = await database.videos.filter(v => v.kind !== 'material' && v.fileDeleted !== 1 && !v.transcriptionPaused && (v.status === 'new' || v.status === 'transcribing')).toArray();
  for (const row of rows) {
    const hasFile = await database.table('courseFiles').get(row.id);
    if (database !== db || owner !== cloud.userId) return;
    if (hasFile) startTranscription(row.id, { resume: true });
  }
}
