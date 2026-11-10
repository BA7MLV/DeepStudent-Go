import { db, type ChatRow, type ChatSessionRow } from './db';
import { editMessage, editSession, learningId } from '../client/learning';
import { cloud } from '../cloud/state';
import { readRecordKeys } from '../cloud/sync';

export async function readConversationSession(id: number) {
  return cloud.enabled ? (await readRecordKeys<ChatSessionRow>('chatSessions', [id]))[0] : db.chatSessions.get(id);
}
export async function readConversationMessage(id: number) {
  return cloud.enabled ? (await readRecordKeys<ChatRow>('chats', [id]))[0] : db.chats.get(id);
}

/** Conversation mutations are server commands; IndexedDB is only a projection. */
export async function appendConversationMessage(row: Omit<ChatRow, 'id'>): Promise<number> {
  const value = { ...row, id: learningId() }; await editMessage(null, value); return value.id;
}
export async function patchConversationMessage(id: number, patch: Partial<ChatRow>) {
  return reviseConversationMessage(id, row => { for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete (row as any)[key]; else (row as any)[key] = value; } });
}
export async function removeConversationMessage(id: number) {
  const database = db, row = await readConversationMessage(id);
  if (database !== db) throw new Error('client_account_changed');
  if (row) await editMessage(row, null);
}
export async function appendConversationSession(row: Omit<ChatSessionRow, 'id'>): Promise<number> {
  const value = { ...row, id: learningId() }; await editSession(null, value); return value.id;
}
export async function patchConversationSession(id: number, patch: Partial<ChatSessionRow>) {
  return reviseConversationSession(id, row => { for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete (row as any)[key]; else (row as any)[key] = value; } });
}
export async function reviseConversationMessage(id: number, revise: (row: ChatRow) => void) {
  const database = db, expected = await readConversationMessage(id);
  if (database !== db) throw new Error('client_account_changed');
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value); await editMessage(expected, value); return 1;
}
export async function reviseConversationSession(id: number, revise: (row: ChatSessionRow) => void) {
  const database = db, expected = await readConversationSession(id);
  if (database !== db) throw new Error('client_account_changed');
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value); await editSession(expected, value); return 1;
}
