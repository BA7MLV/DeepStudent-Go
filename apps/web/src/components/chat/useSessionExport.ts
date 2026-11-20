import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { readChatHistory } from '../../store/chatHistory';
import { buildSessionMarkdown, exportFileName } from '../../utils/chatExport';
import { toast } from '../../ui';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 会话导出的两条入口：工具条的「导出 .md」与每条回答的「更多 → 导出本次会话」。
 *
 * 两处必须得到同一份文本，所以正文拼装只留在这里的一份函数里：
 * 库里已落库的行 + 还在内存里（尚未落库）的消息，按同一条 markdown 规则输出。
 * 文案走调用方同一个 i18n 命名空间，避免同一个词在两处翻译成两种说法。
 */
export function useSessionExport({ activeId, msgs, activeTitle, videoName }: {
  activeId: number | null;
  msgs: ChatMsg[];
  activeTitle: string;
  videoName: string;
}) {
  const { t } = useTranslation('common');

  /** 当前会话 → Markdown 全文（复制与导出共用） */
  const sessionMarkdown = useCallback(async () => {
    const rows = activeId == null ? [] : await readChatHistory(activeId);
    const ids = new Set(rows.map((row) => row.id));
    const all = [...rows.map((row) => ({ ...row, role: row.role === 'user' ? 'user' : 'ai' })), ...msgs.filter((m) => !ids.has(m.rowId))];
    return buildSessionMarkdown({
      title: activeTitle,
      videoName,
      messages: all.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
        reasoning: m.reasoning,
        quiz: m.quiz,
      })),
    });
  }, [activeId, activeTitle, msgs, videoName]);

  /** 导出整个会话为 .md 文件（归档/跨设备带走） */
  const downloadSession = useCallback(async () => {
    if (msgs.length === 0) return void toast.info(t('chatPanel.sessionEmpty'));
    const url = URL.createObjectURL(new Blob([await sessionMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(videoName, activeTitle);
    a.click();
    URL.revokeObjectURL(url);
    toast.success(t('chatPanel.exportedMarkdown'));
  }, [activeTitle, msgs.length, sessionMarkdown, t, videoName]);

  return { sessionMarkdown, downloadSession };
}
