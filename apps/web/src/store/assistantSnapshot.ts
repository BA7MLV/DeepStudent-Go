import { db, type ChatRow } from './db';
import { messageWidgets } from '../harness/widgetLayout';
import { validateWidgetPayload } from '../harness/widgetProtocol';
import { appendConversationMessage, patchConversationMessage } from './conversationProducts';
import { cloud } from '../cloud/state';

/** Complete tool deliveries and final answers share one row; never recreate a deleted owner. */
export async function persistAssistantSnapshot(snapshot: Omit<ChatRow, 'id'>, rowId?: number): Promise<number> {
  for (const widget of messageWidgets(snapshot)) validateWidgetPayload(widget);
  const save = async () => {
    if (rowId == null) return appendConversationMessage(snapshot);
    const previous = await db.chats.get(rowId);
    if (!previous || previous.role !== 'assistant' || previous.sessionId !== snapshot.sessionId || previous.videoId !== snapshot.videoId)
      throw new Error('原回答已删除或会话已变化，作品未保存');
    await patchConversationMessage(rowId, { ...snapshot, createdAt: previous.createdAt,
      interrupted: snapshot.interrupted, interruptReason: snapshot.interruptReason, resume: snapshot.resume });
    return rowId;
  };
  return db.transaction('rw', db.chats, save);
}
