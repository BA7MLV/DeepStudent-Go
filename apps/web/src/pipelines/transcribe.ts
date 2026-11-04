import { transcribe } from '../api/siliconflow';
import { remoteTasks } from '../cloud/state';
import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';
import { getSettings, targetOfSlot } from '../store/settings';
import { db, type SegmentRow } from '../store/db';
import { publishLearningProducts, publishCourseDerivation, learningId, type BrowserLearningProduct } from '../cloud/learning-products';
import { getVideoFile } from '../store/fileStore';
import { extractAndSegment } from '../media/extractClient';
import { wavBlob } from '../media/wav';
import { AdaptiveLimit, withAdaptiveRetry, adaptivePool } from '../utils/concurrency';
import { CancelError, isCancel } from '../utils/cancel';
import { preferOriginalSubtitles } from './subtitleSource';
import { loadBiliSubtitles } from '../bilibili/loadSubtitles';
import { saveImportedSubtitles } from '../store/subtitles';

export interface TranscribeProgress {
  phase: 'source' | 'extract' | 'vad' | 'asr' | 'done';
  done: number;
  total: number;
  message: string;
}

export interface TranscribeOptions {
  /** 取消标记：由任务队列持有并置位，流水线每段派发前检查 */
  signal?: AbortSignal;
}

/**
 * 字幕转写流水线：抽音频 → VAD 分段 → 自适应并发调 ASR（ASR 槽位配的那家供应商）→ 写入 segments 表。
 * 支持断点续做：已完成的段（status=1）会跳过；并发按 AIMD 调节，遇限流自动降速。
 *
 * 重 CPU 的「抽音频 + VAD」在 Worker 里跑（见 `media/extractClient.ts`），
 * 因此本函数可以被丢到后台跑而不卡住正在播放的视频。
 * 已完成字幕直接复用；B 站优先拉原字幕，缺失/拉取失败才做浏览器转写。
 */
