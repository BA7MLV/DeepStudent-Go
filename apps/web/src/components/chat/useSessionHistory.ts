import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { readChatPage } from '../../store/chatHistory';
import { popconfirm, toast } from '../../ui';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 历史翻页：滚到顶（或点「加载更早」）时向已有会话取上一页。
 *
 * 为什么单独成文件：翻页状态（`hasOlder` / `loadingOlder` / `historyError`）由
 * `ChatSessionEffects`（跟随服务端分页）与滚动 hook（触顶加载）两边写，
 * 这里的加载函数只负责「取一页 + 把结果交给 journal」以及失败标记，
 * 与发送状态机没有交集。
 */
export function useOlderMessages({ activeId, msgs, hasOlder, historyRequest, historySession, setLoadingOlder, setHistoryError }: {
  activeId: number | null;
  msgs: ChatMsg[];
  hasOlder: boolean;
  /** 分页闸：触底与按钮共用，避免两路同时取同一页 */
  historyRequest: React.RefObject<boolean>;
  /** 当前会话 id 的镜像：异步回来后先确认用户没切走 */
  historySession: React.RefObject<number | null>;
  setLoadingOlder: (value: boolean) => void;
  setHistoryError: (value: boolean) => void;
}) {
  return useCallback(async () => {
    const first = msgs[0];
    if (activeId == null || !hasOlder || historyRequest.current || first?.rowId == null) return;
    historyRequest.current = true;
    setLoadingOlder(true);
    setHistoryError(false);
    try {
      if (first.createdAt == null) throw new Error('invalid_session_cursor');
      await readChatPage(activeId, { id: first.rowId, createdAt: first.createdAt, role: first.role === 'user' ? 'user' : 'assistant' });
      // Only the journal's accepted page merge may publish pagination metadata.
    } catch {
      if (historySession.current === activeId) setHistoryError(true);
    } finally {
      if (historySession.current === activeId) {
        historyRequest.current = false;
        setLoadingOlder(false);
      }
    }
  }, [activeId, hasOlder, historyRequest, historySession, msgs, setHistoryError, setLoadingOlder]);
}

/** 删除会话前的确认（危险操作：确认按钮上错误色，文案写清动作） */
export function useSessionDeleteConfirm(deleteSession: () => Promise<void>) {
  const { t: chatText } = useTranslation('common');
  return async () => {
    const ok = await popconfirm({
      headline: chatText('chatPanel.deleteSessionTitle'),
      description: chatText('chatPanel.deleteSessionDesc'),
      confirmText: chatText('chatPanel.delete'),
      danger: true,
      testId: 'session-delete-popconfirm',
    });
    if (ok) void deleteSession();
  };
}

/** 停止生成：断掉当前的 LLM 请求与 agent 循环（已流出的内容保留） */
export function useStopGenerating(inflightAbort: React.RefObject<AbortController | null>, activeId: number | null) {
  return () => {
    inflightAbort.current?.abort();
    if (activeId != null) void import('../../cloud/tasks').then(tasks => tasks.cancelResourceTasks(`session:${activeId}`)).catch(error => toast.error((error as Error).message));
  };
}
