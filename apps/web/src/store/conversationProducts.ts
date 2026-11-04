import { db, type ChatRow, type ChatSessionRow } from './db';

/** Static/local conversation persistence. Cloud execution owns its server IO. */
export async function appendConversationMessage(row: Omit<ChatRow, 'id'>): Promise<number> { return await db.chats.add(row) as number; }
export async function patchConversationMessage(id: number, patch: Partial<ChatRow>) { return db.chats.update(id, patch); }
export async function removeConversationMessage(id: number) { return db.chats.delete(id); }
export async function appendConversationSession(row: Omit<ChatSessionRow, 'id'>): Promise<number> { return await db.chatSessions.add(row) as number; }
export async function patchConversationSession(id: number, patch: Partial<ChatSessionRow>) { return db.chatSessions.update(id, patch); }
export async function reviseConversationMessage(id: number, revise: (row: ChatRow) => void) { return db.chats.where('id').equals(id).modify(revise); }
export async function reviseConversationSession(id: number, revise: (row: ChatSessionRow) => void) { return db.chatSessions.where('id').equals(id).modify(revise); }
