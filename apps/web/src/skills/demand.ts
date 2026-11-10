import type { CollectionPage, RuntimeRecord, SkillIndexItem, SkillIndexPage } from '@wangke/contracts/client-runtime';
import { cloud } from '../cloud/state';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { isCurrentServerRuntime, serverRuntime } from '../client/bootstrap';

// Discovery is intentionally complete for @name resolution, but is not an
// unbounded cache. Over-budget catalogs fail explicitly instead of dropping
// enabled skills and silently changing model context or draft interpretation.
const SKILL_CATALOG_ITEMS = 4096;
const SKILL_CATALOG_BYTES = 8 * 1024 * 1024;

/** Explicit package editing needs every reference, not a possibly partial IDB
 * mirror. Do not hydrate partial pages or derive deletion from local absence. */
export async function readSkillReferenceSnapshot(skillId: number): Promise<{ records: RuntimeRecord[]; epoch: string; version: number }> {
  const owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (cloud.userId !== owner || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  };
  guard();
  const request = { kind: 'collectionPage', table: 'skillRefs', parent: skillId } as const;
  let page = (await runtime.read(request)).value as unknown as CollectionPage;
  const { epoch, version } = page, records: RuntimeRecord[] = [];
  for (;;) {
    guard();
    if (page.epoch !== epoch || page.version !== version) throw new Error('projection_cursor_expired');
    if (page.records.some(row => row.table !== 'skillRefs' || row.value?.skillId !== skillId)) throw new Error('protocol_skill_reference_scope');
    records.push(...page.records);
    if (!page.next) return { records, epoch, version };
    page = (await runtime.read({ ...request, cursor: page.next })).value as unknown as CollectionPage;
  }
}

export async function readSkillReferences(skillId: number): Promise<RuntimeRecord[]> {
  return (await readSkillReferenceSnapshot(skillId)).records;
}

/** Discovery is complete or fails; never expose a successful partial catalog.
 * Pages are independent from the global records cursor and never enter IDB as
 * incomplete skill rows. Callers cancel between pages when their view expires. */
export async function readSkillIndex(first?: SkillIndexPage, current: () => boolean = () => true): Promise<SkillIndexItem[]> {
  const owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (!current() || cloud.userId !== owner || !isCurrentServerRuntime(runtime)) throw new Error('skill_read_cancelled');
  };
  guard();
  for (let attempt = 0; ; attempt++) {
    try {
      let page = first ?? (await runtime.read({ kind: 'skillIndex' })).value as unknown as SkillIndexPage;
      guard();
      const { epoch, version } = page, rows: SkillIndexItem[] = [];
      let bytes = 0;
      for (;;) {
        guard();
        if (page.epoch !== epoch || page.version !== version) throw new Error('projection_cursor_expired');
        bytes += new TextEncoder().encode(JSON.stringify(page.skills)).byteLength;
        if (bytes > SKILL_CATALOG_BYTES || rows.length + page.skills.length > SKILL_CATALOG_ITEMS) throw new Error('skill_catalog_budget_exceeded');
        rows.push(...page.skills);
        if (!page.next) return rows.sort((a, b) => a.id - b.id);
        page = (await runtime.read({ kind: 'skillIndex', cursor: page.next })).value as unknown as SkillIndexPage;
      }
    } catch (error) {
      guard();
      // One fresh restart, not an unbounded retry loop during active edits.
      if (attempt || first || !/projection_cursor_expired/.test(String(error))) throw error;
    }
  }
}

export type SkillCatalogSnapshot = { rows?: SkillIndexItem[]; ready: boolean; error?: string };
type Catalog = { subscribe(listener: (snapshot: SkillCatalogSnapshot) => void): () => void };
const catalogs = new WeakMap<AccountLifetime, Catalog>();

export async function retrySkillCatalog() {
  const owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  lifetime.assertCurrent();
  if (owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  runtime.skillIndex().refresh();
}

/** One retained Runtime observation AND one metadata traversal per account,
 * shared by all message chips and composers. No per-message HTTP fan-out. */
export function observeSkillCatalog(listener: (snapshot: SkillCatalogSnapshot) => void): () => void {
  const owner = cloud.userId, lifetime = accountLifetime(owner);
  let catalog = catalogs.get(lifetime);
  if (!catalog) {
    const listeners = new Set<(snapshot: SkillCatalogSnapshot) => void>();
    let state: SkillCatalogSnapshot = { ready: false }, generation = 0;
    let stop: (() => void) | undefined;
    const publish = (next: SkillCatalogSnapshot) => { state = next; for (const notify of listeners) notify(state); };
    const start = () => {
      let stopped = false;
      let off: (() => void) | undefined, release: (() => void) | undefined;
      const cleanup = () => { stopped = true; ++generation; off?.(); release?.(); };
      const unown = lifetime.own(() => { cleanup(); publish({ ready: false, error: 'client_account_changed' }); });
      stop = () => { cleanup(); unown(); stop = undefined; state = { ready: false }; };
      publish({ ...state, ready: false, error: undefined });
      void serverRuntime(owner).then(runtime => {
        const valid = () => !stopped && lifetime.current() && owner === cloud.userId && isCurrentServerRuntime(runtime);
        if (!valid()) return;
        const model = runtime.skillIndex();
        let head: SkillIndexPage | undefined;
        const update = () => {
          if (!valid()) return;
          const snapshot = model.getSnapshot();
          if (snapshot.status === 'error') {
            ++generation; head = undefined;
            publish({ ...state, ready: false, error: snapshot.error });
            return;
          }
          if (snapshot.status !== 'ready' || !snapshot.data) {
            ++generation; head = undefined;
            publish({ ...state, ready: false });
            return;
          }
          const first = snapshot.data as unknown as SkillIndexPage;
          if (head?.epoch === first.epoch && head.version === first.version) return;
          head = first;
          const fence = ++generation;
          publish({ ...state, ready: false, error: undefined });
          void readSkillIndex(first, () => valid() && generation === fence).then(rows => {
            if (valid() && fence === generation) publish({ rows, ready: true });
          }).catch(error => {
            if (!valid() || fence !== generation) return;
            head = undefined;
            publish({ ...state, ready: false, error: String(error) });
            if (/projection_cursor_expired/.test(String(error))) model.refresh();
          });
        };
        off = model.subscribe(update); release = model.acquire(); update();
      }).catch(error => { if (!stopped && lifetime.current()) publish({ ...state, ready: false, error: String(error) }); });
    };
    catalog = { subscribe(notify) {
      listeners.add(notify);
      if (listeners.size === 1) start(); else notify(state);
      return () => { listeners.delete(notify); if (!listeners.size) stop?.(); };
    } };
    catalogs.set(lifetime, catalog);
  }
  return catalog.subscribe(listener);
}
