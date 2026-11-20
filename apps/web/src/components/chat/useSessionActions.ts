import { useTranslation } from 'react-i18next';
import type { ChatSessionRow } from '../../store/db';
import { appendConversationSession, readConversationSession, reviseConversationSession } from '../../store/conversationProducts';
import { readChatHistory } from '../../store/chatHistory';
import { deleteServerSession, forkServerSession } from '../../client/conversations';
import { toast } from '../../ui';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 会话级动作：新开 / 删除会话、分叉、改技能范围。
 *
 * 与 `useChatActions` 分开：这些动作只动「会话」这一层（列表与库里那一行），
 * 不碰消息流，也不读 abort / 发送状态 —— 混在一起会让发送那条路径多背一份依赖。
 */
export function useSessionActions({
  videoId,
  activeId,
  sessions,
  loading,
  historySession,
  setSessions,
  setActiveId,
  setSkillIds,
  setMcpServerIds,
}: {
  videoId: string;
  activeId: number | null;
  sessions: ChatSessionRow[];
  loading: boolean;
  historySession: React.RefObject<number | null>;
  setSessions: (update: React.SetStateAction<ChatSessionRow[]>) => void;
  setActiveId: (id: number | null) => void;
  setSkillIds: (ids: number[] | undefined) => void;
  setMcpServerIds: (ids: string[] | undefined) => void;
}) {
  const { t: chatText } = useTranslation('common');

  /** 新开会话 */
  const createSession = async () => {
    const now = Date.now();
    const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
    setSessions((prev) => [...prev.filter(session => session.id !== id), { id, videoId, title: '新会话', createdAt: now }]);
    setActiveId(id);
  };

  /** 删除当前会话（删光后自动补一个空会话） */
  const deleteSession = async () => {
    if (activeId == null) return;
    await deleteServerSession(activeId, await readChatHistory(activeId));
    const rest = sessions.filter((s) => s.id !== activeId);
    if (rest.length === 0) {
      const now = Date.now();
      const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
      setSessions([{ id, videoId, title: '新会话', createdAt: now }]);
      setActiveId(id);
    } else {
      setSessions(rest);
      setActiveId(rest[rest.length - 1].id!);
    }
    toast.success(chatText('chatPanel.sessionDeleted'));
  };

  /** 从某条消息处分叉出新会话（复制到这条为止，原会话不动）。 */
  const forkMessage = async (message: ChatMsg) => {
    if (loading || activeId == null || message.rowId == null) return;
    const source = await readConversationSession(activeId);
    if (!source) return;
    const rows = await readChatHistory(activeId);
    const cut = rows.findIndex((row) => row.id === message.rowId);
    if (cut < 0) return;
    const kept = rows.slice(0, cut + 1);
    if (kept.length === 0) return;
    const now = Date.now();
    const newId = await forkServerSession(source, kept);
    setSessions((prev) => [...prev.filter(session => session.id !== newId), {
      id: newId,
      videoId,
      title: `${source.title} · 分支`,
      createdAt: now,
      ...(source.skillIds !== undefined ? { skillIds: [...source.skillIds] } : {}),
      ...(source.mcpServerIds !== undefined ? { mcpServerIds: [...source.mcpServerIds] } : {}),
    }]);
    setActiveId(newId);
    toast.success(chatText('chatPanel.forkedToast'));
  };

  const updateMcpServerIds = async (next: string[] | undefined) => {
    if (activeId == null) return;
    await reviseConversationSession(activeId, row => {
      if (next === undefined) delete row.mcpServerIds;
      else row.mcpServerIds = next;
    });
    // 只需把这一条会话修订推上去：会话字段是学习命令 journal 的一部分，
    // 精确排空该实体即可，不再为此拉起全账号 records 周期。
    await (await import('../../client/learning')).drainLearning([`session:${activeId}`]);
    if (historySession.current === activeId) setMcpServerIds(next);
  };

  /**
   * 改当前会话的技能范围。
   *
   * UI 先落地、库写异步补上：勾选框是「点一下就该有反馈」的控件，等 IndexedDB 回来再重渲染
   * 会有一帧迟滞。写失败也只是下次切回来时回到旧范围，不会留下坏状态。
   */
  const updateSkillIds = (next: number[] | undefined) => {
    if (activeId == null) return;
    setSkillIds(next);
    void reviseConversationSession(activeId, (row) => {
        // 「不限定」= 字段不存在，而不是「字段值为 undefined」—— 后者经过结构化克隆后
        // 到底留下 undefined 还是 null 依赖实现，删掉字段最干净、读回来必然 undefined。
        if (next === undefined) delete row.skillIds;
        else row.skillIds = next;
      });
  };

  return { createSession, deleteSession, forkMessage, updateMcpServerIds, updateSkillIds };
}
