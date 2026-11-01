import { useEffect, useState } from 'react';

/** Keep scroll position visible even when the OS automatically hides scrollbars. */
export default function ScrollStatus({ target }: { target: HTMLElement | null }) {
  const [position, setPosition] = useState({ percent: 0, scrollable: false });

  useEffect(() => {
    if (!target) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const range = target.scrollHeight - target.clientHeight;
      const scrollable = range > 1;
      const percent = scrollable ? Math.round(Math.max(0, Math.min(1, target.scrollTop / range)) * 100) : 0;
      setPosition((previous) => previous.percent === percent && previous.scrollable === scrollable
        ? previous : { percent, scrollable });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    resize.observe(target);
    // Both CodeMirror's content and the rendered preview can change height asynchronously.
    const content = target.querySelector('.cm-content, .mr-md');
    if (content) resize.observe(content);
    target.addEventListener('scroll', schedule, { passive: true });
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      target.removeEventListener('scroll', schedule);
    };
  }, [target]);

  const { percent, scrollable } = position;
  return (
    <div className="mr-scroll-status" data-testid="md-scroll-status">
      <span>{!scrollable ? '已显示全部' : percent === 100 ? '已到底部' : '向下滚动查看更多'}</span>
      <div className="mr-scroll-status__track" role="progressbar" aria-label="文档滚动进度"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={scrollable ? percent : 100}>
        <span style={{ width: `${scrollable ? percent : 100}%` }} />
      </div>
      <span className="mr-scroll-status__percent">{scrollable ? `${percent}%` : '100%'}</span>
    </div>
  );
}
