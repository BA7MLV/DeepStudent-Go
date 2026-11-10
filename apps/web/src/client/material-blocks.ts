import type { CollectionPage, RuntimeRead, RuntimeSnapshot } from '@wangke/contracts/client-runtime';
import { db, type MaterialBlockRow } from '../store/db';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { accountLifecycle } from './account-lifecycle';

const MAX_ROWS = 20000;
const MAX_BYTES = 16 * 1024 * 1024;
type Reader = { read(request: RuntimeRead): Promise<RuntimeSnapshot> };

/**
 * Complete, explicit material-block snapshot for ONE material via the bounded
 * collection protocol — never the business-IDB global mirror. The walk keeps
 * the protocol's per-page row/byte bounds, refuses to mix pages across
 * collection versions, and re-verifies the version after the walk so a write
 * that landed mid-walk is detected instead of silently truncated.
 *
 * Readers use this for display/labels; retrieval and search consume the same
 * rows. A failed or out-of-budget read surfaces as an error: unknown is not
 * "no blocks".
 */
export async function readMaterialBlocks(reader: Reader, materialId: string, guard: () => void): Promise<MaterialBlockRow[]> {
  if (typeof materialId !== 'string' || !materialId) throw new Error('invalid_material');
  const head = (await reader.read({ kind: 'collectionPage', table: 'materialBlocks', parent: materialId })).value as unknown as CollectionPage;
  guard();
  const rows: MaterialBlockRow[] = [];
  const seen = new Set<string>();
  let count = 0, bytes = 0;
  const encoder = new TextEncoder();
  let page = head;
  for (;;) {
    guard();
    if (page.epoch !== head.epoch || page.version !== head.version) throw new Error('material_blocks_changed');
    for (const record of page.records) {
      if (!record.value || record.table !== 'materialBlocks' || (record.value as Partial<MaterialBlockRow>).materialId !== materialId) throw new Error('invalid_material_blocks_projection');
      if (++count > MAX_ROWS || (bytes += encoder.encode(JSON.stringify(record)).byteLength) > MAX_BYTES) throw new Error('material_blocks_budget_exceeded');
      rows.push(record.value as unknown as MaterialBlockRow);
    }
    if (!page.next) break;
    if (seen.has(page.next)) throw new Error('material_blocks_cursor_cycle');
    seen.add(page.next);
    guard();
    page = (await reader.read({ kind: 'collectionPage', table: 'materialBlocks', parent: materialId, cursor: page.next })).value as unknown as CollectionPage;
  }
  // A write that landed after the walk but before this barrier must invalidate
  // the snapshot instead of publishing stale labels next to fresh content.
  const verified = (await reader.read({ kind: 'collectionPage', table: 'materialBlocks', parent: materialId })).value as unknown as CollectionPage;
  guard();
  if (verified.epoch !== head.epoch || verified.version !== head.version) throw new Error('material_blocks_changed');
  return rows.sort((a, b) => a.idx - b.idx);
}

/** Existence only (chat retrieval readiness): the first protocol page answers
 * "are there retrievable text blocks at all" without walking large bodies. */
export async function materialBlocksExist(reader: Reader, materialId: string, guard: () => void): Promise<boolean> {
  const page = (await reader.read({ kind: 'collectionPage', table: 'materialBlocks', parent: materialId })).value as unknown as CollectionPage;
  guard();
  if (page.records.some(record => record.table !== 'materialBlocks' || !record.value)) throw new Error('invalid_material_blocks_projection');
  return page.records.length > 0;
}

/**
 * Mode-aware entry: cloud mode reads the authoritative bounded projection and
 * never trusts a partial local mirror; explicit local-history mode keeps the
 * IndexedDB table as its own authority.
 */
export async function loadMaterialBlocksSnapshot(materialId: string, guard: () => void): Promise<MaterialBlockRow[]> {
  if (!cloud.enabled) return db.materialBlocks.where('materialId').equals(materialId).sortBy('idx');
  const owner = cloud.userId, database = db, lifetime = accountLifecycle.current();
  const runtime = await serverRuntime(owner);
  const guarded = () => {
    lifetime?.assertCurrent();
    if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    guard();
  };
  guarded();
  return readMaterialBlocks(runtime, materialId, guarded);
}

/** Mode-aware existence check with the same account/instance guards. */
export async function materialBlocksSnapshotExist(materialId: string, guard: () => void): Promise<boolean> {
  if (!cloud.enabled) return (await db.materialBlocks.where('materialId').equals(materialId).count()) > 0;
  const owner = cloud.userId, database = db, lifetime = accountLifecycle.current();
  const runtime = await serverRuntime(owner);
  const guarded = () => {
    lifetime?.assertCurrent();
    if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    guard();
  };
  guarded();
  return materialBlocksExist(runtime, materialId, guarded);
}