export async function runTranscription(
  videoId: string,
  onProgress: (p: TranscribeProgress) => void,
  opts: TranscribeOptions = {},
): Promise<void> {
  await assertPluginAvailable('material-tools');
  if (remoteTasks()) return runMaterialPluginTask('transcribe', videoId, onProgress, opts.signal);
  const settings = getSettings();
  const video = await db.videos.get(videoId);
  if (!video || video.fileDeleted === 1) throw new Error('视频文件不存在');
  const checkActive = () => { if (opts.signal?.aborted) throw new CancelError(); };
  try {
    checkActive();
    const completed = video.status === 'transcribed' && await db.segments.where('videoId').equals(videoId).filter(r => r.status === 1 && !!r.text.trim()).count() > 0;
    if (!completed) await publishCourseDerivation(videoId, { status: 'transcribing', transcriptionPaused: false });
    if (video.biliSource && !completed) onProgress({ phase: 'source', done: 0, total: 1, message: '优先读取 B 站自带字幕…' });
    if (await preferOriginalSubtitles({
      completed, hasSource: !!video.biliSource, checkActive,
      load: () => loadBiliSubtitles({ proxy: settings.bilibiliProxy, cookie: settings.bilibiliCookie }, video.biliSource!),
      save: bundle => saveImportedSubtitles(videoId, bundle),
      fallback: error => {
        if (error) console.warn('[transcribe] B 站字幕读取失败，改用浏览器转写', error);
        onProgress({ phase: 'source', done: 0, total: 1, message: error ? 'B 站字幕暂不可用，改用浏览器转写…' : '没有自带字幕，开始浏览器转写…' });
      },
    })) {
      onProgress({ phase: 'done', done: 1, total: 1, message: '字幕已就绪' });
      return;
    }
    checkActive();
    // Only require an ASR model after original subtitles have been ruled out.
    const target = targetOfSlot(settings, 'asr');
    const blob = await getVideoFile(videoId);
    if (!blob) throw new Error('视频文件不存在');
    checkActive();

    // 1. 抽取音频 + VAD（Worker 内一次性完成）
    const {
      pcm,
      segments: vadSegs,
      recoveries,
      skipped,
    } = await extractAndSegment(blob, video.duration, (phase, ratio, note) =>
      phase === 'vad'
        ? onProgress({ phase: 'vad', done: 0, total: 1, message: '语音端点检测中…' })
        : onProgress({
            phase: 'extract',
            done: ratio,
            total: 1,
            message: `抽取音频 ${Math.round(ratio * 100)}%${note ? `（${note}）` : ''}`,
          }),
    );
    if (recoveries > 0) {
      // 音轨有损坏帧：已跳过并补静音（时间轴不漂），这里只留一条诊断线索
      console.warn(
        `[transcribe] 音轨有 ${recoveries} 处损坏帧，已跳过约 ${skipped.toFixed(2)}s（时间轴已用静音补齐）`,
      );
    }
    if (opts.signal?.aborted) throw new CancelError();
    if (vadSegs.length === 0) throw new Error('未检测到语音内容');

    // 2. 生成转写计划（保留已完成段，支持续做）
    const existingRows = await db.segments.where('videoId').equals(videoId).toArray();
    const doneRows = existingRows.filter(r => r.status === 1 && !!r.text.trim());
    const doneByIdx = new Map(doneRows.map((r) => [r.idx, r]));
    const planMismatch = existingRows.some(row => !vadSegs[row.idx] ||
      Math.abs(row.start - vadSegs[row.idx].start) > 0.25 || Math.abs(row.end - vadSegs[row.idx].end) > 0.25);

    if (planMismatch) {
      // VAD 结果与已有数据差异过大，清空重来
      doneByIdx.clear();
    }

    const pendingIdx: number[] = [];
    const planProducts: BrowserLearningProduct[] = planMismatch ? existingRows.map(row => ({ kind: 'transcriptSegment', expected: { ...row, id: row.id! }, value: null })) : [];
      for (let i = 0; i < vadSegs.length; i++) {
        if (doneByIdx.has(i)) continue;
        const existing = planMismatch ? undefined : existingRows.find(row => row.idx === i);
        const row = { videoId, idx: i, start: vadSegs[i].start, end: vadSegs[i].end, text: '', status: 0 as const };
        const id = existing?.id ?? learningId();
        planProducts.push({ kind: 'transcriptSegment', expected: existing ? { ...existing, id } : null, value: { ...row, id } });
        pendingIdx.push(i);
      }
    await publishLearningProducts(planProducts);

    // 3. 并发转写（AIMD 自适应：初始值来自设置，遇 429 自动降速）
    const limiter = new AdaptiveLimit(settings.asrConcurrency);
    const total = vadSegs.length;
    let done = total - pendingIdx.length;
    const report = () =>
      onProgress({ phase: 'asr', done, total, message: `转写中 ${done}/${total}（并发 ${limiter.current}）` });
    report();

    const asr = new AbortController();
    const abortAsr = () => asr.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', abortAsr, { once: true });
    if (opts.signal?.aborted) abortAsr();
    try {
      await adaptivePool(pendingIdx, limiter, async (idx) => {
        checkActive();
        const seg = vadSegs[idx];
        const startSample = Math.floor(seg.start * 16000);
        const endSample = Math.min(pcm.length, Math.ceil(seg.end * 16000));
        const segBlob = wavBlob(pcm.subarray(startSample, endSample));
        const result = await withAdaptiveRetry(
          () => transcribe(target, segBlob, `seg-${idx}.wav`, asr.signal),
          limiter,
          3,
          () => asr.signal.aborted,
          asr.signal,
        );
        checkActive();
        asr.signal.throwIfAborted();
        const text = result.text.trim();
        if (!text) throw new Error(`第 ${idx + 1} 段未返回有效字幕，请检查语音识别模型配置`);
        // 句级时间戳：段内相对 → 媒体绝对时间，clamp 在段区间内
        const cues = result.segments
          ?.map((c) => ({
            start: Math.max(seg.start, seg.start + c.start),
            end: Math.min(seg.end, seg.start + c.end),
            text: c.text,
          }))
          .filter((c) => c.end > c.start);
        const patch: Partial<SegmentRow> = { text, status: 1 };
        if (cues?.length) patch.cues = cues;
        const existing = await db.segments.where('videoId').equals(videoId).filter(row => row.idx === idx).first();
        if (!existing?.id) throw new Error('transcription_checkpoint_missing');
        await publishLearningProducts([{ kind: 'transcriptSegment', expected: { ...existing, id: existing.id }, value: { ...existing, ...patch, id: existing.id } }]);
        done++;
        report();
      }, { signal: asr.signal });
    } catch (error) {
      // A failed sibling must not keep writing after the task loses its lease.
      asr.abort();
      throw error;
    } finally {
      opts.signal?.removeEventListener('abort', abortAsr);
    }

    checkActive();
    await publishCourseDerivation(videoId, { status: 'transcribed' });
    onProgress({ phase: 'done', done: total, total, message: '字幕生成完成' });
  } catch (e) {
    // 浏览器租约失效时不要写回：旧宿主已无权覆盖新宿主的数据。
    if (!isCancel(e) && !opts.signal?.aborted) await publishCourseDerivation(videoId, { status: 'error' });
    throw e;
  }
}
