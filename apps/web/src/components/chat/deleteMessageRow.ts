import { db } from '../../store/db';
import { readConversationMessage } from '../../store/conversationProducts';
import { removeConversationMessages } from '../../client/conversations';
import { accountLifecycle } from '../../client/account-lifecycle';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 删除一条消息的落库一半（`useMessageDeletion` 负责滚动容器的占位动画）。
 *
 * 判据三层都挡：生成中不许删、会话已切走不许删、库里那一行已经不属于本次会话也不许删 ——
 * 前两层看的是**本次点击时的快照**（state），最后一层看刚读回来的行，避免删到别的会话。
 * 返回 false 时调用方不会从列表里摘掉这条消息，界面上不会出现「删了又回来」。
 */
export function createDeleteMessageHandler({
  msgs,
  loading,
  activeId,
  setMsgs,
}: {
  msgs: ChatMsg[];
  loading: boolean;
  activeId: number | null;
  setMsgs: (update: (previous: ChatMsg[]) => ChatMsg[]) => void;
}) {
  return async (key: string) => {
    const message = msgs.find((item) => item.key === key);
    const database = db, lifetime = accountLifecycle.current();
    const current = () => database === db && (!lifetime || lifetime.current()) && activeId != null;
    if (loading || activeId == null || !message || message.streaming || message.rowId == null) return false;
    const sessionId = activeId;
    const remove = async () => {
      const row = await readConversationMessage(message.rowId!);
      if (!current()) return false;
      if (!row || row.sessionId !== sessionId) return false;
      await removeConversationMessages([message.rowId!]);
      return true;
    };
    const deleted = await remove();
    if (!deleted) return false;
    if (current()) setMsgs((previous) => previous.filter((item) => item.key !== key));
    return true;
  };
}
