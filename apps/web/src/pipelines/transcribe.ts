import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';

export interface TranscribeProgress {
  phase: 'source' | 'extract' | 'vad' | 'asr' | 'done';
  done: number;
  total: number;
  message: string;
}
export interface TranscribeOptions { signal?: AbortSignal }

export async function runTranscription(videoId: string, onProgress: (p: TranscribeProgress) => void, opts: TranscribeOptions = {}): Promise<void> {
  await assertPluginAvailable('material-tools');
  return runMaterialPluginTask('transcribe', videoId, onProgress, opts.signal);
}
