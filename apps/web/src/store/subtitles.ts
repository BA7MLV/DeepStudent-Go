import { db, type SegmentRow } from './db';
import { cuesToSegments, type SubtitleBundle } from '../bilibili/subtitle';
import { publishLearningProducts, learningId } from '../cloud/learning-products';

/**
 * 导入字幕落库：主语言写 `segments`（AI 全链路用它），全部语言写 `subtitleTracks`（只喂显示）。
 * 主语言非空时把视频直接标为已转写，讲义/卡片/弹幕立刻可用。
 */
export async function saveImportedSubtitles(videoId: string, bundle: SubtitleBundle): Promise<void> {
  const { cloud } = await import('../cloud/state');
  if (cloud.enabled && !cloud.worker) {
    await (await import('../client/resources')).resourceCommand({ kind: 'importSubtitles', courseId: videoId, primary: !!bundle.primary,
      segments: bundle.primary ? cuesToSegments(bundle.primary.cues) : [], tracks: bundle.tracks });
    await (await import('../cloud/sync')).flushCloud();
    return;
  }
  const segments = await db.segments.where('videoId').equals(videoId).toArray();
  const tracks = await db.subtitleTracks.where('videoId').equals(videoId).toArray();
  const course = await db.videos.get(videoId);
  if (!course) throw new Error('course_not_found');
  await publishLearningProducts([
    ...segments.map(row => ({ kind: 'transcriptSegment' as const, expected: { ...row, id: row.id! }, value: null })),
    ...(bundle.primary ? cuesToSegments(bundle.primary.cues).map(row => ({ kind: 'transcriptSegment' as const, expected: null, value: { ...row, id: learningId(), videoId } })) : []),
    ...tracks.map(row => ({ kind: 'subtitleTrack' as const, expected: { ...row, id: row.id! }, value: null })),
    ...bundle.tracks.map(row => ({ kind: 'subtitleTrack' as const, expected: null, value: { id: learningId(), videoId, lang: row.lang, lanDoc: row.lanDoc, primary: row.primary, cues: row.cues } })),
    { kind: 'courseDerivation', courseId: videoId, expected: { status: course.status }, value: { status: bundle.primary ? 'transcribed' : 'new' } },
  ]);
}
