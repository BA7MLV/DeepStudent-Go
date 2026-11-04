import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { installCloudCache, markCloudApply } from '../apps/web/src/cloud/cache.ts';
import { cloudTransaction, isLostCloudTransaction } from '../apps/web/src/cloud/transactions.ts';
import { WangkeDB, cloudDatabaseName } from '../apps/web/src/store/db.ts';
import { quarantineExecutorOutbox } from '../apps/web/src/cloud/executor-recovery.ts';

const lostTransaction = () => new DOMException(
  'Attempt to delete range from database without an in-progress transaction', 'UnknownError',
);

test('legacy/expired executor transactions move atomically to recoverable journal, never to another task', async t => {
  const database = new WangkeDB(cloudDatabaseName(crypto.randomUUID(), true), true);
  t.after(() => database.delete());
  const rows = [
    { id: 'legacy-operation', transaction: 'legacy-transaction', table: 'files', key: 'file', before: null, after: { id: 'file', blob: new Blob(['retain original bytes']) } },
    { id: 'old-permitted-operation', transaction: 'old-transaction', table: 'chats', key: 1, before: null, after: { id: 1 }, permissionId: 'old-permit', executorTaskId: 'old-task' },
    { id: 'current-operation', transaction: 'current-transaction', table: 'chats', key: 2, before: null, after: { id: 2 }, executorTaskId: 'current-task' },
  ];
  await database.table('_cloudOutbox').bulkAdd(rows);
  assert.equal(await quarantineExecutorOutbox(database, 'current-task'), 2);
  assert.equal((await database.table('_cloudOutbox').toArray())[0].id, 'current-operation');
  const legacy = await database.table('_cloudMeta').get('executor-recovery:legacy-transaction');
  assert.equal(legacy.status, 'requires-reconciliation');
  assert.equal(legacy.rows[0].id, 'legacy-operation');
  assert.equal(await legacy.rows[0].after.blob.text(), 'retain original bytes');
  assert.equal((await database.table('_cloudMeta').get('executor-recovery:old-transaction')).rows[0].permissionId, 'old-permit');
  assert.equal(await quarantineExecutorOutbox(database, 'current-task'), 0, 'conversion is idempotent');
});

test('executor cache cannot drain interactive study-time/outbox transactions', async t => {
  const owner = crypto.randomUUID();
  const interactive = new WangkeDB(cloudDatabaseName(owner), true);
  const executor = new WangkeDB(cloudDatabaseName(owner, true), true);
  t.after(async () => { await interactive.delete(); await executor.delete(); });
  assert.equal(interactive.name, `wangke-cloud-${owner}`, 'existing UI data keeps its original database name');
  assert.notEqual(interactive.name, executor.name);
  await interactive.studyDays.put({ date: '2026-11-03', seconds: 60, updatedAt: Date.now() });
  const queued = await interactive.table('_cloudOutbox').toArray();
  assert.equal(queued.length, 1); assert.equal(queued[0].table, 'studyDays');
  assert.equal(await executor.table('_cloudOutbox').count(), 0);
  assert.equal(await executor.studyDays.count(), 0);
  await executor.chatSessions.put({ id: 1, videoId: 'course', createdAt: Date.now(), updatedAt: Date.now() });
  const executorQueue = await executor.table('_cloudOutbox').toArray();
  assert.deepEqual(executorQueue.map(row => row.table), ['chatSessions']);
  await executor.table('_cloudOutbox').clear();
  assert.deepEqual(await interactive.table('_cloudOutbox').toArray(), queued, 'executor acknowledgement never removes UI edits');
  assert.equal(await interactive.chatSessions.count(), 0);
});

async function fixture(t) {
  const database = new Dexie(`cloud-transaction-${crypto.randomUUID()}`);
  database.version(1).stores({ videos: 'id', _cloudOutbox: '++sequence,transaction', _cloudMeta: 'id' });
  installCloudCache(database);
  const fault = { remaining: 0, error: lostTransaction(), transactions: new Set() };
  database.use({
    stack: 'dbcore', name: 'simulate-webkit-transaction-loss', level: 1,
    create: core => ({
      ...core,
      table(name) {
        const table = core.table(name);
        if (name !== '_cloudMeta') return table;
        return {
          ...table,
          mutate(request) {
            if (fault.remaining > 0 && request.type === 'put') {
              fault.remaining--;
              fault.transactions.add(request.trans);
              return Promise.resolve({
                numFailures: request.values.length,
                failures: Object.fromEntries(request.values.map((_, index) => [index, fault.error])),
                results: [], lastResult: undefined,
              });
            }
            return table.mutate(request);
          },
        };
      },
    }),
  });
  t.after(() => database.delete());
  await database.open();
  await database.table('videos').put({ id: 'course', name: 'local' });
  await database.table('_cloudMeta').bulkPut([{ id: 'revision', value: 4 }, { id: 'cursor', value: 0 }]);
  return { database, fault };
}

