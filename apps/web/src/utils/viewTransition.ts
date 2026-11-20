import { flushSync } from 'react-dom';

type ViewTransition = { finished: Promise<void> };
type VTDocument = Document & { startViewTransition?: (update: () => void) => ViewTransition };

/** 与全站 CSS 的 `@media (prefers-reduced-motion: reduce) { transition: none }` 同一口径：直接换状态。 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function viewTransitionSupported(): boolean {
  return typeof (document as VTDocument).startViewTransition === 'function' && !prefersReducedMotion();
}

/**
 * 把一次状态切换包进 same-document View Transition：共享元素（view-transition-name）
 * 在两帧之间做 transform 动画，其余内容短交叉淡化。不支持或用户偏好减少动态时退化为原样切换。
 */
export function withViewTransition(update: () => void): void {
  const doc = document as VTDocument;
  if (typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  doc.startViewTransition(() => {
    flushSync(update);
  });
}

/** 路由页是懒加载的：跳转前先热好 chunk，避免共享元素动画落在一帧加载骨架上。 */
export function preloadChunk(load: () => Promise<unknown>): void {
  void load().catch(() => {});
}

/**
 * 只有导航这一刻才把「工作区」（含路由 Outlet 的常驻区块）挂名：页内的小型 VT
 * （筛选、排序）仍整体交给 root 的短交叉淡化，不被工作区的慢节奏拖累；
 * 导航时则由工作区独享这一帧，侧栏像素原地不动。名字在转场结束后摘回。
 */
export function withRegionViewTransition(region: HTMLElement | null, name: string, update: () => void): void {
  const doc = document as VTDocument;
  if (!region || typeof doc.startViewTransition !== 'function' || prefersReducedMotion()) {
    update();
    return;
  }
  region.style.viewTransitionName = name;
  const transition = doc.startViewTransition(() => {
    flushSync(update);
  });
  transition.finished.finally(() => {
    region.style.viewTransitionName = '';
  }).catch(() => {});
}
