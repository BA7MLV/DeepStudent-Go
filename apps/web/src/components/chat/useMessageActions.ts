import { useTranslation } from 'react-i18next';
import { db } from '../../store/db';
import { readConversationMessage } from '../../store/conversationProducts';
import { removeConversationMessages } from '../../client/conversations';
import { readChatHistory } from '../../store/chatHistory';
import { accountLifecycle } from '../../client/account-lifecycle';
import { toast } from '../../ui';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 消息重试。语义与主页一致：
 * - 提问上的重试 = 重新回答这句话（删掉这一问一答，用同样的问题重跑）
 * - 回答上的重试 = 重新生成（只对最后一条完整回答成立）
 *
 * 判据在 UI 与这里各挡一道：删掉历史中间的一段是一次不可见的批量删除，
 * 要改中间那一步应该用「分支」。
 *
 * 单独成文件而不是塞进 useChatActions：重试会**再次发起一轮问答**（调用 send），
 * 两条路径共用同一套「同一会话 / 同一账号」判据，但错误出口不同 ——
 * 发送失败落在气泡上，重试失败落成 toast，分开放才看得出差别。
 */
export function useRetryMessage({
  msgs,
  loading,
  activeId,
  turnSkillIds,
  setMsgs,
  send,
}: {
  msgs: ChatMsg[];
  loading: boolean;
  activeId: number | null;
  turnSkillIds: number[];
  setMsgs: (update: (previous: ChatMsg[]) => ChatMsg[]) => void;
  send: (question: string, extraRefs?: import('../../store/selectionAsk').Citation[], suppliedSkills?: number[]) => Promise<void>;
}) {
  const { t: chatText } = useTranslation('common');
  return async (key: string) => {
    const database = db, lifetime = accountLifecycle.current();
    try {
    if (loading || activeId == null) return;
    const idx = msgs.findIndex((m) => m.key === key);
    const message = msgs[idx];
    if (!message) return;

    // 流式请求失败时，助手占位尚未落库，但用户问题已经落库；允许从这条失败消息继续，
    // 不要求先有一个 assistant rowId。删除原问题后交给 send 重新创建一轮，避免上下文重复。
    if (message.role === 'ai' && message.rowId == null && message.error) {
      const previous = msgs[idx - 1];
      if (!previous || previous.role !== 'user' || previous.rowId == null) return;
      const original = await readConversationMessage(previous.rowId);
      await removeConversationMessages([previous.rowId]);
      setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.key !== previous.key));
      await send(previous.content, undefined, original?.explicitSkillIds ?? turnSkillIds);
      return;
    }

    const rows = await readChatHistory(activeId);
    const rowIdx = rows.findIndex((row) => row.id === message.rowId);
    if (rowIdx < 0) return;

    if (message.role === 'user') {
      if (msgs[idx + 1]?.role !== 'ai' || idx !== msgs.length - 2) return;
      const tail = rows.slice(rowIdx);
      await removeConversationMessages(tail.flatMap(row => row.id != null ? [row.id] : []));
      setMsgs((prev) => prev.slice(0, idx));
      await send(message.content, undefined, rows[rowIdx].explicitSkillIds ?? []);
      return;
    }

    if (idx !== msgs.length - 1) return;
    let userIdx = -1;
    for (let i = rowIdx - 1; i >= 0; i--) {
      if (rows[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userRow = rows[userIdx];
    await removeConversationMessages([...(message.rowId != null ? [message.rowId] : []), userRow.id!]);
    setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.rowId !== userRow.id));
    await send(userRow.content, undefined, userRow.explicitSkillIds ?? []);
    } catch (error) {
      if (database === db && (!lifetime || lifetime.current())) toast.error(error instanceof Error ? error.message : chatText('chatPanel.answerSaveFailed'));
    }
  };
}
