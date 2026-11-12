import { liveQuery } from 'dexie';
import { db, type ChatRow, type LocalWidgetStateRow } from './db.ts';
import type { WidgetPayload } from '../harness/widgetRuntime.ts';
import { normalizeWidgetState, type WidgetState } from '../harness/widgetState.ts';
import { messageWidgets } from '../harness/widgetLayout.ts';
import { accountLifecycle, type AccountLifetime } from '../client/account-lifecycle';
import { WIDGET_READY_TIMEOUT_MS } from '../harness/widgetDiagnostics';
import { cloud } from '../cloud/state';
import { readConversationMessage } from './conversationProducts';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { legacyHtmlSources } from './legacyHtmlWorks';
import i18n from '../i18n';

export interface WidgetSession {
  rowId: number;
  sessionId: number;
  videoId: string;
  widgetId: string;
  html: string;
  libs: string;
  /** Id-less historical sources get a stable local slot, without editing the cloud message. */
  legacyIndex?: number;
}
const sessionScopes = new WeakMap<WidgetSession, { database: typeof db; lifetime?: AccountLifetime }>();
function assertScope(session: WidgetSession) {
  const scope = sessionScopes.get(session);
  if (scope && scope.database !== db) throw new Error('client_account_changed');
  scope?.lifetime?.assertCurrent();
}

function sources(row: ChatRow): WidgetPayload[] {
  const html = legacyHtmlSources(row.content);
  return [...messageWidgets(row), ...(row.legacyHtmlWorks ?? []).filter(work => html.has(work.source)).map(work => work.payload)];
}

function findSource(row: ChatRow | undefined, payload: WidgetPayload): WidgetPayload | undefined {
  if (!row || row.role !== 'assistant') return;
  return sources(row).find((widget) => widget.html === payload.html
    && JSON.stringify(widget.libs ?? []) === JSON.stringify(payload.libs ?? [])
    && (!payload.id || widget.id === payload.id));
}

function assertSession(row: ChatRow | undefined, session: WidgetSession): asserts row is ChatRow {
  if (!row || row.role !== 'assistant' || row.sessionId !== session.sessionId || row.videoId !== session.videoId
    || !sources(row).some((widget, index) => (session.legacyIndex == null
      ? widget.id === session.widgetId : !widget.id && index === session.legacyIndex)
      && widget.html === session.html
      && JSON.stringify(widget.libs ?? []) === session.libs))
    throw new Error('此交互讲解已修改或删除，请回到当前回答重新打开');
}

/** A single-key server watcher, owned by the caller, never an account mirror.
 * Validate the remote row itself: an obsolete cached row cannot hide revocation. */
function watchSource(rowId: number, next: (row: ChatRow | undefined) => void, error: (error: unknown) => void) {
  const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
  let closed = false, off: (() => void) | undefined, release: (() => void) | undefined, unown: (() => void) | undefined;
  const stop = () => { closed = true; off?.(); release?.(); unown?.(); };
  unown = lifetime?.own(() => { if (!closed) error(new Error('client_account_changed')); stop(); });
  void serverRuntime(owner).then(runtime => {
    if (closed) return;
    const model = runtime.recordKeys({ kind: 'recordKeys', keys: [{ table: 'chats', key: rowId }] });
    const observe = () => {
      if (closed) return;
      try {
        lifetime?.assertCurrent();
        if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
        const snapshot = model.getSnapshot();
        if (snapshot.status === 'error') throw new Error(snapshot.error);
        if (snapshot.status !== 'ready' || !snapshot.data) return;
        const value = snapshot.data as unknown as { records: { table: string; key: number; value: ChatRow | null }[] };
        const record = value.records[0];
        if (value.records.length !== 1 || record.table !== 'chats' || record.key !== rowId) throw new Error('invalid_widget_source_projection');
        next(record.value ?? undefined);
      } catch (reason) { error(reason); }
    };
    off = model.subscribe(observe); release = model.acquire(); observe();
  }).catch(reason => { if (!closed) error(reason); });
  return stop;
}

/** Wait only on this primary key, never flush or manufacture a cache row.
 * A session journal can deliver the source before the confirmed cache catches up.
 * This is initial admission only: established bindings still fail assertSession
 * immediately on deletion/revision change and cannot wait their way back to life. */
function waitForWidgetSource(database: typeof db, rowId: number, payload: WidgetPayload, guard: () => void, signals: AbortSignal[]): Promise<ChatRow> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;
    let stopRemote: (() => void) | undefined;
    const finish = (error?: unknown, row?: ChatRow) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
      stopRemote?.();
      for (const signal of signals) signal.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(row!);
    };
    const abort = () => finish(signals.find(signal => signal.aborted)?.reason ?? new Error('交互讲解已取消'));
    const timer = setTimeout(() => finish(new Error('等待交互讲解归属投影超时，请重试预览')), WIDGET_READY_TIMEOUT_MS);
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    try { guard(); } catch (error) { finish(error); return; }
    subscription = liveQuery(() => database.chats.get(rowId)).subscribe({
      next: row => {
        try { guard(); } catch (error) { finish(error); return; }
        if (findSource(row, payload)) finish(undefined, row);
      },
      error: error => finish(error),
    });
    // Also covers a synchronous observable error during subscribe.
    if (settled) subscription.unsubscribe();
    if (!settled && cloud.enabled) {
      stopRemote = watchSource(rowId, row => {
        if (!findSource(row, payload) || settled) return;
        // Install only via the normal epoch/revision-checked exact-key reader.
        void readConversationMessage(rowId).then(current => {
          guard();
          if (findSource(current, payload)) finish(undefined, current);
        }).catch(reason => finish(reason));
      }, reason => finish(reason));
      if (settled) stopRemote();
    }
  });
}

