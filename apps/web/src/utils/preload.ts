/**
 * 空闲时依次预取若干动态 import。
 *
 * 用 requestIdleCallback（Safari 没有，就退回 setTimeout），一次只取一个，
 * 免得和首屏还在进行的请求抢带宽。省流量模式（Save-Data）下不预取。
 * 返回的函数用于在组件卸载时取消尚未开始的预取。
 */
export function preloadOnIdle(loaders: Array<() => Promise<unknown>>): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  let cancelled = false;
  let handle = 0;
  const idle = (fn: () => void) => {
    if (typeof window.requestIdleCallback === 'function') handle = window.requestIdleCallback(fn, { timeout: 4000 });
    else handle = globalThis.setTimeout(fn, 1500) as unknown as number;
  };
  const queue = [...loaders];
  const next = () => {
    if (cancelled) return;
    const load = queue.shift();
    if (!load) return;
    void load().catch(() => {}).finally(() => idle(next));
  };
  idle(next);
  return () => {
    cancelled = true;
    if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(handle);
    globalThis.clearTimeout(handle);
  };
}

/** Prefetch only the destination a user points at or focuses, rather than every
 * heavy reader/decoder on an unrelated screen. Navigation itself still loads
 * normally if there was no hover (touch, keyboard shortcuts or direct links). */
export function preloadOnIntent(routes: Record<string, () => Promise<unknown>>): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  const pending = new Set<string>();
  const intent = (event: Event) => {
    const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return;
    const pathname = link.hash.slice(1).split('?')[0];
    const route = Object.keys(routes).find(route => pathname === route || pathname.startsWith(`${route}/`));
    if (!route || pending.has(route)) return;
    pending.add(route);
    void routes[route]().catch(() => { pending.delete(route); });
  };
  document.addEventListener('pointerover', intent, { passive: true });
  document.addEventListener('focusin', intent);
  return () => {
    document.removeEventListener('pointerover', intent);
    document.removeEventListener('focusin', intent);
  };
}
