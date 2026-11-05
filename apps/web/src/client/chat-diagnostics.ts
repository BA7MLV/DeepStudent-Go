/** Opt-in development instrumentation for reproducible render regressions.
 * Call sites are DEV-gated and erased from production builds. */
let observer: ((kind: string, key?: string) => void) | undefined;
export function observeChatRenders(next: (kind: string, key?: string) => void) {
  observer = next;
  return () => { if (observer === next) observer = undefined; };
}
export function recordChatRender(kind: string, key?: string) { observer?.(kind, key); }
