import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown } from '@heroui/react';
import { Sym } from '../../ui';
import { messageTime } from '../../utils/messageTime';
import { useMediaQuery } from '../../utils/useMobile';
import { copyWithFeedback } from '../../utils/copyFeedback';
import SkillMessageContent from '../SkillMessageContent';
import { UserContent } from './UserContent';
import type { ChatMsg } from './chatPanelTypes';

/** 长消息默认展示六行；触屏长按可查看时间、复制完整提问与操作。 */
export function UserMessageBubble({ message, busy, canRetry, onRetry, onFork, onDelete }: {
  message: ChatMsg;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const { t: chatText } = useTranslation('common');
  const touchMenu = useMediaQuery('(hover: none), (pointer: coarse), (max-width: 640px)');
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => setOverflows(text.scrollHeight > parseFloat(getComputedStyle(text).lineHeight) * 6 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [message.content, touchMenu]);
  const content = (
    <span ref={textRef} id={`chat-user-text-${message.key}`} className="chat-user-text"
      data-collapsed={overflows && !expanded}>
      <SkillMessageContent content={message.content || chatText('chatPanel.imageMessage')} ids={message.explicitSkillIds} renderText={text => <UserContent content={text} />} />
    </span>
  );
  return (
    <div className="chat-user-content">
      <div className="chat-bubble chat-bubble--user">
        {!touchMenu ? content : (
          <Dropdown trigger="longPress">
            <Dropdown.Trigger className="chat-user-trigger"
              aria-label={chatText('chatPanel.userMessageAria')} data-testid="chat-user-message-trigger">
              {content}
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="chat-message-menu">
              {message.createdAt != null && (
                <time className="chat-message-time" dateTime={new Date(message.createdAt).toISOString()}
                  data-testid="chat-message-time">
                  {messageTime(message.createdAt)}
                </time>
              )}
              <Dropdown.Menu
                aria-label={chatText('chatPanel.askActions')}
                disabledKeys={busy || message.rowId == null ? ['retry', 'fork', 'delete'] : canRetry ? [] : ['retry']}
                onAction={(key) => {
                  if (key === 'retry') onRetry();
                  else if (key === 'fork') onFork();
                  else if (key === 'delete') onDelete();
                  else if (key === 'copy') void copyWithFeedback(message.content, chatText('chatPanel.copiedQuestion'));
                }}
              >
                <Dropdown.Item id="copy" textValue="复制" data-testid="chat-user-copy">
                  <Sym name="content_copy" />复制
                </Dropdown.Item>
                <Dropdown.Item id="retry" textValue={chatText('chatPanel.retry')} data-testid="chat-user-retry">
                  <Sym name="refresh" />重试
                </Dropdown.Item>
                <Dropdown.Item id="fork" textValue="分支出新会话" data-testid="chat-user-fork">
                  <Sym name="fork" />分支出新会话
                </Dropdown.Item>
                <Dropdown.Item id="delete" textValue={chatText('chatPanel.deleteMessage')} data-testid="chat-user-delete">
                  <Sym name="delete" />删除这条消息
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
        {overflows && (
          <Button size="sm" variant="tertiary" className="chat-user-expand"
            aria-expanded={expanded} aria-controls={`chat-user-text-${message.key}`}
            data-testid="chat-user-expand" onPress={() => setExpanded((value) => !value)}>
            {expanded ? chatText('chatPanel.collapse') : chatText('chatPanel.expand')}<Sym name="keyboard_arrow_down" />
          </Button>
        )}
      </div>
    </div>
  );
}
