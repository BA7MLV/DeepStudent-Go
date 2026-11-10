import crypto from 'node:crypto';
import type { ResourceOperation } from '@wangke/contracts/resources';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords } from '../cloud/records.js';
import { recordParentSql, PROJECTION_RECORD_BYTES } from './record-projections.js';
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';

const MAX_ROWS = 20100;
const BATCH_SIZE = 200;

/** Called under the resource command's SQL writer transaction. Preflight both
 * collections before deleting anything; unrelated course bodies never reach JS.
 * Batching bounds mutation arrays, not transactionality or the complete import. */
export function replaceCourseSubtitles(store: DatabaseStore, owner: string, operation: Extract<ResourceOperation, { kind: 'importSubtitles' }>) {
  const db = store.db;
  if (!db.inTransaction) throw new Error('subtitle_import_transaction_required');
  const incomingBytes = Buffer.byteLength(JSON.stringify({ segments: operation.segments, tracks: operation.tracks }));
  const budgetExceeded = () => { throw new RemoteError('client/domain', 'Subtitle replacement exceeds its complete snapshot budget', { code: 'subtitle_import_budget_exceeded' }); };
  if (incomingBytes > PROJECTION_RECORD_BYTES) budgetExceeded();
  const scoped = `FROM cloud_records INDEXED BY cloud_records_parent_key
    WHERE owner_id=? AND table_name=? AND (${recordParentSql})=? AND value IS NOT NULL`;
  const tables = ['segments', 'subtitleTracks'] as const;
  let count = 0, bytes = 0;
  const keys = tables.map(table => {
    const budget = db.prepare(`SELECT count(*) count,coalesce(sum(length(CAST(value AS BLOB))),0) bytes ${scoped}`)
      .get(owner, table, operation.courseId) as { count: number; bytes: number };
    count += budget.count; bytes += budget.bytes;
    if (count > MAX_ROWS || bytes > PROJECTION_RECORD_BYTES) budgetExceeded();
    return db.prepare(`SELECT record_key ${scoped} ORDER BY record_key LIMIT ?`)
      .all(owner, table, operation.courseId, MAX_ROWS + 1) as { record_key: string }[];
  });
  const records = new CloudRecords(store);
  const exists = db.prepare('SELECT 1 FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?');
  for (const [index, table] of tables.entries()) {
    for (let start = 0; start < keys[index].length; start += BATCH_SIZE) {
      records.apply(owner, keys[index].slice(start, start + BATCH_SIZE).map(({ record_key }) => {
        const key = JSON.parse(record_key) as number;
        return { id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: null };
      }));
    }
    const values = table === 'segments' ? operation.segments : operation.tracks;
    for (let start = 0; start < values.length; start += BATCH_SIZE) {
      const allocated = new Set<number>();
      records.apply(owner, values.slice(start, start + BATCH_SIZE).map(value => {
        let key = 0;
        for (let attempt = 0; attempt < 8; attempt++) {
          const candidate = crypto.randomInt(1_000_000, 2 ** 48 - 1);
          // Tombstones are reserved identities too; do not revive deleted rows.
          if (!allocated.has(candidate) && !exists.get(owner, table, JSON.stringify(candidate))) { key = candidate; break; }
        }
        if (!key) throw new Error('subtitle_identity_unavailable');
        allocated.add(key);
        return { id: crypto.randomUUID(), table, key, before: null, after: { ...value, id: key, videoId: operation.courseId } };
      }));
    }
  }
}
