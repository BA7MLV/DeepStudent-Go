import { db, type ChatRow } from './db';
import { compareChatRows } from '@wangke/study-core/chat-order';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { accountLifecycle } from '../client/account-lifecycle';
import { drainLearning, type LearningCommandRow } from '../client/learning';
import type { RuntimeTask } from '@wangke/contracts/client-runtime';

export async function readChatHistory(sessionId: number) {
  return (await db.chats.where('sessionId').equals(sessionId).toArray()).sort(compareChatRows);
}

export const CHAT_PAGE_SIZE = 40;

export interface ChatHistoryAdapter {
  page(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'> & Partial<Pick<ChatRow, 'role'>>): Promise<{ rows: ChatRow[]; hasOlder: boolean; tasks?: RuntimeTask[] }>;
}

export const serverChatHistory: ChatHistoryAdapter = {
  async page(sessionId, before) {
    const owner = cloud.userId, database = db, lifetime = accountLifecycle.current();
    const accountCurrent = () => owner === cloud.userId && database === db && (!lifetime || lifetime.current());
    const pendingCreation = () => database.table<LearningCommandRow>('_learningCommands').filter(command => command.state !== 'confirmed' && command.request.edits.some(edit =>
      edit.kind === 'conversationSession' && edit.expected == null && edit.value?.id === sessionId)).first();
    const pendingSession = await pendingCreation();
    if (!accountCurrent()) throw new Error('client_account_changed');
    if (pendingSession) {
      await drainLearning();
      if (!accountCurrent()) throw new Error('client_account_changed');
      const unsettled = await pendingCreation();
      if (!accountCurrent()) throw new Error('client_account_changed');
      if (unsettled) throw new Error(unsettled.error ?? 'conversation_session_not_confirmed');
    }
    if (!accountCurrent()) throw new Error('client_account_changed');
    // IndexedDB is a materialized cache, not the authority when disconnected.
    // A failed server page is visible to the caller; never silently fork local.
    const runtime = await serverRuntime(owner);
    if (!accountCurrent() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    const page = await runtime.sessionPage(sessionId,
       before?.id == null ? undefined : { id: before.id, createdAt: before.createdAt, role: before.role });
    if (!accountCurrent() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    return { hasOlder: page.hasOlder, tasks: page.tasks, rows: page.rows.map(row => row.data as unknown as ChatRow) };
  },
};

export function readChatPage(sessionId: number, before?: Pick<ChatRow, 'createdAt' | 'id'> & Partial<Pick<ChatRow, 'role'>>) {
  return serverChatHistory.page(sessionId, before);
}
