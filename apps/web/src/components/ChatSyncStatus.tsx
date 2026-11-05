import { useState } from 'react';
import { useCourseChat, retryChatSync } from '../store/courseChat';
import { useCloudSync } from '../cloud/sync';
import { useSustained } from '../cloud/quiet';

/**
 * Normal sync is silent. A slow/failed sync is recoverable without hiding content.
 * Rendered as an overlay above the composer: it must not change the composer's
 * measured height (`--chat-composer-height`), or the message list would jump.
 */
export default function ChatSyncStatus() {
  const id = useCourseChat(state => state.activeId);
  const pending = useCourseChat(state => state.messages.some(message => message.syncPending && !message.streaming && message.role === 'ai' && !message.interrupted));
  const historyError = useCourseChat(state => state.historyError);
  const syncError = useCloudSync(state => state.error);
  const degraded = useCloudSync(state => state.degradedSince > 0);
  // Confirmation normally lands within a second or two; only a real stall shows.
  const slow = useSustained(pending, 8000);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState('');
  const error = historyError || syncError || retryError || (slow && degraded);
  if (id == null || !pending || !slow && !error) return null;
  return <div className="course-chat__sync-status" role="status" data-testid="chat-sync-status">
    <span>{error ? '同步暂未完成，当前回答已保留' : '回答已完成，正在同步到本机…'}</span>
    {error && <button type="button" disabled={retrying} onClick={async () => {
      setRetrying(true);
      setRetryError('');
      try { await retryChatSync(id); }
      catch (error) { setRetryError(error instanceof Error ? error.message : String(error)); }
      finally { setRetrying(false); }
    }}>{retrying ? '重试中…' : '重试同步'}</button>}
  </div>;
}