test('recognizes WebKit errors and Dexie wrappers without retrying unrelated errors', () => {
  const error = lostTransaction();
  assert.equal(isLostCloudTransaction(error), true);
  assert.equal(isLostCloudTransaction(new Dexie.BulkError('write failed', [error, error])), true);
  assert.equal(isLostCloudTransaction({ inner: error }), true);
  assert.equal(isLostCloudTransaction(new Error('wrapped', { cause: error })), true);
  assert.equal(isLostCloudTransaction(new Dexie.BulkError('mixed', [error, new DOMException('duplicate', 'ConstraintError')])), false);
  for (const unrelated of [null, 'error', new Error('sync_conflict'), new DOMException('full', 'QuotaExceededError'),
    new DOMException('other storage error', 'UnknownError'), new DOMException('inactive', 'TransactionInactiveError')]) {
    assert.equal(isLostCloudTransaction(unrelated), false);
  }
  const circular = { name: 'BulkError', failures: [] };
  circular.failures.push(circular);
  assert.equal(isLostCloudTransaction(circular), false);
});

for (const failures of [1, 2]) {
  test(`acknowledgement retries ${failures} lost transaction(s), rolling back the outbox deletion`, async t => {
    const { database, fault } = await fixture(t);
    fault.remaining = failures;
    let attempts = 0;
    const transactions = new Set();
    const rows = await database.table('_cloudOutbox').toArray();
    const result = await cloudTransaction(database, [database.table('_cloudOutbox'), database.table('_cloudMeta')], async () => {
      attempts++;
      transactions.add(Dexie.currentTransaction.idbtrans);
      assert.equal(await database.table('_cloudOutbox').count(), 1, 'failed acknowledgement must restore the outbox');
      assert.equal((await database.table('_cloudMeta').get('revision')).value, 4);
      await database.table('_cloudOutbox').bulkDelete(rows.map(row => row.sequence));
      await database.table('_cloudMeta').bulkPut([{ id: 'revision', value: 5 }]);
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.equal(attempts, failures + 1);
    assert.equal(transactions.size, attempts, 'every attempt uses a fresh native transaction');
    assert.equal(await database.table('_cloudOutbox').count(), 0);
    assert.equal((await database.table('_cloudMeta').get('revision')).value, 5);
  });
}

test('persistent transaction loss stops after three attempts and preserves pending edits and revisions', async t => {
  const { database, fault } = await fixture(t);
  fault.remaining = Infinity;
  let attempts = 0;
  await assert.rejects(cloudTransaction(database, database.tables, async () => {
    attempts++;
    await database.table('_cloudOutbox').clear();
    await database.table('_cloudMeta').bulkPut([{ id: 'revision', value: 5 }]);
  }), isLostCloudTransaction);
  assert.equal(attempts, 3);
  assert.equal(fault.transactions.size, 3);
  assert.equal(await database.table('_cloudOutbox').count(), 1);
  assert.equal((await database.table('_cloudMeta').get('revision')).value, 4);
  assert.equal((await database.table('videos').get('course')).name, 'local');
});

test('download retries roll back data and cursor together, without creating upload echoes', async t => {
  const { database, fault } = await fixture(t);
  await database.table('_cloudOutbox').clear();
  fault.remaining = 1;
  let attempts = 0;
  const applied = await cloudTransaction(database, database.tables, async () => {
    attempts++;
    markCloudApply();
    assert.equal((await database.table('videos').get('course')).name, 'local');
    assert.equal((await database.table('_cloudMeta').get('cursor')).value, 0);
    await database.table('videos').put({ id: 'course', name: 'remote' });
    await database.table('_cloudMeta').put({ id: 'cursor', value: 10 });
    return true;
  });
  assert.equal(applied, true);
  assert.equal(attempts, 2);
  assert.equal((await database.table('videos').get('course')).name, 'remote');
  assert.equal((await database.table('_cloudMeta').get('cursor')).value, 10);
  assert.equal(await database.table('_cloudOutbox').count(), 0);
});

test('permanent storage failures abort immediately, without deleting the outbox', async t => {
  const { database, fault } = await fixture(t);
  fault.remaining = Infinity;
  fault.error = new DOMException('storage full', 'QuotaExceededError');
  let attempts = 0;
  await assert.rejects(cloudTransaction(database, database.tables, async () => {
    attempts++;
    await database.table('_cloudOutbox').clear();
    await database.table('_cloudMeta').put({ id: 'revision', value: 5 });
  }), error => !isLostCloudTransaction(error));
  assert.equal(attempts, 1);
  assert.equal(await database.table('_cloudOutbox').count(), 1);
});
