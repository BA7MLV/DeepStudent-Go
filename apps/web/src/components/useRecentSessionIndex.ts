import { useEffect, useRef, useState } from 'react';
import type { SessionIndexPage } from '@wangke/contracts/client-runtime';
import { cloud } from '../cloud/state';
import { isCurrentServerRuntime, serverRuntime } from '../client/bootstrap';
import { LIBRARY_ASSISTANT_ID } from '../harness/libraryAssistant';

/** One 50-row navigation page, not a second message cache. First-page stream
 * supplies invalidations for the entire authorized course scope. */
export function useRecentSessionIndex(enabled: boolean, archived = false, recentOnly = true, videoId = LIBRARY_ASSISTANT_ID) {
  const owner = cloud.userId;
  const scope = JSON.stringify([owner, videoId, archived, recentOnly]);
  const [state, setState] = useState<{ scope: string; page?: SessionIndexPage; loading: boolean; error?: string }>({ scope, loading: true });
  const [retryTick, setRetryTick] = useState(0);
  const navigation = useRef<(cursor?: string) => void>(() => {});
  useEffect(() => {
    if (!enabled) return;
    const request = { kind: 'sessionIndex', videoId, archived, recentOnly } as const;
    let stopped = false, generation = 0;
    let off: (() => void) | undefined, release: (() => void) | undefined;
    let current: SessionIndexPage | undefined;
    setState({ scope, loading: true });
    void serverRuntime(owner).then(runtime => {
      const valid = () => !stopped && owner === cloud.userId && isCurrentServerRuntime(runtime);
      if (!valid()) return;
      const model = runtime.sessionIndex(request);
      const publish = () => {
        if (!valid()) return;
        const snapshot = model.getSnapshot();
        const baseline = snapshot.data as unknown as SessionIndexPage | undefined;
        if (baseline && (!current || baseline.epoch !== current.epoch || baseline.version !== current.version)) {
          ++generation;
          current = baseline;
          setState({ scope, page: current, loading: false });
        } else if (snapshot.status === 'error') setState({ scope, page: current, loading: false, error: snapshot.error });
      };
      navigation.current = cursor => {
        if (!valid()) return;
        const expected = current, fence = ++generation;
        setState({ scope, page: current, loading: true });
        void runtime.read({ ...request, ...(cursor ? { cursor } : {}) }).then(snapshot => {
          if (!valid() || fence !== generation) return;
          const page = snapshot.value as unknown as SessionIndexPage;
          // Even a successful HTTP response cannot mix with a newer pushed head.
          const head = model.getSnapshot().data as unknown as SessionIndexPage | undefined;
          if (head && (head.epoch !== page.epoch || head.version !== page.version)) { model.refresh(); return; }
          current = page;
          setState({ scope, page, loading: false });
        }).catch(error => {
          if (!valid() || fence !== generation) return;
          setState({ scope, page: expected, loading: false, error: error instanceof Error ? error.message : 'remote_failed' });
          if (/projection_cursor_expired/.test(String(error))) model.refresh();
        });
      };
      off = model.subscribe(publish); release = model.acquire(); publish();
    }).catch(error => { if (!stopped && owner === cloud.userId) setState({ scope, loading: false, error: String(error) }); });
    return () => { stopped = true; ++generation; navigation.current = () => {}; off?.(); release?.(); };
  }, [enabled, owner, retryTick, archived, recentOnly, videoId, scope]);
  const visible = enabled && state.scope === scope ? state : { scope, loading: enabled };
  return { ...visible, next: () => navigation.current(visible.page?.next), previous: () => navigation.current(visible.page?.previous),
    retry: () => setRetryTick(value => value + 1) };
}
