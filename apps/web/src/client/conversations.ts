import { db, type ChatRow, type ChatSessionRow } from '../store/db';
import { learningEdit, learningId, submitLearning } from './learning';

export async function removeConversationMessages(ids: number[]) {
  const database = db, rows = (await database.chats.bulkGet(ids)).filter((row): row is ChatRow => !!row);
  if (database !== db) throw new Error('client_account_changed');
  if (!rows.length) return;
  await submitLearning(rows.map(expected => learningEdit({ kind: 'conversationMessage', expected, value: null } as any)),
    [...new Set(rows.flatMap(row => [`session:${row.sessionId}`, `message:${row.id}`]))]);
}

export async function deleteServerSession(sessionId: number, messages: ChatRow[]) {
  const database = db, expected = await database.chatSessions.get(sessionId);
  if (database !== db) throw new Error('client_account_changed');
  if (!expected) return;
  await submitLearning([...messages.map(row => learningEdit({ kind: 'conversationMessage', expected: row, value: null } as any)),
    learningEdit({ kind: 'conversationSession', expected, value: null } as any)], [`session:${sessionId}`]);
}
export async function forkServerSession(source: ChatSessionRow, messages: ChatRow[]) {
  const sid = learningId();
  const { id: _id, pinnedSkillIds: _legacy, ...attributes } = source;
  await submitLearning([learningEdit({ kind: 'conversationSession', expected: null,
    value: { ...attributes, id: sid, title: `${source.title} · 分支`, createdAt: Date.now(), pinned: false, archived: false } } as any),
  ...messages.map(row => {
    const { id: _id, taskId: _task, resume: _resume, widgetState: _state, widgetStates: _states, ...content } = row;
    return learningEdit({ kind: 'conversationMessage', expected: null, value: { ...content, id: learningId(), sessionId: sid } } as any);
  })], [`session:${source.id}`, `session:${sid}`]);
  return sid;
}
