import { db, type ChatRow, type ChatSessionRow } from './db';
import { cloud } from '../cloud/state';
import { publishLearningProducts, learningId, type BrowserLearningProduct } from '../cloud/learning-products';

/** Named producer operations. Account UI retains its editLearning adapter;
 * task producers publish conversation products, never generic cache mutations. */
export async function appendConversationMessage(row: Omit<ChatRow, 'id'>): Promise<number> {
  if (!cloud.worker) return await db.chats.add(row) as number;
  const id = learningId();
  await publishLearningProducts([{ kind: 'conversationMessage', expected: null, value: { ...row, id } } as BrowserLearningProduct]);
  return id;
}
export async function patchConversationMessage(id: number, patch: Partial<ChatRow>) {
  if (!cloud.worker) return db.chats.update(id, patch);
  const expected = await db.chats.get(id);
  if (!expected) return 0;
  await publishLearningProducts([{ kind: 'conversationMessage', expected, value: { ...expected, ...patch, id } } as BrowserLearningProduct]);
  return 1;
}
export async function removeConversationMessage(id: number) {
  if (!cloud.worker) return db.chats.delete(id);
  const expected = await db.chats.get(id);
  if (expected) await publishLearningProducts([{ kind: 'conversationMessage', expected, value: null } as BrowserLearningProduct]);
}
export async function appendConversationSession(row: Omit<ChatSessionRow, 'id'>): Promise<number> {
  if (!cloud.worker) return await db.chatSessions.add(row) as number;
  const id = learningId();
  await publishLearningProducts([{ kind: 'conversationSession', expected: null, value: { ...row, id } } as BrowserLearningProduct]);
  return id;
}
export async function patchConversationSession(id: number, patch: Partial<ChatSessionRow>) {
  if (!cloud.worker) return db.chatSessions.update(id, patch);
  const expected = await db.chatSessions.get(id);
  if (!expected) return 0;
  await publishLearningProducts([{ kind: 'conversationSession', expected, value: { ...expected, ...patch, id } } as BrowserLearningProduct]);
  return 1;
}

export async function reviseConversationMessage(id: number, revise: (row: ChatRow) => void) {
  if (!cloud.worker) return db.chats.where('id').equals(id).modify(revise);
  const expected = await db.chats.get(id);
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value);
  await publishLearningProducts([{ kind: 'conversationMessage', expected, value } as BrowserLearningProduct]);
  return 1;
}
export async function reviseConversationSession(id: number, revise: (row: ChatSessionRow) => void) {
  if (!cloud.worker) return db.chatSessions.where('id').equals(id).modify(revise);
  const expected = await db.chatSessions.get(id);
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value);
  await publishLearningProducts([{ kind: 'conversationSession', expected, value } as BrowserLearningProduct]);
  return 1;
}
