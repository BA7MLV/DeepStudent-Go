/** Protocol-level evidence for the bounded material-blocks reader.
 * Pure fake readers; no server, browser or IndexedDB required. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readMaterialBlocks, materialBlocksExist } from '../apps/web/src/client/material-blocks.ts';

const page = (records, next, version = 1, epoch = 'e1') => ({ records, next, version, epoch });
const record = (id, unit, idx, text = `block-${unit}-${idx}`) =>
  ({ table: 'materialBlocks', key: id, value: { id, materialId: 'mat-1', idx, unit, unitLabel: `第 ${unit} 段`, text } });

function readerOf(pages, onRead) {
  let call = 0;
  return { read: async request => {
    onRead?.(request, call);
    const value = pages[Math.min(call++, pages.length - 1)];
    return { value };
  } };
}

test('walks every page in order and sorts by idx', async () => {
  const requests = [];
  const reader = readerOf([
    page([record(3, 1, 2), record(1, 1, 0)], 'c1'),
    page([record(2, 2, 1)], undefined),
    page([]), // verification barrier
  ], request => requests.push(request));
  const rows = await readMaterialBlocks(reader, 'mat-1', () => {});
  assert.deepEqual(rows.map(row => row.id), [1, 2, 3]);
  assert.deepEqual(rows.map(row => row.idx), [0, 1, 2]);
  assert.equal(requests.filter(request => request.cursor).length, 1, 'cursor pages are requested once');
  assert.ok(requests.every(request => request.kind === 'collectionPage' && request.table === 'materialBlocks' && request.parent === 'mat-1'));
});

test('rejects records that do not belong to the requested material', async () => {
  const foreign = { table: 'materialBlocks', key: 9, value: { id: 9, materialId: 'other', idx: 0, unit: 1, unitLabel: 'x', text: 'y' } };
  await assert.rejects(() => readMaterialBlocks(readerOf([page([foreign])]), 'mat-1', () => {}), /invalid_material_blocks_projection/);
});

test('a version change across pages refuses the mixed snapshot', async () => {
  const reader = readerOf([page([record(1, 1, 0)], 'c1'), page([record(2, 2, 1)], undefined, 2)]);
  await assert.rejects(() => readMaterialBlocks(reader, 'mat-1', () => {}), /material_blocks_changed/);
});

test('a version change after the walk is caught by the verification barrier', async () => {
  const pages = [page([record(1, 1, 0)], 'c1'), page([record(2, 2, 1)], undefined), page([], undefined, 2)];
  const reader = readerOf(pages);
  await assert.rejects(() => readMaterialBlocks(reader, 'mat-1', () => {}), /material_blocks_changed/);
});

test('a cursor cycle is refused instead of looping forever', async () => {
  const looping = readerOf([page([record(1, 1, 0)], 'c1'), page([record(2, 2, 1)], 'c1'), page([record(3, 3, 2)], 'c1')]);
  await assert.rejects(() => readMaterialBlocks(looping, 'mat-1', () => {}), /material_blocks_cursor_cycle/);
});

test('row and byte budgets are explicit errors, never silent truncation', async () => {
  const many = Array.from({ length: 20001 }, (_, index) => record(index + 1, 1, index));
  await assert.rejects(() => readMaterialBlocks(readerOf([page(many)]), 'mat-1', () => {}), /material_blocks_budget_exceeded/);
  const big = record(1, 1, 0, 'x'.repeat(17 * 1024 * 1024));
  await assert.rejects(() => readMaterialBlocks(readerOf([page([big])]), 'mat-1', () => {}), /material_blocks_budget_exceeded/);
});

test('guard failures abort the walk', async () => {
  const reader = readerOf([page([record(1, 1, 0)], 'c1')]);
  await assert.rejects(() => readMaterialBlocks(reader, 'mat-1', () => { throw new Error('client_account_changed'); }), /client_account_changed/);
});

test('existence check reads only the first page', async () => {
  const requests = [];
  const reader = readerOf([page([record(1, 1, 0)], 'c1')], request => requests.push(request));
  assert.equal(await materialBlocksExist(reader, 'mat-1', () => {}), true);
  assert.equal(requests.length, 1);
  assert.equal(await materialBlocksExist(readerOf([page([])]), 'mat-1', () => {}), false);
});

test('invalid material id is rejected before any read', async () => {
  let reads = 0;
  const reader = { read: async () => { reads++; return { value: page([]) }; } };
  await assert.rejects(() => readMaterialBlocks(reader, '', () => {}), /invalid_material/);
  assert.equal(reads, 0);
});
