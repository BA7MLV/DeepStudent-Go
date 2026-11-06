import type { ModelRequestPolicy } from './model-policy.js';

export type StreamDeadlinePolicy = Pick<ModelRequestPolicy, 'firstTokenMs' | 'idleMs' | 'streamTotalMs'>;

export interface StreamDeadline {
  /** Aborts with TimeoutError when the first token, idle gap or total turn limit expires. */
  readonly signal: AbortSignal;
  /** Call for every response-body chunk; resets the idle deadline. */
  chunk(): void;
  /** A non-SSE body may take as long as the total turn limit; it has no token gaps. */
  nonStream(): void;
  /** Clear every timer and the outer listener once the response body is done. */
  close(): void;
}

/** A streaming request has three independent limits:
 * - first token: queue + prefill;
 * - idle: time between chunks, reset by every received chunk;
 * - total: an absolute safety cap for the whole turn.
 * None of them is a retry budget; the outer chain signal remains the owner of
 * the total request/fallback deadline. */
export function createStreamDeadline(outer: AbortSignal, policy: StreamDeadlinePolicy): StreamDeadline {
  const controller = new AbortController();
  const abort = (reason: unknown) => { if (!controller.signal.aborted) controller.abort(reason); };
  const onOuter = () => abort(outer.reason);
  // Register first, then inspect: an abort between the two must not be lost.
  outer.addEventListener('abort', onOuter, { once: true });
  if (outer.aborted) onOuter();

  function arm(ms: number, name: string) {
    const timer = setTimeout(() => abort(new DOMException(name, 'TimeoutError')), ms);
    timer.unref?.();
    return timer;
  }
  function clear(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) clearTimeout(timer);
  }

  let firstTimer: ReturnType<typeof setTimeout> | undefined = arm(policy.firstTokenMs, 'first_token_timeout');
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const totalTimer = arm(policy.streamTotalMs, 'stream_total_timeout');
  let sawChunk = false;

  function armIdle() {
    clear(idleTimer);
    idleTimer = arm(policy.idleMs, 'stream_idle_timeout');
  }

  return {
    signal: controller.signal,
    chunk() {
      if (!sawChunk) {
        sawChunk = true;
        clear(firstTimer);
        firstTimer = undefined;
      }
      armIdle();
    },
    nonStream() {
      clear(firstTimer);
      firstTimer = undefined;
      clear(idleTimer);
      idleTimer = undefined;
    },
    close() {
      clear(firstTimer);
      clear(idleTimer);
      clear(totalTimer);
      outer.removeEventListener('abort', onOuter);
    },
  };
}
