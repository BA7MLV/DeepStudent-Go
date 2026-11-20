import { Button, ListBox, Select, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { useRecentSessionIndex } from '../useRecentSessionIndex';
import type { ChatSessionRow } from '../../store/db';
import { PanelBar, Sym } from '../../ui';
import { CopyButton } from '../../ui/copy-button';
/** 会话索引 hook 的返回值（下拉底部的云端分页就是它驱动的） */
type SessionIndex = ReturnType<typeof useRecentSessionIndex>;

/**
 * 会话工具条：会话下拉（含云端分页）+ 新开 / 复制 / 导出 / 删除。
 *
 * 只收值与该面板的动作回调：`isDisabled` 一律看 `loading`，与原先内联时同一判据，
 * 剪贴板按钮的 `key={activeId}` 也保留 —— 换会话要重新挂一份，否则复制的是上一段文本。
 */
export function ChatToolbar({
  sessions,
  activeId,
  activeTitle,
  loading,
  msgsLength,
  selectSession,
  onNewSession,
  onDeleteSession,
  sessionMarkdown,
  onDownload,
  sessionIndex,
  cloudEnabled,
}: {
  sessions: ChatSessionRow[];
  activeId: number | null;
  activeTitle: string;
  loading: boolean;
  msgsLength: number;
  selectSession: (key: React.Key | null) => void;
  onNewSession: () => void;
  onDeleteSession: () => void;
  sessionMarkdown: () => Promise<string>;
  onDownload: () => void;
  sessionIndex: SessionIndex;
  cloudEnabled: boolean;
}) {
  const { t: chatText } = useTranslation('common');
  const { t: navigationText } = useTranslation('interface');

  /** 顶部一排小图标按钮（新开 / 复制 / 导出 / 删除 / 思考开关） */
  const iconBtn = (
    testId: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled?: boolean,
    variant?: 'primary' | 'tertiary',
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant={variant ?? 'tertiary'}
          size="sm"
          data-testid={testId}
          aria-label={label}
          isDisabled={disabled}
          onPress={onClick}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  return (
      <PanelBar wrap={false} testId="chat-toolbar">
        <Select
          className="chat-session-select"
          selectedKey={activeId != null ? String(activeId) : null}
          onSelectionChange={selectSession}
          isDisabled={loading}
          data-testid="chat-session"
          aria-label={chatText('chatPanel.switchSession')}
        >
          <Select.Trigger>
            <Select.Value className="chat-session-title" title={activeTitle} />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {sessions.map((s) => (
                <ListBox.Item key={s.id} id={String(s.id)} textValue={s.title}>
                  {s.title}
                </ListBox.Item>
              ))}
            </ListBox>
            {cloudEnabled && <div className="flex flex-wrap gap-1 p-1">
              {sessionIndex.page?.previous && <Button size="sm" variant="tertiary" isDisabled={sessionIndex.loading} onPress={sessionIndex.previous} data-testid="qa-sessions-previous">{navigationText('recent.previousPage')}</Button>}
              {sessionIndex.page?.next && <Button size="sm" variant="tertiary" isDisabled={sessionIndex.loading} onPress={sessionIndex.next} data-testid="qa-sessions-next">{navigationText('recent.nextPage')}</Button>}
              {sessionIndex.error && <><span role="status">{navigationText('recent.loadFailed')}</span><Button size="sm" variant="tertiary" onPress={sessionIndex.retry}>{navigationText('recent.retry')}</Button></>}
            </div>}
          </Select.Popover>
        </Select>
        {iconBtn('chat-new-session', chatText('chatPanel.newChat'), <Sym name="add" />, onNewSession, loading)}
        <CopyButton key={activeId} text={sessionMarkdown} label="复制整个会话（Markdown）" isIconOnly
          variant="tertiary" size="sm" data-testid="copy-session-btn" isDisabled={loading || msgsLength === 0} />
        {iconBtn('export-session-btn', chatText('chatPanel.exportMd'), <Sym name="download" />, onDownload, loading || msgsLength === 0)}
        {iconBtn('chat-delete-session', chatText('chatPanel.deleteSession'), <Sym name="delete" />, onDeleteSession, loading)}
      </PanelBar>
  );
}
