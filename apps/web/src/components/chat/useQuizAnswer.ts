import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { db } from '../../store/db';
import { readConversationMessage } from '../../store/conversationProducts';
import { editMessage } from '../../client/learning';
import { canUpdateQuizPick, type QuizPick } from '../../harness/quiz';
import { accountLifecycle } from '../../client/account-lifecycle';
import { toast } from '../../ui';
import type { ChatMsg } from './chatPanelTypes';

/** 题卡作答：更新消息状态；已落库的同步回写 IndexedDB */
export function useQuizAnswer({
  msgs,
  pauseFollowing,
  setMsgs,
}: {
  msgs: ChatMsg[];
  pauseFollowing: () => void;
  setMsgs: (update: (previous: ChatMsg[]) => ChatMsg[]) => void;
}) {
  const { t: chatText } = useTranslation('common');
  const handleAnswer = useCallback(async (key: string, qi: number, oi: QuizPick) => {
    // Revealing an explanation is a reading interaction, not new model output.
    pauseFollowing();
    const message = msgs.find(item => item.key === key), database = db, lifetime = accountLifecycle.current();
    if (!message?.quiz || message.rowId == null || !canUpdateQuizPick(message.quiz.data.questions[qi], message.quiz.picks[qi], oi)) return;
    const picks = [...message.quiz.picks]; picks[qi] = oi;
    const quiz = { ...message.quiz, picks };
    try {
      const row = await readConversationMessage(message.rowId);
      if (database !== db || lifetime && !lifetime.current()) return;
      if (!row || JSON.stringify(row.quiz) !== JSON.stringify(message.quiz)) throw new Error(chatText('chatPanel.quizChanged'));
      await editMessage(row, { ...row, quiz });
      if (database === db && (!lifetime || lifetime.current())) setMsgs(prev => prev.map(item => item.key === key ? { ...item, quiz } : item));
    } catch (error) { if (database === db && (!lifetime || lifetime.current())) toast.error(error instanceof Error ? error.message : chatText('chatPanel.answerSaveFailed')); }
  }, [chatText, msgs, pauseFollowing, setMsgs]);
  return { handleAnswer };
}
