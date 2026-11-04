import { remoteTasks } from '../cloud/state';
import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { publishLearningProducts, learningId } from '../cloud/learning-products';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { generateText, type TextProgress } from './textGeneration';

export type DanmakuProgress = TextProgress;

export async function runDanmaku(videoId: string, onProgress: (p: DanmakuProgress) => void): Promise<number> {
  await assertPluginAvailable('material-tools');
  if (remoteTasks()) return runMaterialPluginTask('danmaku', videoId, onProgress);
  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  const segments = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  await acquireWakeLock();
  try {
    const items = await generateText('danmaku', video.name, segments, targetOfSlot(getSettings(), 'chat'), onProgress);
    const old = await db.danmakus.where('videoId').equals(videoId).toArray();
    await publishLearningProducts([
      ...old.map(row => ({ kind: 'courseDanmaku' as const, expected: { ...row, id: row.id! }, value: null })),
      ...items.map(item => ({ kind: 'courseDanmaku' as const, expected: null, value: { id: learningId(), videoId, ...item } })),
    ]);
    return items.length;
  } finally { await releaseWakeLock(); }
}
