import Dexie from 'dexie';
import { db, legacyExecutorDatabaseName, legacyCloudDatabaseName } from '../store/db';
import { cloud } from './state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { encodeRecoveryValue } from './recovery-export';
import { commandDigest } from '../client/command-digest';

export interface RecoveryEntry { id: string; title: string; fingerprint: string; pending: boolean; handled: boolean; count: number; dismissible?: boolean }
const containsAttachment = (value: unknown): boolean => value instanceof Blob ||
  !!value && typeof value === 'object' && Object.values(value).some(containsAttachment);
// Listing can inspect small command metadata, but never read attachment bytes.
const evidenceMetadata = (value: unknown): unknown => {
  if (value instanceof Blob) return { attachmentSize: value.size, attachmentType: value.type };
  if (Array.isArray(value)) return value.map(evidenceMetadata);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evidenceMetadata(item)]));
  return value;
};
/** Dynamic schema open only: no version declaration, upgrades or source writes. */
async function readSource<T>(owner: string, name: string, read: (database: Dexie) => Promise<T>): Promise<T> {
  const scope = db;
  if (!owner || owner !== cloud.userId || !await Dexie.exists(name)) throw new Error('executor_recovery_not_found');
  const database = new Dexie(name);
  try {
    await database.open();
    const value = await database.transaction('r', database.tables, () => read(database));
    if (owner !== cloud.userId || scope !== db) throw new Error('client_account_changed');
    return value;
  } finally { database.close(); }
}
async function sourceSummary(owner: string, name: string) {
  return readSource(owner, name, async database => {
    const counts: Record<string, number> = {};
    const keys: Record<string, string[]> = {};
    for (const table of database.tables) {
      counts[table.name] = await table.count();
      // Keys only, never materialize attachment values on the list screen.
      keys[table.name] = (await table.toCollection().primaryKeys()).map(String);
    }
    return { counts, fingerprint: JSON.stringify([name, keys]) };
  });
}
export async function listExecutorRecovery(owner: string): Promise<RecoveryEntry[]> {
  const scope = db, rows: RecoveryEntry[] = [];
  if (!owner || owner !== cloud.userId) return rows;
  for (const [name, id] of [[legacyExecutorDatabaseName(owner), 'executor-legacy-snapshot'], [legacyCloudDatabaseName(owner), 'main-legacy-snapshot']]) {
    if (!await Dexie.exists(name)) continue;
    const summary = await sourceSummary(owner, name);
    const count = Object.values(summary.counts).reduce((a, b) => a + b, 0);
    if (count) rows.push({ id, title: '旧版本本地数据', count, fingerprint: summary.fingerprint, pending: false, handled: false });
    if (id === 'executor-legacy-snapshot') {
      const evidence = await readSource(owner, name, async database => {
        const keys = database.tables.some(t => t.name === '_cloudMeta') ? (await database.table('_cloudMeta').toCollection().primaryKeys()).map(String).filter(key => /^(executor-|resource-command:)/.test(key)) : [];
        const meta = await Promise.all(keys.map(key => database.table('_cloudMeta').get(key)));
        const outbox = summary.counts._cloudOutbox ?? 0;
        return { meta, outbox };
      });
      for (const item of evidence.meta) {
        const value = item?.value;
        if (!item) continue;
        const concrete = !!(value?.operationId || value?.request?.operationId || value?.taskId || ['queued', 'uncertain', 'conflict'].includes(value?.state));
        const attachment = containsAttachment(item);
        rows.push({ id: item.id, title: concrete ? '旧版本操作待核对' : '旧版本本地记录', count: 1,
          fingerprint: await commandDigest(evidenceMetadata(item)), pending: concrete && (attachment || value?.state !== 'confirmed' && value?.receipt?.status !== 'completed'), handled: false,
          dismissible: !attachment });
      }
      // A keys-only signature cannot prove a mutable outbox's payload unchanged.
      // Never let a blanket marker hide a same-key attachment/intent replacement.
      if (evidence.outbox) rows.push({ id: 'executor-legacy-outbox', title: '旧版本未确认修改', count: evidence.outbox, fingerprint: summary.fingerprint, pending: true, handled: false, dismissible: false });
    }
  }
  for (const row of await scope.table('_historyRecovery').toArray()) {
    if (row.source && (row.transaction || row.journalId)) rows.push({ id: `main:${row.id}`, title: '旧版本未确认修改', count: row.count,
      fingerprint: row.fingerprint, pending: !['resolved', 'converted'].includes(row.state) && (row.changedEvidence || row.receipt?.status !== 'completed'), handled: false });
  }
  for (const row of rows) {
    row.handled = row.dismissible !== false && !!await scope.table('_historyRecovery').get(`handled:${row.id}:${row.fingerprint}`);
    // An identity-only receipt cannot verify bytes omitted from this fingerprint.
    if (row.dismissible !== false && (await scope.table('_historyRecovery').get(`receipt:${row.id}:${row.fingerprint}`))?.receipt?.status === 'completed') row.pending = false;
  }
  if (scope !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  return rows;
}
const inspections = new WeakMap<object, { owner: string; current(): boolean }>();
export async function inspectExecutorRecovery(id: string, queryServer = false) {
  const owner = cloud.userId, scope = db;
  const current = () => owner === cloud.userId && scope === db;
  const entry = (await listExecutorRecovery(owner)).find(row => row.id === id);
  if (!entry) throw new Error('executor_recovery_not_found');
  let row: any;
  if (id.startsWith('main:')) row = await scope.table('_historyTransactions').get(id.slice(5));
  else {
    const name = id === 'main-legacy-snapshot' ? legacyCloudDatabaseName(owner) : legacyExecutorDatabaseName(owner);
    row = await readSource(owner, name, async database => {
      if (id.endsWith('legacy-snapshot')) return { id, tables: Object.fromEntries(await Promise.all(database.tables.map(async t => [t.name, await t.count()]))) };
      if (id === 'executor-legacy-outbox') return { id, count: await database.table('_cloudOutbox').count() };
      return database.table('_cloudMeta').get(id);
    });
  }
  const operationId = row?.transaction ?? row?.journal?.value?.operationId ?? row?.journal?.value?.request?.operationId ?? row?.value?.operationId ?? row?.value?.request?.operationId;
  let receipt = null, server = null, remoteError: string | undefined;
  // Local inspection/export does not need an available server carrier.
  if (queryServer && typeof operationId === 'string') {
    try {
      const runtime = await serverRuntime(owner);
      const result = await runtime.receipt(operationId);
      if (!current() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      receipt = result;
       if (id.startsWith('main:')) await scope.table('_historyRecovery').update(id.slice(5), { receipt });
       else await scope.table('_historyRecovery').put({ id: `receipt:${id}:${entry.fingerprint}`, receipt });
    } catch (error) { if (!current()) throw error; remoteError = '服务器暂不可达，本地原稿仍可导出'; }
  }
  if (!current()) throw new Error('client_account_changed');
  const detail = { entry, row: { ...row, id }, receipt, server, observed: null, remoteError };
  inspections.set(detail, { owner, current }); return detail;
}
export async function exportExecutorRecovery(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>) {
  const scope = inspections.get(detail);
  if (!scope?.current()) throw new Error('client_account_changed');
  let row: any;
  if (detail.entry.id.startsWith('main:')) row = await db.table('_historyTransactions').get(detail.entry.id.slice(5));
  else {
    const name = detail.entry.id === 'main-legacy-snapshot' ? legacyCloudDatabaseName(scope.owner) : legacyExecutorDatabaseName(scope.owner);
    row = await readSource(scope.owner, name, async database => {
      if (detail.entry.id.endsWith('legacy-snapshot')) {
        const value: Record<string, unknown[]> = {};
        for (const table of database.tables) value[table.name] = await table.toArray();
        return { id: detail.entry.id, value };
      }
      if (detail.entry.id === 'executor-legacy-outbox') return { id: detail.entry.id, rows: await database.table('_cloudOutbox').toArray() };
      return database.table('_cloudMeta').get(detail.entry.id);
    });
  }
  const value = await encodeRecoveryValue({ ...detail, row });
  if (!scope.current()) throw new Error('client_account_changed');
  return value;
}
export async function markExecutorRecoveryHandled(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>) {
  const scope = inspections.get(detail);
  if (!scope?.current()) throw new Error('client_account_changed');
  if (detail.entry.dismissible === false) throw new Error('executor_recovery_payload_unverified');
  await db.table('_historyRecovery').put({ id: `handled:${detail.entry.id}:${detail.entry.fingerprint}`, handledAt: Date.now() });
}
