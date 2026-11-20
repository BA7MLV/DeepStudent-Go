/**
 * 资料库「单张卡片」拖进文件夹 / 顶栏投放区的手势状态机。
 *
 * 从 Library.tsx 抽出来的两段逻辑：
 *   1. 卡片自身的「长按 / 鼠标按住移动」起拖判定（原来写在 VideoRow 里）；
 *   2. 起拖之后的指针跟随、命中检测、松手落点（原来写在主组件的 beginDrag/moveDrag/endDrag）。
 *
 * 合成一个 hook 是因为它们是同一件手势的两半，拆开就得靠父组件在中间传一堆 ref；
 * 命中检测本身在 `libraryDrag.ts`，这里只负责「什么时候开始 / 结束」与副作用（指针捕获、
 * 拖拽期间禁止选中与滚动）。
 *
 * 拖拽中的 `DragState` 同时写进 state 与 ref：state 驱动渲染（悬浮卡片、投放区高亮），
 * ref 供事件处理器同步读取 —— React 的 state 在同一个事件循环里不会立刻更新，
 * 连续 pointermove 只看 state 会漏掉上一帧的命中结果。
 */
import { useEffect, useRef, useState } from 'react';
import type { VideoRow } from '../store/db';
import { UNCAT_KEY } from './libraryModel';
import { groupKeyAt, zoneAt } from './libraryDrag';
import { LONG_PRESS_MS, LONG_PRESS_SLOP, type DragState } from './libraryGesture';

export type { DragState };

/** 卡片长按/按住拖动起拖判定；返回给 VideoRow 的指针处理器 */
export function useCardDragGesture({
  dragging,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  dragging: boolean;
  /** 整卡长按到点：以卡片元素为指针捕获目标开始拖拽 */
  onBeginDrag: (el: HTMLElement, pointerId: number, x: number, y: number) => void;
  onDragMove: (event: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
}) {
  const articleRef = useRef<HTMLElement>(null);
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number; pointerId: number; pointerType: string } | null>(null);
  /** 长按起拖后要吃掉落点那次 click（否则松手会顺手点进播放页 / 弹出菜单） */
  const swallowClick = useRef(false);

  useEffect(() => () => {
    if (pressTimer.current != null) window.clearTimeout(pressTimer.current);
  }, []);

  const clearPress = () => {
    if (pressTimer.current != null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressOrigin.current = null;
  };

  const onPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    // 长按只认主指针（触屏 / 鼠标左键）
    if (!e.isPrimary || e.button !== 0) return;
    const target = e.target as HTMLElement;
    // 缩略图也是起拖区域；操作按钮仍保持原生点击行为。
    if (target.closest('button, a, input, textarea, select, [data-slot="dropdown-trigger"]') && !target.closest('[data-testid="video-thumb"]')) return;
    const el = articleRef.current;
    if (!el) return;
    // 新一次按下：清掉上一轮可能残留的「吃掉 click」（正常情况那一下已经被消耗）
    swallowClick.current = false;
    const x = e.clientX;
    const y = e.clientY;
    pressOrigin.current = { x, y, pointerId: e.pointerId, pointerType: e.pointerType };
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      const origin = pressOrigin.current;
      pressOrigin.current = null;
      if (!origin) return;
      // 起拖：吃掉落点那次 click，交给父级的统一拖拽逻辑
      swallowClick.current = true;
      onBeginDrag(el, origin.pointerId, x, y);
    }, LONG_PRESS_MS);
  };

  /** 长按计时中移出阈值：触屏视为滚动、取消长按；鼠标则是「按住拖动」直接起拖 */
  const onPointerMove = (e: React.PointerEvent<HTMLElement>) => {
    const origin = pressOrigin.current;
    if (!origin || pressTimer.current == null) return;
    if (Math.hypot(e.clientX - origin.x, e.clientY - origin.y) <= LONG_PRESS_SLOP) return;
    clearPress();
    if (origin.pointerType === 'mouse' && articleRef.current) {
      swallowClick.current = true;
      onBeginDrag(articleRef.current, origin.pointerId, e.clientX, e.clientY);
      e.preventDefault();
    }
  };

  return {
    articleRef,
    /** 供 onContextMenu 判断「长按呼菜单」是否该被抑制 */
    pressing: () => dragging || pressTimer.current != null,
    onPointerDown,
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      onPointerMove(e);
      onDragMove(e);
    },
    onPointerUp: () => {
      clearPress();
      onDragEnd();
    },
    onPointerCancel: () => {
      clearPress();
      onDragCancel();
    },
    onPointerLeave: clearPress,
    onClickCapture: (e: React.MouseEvent) => {
      if (!swallowClick.current) return;
      swallowClick.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}

