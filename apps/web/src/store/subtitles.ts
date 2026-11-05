import { cuesToSegments, type SubtitleBundle } from '../bilibili/subtitle';

export async function saveImportedSubtitles(videoId: string, bundle: SubtitleBundle): Promise<void> {
  await (await import('../client/resources')).resourceCommand({ kind: 'importSubtitles', courseId: videoId, primary: !!bundle.primary,
    segments: bundle.primary ? cuesToSegments(bundle.primary.cues) : [], tracks: bundle.tracks });
  await (await import('../cloud/sync')).flushCloud();
}
