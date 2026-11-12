import type { CollectionPage, ProjectionTable, RuntimeRead, RuntimeSnapshot, RuntimeRecord } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { accountLifetime } from './account-lifecycle';

type Reader = { read(request: RuntimeRead): Promise<RuntimeSnapshot> };
/** An explicit complete scope, not a UI page or an account mirror. Never publish
 * half a walk, mixed generations, or an over-budget result as an empty scope. */
export async function readCollection<T>(reader: Reader, table: ProjectionTable, parent: string | number | undefined,
  guard: () => void, first?: CollectionPage): Promise<{ rows: T[]; records: RuntimeRecord[]; epoch: string; version: number }> {
  const request = { kind: 'collectionPage' as const, table, ...(parent === undefined ? {} : { parent }) };
  const parentField = table === 'chats' ? 'sessionId' : table === 'skillRefs' ? 'skillId'
    : table === 'materialBlocks' || table === 'materialInk' ? 'materialId' : 'videoId';
  const head = first ?? (await reader.read(request)).value as unknown as CollectionPage;
  const rows: T[] = [], seen = new Set<string>(), keys = new Set<string>();
  const records: RuntimeRecord[] = [];
  let page = head, bytes = 0;
  for (;;) {
    guard();
    if (page.epoch !== head.epoch || page.version !== head.version) throw new Error('collection_snapshot_changed');
    for (const record of page.records) {
      const key = JSON.stringify(record.key);
      if (record.table !== table || !record.value || keys.has(key) || parent !== undefined && record.value[parentField] !== parent) throw new Error('invalid_collection_projection');
      keys.add(key);
      bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength;
      if (rows.length >= 20000 || bytes > 16 * 1024 * 1024) throw new Error('collection_snapshot_budget_exceeded');
      rows.push(record.value as unknown as T);
      records.push(record);
    }
    if (!page.next) break;
    if (seen.has(page.next)) throw new Error('collection_cursor_cycle');
    seen.add(page.next);
    page = (await reader.read({ ...request, cursor: page.next })).value as unknown as CollectionPage;
  }
  const verified = (await reader.read(request)).value as unknown as CollectionPage;
  guard();
  if (verified.epoch !== head.epoch || verified.version !== head.version) throw new Error('collection_snapshot_changed');
  return { rows, records, epoch: head.epoch, version: head.version };
}

export async function loadCollection<T>(table: ProjectionTable, parent: string | number | undefined): Promise<T[]> {
  const owner = cloud.userId, database = db, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => { lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  guard();
  return (await readCollection<T>(runtime, table, parent, guard)).rows;
}

/** Observes only the requested collection head; downstream pages are a bounded,
 * verified snapshot. Last complete value belongs to the caller on failure. */
export function observeCollection<T>(table: ProjectionTable, parent: string | number | undefined,
  observer: { next(rows: T[]): void; error(error: unknown): void }) {
  const owner = cloud.userId, database = db, lifetime = accountLifetime(owner);
  let closed = false, cleanup: (() => void) | undefined;
  const guard = () => { lifetime.assertCurrent(); if (closed || database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  const unown = lifetime.own(() => { closed = true; cleanup?.(); });
  void serverRuntime(owner).then(runtime => {
    guard();
    const projection = runtime.collection({ kind: 'collectionPage', table, ...(parent === undefined ? {} : { parent }) });
    let running = false, dirty = false;
    const pump = () => {
      if (closed || running || !dirty) return;
      const snapshot = projection.model.getSnapshot();
      if (snapshot.status === 'error') { dirty = false; observer.error(new Error(snapshot.error)); return; }
      if (snapshot.status !== 'ready' || !snapshot.data) return;
      dirty = false; running = true;
      const head = snapshot.data as unknown as CollectionPage;
      void readCollection<T>(runtime, table, parent, () => { guard(); if (!isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); }, head).then(value => {
        guard();
        const latest = projection.model.getSnapshot().data as unknown as CollectionPage;
        if (latest.epoch !== value.epoch || latest.version !== value.version) { dirty = true; return; }
        observer.next(value.rows);
      }).catch(error => {
        if (closed || !lifetime.current()) return;
        if ((error as Error).message === 'collection_snapshot_changed') dirty = true;
        else observer.error(error);
      }).finally(() => { running = false; pump(); });
    };
    const observe = () => { dirty = true; pump(); };
    const off = projection.model.subscribe(observe), release = projection.model.acquire();
    cleanup = () => { off(); release(); projection.dispose(); };
    observe();
  }).catch(error => { if (!closed && lifetime.current()) observer.error(error); });
  return { unsubscribe() { closed = true; cleanup?.(); unown(); } };
}
