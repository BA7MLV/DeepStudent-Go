import type { LearningProduct, LearningBlob, LearningCourseState } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from './state';
type BrowserValue<T> = T extends LearningBlob ? Blob : T extends (infer U)[] ? BrowserValue<U>[] : T extends object ? { [K in keyof T]: BrowserValue<T[K]> } : T;
export type BrowserLearningProduct = BrowserValue<LearningProduct>;
const targets = { transcriptSegment: 'segments', subtitleTrack: 'subtitleTracks', materialBlock: 'materialBlocks', slideFrame: 'frames', courseCover: 'covers', handoutDocument: 'handouts', candidateCard: 'cards', courseComment: 'comments', courseDanmaku: 'danmakus', conversationMessage: 'chats', conversationSession: 'chatSessions' } as const;
export const learningId = () => { const n = crypto.getRandomValues(new Uint32Array(2)); return (n[0] & 0xfffff) * 0x100000000 + n[1] || 1; };

/** Static Local adapter only. Cloud products are committed by the API; a cloud
 * connection failure must not start a second local producer. */
export async function publishLearningProducts(products: BrowserLearningProduct[]) {
  if (!products.length) return;
  if (cloud.enabled) throw new Error('server_learning_task_required');
  await db.transaction('rw', db.tables, async () => {
    for (const product of products) {
      if (product.kind === 'courseDerivation') { await db.videos.update(product.courseId, product.value); continue; }
      const row = product.value ?? product.expected;
      if (!row) throw new Error('learning_product_identity_missing');
      const key = product.kind === 'courseCover' ? (row as any).videoId : (row as any).id;
      const table = db.table(targets[product.kind]);
      if (product.value) await table.put(product.value); else await table.delete(key);
    }
  });
}
export async function publishCourseDerivation(courseId: string, value: LearningCourseState) {
  if (cloud.enabled) throw new Error('server_learning_task_required');
  if (!await db.videos.get(courseId)) throw new Error('course_not_found');
  await publishLearningProducts([{ kind: 'courseDerivation', courseId, expected: {}, value }]);
}
