import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../../ui';

/**
 * 缺少可检索正文时的提示条。
 *
 * 不阻止发送（材料课程可以看图、框选提问），只在失败时多给一枚重试键；
 * 重试只是把面板的 `indexAttempt` 加一，由负责探测的 effect 重跑一遍。
 */
export function ChatIndexNote({ note, failed, onRetry }: { note: string; failed: boolean; onRetry: () => void }) {
  const { t: chatText } = useTranslation('common');
  return (
    <div className="chat-note" data-testid="chat-index-note">
      <Sym name="warning" className="chat-note__icon" />
      <span>{note}</span>
      {failed && <Button size="sm" variant="tertiary" data-testid="chat-index-retry" onPress={onRetry}>{chatText('chatPanel.retry')}</Button>}
    </div>
  );
}
