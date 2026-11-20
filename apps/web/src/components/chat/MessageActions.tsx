import { Button, Dropdown, Tooltip } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../../ui';
import { CopyButton } from '../../ui/copy-button';
import { copyWithFeedback } from '../../utils/copyFeedback';
import { markdownToPlainText } from '../../utils/chatExport';

/**
 * 一条消息下面的操作行。
 *
 * 与主页「AI 助手」页的 `MessageActions` 保持同一套交互：复制 / 重试 / 分支 / 更多，
 * 悬浮或键盘焦点进入才显形，触屏常显；用户消息的动作行挂在气泡**外面**，
 * 避免悬停时气泡底色多长出一条图标行。见 pages/CourseChat.tsx 的同名组件。
 */
export function MessageActions({
  content,
  isUser,
  busy,
  canRetry,
  retryHint,
  onRetry,
  onFork,
  onExport,
  onDelete,
}: {
  content: string;
  isUser: boolean;
  busy: boolean;
  canRetry: boolean;
  retryHint: string;
  onRetry: () => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { t: chatText } = useTranslation('common');
  const action = (
    label: string,
    icon: React.ReactNode,
    onPress: () => void,
    testId: string,
    disabled = false,
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="chat-action"
          aria-label={label}
          isDisabled={disabled}
          data-testid={testId}
          onPress={onPress}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  const copyLabel = isUser ? chatText('chatPanel.copyQuestion') : chatText('chatPanel.copyAnswer');

  return (
    <div className="chat-message-actions" data-testid="chat-message-actions">
      <CopyButton text={content} label={copyLabel} isIconOnly variant="tertiary" size="sm"
        className="chat-action" data-testid="chat-copy-message" />

      {action(retryHint, <Sym name="refresh" />, onRetry, 'chat-retry-message', busy || !canRetry)}

      {action(chatText('chatPanel.fork'), <Sym name="fork" />, onFork, 'chat-fork-message', busy)}
      {action('删除这条消息', <Sym name="delete" />, onDelete, 'chat-delete-message', busy)}

      {!isUser && (
        <Dropdown>
          {/* Dropdown.Trigger 自己渲染 <button>，不能在里面再套 HeroUI Button */}
          <Dropdown.Trigger
            className="chat-action"
            aria-label={chatText('chatPanel.more')}
            data-testid="chat-message-more"
          >
            <Sym name="more_horiz" />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === 'copy-plain') void copyWithFeedback(markdownToPlainText(content), chatText('chatPanel.copiedPlain'));
                else if (key === 'export') onExport();
              }}
            >
              <Dropdown.Item id="copy-plain" textValue={chatText('chatPanel.copyPlain')} data-testid="chat-copy-plain">
                <span className="chat-menu-item">复制纯文本</span>
              </Dropdown.Item>
              <Dropdown.Item id="export" textValue={chatText('chatPanel.exportSession')} data-testid="chat-export-session">
                <span className="chat-menu-item">导出本次会话</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}
