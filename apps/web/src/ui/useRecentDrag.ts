import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';

type SaveResult = void | boolean;
type Item = { id: string; pinned?: boolean; onUnpin?: () => void | Promise<boolean> };
type Target = { kind: 'zone' } | { kind: 'list'; index: number } | null;
type Row = { id: string; top: number; height: number };
type Drag = {
  item: Item;
  source: DOMRect;
  keyboard: boolean;
  rows: Row[];
  pinned: Row[];
  step: number;
  ownIndex: number;
};

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const spring = { duration: 250, easing: 'linear(0, .25 12%, .74 32%, .97 53%, 1.025 71%, 1)' };
const rowsIn = (element: HTMLElement | null) => [...(element?.querySelectorAll<HTMLElement>('[data-recent-id]') ?? [])];
const contains = (rect: DOMRect, x: number, y: number) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);

/** 侧栏原有的长按置顶手势；候选位置读静止的几何，避免涟漪把命中线来回推。 */
export function useRecentDrag<T extends Item>(items: T[], reorder?: (ids: string[]) => void | Promise<boolean>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const areaRef = useRef<HTMLDivElement>(null);
  const zoneRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [target, setTarget] = useState<Target>(null);
  const [glide, setGlide] = useState(false);
  const [pending, setPending] = useState<string[] | null>(null);
  const current = useRef<Drag | null>(null);
  const landing = useRef<Target>(null);
  const stopPress = useRef<(() => void) | null>(null);
  const suppressUntil = useRef(0);
  const point = useRef({ x: 0, y: 0 });
  const focusAfter = useRef<string | null>(null);
  const first = useRef<Map<string, DOMRect> | null>(null);
  const flying = useRef<{ id: string; node: HTMLElement; rect: DOMRect } | null>(null);
  const springs = useRef<Animation[]>([]);
  const saving = useRef(false);
  const publication = useRef<{ ids: string[]; timer: number; finish: (rollback: boolean) => void } | null>(null);
  const latest = useRef({ items, reorder });
  useLayoutEffect(() => {
    latest.current = { items, reorder };
    const waiting = publication.current;
    if (waiting && sameOrder(items.filter((item) => item.pinned).map((item) => item.id), waiting.ids)) waiting.finish(false);
  });

  const pinnedIds = pending ?? items.filter((item) => item.pinned).map((item) => item.id);
  const byId = new Map(items.map((item) => [item.id, item]));
  const pinnedItems = pinnedIds.flatMap((id) => {
    const item = byId.get(id);
    return item ? [{ ...item, pinned: true }] : [];
  });
  const pinnedSet = new Set(pinnedIds);
  const unpinnedItems = items.filter((item) => !pinnedSet.has(item.id)).map((item) => item.pinned ? { ...item, pinned: false } : item);

  function updateTarget(next: Target) {
    const previous = landing.current;
    if (previous?.kind === next?.kind && (next?.kind !== 'list' || (previous?.kind === 'list' && previous.index === next.index))) return;
    setGlide(previous?.kind === 'list' && previous.index !== current.current?.ownIndex);
    landing.current = next;
    setTarget(next);
  }

  function capture(includePreview: boolean) {
    if (reduced()) return;
    const rects = new Map(rowsIn(rootRef.current).map((row) => [row.dataset.recentId!, row.getBoundingClientRect()]));
    const ghost = includePreview ? previewRef.current?.firstElementChild : null;
    if (ghost instanceof HTMLElement && current.current) {
      flying.current = { id: current.current.item.id, node: ghost.cloneNode(true) as HTMLElement, rect: ghost.getBoundingClientRect() };
    }
    first.current = rects;
  }

  // FLIP：先读当前画面（包括动画中途），DOM 换序后只用 transform 接住它。
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (first.current) {
      const from = first.current;
      first.current = null;
      const flight = flying.current;
      flying.current = null;
      springs.current.forEach((animation) => animation.cancel());
      springs.current = reduced() ? [] : rowsIn(root).flatMap((row) => {
        const before = from.get(row.dataset.recentId!);
        if (!before) return [];
        const after = row.getBoundingClientRect();
        if (flight && flight.id === row.dataset.recentId && after.width && flight.rect.width) {
          return landPreview(flight.node, flight.rect, row, after);
        }
        const dx = before.left - after.left;
        const dy = before.top - after.top;
        const scale = before.width / after.width;
        if (!after.width || (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(scale - 1) < 0.01)) return [];
        return [row.animate([
          { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, transformOrigin: 'top left' },
          { transform: 'none', transformOrigin: 'top left' },
        ], spring)];
      });
    }
    if (focusAfter.current) {
      const row = rowsIn(root).find((row) => row.dataset.recentId === focusAfter.current);
      focusAfter.current = null;
      row?.focus({ preventScroll: true });
    }
  });

  useEffect(() => () => {
    stopPress.current?.();
    window.clearTimeout(publication.current?.timer);
    springs.current.forEach((animation) => animation.cancel());
  }, []);

  function lift(item: Item, element: HTMLElement, keyboard: boolean) {
    const area = areaRef.current?.getBoundingClientRect();
    if (!area || saving.current || current.current) return null;
    springs.current.forEach((animation) => animation.cancel());
    const source = element.getBoundingClientRect();
    const measure = (row: HTMLElement) => {
      const rect = row.getBoundingClientRect();
      return { id: row.dataset.recentId!, top: rect.top - area.top, height: rect.height };
    };
    const siblings = rowsIn(element.closest<HTMLElement>('[role="listbox"]')).map(measure);
    const index = siblings.findIndex((row) => row.id === item.id);
    const next = siblings[index + 1];
    const top = source.top - area.top;
    const previous = siblings[index - 1];
    const step = next ? next.top - top : previous ? top - previous.top : source.height;
    const active: Drag = { item, source, keyboard, rows: siblings, pinned: rowsIn(areaRef.current).map(measure), step, ownIndex: item.pinned ? index : -1 };
    current.current = active;
    setDrag(active);
    return active;
  }

  function finish(commit: boolean) {
    const active = current.current;
    if (!active) return;
    const destination = landing.current;
    const { items, reorder } = latest.current;
    const ids = items.filter((item) => item.pinned).map((item) => item.id);
    const id = active.item.id;
    const without = ids.filter((key) => key !== id);
    let save: (() => SaveResult | Promise<SaveResult>) | undefined;
    if (commit && items.some((item) => item.id === id)) {
      if (destination?.kind === 'zone' && active.item.pinned) {
        save = active.item.onUnpin;
      } else if (destination && reorder) {
        without.splice(destination.kind === 'list' ? destination.index : without.length, 0, id);
        if (without.some((key, index) => key !== ids[index])) save = () => reorder(without);
      }
    }
    capture(true);
    if (save && active.keyboard) focusAfter.current = id;
    if (!active.keyboard) suppressUntil.current = Date.now() + 350;
    current.current = null;
    setDrag(null);
    updateTarget(null);
    if (save) {
      saving.current = true;
      setPending(without);
      const done = (rollback: boolean) => {
        window.clearTimeout(publication.current?.timer);
        publication.current = null;
        if (rollback) capture(false);
        saving.current = false;
        setPending(null);
      };
      void Promise.resolve().then(save).then(result => {
        if (!rootRef.current) return;
        if (result === false) { done(true); return; }
        const published = latest.current.items.filter((item) => item.pinned).map((item) => item.id);
        if (sameOrder(published, without)) { done(false); return; }
        // 写入回执与侧栏订阅独立到达；在新索引发布前不要闪回旧顺序。
        publication.current = { ids: without, timer: window.setTimeout(() => done(true), 3000), finish: done };
      }, () => { if (rootRef.current) done(true); });
    }
  }

  function hit(x: number, y: number): Target {
    const active = current.current;
    const area = areaRef.current?.getBoundingClientRect();
    const viewport = rootRef.current?.parentElement?.getBoundingClientRect();
    if (!active || !area || !contains(area, x, y) || (viewport && !contains(viewport, x, y))) return null;
    const zone = zoneRef.current?.getBoundingClientRect();
    if (zone && contains(zone, x, y)) return { kind: 'zone' };
    const index = active.pinned.filter((row) => row.id !== active.item.id && y - area.top > row.top + row.height / 2).length;
    return { kind: 'list', index };
  }

  function movePreview() {
    const active = current.current;
    const preview = previewRef.current;
    if (!active || !preview) return;
    const { x, y } = point.current;
    const area = areaRef.current?.getBoundingClientRect();
    // 桌面向工作区抬起；抽屉只剩少量横向空间时改为斜上方，保留投放线的视野。
    const roomy = area && window.innerWidth - area.right > active.source.width * 0.9;
    const left = roomy ? Math.max(x + 14, area.right + 8) : Math.min(x + 30, window.innerWidth - 80);
    const top = roomy ? y - active.source.height / 2 : y - active.source.height - 12;
    preview.style.transform = `translate3d(${left}px,${top}px,0)`;
  }

  useLayoutEffect(() => {
    if (!drag) return;
    if (drag.keyboard) {
      const area = areaRef.current?.getBoundingClientRect();
      if (area && target?.kind === 'list') {
        const y = target.index === drag.ownIndex ? drag.source.top + drag.source.height / 2 : area.top + gapTop(drag, target.index);
        point.current = { x: drag.source.left + drag.source.width / 2, y };
      }
    }
    movePreview();
  });

  function beginPress(item: T, event: PointerEvent<HTMLElement>) {
    if (!reorder || saving.current || current.current || !event.isPrimary || event.button !== 0) return;
    stopPress.current?.();
    suppressUntil.current = 0;
    const element = event.currentTarget;
    const { pointerId, pointerType, clientX, clientY } = event;
    point.current = { x: clientX, y: clientY };
    const start = () => {
      if (!element.isConnected || !lift(item, element, false)) return;
      updateTarget(hit(point.current.x, point.current.y));
      if (pointerType !== 'mouse') window.addEventListener('touchmove', blockTouchScroll, { passive: false });
    };
    const timer = window.setTimeout(start, 350);
    const blockTouchScroll = (touch: TouchEvent) => { if (touch.cancelable) touch.preventDefault(); };
    const refresh = () => {
      if (!current.current) return;
      movePreview();
      updateTarget(hit(point.current.x, point.current.y));
    };
    const move = (move: globalThis.PointerEvent) => {
      if (move.pointerId !== pointerId) return;
      point.current = { x: move.clientX, y: move.clientY };
      if (!current.current && Math.hypot(move.clientX - clientX, move.clientY - clientY) > 8) {
        clearTimeout(timer);
        if (pointerType !== 'mouse') { cleanup(); return; }
        start();
      }
      refresh();
    };
    const cancel = () => { cleanup(); finish(false); };
    const up = (up: globalThis.PointerEvent) => {
      if (up.pointerId !== pointerId) return;
      if (current.current) updateTarget(hit(up.clientX, up.clientY));
      cleanup();
      finish(true);
    };
    const pointerCancel = (e: globalThis.PointerEvent) => { if (e.pointerId === pointerId) cancel(); };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || !current.current) return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    };
    const cleanup = () => {
      clearTimeout(timer);
      stopPress.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', pointerCancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('touchmove', blockTouchScroll);
      window.removeEventListener('scroll', refresh, true);
      window.removeEventListener('blur', cancel);
    };
    stopPress.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', pointerCancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('scroll', refresh, true);
    window.addEventListener('blur', cancel);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    const active = current.current;
    if (active?.keyboard) {
      if (event.key === 'Tab') { finish(false); return; }
      consume();
      if (event.key === 'Escape') finish(false);
      else if (event.key === 'Enter' || event.key === ' ') { if (!event.repeat) finish(true); }
      else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const index = landing.current?.kind === 'list' ? landing.current.index : 0;
        const last = active.pinned.length - Number(active.ownIndex >= 0);
        const next = Math.max(0, Math.min(last, index + (event.key === 'ArrowUp' ? -1 : 1)));
        updateTarget({ kind: 'list', index: next });
        const area = areaRef.current?.getBoundingClientRect();
        const view = rootRef.current?.parentElement;
        if (area && view) {
          const y = area.top + gapTop(active, next);
          const bounds = view.getBoundingClientRect();
          if (y < bounds.top + 12) view.scrollBy(0, y - bounds.top - 12);
          if (y > bounds.bottom - 12) view.scrollBy(0, y - bounds.bottom + 12);
        }
      }
      return;
    }
    if (!reorder || event.key !== ' ' || !event.shiftKey || event.repeat) return;
    const row = (event.target as HTMLElement).closest<HTMLElement>('[data-recent-id]');
    const item = items.find((item) => item.id === row?.dataset.recentId);
    if (!row || !item || event.target !== row) return;
    consume();
    stopPress.current?.();
    const picked = lift(item, row, true);
    if (picked) {
      point.current = { x: picked.source.left + picked.source.width / 2, y: picked.source.top + picked.source.height / 2 };
      updateTarget({ kind: 'list', index: Math.max(0, picked.ownIndex) });
    }
  }

  const index = target?.kind === 'list' ? target.index : null;
  const gap = drag && index !== null && index !== drag.ownIndex ? index : null;
  function rowStyle(id: string): CSSProperties | undefined {
    if (!drag || id === drag.item.id) return;
    const siblings = drag.rows;
    const sourceIndex = siblings.findIndex((row) => row.id === drag.item.id);
    const collapse = siblings.findIndex((row) => row.id === id) > sourceIndex ? -drag.step : 0;
    const pinnedIndex = drag.pinned.findIndex((row) => row.id === id);
    if (gap === null || pinnedIndex < 0) return { translate: `0 ${collapse}px` };
    const i = pinnedIndex - Number(drag.ownIndex >= 0 && pinnedIndex > drag.ownIndex);
    const before = i < gap;
    const n = before ? gap - i - 1 : i - gap;
    return { translate: `0 ${collapse + (before ? -1 : 1) * 8 * 0.7 ** n}px`, transitionDelay: `${24 * n}ms` };
  }

  return { rootRef, areaRef, zoneRef, previewRef, pinnedItems, unpinnedItems, drag, target, gap, glide, saving: pending !== null,
    hintTop: drag && gap !== null ? gapTop(drag, gap) : undefined,
    beginPress, onKeyDown, rowStyle,
    suppressSelection: () => current.current != null || Date.now() < suppressUntil.current,
    isDragging: () => current.current != null,
    cancelKeyboard: () => { if (current.current?.keyboard) finish(false); },
  };
}

