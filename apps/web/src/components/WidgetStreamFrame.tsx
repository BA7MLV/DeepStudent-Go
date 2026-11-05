import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { applyStaticPreviewTheme, buildStaticPreviewDocument, StaticPreviewRenderer, STATIC_PREVIEW_SANDBOX } from '../harness/widgetStaticPreview';
import { observeWidgetTheme, readWidgetTheme } from '../harness/widgetTheme';
import './widget-stream-frame.css';

/**
 * High-fidelity, script-free preview of a show_widget HTML fragment.
 *
 * Rendered with the same UI kit, theme tokens and transparent frameless layout
 * as the final work, so generation → validation → interactive is one visual
 * surface instead of a grey text card followed by a loading box. Controls are
 * inert until the real isolated runtime takes over. See widgetStaticPreview.ts
 * for the sanitizer / sandbox / CSP boundary.
 */
interface Props {
  html: string;
  dark: boolean;
  /** Visible status line. Omit when the caller announces its own status. */
  status?: string;
  /** Keep at least this height (e.g. remembered height of the final work). */
  minHeight?: number;
  testId?: string;
  onHeight?: (height: number) => void;
}

export default function WidgetStreamFrame({ html, dark, status, minHeight = 0, testId = 'widget-stream-preview', onHeight }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const rendererRef = useRef<StaticPreviewRenderer | null>(null);
  const latest = useRef(html);
  const raf = useRef<number | null>(null);
  const onHeightRef = useRef(onHeight);
  onHeightRef.current = onHeight;
  const darkRef = useRef(dark);
  darkRef.current = dark;
  latest.current = html;
  // The document shell is created once; content and theme are patched in place.
  const [srcDoc] = useState(() => buildStaticPreviewDocument(
    typeof document !== 'undefined' && document.body ? readWidgetTheme(document.body, dark) : undefined));
  const [height, setHeight] = useState(0);

  const flush = useCallback(() => {
    raf.current = null;
    const renderer = rendererRef.current, frame = frameRef.current;
    // React removes the iframe at commit but runs passive cleanups later; a frame
    // queued in between must not touch a document whose browsing context is gone.
    if (!renderer || !frame?.isConnected || !renderer.owns(frame.contentDocument)) return;
    renderer.update(latest.current);
    const next = renderer.height();
    setHeight((current) => current === next ? current : next);
    onHeightRef.current?.(next);
  }, []);
  const schedule = useCallback(() => {
    if (raf.current == null) raf.current = requestAnimationFrame(flush);
  }, [flush]);

  // Bind once the srcdoc document exists; React may commit before it parses.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observer: ResizeObserver | undefined;
    // Re-bind on every load: moving an iframe in the DOM reloads its srcdoc.
    const bind = () => {
      const doc = frame.contentDocument;
      if (!doc?.body?.querySelector('[data-wbw-preview-part]') || rendererRef.current?.owns(doc)) return;
      if (hostRef.current) applyStaticPreviewTheme(doc, readWidgetTheme(hostRef.current, darkRef.current));
      rendererRef.current = new StaticPreviewRenderer(doc);
      observer?.disconnect();
      observer = new ResizeObserver(schedule);
      observer.observe(doc.body);
      observer.observe(frame);
      schedule();
    };
    bind();
    frame.addEventListener('load', bind);
    return () => {
      frame.removeEventListener('load', bind);
      observer?.disconnect();
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      rendererRef.current = null;
    };
    // Theme is synced by the effect below; rebinding would discard frozen nodes.
  }, [schedule]);

  useLayoutEffect(() => { schedule(); }, [html, schedule]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const sync = () => {
      const doc = frameRef.current?.contentDocument;
      if (doc?.documentElement) { applyStaticPreviewTheme(doc, readWidgetTheme(host, dark)); schedule(); }
    };
    sync();
    return observeWidgetTheme(host, sync);
  }, [dark, schedule]);

  return (
    <div ref={hostRef} className="md-embedded-ui widget-stream-frame" data-testid={testId} aria-busy="true">
      <iframe
        ref={frameRef}
        className="widget-stream-frame__frame"
        title="交互图形预览（生成中，暂不可操作）"
        /* Never add allow-scripts here: this document is same-origin for measurement. */
        sandbox={STATIC_PREVIEW_SANDBOX}
        srcDoc={srcDoc}
        tabIndex={-1}
        style={{ height: Math.max(minHeight, height, 80), colorScheme: dark ? 'dark' : 'light' }}
        data-testid="widget-stream-frame"
      />
      {status && <div className="widget-stream-frame__status" role="status" aria-live="polite">
        <span className="widget-stream-frame__dot" aria-hidden="true" />{status}
      </div>}
    </div>
  );
}
