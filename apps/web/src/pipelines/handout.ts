import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';

export interface HandoutProgress {
  phase: 'frames' | 'captions' | 'outline' | 'writing' | 'docx' | 'done';
  done: number;
  total: number;
  message: string;
}

export async function runHandout(videoId: string, onProgress: (p: HandoutProgress) => void): Promise<void> {
  await assertPluginAvailable('material-tools');
  return runMaterialPluginTask('handout', videoId, onProgress);
}
