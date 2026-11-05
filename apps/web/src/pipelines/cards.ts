import { assertPluginAvailable } from '../plugins/availability';
import { runCardsPluginTask } from '../plugins/legacy-actions';
export interface CardsProgress { done: number; total: number; message: string }

export async function runCards(videoId: string, onProgress: (p: CardsProgress) => void): Promise<number> {
  await assertPluginAvailable('flashcards');
  return runCardsPluginTask(videoId, onProgress);
}
