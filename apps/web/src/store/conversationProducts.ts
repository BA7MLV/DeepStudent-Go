import { db, type ChatRow, type ChatSessionRow } from './db';
import { editMessage, editSession, learningId } from '../client/learning';

/** Conversation mutations are server commands; IndexedDB is only a projection. */
export async function appendConversationMessage(row: Omit<ChatRow, 'id'>): Promise<number> {
  const value = { ...row, id: learningId() }; await editMessage(null, value); return value.id;
}
export async function patchConversationMessage(id: number, patch: Partial<ChatRow>) {
  return reviseConversationMessage(id, row => { for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete (row as any)[key]; else (row as any)[key] = value; } });
}
export async function removeConversationMessage(id: number) {
  const database = db, row = await database.chats.get(id);
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
  const database = db, expected = await database.chats.get(id);
  if (database !== db) throw new Error('client_account_changed');
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value); await editMessage(expected, value); return 1;
}
export async function reviseConversationSession(id: number, revise: (row: ChatSessionRow) => void) {
  const database = db, expected = await database.chatSessions.get(id);
  if (database !== db) throw new Error('client_account_changed');
  if (!expected) return 0;
  const value = structuredClone(expected); revise(value); await editSession(expected, value); return 1;
}
