import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';

export interface CommentsProgress { done: number; total: number; message: string }

export async function runComments(videoId: string, onProgress: (p: CommentsProgress) => void): Promise<{ threads: number; posts: number }> {
  await assertPluginAvailable('material-tools');
  return runMaterialPluginTask('comments', videoId, onProgress);
}
