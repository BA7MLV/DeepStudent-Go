import { useEffect } from 'react';
import { cloud } from './state';

/** Keep worker credentials/state in a separate realm, never in the interactive app.
 * Web Locks elect one host per browser/account; server leases coordinate devices. */
export default function BrowserWorkerHost() {
  useEffect(() => {
    if (!cloud.enabled || cloud.worker) return;
    const abort = new AbortController();
    let release: (() => void) | undefined;
    const run = () => new Promise<void>(resolve => {
      if (abort.signal.aborted) { resolve(); return; }
      const frame = document.createElement('iframe');
      const url = new URL(location.pathname, location.origin);
      url.searchParams.set('cloud-worker', '1');
      frame.src = url.href;
      frame.hidden = true;
      frame.title = '浏览器后台媒体处理';
      frame.setAttribute('aria-hidden', 'true');
      frame.dataset.browserWorker = '';
      release = () => { frame.remove(); resolve(); };
      document.body.append(frame);
    });
    if (navigator.locks) {
      void navigator.locks.request(`media-worker:${cloud.userId}`, { signal: abort.signal }, run).catch(error => {
        if (!abort.signal.aborted) console.warn('浏览器后台处理启动失败', error);
      });
    } else void run();
    return () => { abort.abort(); release?.(); };
  }, []);
  return null;
}