function matchesSnapshot(snapshot: LocalWidgetStateRow | undefined, session: WidgetSession): snapshot is LocalWidgetStateRow {
  return !!snapshot && snapshot.sessionId === session.sessionId && snapshot.videoId === session.videoId
    && snapshot.html === session.html && snapshot.libs === session.libs;
}

/** Stop the admission waiter immediately; shared exact-key reads retain their
 * own account/epoch guards and may finish without reviving a cancelled view. */
function cancellable<T>(work: Promise<T>, signals: AbortSignal[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { for (const signal of signals) signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(signals.find(signal => signal.aborted)?.reason ?? new Error(i18n.t('dataDelivery.widgetCancelled'))); };
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    if (signals.some(signal => signal.aborted)) abort();
    work.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Authoritative source admission; snapshots stay device-local. */
export async function openWidgetSession(rowId: number, payload: WidgetPayload, options: { waitForSource?: boolean; signal?: AbortSignal } = {}): Promise<WidgetSession> {
  const database = db;
  const lifetime = accountLifecycle.current();
  const signals = [options.signal, lifetime?.signal].filter((signal): signal is AbortSignal => !!signal);
  const guard = () => {
    if (database !== db) throw new Error('client_account_changed');
    lifetime?.assertCurrent();
    for (const signal of signals) if (signal.aborted) throw signal.reason ?? new Error('交互讲解已取消');
  };
  const run = async () => {
    guard();
    let row: ChatRow | undefined;
    try { row = await cancellable(readConversationMessage(rowId), signals); }
    catch (error) {
      guard();
      // A missing-row read can race the task's first committed source. The
      // exact-key reader correctly refuses that mixed head; wait for a fresh
      // single-key baseline instead of turning it into success or a false 404.
      if (!options.waitForSource || !(error instanceof Error) || error.message !== 'collection_snapshot_changed') throw error;
    }
    guard();
    if (!findSource(row, payload) && options.waitForSource) row = await waitForWidgetSource(database, rowId, payload, guard, signals);
    guard();
    const source = findSource(row, payload);
    if (!row || !source) throw new Error('此交互讲解已修改或删除，请重新打开');
    const legacyIndex = source.id ? undefined : sources(row).indexOf(source);
    const widgetId = source.id || `legacy:${legacyIndex}`;
    const session = { rowId, sessionId: row.sessionId, videoId: row.videoId, widgetId, html: source.html,
      libs: JSON.stringify(source.libs ?? []), legacyIndex };
    sessionScopes.set(session, { database, lifetime });
    await database.transaction('rw', database.chats, database._widgetStates, async () => {
      const current = await database.chats.get(rowId);
      guard();
      assertSession(current, session);
      const previous = await database._widgetStates.get([rowId, widgetId]);
      guard();
      if (matchesSnapshot(previous, session)) return;
      // Import historical inline state once. Later cloud projections must never
      // overwrite this device's UI. A null marker also prevents repeated imports.
      const legacy = current.widgetStates?.[widgetId]
        ?? (current.widgetState?.widgetId === widgetId ? current.widgetState.value : null);
      await database._widgetStates.put({ ...session, state: previous || legacy == null ? null : normalizeWidgetState(legacy) });
      guard();
    });
    guard();
    return session;
  };
  return run();
}

export async function readWidgetState(session: WidgetSession): Promise<WidgetState | null> {
  assertScope(session);
  await readConversationMessage(session.rowId);
  assertScope(session);
  return readLocalWidgetState(session);
}

async function readLocalWidgetState(session: WidgetSession): Promise<WidgetState | null> {
  assertScope(session);
  const database = db;
  return database.transaction('r', database.chats, database._widgetStates, async () => {
    const row = await database.chats.get(session.rowId);
    const snapshot = await database._widgetStates.get([session.rowId, session.widgetId]);
    if (database !== db) throw new Error('client_account_changed');
    assertScope(session);
    assertSession(row, session);
    return matchesSnapshot(snapshot, session) && snapshot.state != null ? normalizeWidgetState(snapshot.state) : null;
  });
}

/** The ACK is sent only after this transaction commits. Stale frames cannot recreate deleted rows. */
export async function saveWidgetState(session: WidgetSession, raw: unknown): Promise<WidgetState> {
  assertScope(session);
  await readConversationMessage(session.rowId);
  assertScope(session);
  const database = db;
  const state = normalizeWidgetState(raw);
  await database.transaction('rw', database.chats, database._widgetStates, async () => {
    const row = await database.chats.get(session.rowId);
    if (database !== db) throw new Error('client_account_changed');
    assertScope(session);
    assertSession(row, session);
    await database._widgetStates.put({ rowId: session.rowId, widgetId: session.widgetId,
      sessionId: session.sessionId, videoId: session.videoId, html: session.html, libs: session.libs, state });
    assertScope(session);
  });
  return state;
}

export function observeWidgetState(session: WidgetSession) {
  return { subscribe(observer: { next(value: WidgetState | null): void; error(error: unknown): void }) {
    let closed = false, local: { unsubscribe(): void } | undefined, stopRemote: (() => void) | undefined;
    const unsubscribe = () => { closed = true; local?.unsubscribe(); stopRemote?.(); };
    const failed = (error: unknown) => { if (!closed) { unsubscribe(); observer.error(error); } };
    local = liveQuery(() => readLocalWidgetState(session)).subscribe({ next: value => { if (!closed) observer.next(value); }, error: failed });
    if (cloud.enabled) stopRemote = watchSource(session.rowId, row => {
      try { assertScope(session); assertSession(row, session); } catch (error) { failed(error); }
    }, failed);
    if (closed) unsubscribe();
    return { unsubscribe };
  } };
}
