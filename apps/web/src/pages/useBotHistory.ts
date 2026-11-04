import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type SetStateAction } from 'react';
import type { BotActivityDto, BotSyncState } from '@wangke/contracts';
import { apiUrl } from '../api/base';
import { serverClient, ServerApiError, type ThreadDetail } from '../api/serverClient';
import { followBot } from '../client/bot';
import { BotHistoryModel } from '@wangke/client-core/bot-history';
import { BotFollowModel } from '@wangke/client-core';

interface View {
  cursor: number;
  stateCursor: number;
  hasOlder: boolean;
  hasNewer: boolean;
  loadingOlder: boolean;
  historyError: boolean;
  legacy: boolean;
  follow: boolean;
  scrollTop: number;
  touched: number;
  progress?: string;
  activity?: BotActivityDto | null;
  activityCursor: number;
  anchor?: { key: string; offset: number };
}
interface Cache { readonly details: Record<string, ThreadDetail>; model: BotHistoryModel<ThreadDetail>; views: Map<string, View> }
// Only keep the current authenticated identity; logout/account changes explicitly clear it.
let parked: { scope: string; cache: Cache } | undefined;
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', () => { parked?.cache.model.dispose(); parked = undefined; });
const emptyCache = (scope = ''): Cache => {
  const model = new BotHistoryModel<ThreadDetail>({ server: apiUrl('/api/v1'), account: scope, scope: 'bot' });
  return { model, get details() { return model.getSnapshot(); }, views: new Map() };
};
const newView = (legacy = false): View => ({ cursor: 0, stateCursor: 0, activityCursor: 0, hasOlder: false, hasNewer: false, loadingOlder: false, historyError: false, legacy, follow: true, scrollTop: 0, touched: Date.now() });
const terminal = (error: unknown) => error instanceof ServerApiError && [401, 403, 404].includes(error.status);

