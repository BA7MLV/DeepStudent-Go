import Dexie from 'dexie';
import { db, legacyCloudDatabaseName } from '../store/db';
import { cloud } from './state';
import type { OutboxRow } from './cache';
import { commandDigest } from '../client/command-digest';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { queueLearning } from '../client/learning';
import type { ClientLearningEdit } from '@wangke/contracts/client-runtime';

/** Copy first, never mutate the source. Unknown old effects are not converted to
 * new identities. Re-entrant by source + original transaction identity. */
export async function preserveLegacyCloudData() {
  const owner = cloud.userId, database = db, name = legacyCloudDatabaseName(owner);
  if (!await Dexie.exists(name)) return;
  const source = new Dexie(name);
  const guard = () => { if (owner !== cloud.userId || database !== db) throw new Error('client_account_changed'); };
  try {
    await source.open(); guard();
    const value = await source.transaction('r', source.tables, async () => ({
      rows: source.tables.some(t => t.name === '_cloudOutbox') ? await source.table<OutboxRow>('_cloudOutbox').toArray() : [],
      meta: source.tables.some(t => t.name === '_cloudMeta') ? await source.table('_cloudMeta').toArray() : [],
    }));
    guard();
    const groups = new Map<string, OutboxRow[]>();
    for (const row of value.rows) { const group = groups.get(row.transaction) ?? []; group.push(row); groups.set(row.transaction, group); }
    const fingerprints = new Map(await Promise.all([...groups].map(async ([id, rows]) => [id, await commandDigest(rows)] as const)));
    guard();
    await database.transaction('rw', database.table('_historyRecovery'), database.table('_historyTransactions'), async () => {
      guard();
      for (const [transaction, rows] of groups) {
        const fingerprint = fingerprints.get(transaction)!;
        const originalId = `${name}:${transaction}`;
        const previous = await database.table('_historyRecovery').get(originalId);
        // A late old tab can add evidence to the same transaction. Preserve
        // both versions; a previous handled marker cannot hide the new bytes.
        const id = previous && previous.fingerprint !== fingerprint ? `${originalId}:${fingerprint}` : originalId;
        if (!await database.table('_historyRecovery').get(id)) {
          await database.table('_historyTransactions').add({ id, source: name, transaction, rows });
          await database.table('_historyRecovery').add({ id, source: name, transaction, count: rows.length,
            fingerprint, createdAt: Date.now(), state: 'review', changedEvidence: id !== originalId });
        }
      }
      // Never copy legacy journals into active command tables: merely opening
      // recovery must not wake task/resource/preference replay. Original values
      // and Blobs are archived, not rewritten as synthetic conflict commands.
    });
    for (const row of value.meta) {
      if (/^(cursor$|revision:)/.test(row.id)) continue;
      const fingerprint = await commandDigest(row); guard();
      await database.transaction('rw', database.table('_historyRecovery'), database.table('_historyTransactions'), async () => {
        guard();
        const originalId = `${name}:journal:${row.id}`;
        const previous = await database.table('_historyRecovery').get(originalId);
        const id = previous && previous.fingerprint !== fingerprint ? `${originalId}:${fingerprint}` : originalId;
        if (await database.table('_historyRecovery').get(id)) return;
        await database.table('_historyTransactions').add({ id, source: name, journal: row });
        await database.table('_historyRecovery').add({ id, source: name, journalId: row.id, fingerprint, count: 1, createdAt: Date.now(), state: 'review', changedEvidence: id !== originalId });
      });
    }
  } finally { source.close(); }
}

/** Original identities only. Missing/unknown effects remain review-only; no
 * replacement operation or before/after replay is inferred from legacy rows. */
export async function reconcileLegacyReceipts() {
  const owner = cloud.userId, database = db;
  let converted = false;
  const runtime = await serverRuntime(owner);
  const guard = () => { if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  for (const row of await database.table('_historyRecovery').toArray()) {
    guard();
    if (!row.source || !row.transaction || ['resolved', 'converted'].includes(row.state) || row.receipt?.status === 'completed') continue;
    const receipt = await runtime.receipt(row.transaction); guard();
    await database.table('_historyRecovery').update(row.id, { receipt, checkedAt: Date.now() });
    // A reused old identity with changed payload is evidence, not the same
    // command. Its identity-only receipt cannot confirm these different bytes.
    if (row.changedEvidence) continue;
    if (receipt.status !== 'missing') continue;
    const original = await database.table('_historyTransactions').get(row.id); guard();
    const rows: OutboxRow[] = original?.rows ?? [];
    // The one lossless SQL-only conversion: original mutation IDs retain the
    // server's cloud_operations deduplication, even if an old aggregate receipt
    // is absent. No executor permits, mixed transactions or file effects qualify.
    const edits: ClientLearningEdit[] = [];
    for (const change of rows) {
      const after = change.after, before = change.before;
      const seconds = Number(after?.seconds) - Number(before?.seconds ?? 0);
      if (change.table !== 'studyDays' || change.executorTaskId != null || change.permissionId != null || typeof change.id !== 'string' || !change.id || !after ||
        typeof after.seconds !== 'number' || !Number.isFinite(after.seconds) || after.seconds < 0 ||
        before && (before.date !== change.key || typeof before.seconds !== 'number' || !Number.isFinite(before.seconds) || before.seconds < 0) ||
        typeof change.key !== 'string' || after.date !== change.key ||
        !/^\d{4}-\d{2}-\d{2}$/.test(change.key) || !Number.isFinite(seconds) || seconds < 0 || seconds > 86400 || !Number.isFinite(after.updatedAt) ||
        Object.keys(after).some(key => !['date', 'seconds', 'updatedAt'].includes(key)) ||
        before && Object.keys(before).some(key => !['date', 'seconds', 'updatedAt'].includes(key))) { edits.length = 0; break; }
      edits.push({ kind: 'studyTime', date: change.key, seconds, updatedAt: Number(after.updatedAt), mutationId: change.id });
    }
    if (!edits.length) continue;
    await queueLearning(edits, rows.map(change => `study:${change.key}`), row.transaction); guard();
    // Journal-first is deliberately re-entrant if the page dies before this
    // marker: queueLearning validates identical original intent and retains ID.
    await database.table('_historyRecovery').update(row.id, { state: 'converted', convertedOperationId: row.transaction });
    converted = true;
  }
  return converted;
}
