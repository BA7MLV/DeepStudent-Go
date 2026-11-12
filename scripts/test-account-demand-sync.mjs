/** Protocol snapshots, not source-string assertions. Browser/API/IDB coverage
 * lives in e2e-account-demand-sync.mjs. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readCollection } from '../apps/web/src/client/collections.ts';

const row = id => ({ table: 'cards', key: id, revision: id, value: { id, videoId: 'course', time: id } });
const page = (records, next, version = 1, epoch = 'e1') => ({ records, next, version, epoch });
const reader = values => { let index = 0; return { read: async () => ({ value: values[Math.min(index++, values.length - 1)] }) }; };
test('complete named scope includes every page, never a UI subset', async () => {
  const result = await readCollection(reader([page([row(1)], 'next'), page([row(2)]), page([row(1)], 'next')]), 'cards', 'course', () => {});
  assert.deepEqual(result.rows.map(row => row.id), [1, 2]);
  assert.equal(result.records.length, 2);
});
test('mixed version/epoch and post-walk mutation cannot publish', async () => {
  for (const pages of [
    [page([row(1)], 'next'), page([row(2)], undefined, 2)],
    [page([row(1)], 'next'), page([row(2)], undefined, 1, 'e2')],
    [page([row(1)]), page([], undefined, 2)],
  ]) await assert.rejects(readCollection(reader(pages), 'cards', 'course', () => {}), /collection_snapshot_changed/);
});
test('foreign parent and duplicate record keys fail closed', async () => {
  const foreign = row(1); foreign.value.videoId = 'other';
  for (const rows of [[foreign], [row(1), row(1)]]) await assert.rejects(readCollection(reader([page(rows)]), 'cards', 'course', () => {}), /invalid_collection_projection/);
});
test('cursor cycles, oversized bodies and account invalidation do not return partial success', async () => {
  await assert.rejects(readCollection(reader([page([row(1)], 'next'), page([row(2)], 'next')]), 'cards', 'course', () => {}), /collection_cursor_cycle/);
  const big = row(1); big.value.body = 'x'.repeat(17 * 1024 * 1024);
  await assert.rejects(readCollection(reader([page([big])]), 'cards', 'course', () => {}), /collection_snapshot_budget_exceeded/);
  await assert.rejects(readCollection(reader([page([row(1)])]), 'cards', 'course', () => { throw new Error('client_account_changed'); }), /client_account_changed/);
});
