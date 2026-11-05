import type { CloudMutation } from '@wangke/contracts/cloud';
import { CloudConflict, type CloudRecords } from '../cloud/records.js';

/** Shared by account commands and plugin/Bot actions. The caller supplies the
 * state the user actually saw, never a newly read baseline for a stale action.
 * Apply inside the caller's transaction/receipt boundary. */
export function cardReviewMutation(
  records: Pick<CloudRecords, 'get'>,
  owner: string,
  input: { courseId: string; cardId: number; expected: number; status: number; mutationId: string },
): CloudMutation {
  if (!Number.isSafeInteger(input.cardId) || input.cardId <= 0
    || ![0, 1, 2].includes(input.expected) || ![0, 1, 2].includes(input.status)) throw new Error('invalid_card_review');
  const course = records.get(owner, 'videos', input.courseId);
  const card = records.get(owner, 'cards', input.cardId);
  if (!course || course.fileDeleted || !card || card.videoId !== input.courseId) throw new Error('learning_card_denied');
  if (card.status !== input.expected) throw new CloudConflict('cards', input.cardId, ['status']);
  return { id: input.mutationId, table: 'cards', key: input.cardId, before: card, after: { ...card, status: input.status } };
}
