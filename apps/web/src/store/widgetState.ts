import { liveQuery } from 'dexie';
import { db, type ChatRow, type LocalWidgetStateRow } from './db.ts';
import type { WidgetPayload } from '../harness/widgetRuntime.ts';
import { normalizeWidgetState, type WidgetState } from '../harness/widgetState.ts';
import { messageWidgets } from '../harness/widgetLayout.ts';
import { accountLifecycle, type AccountLifetime } from '../client/account-lifecycle';
import { WIDGET_READY_TIMEOUT_MS } from '../harness/widgetDiagnostics';

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

function findSource(row: ChatRow | undefined, payload: WidgetPayload): WidgetPayload | undefined {
  if (!row || row.role !== 'assistant') return;
  return messageWidgets(row).find((widget) => widget.html === payload.html
    && JSON.stringify(widget.libs ?? []) === JSON.stringify(payload.libs ?? [])
    && (!payload.id || widget.id === payload.id));
}

function assertSession(row: ChatRow | undefined, session: WidgetSession): asserts row is ChatRow {
  if (!row || row.role !== 'assistant' || row.sessionId !== session.sessionId || row.videoId !== session.videoId
    || !messageWidgets(row).some((widget, index) => (session.legacyIndex == null
      ? widget.id === session.widgetId : !widget.id && index === session.legacyIndex)
      && widget.html === session.html
      && JSON.stringify(widget.libs ?? []) === session.libs))
    throw new Error('此交互讲解已修改或删除，请回到当前回答重新打开');
}

/** Wait only on this primary key, never fetch/flush or manufacture a cache row.
 * A session journal can deliver the source before the confirmed cache catches up.
 * This is initial admission only: established bindings still fail assertSession
 * immediately on deletion/revision change and cannot wait their way back to life. */
function waitForWidgetSource(database: typeof db, rowId: number, payload: WidgetPayload, guard: () => void, signals: AbortSignal[]): Promise<ChatRow> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let subscription: { unsubscribe(): void } | undefined;
    const finish = (error?: unknown, row?: ChatRow) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      subscription?.unsubscribe();
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
  });
}

function matchesSnapshot(snapshot: LocalWidgetStateRow | undefined, session: WidgetSession): snapshot is LocalWidgetStateRow {
  return !!snapshot && snapshot.sessionId === session.sessionId && snapshot.videoId === session.videoId
    && snapshot.html === session.html && snapshot.libs === session.libs;
}

/** Admission and persistence are entirely local; opening a legacy widget never edits its message. */
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
    const row = options.waitForSource
      ? await waitForWidgetSource(database, rowId, payload, guard, signals)
      : await database.chats.get(rowId);
    guard();
    const source = findSource(row, payload);
    if (!row || !source) throw new Error('此交互讲解已修改或删除，请重新打开');
    const legacyIndex = source.id ? undefined : messageWidgets(row).indexOf(source);
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
  return liveQuery(() => readWidgetState(session));
}