function landPreview(node: HTMLElement, from: DOMRect, row: HTMLElement, to: DOMRect) {
  // 放下时继续画在滚动区外面，避免悬浮行飞回去的前半段被裁掉。
  const shell = document.createElement('div');
  shell.className = 'recent-drag-preview';
  shell.setAttribute('aria-hidden', 'true');
  Object.assign(shell.style, { width: `${from.width}px`, height: `${from.height}px`, transition: 'none' });
  Object.assign(node.style, { animation: 'none', transform: 'none' });
  shell.append(node);
  document.body.append(shell);
  const flight = shell.animate([
    { transform: `translate(${from.left}px, ${from.top}px)`, transformOrigin: 'top left' },
    { transform: `translate(${to.left}px, ${to.top}px) scale(${to.width / from.width})`, transformOrigin: 'top left' },
  ], spring);
  void flight.finished.then(() => shell.remove(), () => shell.remove());
  return [flight, row.animate([{ opacity: 0 }, { opacity: 0.5, offset: 0.88 }, { opacity: 1 }], spring)];
}

function gapTop(drag: Drag, index: number) {
  const positions = drag.pinned.flatMap((row, i) => row.id === drag.item.id ? [] : [{
    ...row, top: row.top - (drag.ownIndex >= 0 && i > drag.ownIndex && !reduced() ? drag.step : 0),
  }]);
  const before = positions[index - 1];
  const after = positions[index];
  if (before && after) return (before.top + before.height + after.top) / 2;
  return after ? after.top : before ? before.top + before.height : 1;
}