/** Bot-only history/sync. Business sending and drafts stay in Workspace. */
export function useBotHistory(scope: string | null, activeId: string | null, enabled: boolean, modern: boolean) {
  const account = scope ?? '';
  scope = scope ? `${apiUrl('/api/v1')}::${scope}` : null;
  const [initialCache] = useState(() => emptyCache());
  const cacheRef = useRef<Cache>(initialCache);
  useSyncExternalStore(cacheRef.current.model.subscribe, cacheRef.current.model.getSnapshot);
  const identityRef = useRef<string | null>(null);
  const [, render] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'live' | 'offline' | 'error'>('connecting');
  const [announcement, setAnnouncement] = useState(0);
  const [available, setAvailable] = useState(() => navigator.onLine && !document.hidden);
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const notify = useCallback(() => render(value => value + 1), []);
  const setDetails = useCallback((value: SetStateAction<Record<string, ThreadDetail>>) => {
    const cache = cacheRef.current;
    cache.model.update(value, new Set(activeRef.current ? [activeRef.current] : []));
    for (const id of cache.views.keys()) if (!cache.details[id]) cache.views.delete(id);
    notify();
  }, [notify]);
  const patchActive = useCallback((id: string, update: (detail: ThreadDetail) => ThreadDetail) => {
    setDetails(old => {
      if (!old[id]) return old;
      const next = update(old[id]);
      return next === old[id] ? old : { ...old, [id]: next };
    });
  }, [setDetails]);

  useEffect(() => {
    const availability = () => { const next = navigator.onLine && !document.hidden; setAvailable(next); if (!next) setSyncStatus('offline'); };
    const clear = () => { parked = undefined; const old = cacheRef.current; cacheRef.current = emptyCache(); old.model.dispose(); identityRef.current = null; setSyncStatus('error'); notify(); };
    window.addEventListener('online', availability);
    window.addEventListener('offline', availability);
    document.addEventListener('visibilitychange', availability);
    window.addEventListener('wangke:bot-session-ended', clear);
    return () => {
      window.removeEventListener('online', availability);
      window.removeEventListener('offline', availability);
      document.removeEventListener('visibilitychange', availability);
      window.removeEventListener('wangke:bot-session-ended', clear);
    };
  }, [notify]);

  useEffect(() => {
    if (identityRef.current === scope) return;
    identityRef.current = scope;
    const old = cacheRef.current;
    cacheRef.current = scope && parked?.scope === scope ? parked.cache : emptyCache(account);
    if (old !== cacheRef.current) old.model.dispose();
    if (!scope || parked?.scope !== scope) parked = undefined;
    notify();
  }, [scope, account, notify]);
  useEffect(() => () => {
    if (scope && identityRef.current === scope) parked = { scope, cache: cacheRef.current };
  }, [scope]);

  const loaded = Boolean(cacheRef.current.details[activeId ?? '']);
  useEffect(() => {
    if (!scope || identityRef.current !== scope || !enabled || !activeId || loaded) return;
    const controller = new AbortController();
    const cache = cacheRef.current;
    setDetailError('');
    const load = async () => {
      try {
        let detail: ThreadDetail;
        let view = newView();
        if (modern) {
          const snapshot = await serverClient.threadSnapshot(activeId, controller.signal);
          detail = snapshot;
          view = { ...view, cursor: snapshot.eventCursor, stateCursor: snapshot.eventCursor, activity: snapshot.activity, activityCursor: snapshot.eventCursor, hasOlder: snapshot.hasOlder };
        } else {
          detail = await serverClient.thread(activeId);
          view.legacy = true;
        }
        if (controller.signal.aborted || cacheRef.current !== cache) return;
        cache.views.set(activeId, view);
        setDetails(old => ({ ...old, [activeId]: detail }));
      } catch (error) {
        if (!controller.signal.aborted) setDetailError(error instanceof Error ? error.message : 'load_failed');
      }
    };
    void load();
    return () => controller.abort();
  }, [scope, enabled, activeId, loaded, revision, modern, setDetails]);

  const loadOlder = useCallback(async () => {
    const id = activeRef.current;
    const cache = cacheRef.current;
    const view = id ? cache.views.get(id) : undefined;
    const detail = id ? cache.details[id] : undefined;
    const before = detail?.messages.find(message => !message.id.startsWith('pending-'))?.seq;
    if (!id || !detail || !view?.hasOlder || view.loadingOlder || !before || view.legacy) return;
    view.loadingOlder = true; view.historyError = false; notify();
    try {
      const page = await serverClient.threadMessages(id, before);
      if (cacheRef.current !== cache || cache.views.get(id) !== view) return;
      const current = cache.details[id];
      if (!current) return;
      Object.assign(view, cache.model.prepend(id, page, view.hasNewer));
    } catch { if (cache.views.get(id) === view) view.historyError = true; }
    finally { view.loadingOlder = false; notify(); }
  }, [notify, patchActive]);

  const jumpLatest = useCallback(async () => {
    const id = activeRef.current;
    const cache = cacheRef.current;
    const view = id ? cache.views.get(id) : undefined;
    if (!id || !view) return true;
    if (view.hasNewer) {
      try {
        // Fetch the newest PAGE, not a snapshot: never skip events/state using a newer cursor.
        const page = await serverClient.threadMessages(id, Number.MAX_SAFE_INTEGER);
        if (cacheRef.current !== cache || cache.views.get(id) !== view) return;
        cache.model.latest(id, page);
        view.hasOlder = page.hasOlder; view.hasNewer = false; view.historyError = false;
      } catch { view.historyError = true; notify(); return false; }
    }
    view.follow = true;
    notify();
    return true;
  }, [notify, patchActive]);

  useEffect(() => {
    if (!scope || identityRef.current !== scope || !enabled || !activeId || !loaded || !available) return;
    const cache = cacheRef.current;
    const view = cache.views.get(activeId) ?? newView(!modern);
    cache.views.set(activeId, view); view.touched = Date.now();
    cache.model.touch(activeId);
    const legacyState = async (): Promise<BotSyncState> => {
      const detail = cache.details[activeId];
      const knownApprovals = new Set(detail?.approvals?.map(approval => approval.messageId));
      // Old APIs cannot list approvals independently. Only a new approval card
      // needs the compatibility detail request; progress never takes this path.
      if (detail?.messages.some(message => message.kind === 'approval' && !knownApprovals.has(message.id))) {
        const full = await serverClient.thread(activeId);
        return { approvals: full.approvals ?? [], questions: full.questions ?? [], runs: full.runs ?? [], running: Boolean(full.running), eventCursor: 0 };
      }
      const [state, approvals] = await Promise.all([serverClient.threadState(activeId), Promise.all((detail?.approvals ?? []).filter(approval => approval.status === 'pending').map(approval => serverClient.approvals(approval.id)))]);
      return { ...state, approvals, questions: state.questions ?? [], runs: state.runs ?? [], running: Boolean(state.running), eventCursor: 0 };
    };
    return new BotFollowModel(cache.model, activeId, view, {
      available: () => navigator.onLine && !document.hidden,
      current: () => cacheRef.current === cache,
      state: signal => view.legacy ? legacyState() : serverClient.threadSyncState(activeId,
        cache.details[activeId]?.messages[0]?.seq, signal,
        cache.details[activeId]?.messages.filter(message => !message.id.startsWith('pending-')).at(-1)?.seq),
      snapshot: (signal, before) => serverClient.threadSnapshot(activeId, signal, before),
      follow: (after, receive, signal, ready) => followBot(activeId, after, receive, signal, ready),
      fatal: error => {
        if (!terminal(error)) return false;
        if (error instanceof ServerApiError && [401, 403].includes(error.status)) window.dispatchEvent(new Event('wangke:bot-session-ended'));
        cache.views.delete(activeId); notify(); return true;
      },
      retryAfter: error => error instanceof ServerApiError ? error.retryAfterMs ?? 0 : 0,
      status: setSyncStatus,
      announce: () => setAnnouncement(value => value + 1),
      changed: notify,
    }).start();
  }, [scope, enabled, activeId, loaded, available, modern, patchActive, setDetails, notify]);

  const view = activeId ? cacheRef.current.views.get(activeId) : undefined;
  return {
    details: identityRef.current === scope ? cacheRef.current.details : {}, setDetails, patchActive, detailError,
    retry: () => { setDetailError(''); setRevision(value => value + 1); },
    hasOlder: Boolean(view?.hasOlder), hasNewer: Boolean(view?.hasNewer), loadingOlder: Boolean(view?.loadingOlder), historyError: Boolean(view?.historyError),
    loadOlder, jumpLatest, syncStatus, announcement,
    setReading: (follow: boolean, scrollTop: number, anchor?: View['anchor']) => { if (view) { const changed = view.follow !== follow; view.follow = follow; view.scrollTop = scrollTop; view.anchor = anchor; if (changed) notify(); } },
    reading: view,
  };
}
