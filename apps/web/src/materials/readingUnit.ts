/** 阅读位置以实际视口为准，不依赖 IntersectionObserver 的增量通知。
 * rootMargin 的百分比按宽度计算，横向面板里原来的 -88% 会把判定带压成空区。 */
export function toReadingUnit(unit: number | undefined): number {
  return typeof unit === 'number' && Number.isFinite(unit) && unit > 1 ? Math.floor(unit) : 1;
}

type UnitElements = Iterable<readonly [number, Element]>;

export function readCurrentUnit(root: HTMLElement, elements: UnitElements): number | null {
  const viewportTop = root === root.ownerDocument.scrollingElement ? 0 : root.getBoundingClientRect().top + root.clientTop;
  const line = viewportTop + 12;
  let current: number | null = null;
  let currentTop = -Infinity;
  let next: number | null = null;
  let nextTop = Infinity;
  let last: number | null = null;
  let lastBottom = -Infinity;
  for (const [unit, el] of elements) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0 || el.getClientRects().length === 0) continue;
    if (rect.bottom > lastBottom) { last = unit; lastBottom = rect.bottom; }
    if (rect.top <= line && rect.bottom > line && rect.top >= currentTop) {
      current = unit;
      currentTop = rect.top;
    } else if (rect.top > line && rect.top < nextTop) {
      next = unit;
      nextTop = rect.top;
    }
  }
  // 最后一屏可能容纳多段：已滚到底就报最后一段；短文档没有滚动，不自动变成「已读完」。
  if (root.scrollTop > 0 && root.scrollHeight - root.clientHeight - root.scrollTop <= 1) return last;
  return current ?? next ?? last;
}

/** 不在挂载时改写位置：断点续读 / 切视图 / 短文档跳转都先保留显式目标。
 * 只在真实纵向滚动后计算，一帧最多一次；之后的缩放、图片展开也会重新判定。 */
export function trackReadingUnit(root: HTMLElement, elements: () => UnitElements, update: (unit: number) => void): () => void {
  let frame = 0;
  let top = root.scrollTop;
  let moved = false;
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const unit = readCurrentUnit(root, elements());
      if (unit !== null) update(unit);
    });
  };
  const onScroll = () => {
    if (root.scrollTop === top) return;
    top = root.scrollTop;
    moved = true;
    schedule();
  };
  root.addEventListener('scroll', onScroll, { passive: true });
  const resize = new ResizeObserver(() => { if (moved) schedule(); });
  resize.observe(root);
  const parents = new Set<Element>();
  for (const [, el] of elements()) if (el.parentElement) parents.add(el.parentElement);
  for (const parent of parents) resize.observe(parent);
  return () => {
    root.removeEventListener('scroll', onScroll);
    resize.disconnect();
    if (frame) cancelAnimationFrame(frame);
  };
}
