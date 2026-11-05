import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';

export interface DanmakuProgress { done: number; total: number; message: string }

export async function runDanmaku(videoId: string, onProgress: (p: DanmakuProgress) => void): Promise<number> {
  await assertPluginAvailable('material-tools');
  return runMaterialPluginTask('danmaku', videoId, onProgress);
}