/** 主组件侧：起拖之后的跟随、命中、落点结算 */
export function useLibraryItemDrag({
  headers,
  pinZone,
  deleteZone,
  onPin,
  onDelete,
  onMoveTo,
}: {
  headers: React.RefObject<Map<string, HTMLDivElement>>;
  pinZone: React.RefObject<HTMLDivElement | null>;
  deleteZone: React.RefObject<HTMLDivElement | null>;
  onPin: (video: VideoRow) => Promise<void> | void;
  onDelete: (video: VideoRow) => void;
  /** 松手落在组头上：target 为 null 表示「未分类」 */
  onMoveTo: (video: VideoRow, target: number | null) => Promise<void> | void;
}) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);

  const beginDrag = (el: HTMLElement, pointerId: number, video: VideoRow, x: number, y: number) => {
    el.setPointerCapture(pointerId);
    const next: DragState = { video, x, y, overKey: null, zone: null };
    dragRef.current = next;
    setDrag(next);
  };

  const moveDrag = (e: React.PointerEvent<HTMLElement>) => {
    const current = dragRef.current;
    if (!current) return;
    // 拖动中指针捕获抑制了页面滚动，贴近视口边缘时手动滚动。
    // 滚动容器是 PageShell 的内容区。用 data-testid 而不是类名找它 ——
    // 外壳的版式类名已经全部并进 Tailwind 工具类，没有稳定的类名可依赖了。
    const main = document.querySelector<HTMLElement>('[data-testid="page-main"]');
    if (e.clientY < 80) main?.scrollBy(0, -12);
    else if (e.clientY > window.innerHeight - 80) main?.scrollBy(0, 12);
    const zone = zoneAt({ pin: pinZone.current, remove: deleteZone.current }, e.clientX, e.clientY);
    const overKey = zone ? null : groupKeyAt(headers.current ?? new Map(), e.clientX, e.clientY);
    const next: DragState = { ...current, x: e.clientX, y: e.clientY, overKey, zone };
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = async () => {
    const finished = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!finished) return;
    // 顶栏投放区：置顶 / 删除。删除走与行内同一个确认弹窗（销毁性操作不静默执行）
    if (finished.zone === 'delete') {
      onDelete(finished.video);
      return;
    }
    if (finished.zone === 'pin') {
      await onPin(finished.video);
      return;
    }
    if (!finished.overKey) return;
    const target = finished.overKey === UNCAT_KEY ? null : Number(finished.overKey);
    if (target === (finished.video.folderId ?? null)) return; // 原地放回
    await onMoveTo(finished.video, target);
  };

  const cancelDrag = () => {
    dragRef.current = null;
    setDrag(null);
  };

  // 拖动期间禁止文本选中、禁止触屏在拖动中滚动页面；Esc 取消拖拽。
  // 触屏长按起手时 `touch-action` 不是 none（整张卡片要保持可滚动），
  // 所以这里补一条非 passive 的 touchmove 阻止默认滚动 —— 只在拖拽进行中挂上。
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    document.body.style.userSelect = 'none';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        dragRef.current = null;
        setDrag(null);
      }
    };
    const preventTouchScroll = (e: TouchEvent) => {
      if (e.cancelable) e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('touchmove', preventTouchScroll, { passive: false });
    return () => {
      document.body.style.userSelect = '';
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('touchmove', preventTouchScroll);
    };
  }, [dragging]);

  return { drag, beginDrag, moveDrag, endDrag, cancelDrag };
}
