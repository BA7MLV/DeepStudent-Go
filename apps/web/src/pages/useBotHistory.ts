import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { BotSyncState, MessageDto, SseEvent } from '@wangke/contracts';
import { apiUrl } from '../api/base';
import { serverClient, ServerApiError, type ThreadDetail } from '../api/serverClient';
import { mergeById, mergeMessages } from './botMessageCache';

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
  anchor?: { key: string; offset: number };
  deferred?: MessageDto[];
}
interface Cache { details: Record<string, ThreadDetail>; views: Map<string, View> }
// Only keep the current authenticated identity; logout/account changes explicitly clear it.
let parked: { scope: string; cache: Cache } | undefined;
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', () => { parked = undefined; });
const emptyCache = (): Cache => ({ details: {}, views: new Map() });
const newView = (legacy = false): View => ({ cursor: 0, stateCursor: 0, hasOlder: false, hasNewer: false, loadingOlder: false, historyError: false, legacy, follow: true, scrollTop: 0, touched: Date.now() });
const terminal = (error: unknown) => error instanceof ServerApiError && [401, 403, 404].includes(error.status);
const pause = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => {
  if (signal.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
  const timer = window.setTimeout(finish, ms);
  signal.addEventListener('abort', finish, { once: true });
});

/** Bot-only history/sync. Business sending and drafts stay in Workspace. */
export function useBotHistory(scope: string | null, activeId: string | null, enabled: boolean, modern: boolean) {
  scope = scope ? `${apiUrl('/api/v1')}::${scope}` : null;
  const cacheRef = useRef<Cache>(emptyCache());
  const identityRef = useRef<string | null>(null);
  const [, render] = useState(0);
  const [detailError, setDetailError] = useState('');
  const [revision, setRevision] = useState(0);
  const [syncStatus, setSyncStatus] = useState<'connecting' | 'live' | 'offline' | 'error'>('connecting');
  const [announcement, setAnnouncement] = useState(0);
  const [available, setAvailable] = useState(() => navigator.onLine && !document.hidden);
  const activeRef = useRef(activeId); activeRef.current = activeId;
  const notify = useCallback(() => render(value => value + 1), []);
  const prune = useCallback((protectedIds: Set<string>) => {
    const cache = cacheRef.current;
    const entries = Object.entries(cache.details);
    let bytes = entries.reduce((sum, [, detail]) => sum + detail.messages.reduce((total, message) => total + message.content.length * 2, 0), 0);
    let count = entries.length;
    for (const [id, detail] of entries.sort(([a], [b]) => (cache.views.get(a)?.touched ?? 0) - (cache.views.get(b)?.touched ?? 0))) {
      if (count <= 8 && bytes <= 16 * 1024 * 1024) break;
      if (id === activeRef.current || protectedIds.has(id) || detail.messages.some(message => message.id.startsWith('pending-'))) continue;
      bytes -= detail.messages.reduce((total, message) => total + message.content.length * 2, 0); count--;
      delete cache.details[id]; cache.views.delete(id);
    }
  }, []);
  const setDetails = useCallback((value: SetStateAction<Record<string, ThreadDetail>>) => {
    const cache = cacheRef.current;
    let next = typeof value === 'function' ? value(cache.details) : value;
    if (next === cache.details) return;
    for (const [id, detail] of Object.entries(next)) {
      if (detail === cache.details[id]) continue;
      const loaded = new Set(detail.messages.map(message => message.id));
      const approvals = detail.approvals?.filter(card => card.status === 'pending' || loaded.has(card.messageId));
      const questions = detail.questions?.filter(card => card.status === 'pending' || loaded.has(card.messageId));
      if (approvals?.length !== detail.approvals?.length || questions?.length !== detail.questions?.length) next = { ...next, [id]: { ...detail, approvals, questions } };
    }
    const added = new Set(Object.keys(next).filter(id => !cache.details[id]));
    cache.details = next;
    for (const id of cache.views.keys()) if (!next[id]) cache.views.delete(id);
    prune(added); notify();
  }, [notify, prune]);
  const patchActive = useCallback((id: string, update: (detail: ThreadDetail) => ThreadDetail) => {
    setDetails(old => {
      if (!old[id]) return old;
      const next = update(old[id]);
      return next === old[id] ? old : { ...old, [id]: next };
    });
  }, [setDetails]);

  useEffect(() => {
    const availability = () => { const next = navigator.onLine && !document.hidden; setAvailable(next); if (!next) setSyncStatus('offline'); };
    const clear = () => { parked = undefined; cacheRef.current = emptyCache(); identityRef.current = null; setSyncStatus('error'); notify(); };
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
    cacheRef.current = scope && parked?.scope === scope ? parked.cache : emptyCache();
    if (!scope || parked?.scope !== scope) parked = undefined;
    notify();
  }, [scope, notify]);
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
          view = { ...view, cursor: snapshot.eventCursor, stateCursor: snapshot.eventCursor, hasOlder: snapshot.hasOlder };
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
      let messages = mergeMessages(current.messages, page.messages);
      if (messages.length > 1000) {
        // Trim only the remote tail while reading older pages; do not invent continuity.
        messages = messages.slice(0, 1000).concat(messages.slice(1000).filter(message => message.id.startsWith('pending-')));
        view.hasNewer = true;
      }
      view.hasOlder = page.hasOlder;
      patchActive(id, old => ({ ...old, messages, approvals: mergeById(old.approvals, page.approvals), questions: mergeById(old.questions, page.questions) }));
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
        const pageIds = new Set(page.messages.map(message => message.id));
        const latestSeq = page.messages.at(-1)?.seq ?? 0;
        patchActive(id, old => ({ ...old, messages: mergeMessages(mergeMessages(page.messages, view.deferred?.filter(message => message.seq > latestSeq || pageIds.has(message.id)) ?? []), old.messages.filter(message => message.id.startsWith('pending-') || message.seq > latestSeq)), approvals: mergeById(old.approvals, page.approvals), questions: mergeById(old.questions, page.questions) }));
        view.deferred = undefined;
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
    const controller = new AbortController();
    const signal = controller.signal;
    let stateTimer: number | undefined;
    let stateFlight = false;
    let stateDirty = false;
    let stateGeneration = 0;
    let stateFailures = 0;
    let failureCount = 0;
    let resyncCount = 0;
    let legacyTimer: number | undefined;
    let announcedSeq = cache.details[activeId]?.messages.filter(message => !message.id.startsWith('pending-')).at(-1)?.seq ?? 0;
    const applyState = (state: BotSyncState) => {
      if (state.eventCursor < view.stateCursor) return;
      view.stateCursor = state.eventCursor;
      patchActive(activeId, old => ({ ...old, ...state.thread, runs: state.runs, running: state.running, approvals: mergeById(old.approvals, state.approvals), questions: mergeById(old.questions, state.questions) }));
    };
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
    const refreshState = async () => {
      stateTimer = undefined;
      if (signal.aborted || cacheRef.current !== cache || !navigator.onLine || document.hidden) return;
      if (stateFlight) { stateDirty = true; return; }
      stateFlight = true; stateDirty = false;
      const generation = stateGeneration;
      try {
        const state = view.legacy
          ? await legacyState()
          : await serverClient.threadSyncState(activeId, cache.details[activeId]?.messages[0]?.seq, signal, cache.details[activeId]?.messages.filter(message => !message.id.startsWith('pending-')).at(-1)?.seq);
        if (!signal.aborted && cacheRef.current === cache) {
          if (generation === stateGeneration) applyState(state);
          else stateDirty = true;
          stateFailures = 0;
        }
      } catch (error) {
        if (terminal(error)) {
          if (error instanceof ServerApiError && [401, 403].includes(error.status)) window.dispatchEvent(new Event('wangke:bot-session-ended'));
          setSyncStatus('error'); controller.abort();
        }
        else if (!signal.aborted) { stateDirty = true; stateFailures++; }
      } finally {
        stateFlight = false;
        if (stateDirty && !signal.aborted) stateTimer = window.setTimeout(() => void refreshState(), Math.min(30_000, 200 * 2 ** Math.min(stateFailures, 7)));
      }
    };
    const invalidate = () => {
      stateGeneration++;
      if (!stateTimer && !stateFlight) stateTimer = window.setTimeout(() => void refreshState(), 80);
      else stateDirty = true;
    };
    const receive = (event: SseEvent, cursor: number) => {
      if (signal.aborted || cacheRef.current !== cache) return;
      if (event.type === 'resync.required') throw new Error('sync_resync_required');
      if (cursor <= view.cursor) return;
      if (event.type === 'thread.state_invalidated') invalidate();
      if ('message' in event) {
        const message = event.message;
        if (message.seq > announcedSeq && message.role === 'assistant' && message.kind !== 'progress') { announcedSeq = message.seq; setAnnouncement(value => value + 1); }
        if (message.role === 'assistant' && view.progress !== (message.kind === 'progress' ? message.content : undefined)) {
          view.progress = message.kind === 'progress' ? message.content : undefined;
          notify();
        }
        // Progress stays out of history; persisted run state owns running/terminal truth.
        if (!(message.role === 'assistant' && message.kind === 'progress') && !view.hasNewer) {
          patchActive(activeId, old => {
            let messages = mergeMessages(old.messages, [message]);
            if (messages === old.messages) return old;
            if (messages.length > 1000 && view.follow) { messages = messages.slice(-1000); view.hasOlder = true; }
            else if (messages.length > 1000) { view.hasNewer = true; messages = old.messages; }
            return { ...old, messages, updatedAt: message.createdAt > old.updatedAt ? message.createdAt : old.updatedAt };
          });
        }
        if (view.hasNewer && !(message.role === 'assistant' && message.kind === 'progress')) view.deferred = mergeMessages(view.deferred ?? [], [message]).slice(-1000);
        if (view.legacy && (message.kind === 'approval' || message.kind === 'question')) invalidate();
      }
      view.cursor = cursor;
      failureCount = 0;
      setSyncStatus(view.legacy ? 'connecting' : 'live');
    };
    const connect = async () => {
      while (!signal.aborted) {
        if (document.hidden || !navigator.onLine) { setSyncStatus('offline'); await pause(1000, signal); continue; }
        setSyncStatus('connecting');
        let retryAfterMs = 0;
        try {
          await serverClient.events(activeId, view.cursor, receive, signal, !view.legacy, () => { if (!signal.aborted) setSyncStatus('live'); });
        } catch (error) {
          if (signal.aborted) break;
          if (terminal(error)) {
            if (error instanceof ServerApiError && [401, 403].includes(error.status)) window.dispatchEvent(new Event('wangke:bot-session-ended'));
            delete cache.details[activeId]; cache.views.delete(activeId); notify();
            setSyncStatus('error'); controller.abort(); break;
          }
          if (error instanceof ServerApiError) retryAfterMs = error.retryAfterMs ?? 0;
          if (error instanceof Error && ['sync_resync_required', 'invalid_sync_event', 'sync_event_too_large'].includes(error.message)) {
            if (++resyncCount > 2) { setSyncStatus('error'); break; }
            // Keep readable history/drafts while rebuilding the current loaded range.
            try {
              const anchor = view.anchor;
              const anchorMessage = !view.follow && anchor ? cache.details[activeId]?.messages.find(message => message.id === anchor.key || `user-${message.clientNonce}` === anchor.key) : undefined;
              const beforeSeq = anchorMessage ? Math.min(Number.MAX_SAFE_INTEGER, anchorMessage.seq + 25) : undefined;
              const snapshot = await serverClient.threadSnapshot(activeId, signal, beforeSeq);
              if (signal.aborted) break;
              view.cursor = snapshot.eventCursor; view.stateCursor = snapshot.eventCursor;
              view.hasOlder = snapshot.hasOlder; view.hasNewer = Boolean(beforeSeq);
              setDetails(old => ({ ...old, [activeId]: { ...snapshot, messages: mergeMessages(snapshot.messages, old[activeId]?.messages.filter(message => message.id.startsWith('pending-')) ?? []) } }));
            } catch { setSyncStatus('error'); break; }
          }
        }
        if (signal.aborted) break;
        setSyncStatus('offline');
        await pause(Math.max(retryAfterMs, view.legacy ? 1800 : Math.min(30_000, 500 * 2 ** Math.min(failureCount++, 6)) * (0.8 + Math.random() * 0.4)), signal);
      }
    };
    // State is reconciled once when reopening a cached thread, then invalidation driven.
    void refreshState();
    if (view.legacy) legacyTimer = window.setInterval(() => void refreshState(), 3000);
    void connect();
    return () => { controller.abort(); clearTimeout(stateTimer); clearInterval(legacyTimer); };
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
