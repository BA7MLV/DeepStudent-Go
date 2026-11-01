import { useCallback, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

export interface VirtualMessagesHandle {
  scrollToIndex: (index: number) => void;
  cancelScroll: () => void;
}

/** Shared dynamic-height window. Stable keys preserve the reading anchor on prepend. */
export default function VirtualMessages<T extends { key: string }>({ items, scrollRef, children, ref, onResize, scrollPaddingStart = 0, initialAnchor, positionEmpty = false }: {
  items: T[];
  scrollRef: RefObject<HTMLDivElement | null>;
  children: (item: T, index: number) => ReactNode;
  ref?: Ref<VirtualMessagesHandle>;
  onResize: () => void;
  scrollPaddingStart?: number;
  initialAnchor?: { key: string; offset: number };
  positionEmpty?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  const [positioned, setPositioned] = useState(false);
  const restore = useRef(initialAnchor);
  const [restoreTick, setRestoreTick] = useState(0);
  const restoredSize = useRef({ total: -1, stable: 0 });
  const getItemKey = useCallback((index: number) => items[index].key, [items]);
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey,
    estimateSize: () => 180,
    overscan: 4,
    scrollMargin: margin,
    scrollPaddingStart,
    anchorTo: 'end',
    // useChatScroll owns end-following, including the scrollport's CSS padding.
    // The virtual distance excludes that padding, so even a zero threshold can
    // pull readers back after an upward gesture. A negative threshold disables
    // end-following while anchorTo still preserves keyed anchors on prepend.
    followOnAppend: false,
    scrollEndThreshold: -1,
  });
  useImperativeHandle(ref, () => ({
    scrollToIndex: (index) => virtualizer.scrollToIndex(index, { align: 'start', behavior: 'auto' }),
    cancelScroll: () => virtualizer.cancelScroll(),
  }), [virtualizer]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    const host = hostRef.current;
    if (positioned || !scroll || !host || scroll.clientHeight === 0) return;
    if (!items.length && positionEmpty) { setPositioned(true); return; }
    const anchor = restore.current;
    const index = anchor ? items.findIndex(item => item.key === anchor.key) : -1;
    if (anchor && index >= 0) {
      const row = host.querySelector<HTMLElement>(`[data-index="${index}"]`);
      if (!row) {
        if (restoreTick >= 30) { setPositioned(true); return; }
        // The first layout may not yet have measurements, so scrollToIndex can
        // be a no-op. Retry after measurement rather than revealing row zero.
        virtualizer.scrollToIndex(index, { align: 'start' });
        const frame = requestAnimationFrame(() => setRestoreTick(value => value + 1));
        return () => cancelAnimationFrame(frame);
      }
      virtualizer.cancelScroll();
      const delta = row.getBoundingClientRect().top - scroll.getBoundingClientRect().top - anchor.offset;
      scroll.scrollTop += delta;
      const total = virtualizer.getTotalSize();
      restoredSize.current.stable = Math.abs(delta) < 1 && restoredSize.current.total === total ? restoredSize.current.stable + 1 : 0;
      restoredSize.current.total = total;
      // Rows above the target can still change from estimates to measurements.
      // Keep correcting the keyed pixel anchor until those commits settle.
      if (restoredSize.current.stable >= 3 || restoreTick >= 30) { setPositioned(true); return; }
      const frame = requestAnimationFrame(() => setRestoreTick(value => value + 1));
      return () => cancelAnimationFrame(frame);
    }
    // A virtual window initially contains estimates (and may not contain the
    // last row at all). Keep it unpainted until the measured tail is committed.
    virtualizer.scrollToEnd();
    const tailMounted = host.querySelector(`[data-index="${items.length - 1}"]`) != null;
    if (tailMounted && Math.abs(host.offsetHeight - virtualizer.getTotalSize()) < 1) {
      setPositioned(true);
    }
  });
  // Virtualizer commits can adjust the offset without changing total height.
  // Reassert the reading mode after those commits too, not only on resize.
  useLayoutEffect(onResize);
  useLayoutEffect(() => {
    const host = hostRef.current;
    const scroll = scrollRef.current;
    if (!host || !scroll) return;
    const measure = () => {
      setMargin(host.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop);
      onResize();
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroll);
    // The scrollport's height does not change when an answer, image, preview or
    // final action row grows. Observe the virtual content's actual height too.
    observer.observe(host);
    return () => observer.disconnect();
  }, [scrollRef, onResize]);
  return (
    <div ref={hostRef} data-chat-positioned={positioned ? 'true' : 'false'}
      style={{ height: virtualizer.getTotalSize(), position: 'relative', overflowAnchor: 'none' }}>
      {virtualizer.getVirtualItems().map((item) => (
        <div key={item.key} data-index={item.index} data-message-key={item.key} ref={virtualizer.measureElement}
          style={{ position: 'absolute', top: item.start - margin, left: 0, width: '100%', display: 'flow-root' }}>
          {children(items[item.index], item.index)}
        </div>
      ))}
    </div>
  );
}
