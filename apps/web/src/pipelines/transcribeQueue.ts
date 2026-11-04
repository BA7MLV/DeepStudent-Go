/**
 * 转写任务队列：全局唯一入口，负责「谁在跑、谁排队、能不能取消、刷新后怎么续」。
 *
 * 三件事：
 * 1. **幂等吸附**——同一个视频重复触发（面板点第二次、启动续跑又来一遍）不会起第二份；
 * 2. **串行**——同一时刻只转一个视频，避免抽音频/VAD 与正在播放的视频抢 CPU；
 * 3. **续跑**——启动时把上次没转完（`status='transcribing'`）的视频重新入队。
 *
 * 进度写在 `store/jobs.ts` 里，因此切视频、回资料库都不会丢。
 */
import { db } from '../store/db';
import { remoteTasks } from '../cloud/state';
import { cancelResourceTasks } from '../cloud/tasks';
import { getVideoFile } from '../store/fileStore';
import { isJobActive, useJobStore } from '../store/jobs';
import { runTranscription, type TranscribeProgress } from './transcribe';
import { terminateExtractor } from '../media/extractClient';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { isCancel } from '../utils/cancel';
import { formatCaughtError } from '../utils/errorText';
import { toast } from '../ui';

/** 在途任务的取消标记（key = videoId） */
const signals = new Map<string, AbortController>();

let pumping = false;

/** 触发一次转写。已在跑/已在队列则直接返回（幂等） */
export function startTranscription(videoId: string, opts: { resume?: boolean } = {}): void {
  const state = useJobStore.getState();
  if (isJobActive(state.jobs[videoId])) return; // 吸附：不重复启动
  state.upsert(videoId, {
    phase: 'queued',
    message: opts.resume ? '等待续跑…' : '排队中…',
    done: 0,
    total: 0,
    error: undefined,
    resume: !!opts.resume,
  });
  if (remoteTasks()) {
    // Submit every requested job immediately; the server owns concurrency and queue
    // lifetime, including videos behind the currently running transcription.
    void runOne(videoId);
    return;
  }
  state.enqueue(videoId);
  void pump();
}

/** 取消：中止 ASR 请求；抽音频/VAD 阶段直接终止 Worker。 */
export function cancelTranscription(videoId: string): void {
  if (remoteTasks()) {
    signals.get(videoId)?.abort();
    void cancelResourceTasks(`course:${videoId}`, 'transcribe').then(() => settleCanceled(videoId)).catch(e => toast.error(e.message));
    markCanceled(videoId);
    return;
  }
  const job = useJobStore.getState().jobs[videoId];
  if (!isJobActive(job)) return;
  const signal = signals.get(videoId);
  if (!signal) {
    // 还没轮到它：直接出队
    dequeue(videoId);
    markCanceled(videoId);
    void settleCanceled(videoId).catch(e => toast.error(e.message));
    return;
  }
  signal.abort();
  // 抽取/VAD 卡在 Worker 的密集循环里，标记管不到，只能 terminate
  if (job?.phase === 'extract' || job?.phase === 'vad') terminateExtractor();
}

function dequeue(videoId: string): void {
  useJobStore.setState((s) => ({ queue: s.queue.filter((q) => q !== videoId) }));
}

function markCanceled(videoId: string): void {
  useJobStore.getState().upsert(videoId, { phase: 'canceled', message: '已取消' });
}

/** 串行泵：队列里有活就一直跑，跑空为止 */
async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  await acquireWakeLock();
  try {
    for (;;) {
      const id = useJobStore.getState().queue[0];
      if (!id) break;
      useJobStore.getState().setActive(id);
      await runOne(id);
      // 出队。job 本身留着（done/error/canceled 还要给 UI 看一会儿）
      useJobStore.setState((st) => ({ queue: st.queue.filter((q) => q !== id), activeId: null }));
    }
  } finally {
    pumping = false;
    useJobStore.getState().setActive(null);
    await releaseWakeLock();
  }
}

async function runOne(videoId: string): Promise<void> {
  const job = useJobStore.getState().jobs[videoId];
  if (!job || job.phase === 'canceled') return;

  const controller = new AbortController();
  const signal = controller.signal;
  signals.set(videoId, controller);

  try {
    await runTranscription(
      videoId,
      (p: TranscribeProgress) => {
        if (signal.aborted || signals.get(videoId) !== controller) return;
        if (p.phase === 'done') return;
        useJobStore.getState().upsert(videoId, {
          phase: p.phase,
          message: p.message,
          done: p.done,
          total: p.total,
        });
      },
      { signal },
    );
    if (signals.get(videoId) !== controller) return;
    useJobStore.getState().upsert(videoId, { phase: 'done', message: '字幕生成完成' });
    const row = await db.videos.get(videoId);
    toast.success(`《${row?.name ?? '视频'}》字幕生成完成`);
    // 完成态只留一小会儿，随后自动清掉（下次再点就是「重新生成」）
    window.setTimeout(() => {
      if (useJobStore.getState().jobs[videoId]?.phase === 'done') useJobStore.getState().drop(videoId);
    }, 2000);
  } catch (e) {
    if (signals.get(videoId) !== controller) return;
    if (isCancel(e) || signal.aborted) {
      if (!remoteTasks()) await settleCanceled(videoId);
      markCanceled(videoId);
      return;
    }
    const text = formatCaughtError(e);
    useJobStore.getState().upsert(videoId, { phase: 'error', message: '转写失败', error: text });
    const row = await db.videos.get(videoId);
    toast.error(`《${row?.name ?? '视频'}》转写失败：${text}`);
  } finally {
    if (signals.get(videoId) === controller) signals.delete(videoId);
  }
}

/** 部分字幕仍可阅读，但不是完成态；显式重试才能继续，避免刷新后偷跑。 */
async function settleCanceled(videoId: string): Promise<void> {
  if (remoteTasks()) {
    await (await import('../client/resources')).resourceCommand({ kind: 'pauseTranscription', courseId: videoId });
    return;
  }
  await db.videos.update(videoId, { status: 'new', transcriptionPaused: true });
}

/**
 * 启动时准备新视频、续跑中断的视频。服务端模式只检查文件索引，不下载视频；
 * 提交会吸附已有任务，浏览器宿主随后领取。错误任务不在此无限重试。
 */
export async function resumePendingTranscriptions(): Promise<void> {
  // status 不是索引（videos 只索引了 id, createdAt），只能全表过滤；视频量级无所谓
  const rows = await db.videos.filter((v) => v.kind !== 'material' && v.fileDeleted !== 1 && !v.transcriptionPaused &&
    (v.status === 'new' || v.status === 'transcribing')).toArray();
  let resumed = 0;
  for (const v of rows) {
    // 视频文件本体没了就没法续（可能已删文件释放空间），跳过且不改状态
    const hasFile = remoteTasks() ? await db.table('courseFiles').get(v.id) : await getVideoFile(v.id);
    if (!hasFile) continue;
    startTranscription(v.id, { resume: true });
    resumed++;
  }
  if (resumed > 0) toast.info(`正在自动处理 ${resumed} 个视频的字幕，请保持页面打开`);
}
