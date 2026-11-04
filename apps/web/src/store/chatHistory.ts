import { db, type ChatRow } from './db';
import { compareChatRows } from '@wangke/study-core/chat-order';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';

export async function readChatHistory(sessionId: number) {
  return (await db.chats.where('sessionId').equals(sessionId).toArray()).sort(compareChatRows);
}

export const CHAT_PAGE_SIZE = 40;

export interface ChatHistoryAdapter {
  page(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'> & Partial<Pick<ChatRow, 'role'>>): Promise<{ rows: ChatRow[]; hasOlder: boolean }>;
}

export const localChatHistory: ChatHistoryAdapter = { page: readLocalChatPage };
export const serverChatHistory: ChatHistoryAdapter = {
  async page(sessionId, before) {
    const owner = cloud.userId, database = db;
    const accountCurrent = () => owner === cloud.userId && database === db;
    const pendingSession = await database.table('_cloudOutbox').filter(row => row.table === 'chatSessions' && row.key === sessionId).count();
    if (!accountCurrent()) throw new Error('client_account_changed');
    if (pendingSession) await (await import('../cloud/sync')).flushCloud();
    if (!accountCurrent()) throw new Error('client_account_changed');
    // IndexedDB is a materialized cache, not the authority when disconnected.
    // A failed server page is visible to the caller; never silently fork local.
    const runtime = await serverRuntime(owner);
    if (!accountCurrent() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    const page = await runtime.sessionPage(sessionId,
       before?.id == null ? undefined : { id: before.id, createdAt: before.createdAt, role: before.role });
    if (!accountCurrent() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    return { hasOlder: page.hasOlder, rows: page.rows.map(row => row.data as unknown as ChatRow) };
  },
};

export function readChatPage(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'> & Partial<Pick<ChatRow, 'role'>>) {
  return (cloud.enabled ? serverChatHistory : localChatHistory).page(sessionId, before);
}

/** Read bounded timestamp ranges, including whole tie buckets before applying the shared order. */
async function readLocalChatPage(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'>) {
  return db.transaction('r', db.chats, async () => {
    const cursor = before?.id == null ? undefined : await db.chats.get(before.id);
    const bucket = (time: number) => db.chats.where('[sessionId+createdAt+id]')
      .between([sessionId, time, -Infinity], [sessionId, time, Infinity], true, true).toArray();
    const tied = before ? (await bucket(before.createdAt))
      .filter(row => compareChatRows(row, cursor ?? before) < 0) : [];
    const previous = await db.chats.where('[sessionId+createdAt+id]')
      .between([sessionId, -Infinity, -Infinity],
        [sessionId, before?.createdAt ?? Infinity, before ? -Infinity : Infinity], true, false)
      .reverse().limit(CHAT_PAGE_SIZE + 1).toArray();
    const oldest = previous.at(-1)?.createdAt;
    const boundary = oldest == null ? [] : await bucket(oldest);
    const rows = [...tied, ...previous.filter(row => row.createdAt !== oldest), ...boundary].sort(compareChatRows);
    return { hasOlder: rows.length > CHAT_PAGE_SIZE, rows: rows.slice(-CHAT_PAGE_SIZE) };
  });
}
