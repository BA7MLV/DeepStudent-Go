import type { SseEvent } from '@wangke/contracts';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { ServerApiError } from '../api/serverClient';

/** Platform carrier seam for the existing Bot watermark/nonce/window algorithm.
 * Replay starts at the last applied cursor; cancelling observes, never cancels a run.
 * No SSE or HTTP-poll fallback when the shared connection is unavailable. */
export async function followBot(threadId: string, after: number, receive: (event: SseEvent, cursor: number) => void, signal: AbortSignal, opened: () => void) {
  signal.throwIfAborted();
  const runtime = await serverRuntime(cloud.userId);
  signal.throwIfAborted();
  if (!isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  const control = new AbortController();
  const abort = () => control.abort(signal.reason ?? runtime.signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  runtime.signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted || runtime.signal.aborted) abort();
  let cursor = after;
  try {
    for await (const frame of runtime.botJournal(threadId, after, control.signal)) {
      if (control.signal.aborted || !isCurrentServerRuntime(runtime)) break;
      if (frame.type === 'ready') { opened(); continue; }
      if (frame.event.type === 'resync.required') throw new Error('sync_resync_required');
      if (frame.cursor <= cursor) continue;
      // Cursor only advances after the existing domain consumer applies a frame.
      receive(frame.event, frame.cursor);
      cursor = frame.cursor;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'client/unauthenticated') throw new ServerApiError(401, 'bot_unauthenticated');
    if (code === 'client/forbidden') throw new ServerApiError(403, 'bot_forbidden');
    throw error;
  } finally {
    control.abort();
    signal.removeEventListener('abort', abort);
    runtime.signal.removeEventListener('abort', abort);
  }
}
