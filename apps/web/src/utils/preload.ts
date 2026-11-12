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
 * normally if there was no hover (touch, keyboard shortcuts or direct links).
 *
 * 停留阈值（X 同款）：指针只是扫过链接（滚动时指针静止、列表从指针下方滚过）
 * 不算意图，停留 100ms 才预取；键盘 focus 是明确意图，立即预取。 */
export function preloadOnIntent(routes: Record<string, () => Promise<unknown>>): () => void {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  if (connection?.saveData) return () => {};
  const pending = new Set<string>();
  const routeFor = (target: EventTarget | null) => {
    const link = target instanceof Element ? target.closest('a[href]') : null;
    if (!(link instanceof HTMLAnchorElement) || link.origin !== location.origin) return null;
    const pathname = link.hash.slice(1).split('?')[0];
    const route = Object.keys(routes).find(route => pathname === route || pathname.startsWith(`${route}/`));
    return route && !pending.has(route) ? { route, link } : null;
  };
  const prefetch = (route: string) => {
    if (pending.has(route)) return;
    pending.add(route);
    void routes[route]().catch(() => { pending.delete(route); });
  };
  let dwell = 0;
  let dwellLink: HTMLAnchorElement | null = null;
  const cancelDwell = () => {
    globalThis.clearTimeout(dwell);
    dwellLink = null;
  };
  const over = (event: PointerEvent) => {
    const target = routeFor(event.target);
    cancelDwell();
    if (!target) return;
    dwellLink = target.link;
    dwell = globalThis.setTimeout(() => { if (dwellLink === target.link) prefetch(target.route); }, 100) as unknown as number;
  };
  const out = (event: PointerEvent) => {
    if (dwellLink && !(event.relatedTarget instanceof Node && dwellLink.contains(event.relatedTarget))) cancelDwell();
  };
  const focus = (event: FocusEvent) => {
    const target = routeFor(event.target);
    if (target) prefetch(target.route);
  };
  document.addEventListener('pointerover', over, { passive: true });
  document.addEventListener('pointerout', out, { passive: true });
  document.addEventListener('focusin', focus);
  return () => {
    cancelDwell();
    document.removeEventListener('pointerover', over);
    document.removeEventListener('pointerout', out);
    document.removeEventListener('focusin', focus);
  };
}
