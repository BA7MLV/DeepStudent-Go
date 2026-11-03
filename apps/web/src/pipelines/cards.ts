import { remoteTasks } from '../cloud/state';
import { assertPluginAvailable } from '../plugins/availability';
import { runCardsPluginTask } from '../plugins/legacy-actions';
import { getSettings, targetOfSlot } from '../store/settings';
import { db } from '../store/db';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { generateText, type TextProgress, type TextSegment } from './textGeneration';

export type CardsProgress = TextProgress;

export async function runCards(videoId: string, onProgress: (p: CardsProgress) => void): Promise<number> {
  await assertPluginAvailable('flashcards');
  if (remoteTasks()) return runCardsPluginTask(videoId, onProgress);
  const video = await db.videos.get(videoId);
  if (!video) throw new Error('视频不存在');
  let segments: TextSegment[] = await db.segments.where('videoId').equals(videoId).sortBy('idx');
  if (!segments.some(s => s.status === 1 && s.text)) {
    const blocks = await db.materialBlocks.where('materialId').equals(videoId).sortBy('idx');
    segments = blocks.map((b, i) => ({ idx: i, start: i, end: i + 1, text: b.text ?? '', status: 1 }));
    if (segments.length > 0 && segments.length < 3) {
      const text = segments.map(s => s.text).join('\n'), width = Math.ceil(text.length / 3);
      if (text.trim().length < 3) throw new Error('course_source_too_short');
      segments = [0, 1, 2].map(i => ({ idx: i, start: i, end: i + 1, text: text.slice(i * width, (i + 1) * width), status: 1 }));
    }
  }
  await acquireWakeLock();
  try {
    const cards = await generateText('cards', video.name, segments, targetOfSlot(getSettings(), 'chat'), onProgress);
    const now = Date.now();
    await db.transaction('rw', db.cards, async () => {
      await db.cards.where('videoId').equals(videoId).delete();
      await db.cards.bulkAdd(cards.map(c => ({ videoId, ...c, status: 0 as const, createdAt: now })));
    });
    return cards.length;
  } finally { await releaseWakeLock(); }
}
