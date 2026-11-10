import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';
import { RecordProjections } from '../apps/api/src/realtime/record-projections.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/clear-study-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system'));
const plugins = new PluginService(store);
const domain = new ClientRuntimeDomain(store, plugins);
const records = new CloudRecords(store);
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
const add = (date, seconds, user = owner) => domain.editLearning(user, { operationId: crypto.randomUUID(), edits: [
  { kind: 'studyTime', date, seconds, updatedAt: Date.now(), mutationId: crypto.randomUUID() },
] });
const clear = expected => ({ operationId: crypto.randomUUID(), edits: [{ kind: 'clearStudyTime', expected, mutationId: crypto.randomUUID() }] });
const conflict = error => error.code === 'client/record-conflict';
try {
  await add('2026-11-05', 10);
  await add('2026-11-06', 20);
  await add('2026-11-05', 75, other);
  const initial = records.studyDays(owner);
  await assert.rejects(domain.editLearning(other, clear(initial)), conflict);
  assert.equal(records.studyDays(other)[0].seconds, 75, 'another account is never cleared by this snapshot');
  await add('2026-11-05', 2);
  await assert.rejects(domain.editLearning(owner, clear(initial)), conflict);
  assert.equal(records.studyDays(owner).length, 2, 'stale edit rolls back all deletions');
  const beforeNewDay = records.studyDays(owner);
  await add('2026-11-07', 3);
  await assert.rejects(domain.editLearning(owner, clear(beforeNewDay)), conflict);
  assert.equal(records.studyDays(owner).length, 3, 'new days are part of the snapshot CAS');
  const request = clear(records.studyDays(owner));
  const receipt = await domain.editLearning(owner, request);
  assert.deepEqual(records.studyDays(owner), []);
  await add('2026-11-05', 4);
  assert.deepEqual(await domain.editLearning(owner, request), receipt, 'lost-response retry returns original receipt');
  assert.equal(records.studyDays(owner)[0].seconds, 4, 'retry must not clear later work');
  await assert.rejects(domain.editLearning(owner, { ...request, edits: clear(records.studyDays(owner)).edits }), error => error.code === 'client/conflict');
  await assert.rejects(domain.editLearning(owner, clear([])), conflict);
  await assert.rejects(domain.editLearning(owner, clear([...records.studyDays(owner), ...records.studyDays(owner)])), error => error.metadata?.code === 'invalid_study_snapshot' || error.code === 'client/domain');
  const mixed = clear(records.studyDays(owner));
  mixed.edits.push({ kind: 'studyTime', date: '2026-11-08', seconds: 1, updatedAt: 1, mutationId: crypto.randomUUID() });
  await assert.rejects(domain.editLearning(owner, mixed), error => error.code === 'client/domain');
  assert.equal(records.get(owner, 'studyDays', '2026-11-08'), null);
  await domain.editLearning(owner, clear(records.studyDays(owner)));
  const empty = clear([]);
  await domain.editLearning(owner, empty);
  await add('2026-11-09', 5);
  await domain.editLearning(owner, empty);
  assert.equal(records.studyDays(owner)[0].seconds, 5, 'empty clears also have durable receipts');
  assert.equal(records.studyDays(other)[0].seconds, 75);
  const reads = new RecordProjections(store);
  const summary = reads.studySummary(owner);
  assert.equal(summary.activeDays, 1); assert.equal(summary.totalSeconds, 5);
  assert.deepEqual(Object.keys(summary).sort(), ['activeDays', 'snapshot', 'totalSeconds']);
  const snapshotClear = snapshot => ({ operationId: crypto.randomUUID(), edits: [{ kind: 'clearStudySnapshot', snapshot, mutationId: crypto.randomUUID() }] });
  await assert.rejects(domain.editLearning(other, snapshotClear(summary.snapshot)), conflict);
  await assert.rejects(domain.editLearning(owner, snapshotClear(summary.snapshot.slice(0, -1) + '!')), conflict);
  const tampered = JSON.parse(Buffer.from(summary.snapshot.split('.')[0], 'base64url').toString());
  tampered.owner = other;
  await assert.rejects(domain.editLearning(other, snapshotClear(Buffer.from(JSON.stringify(tampered)).toString('base64url') + '.' + summary.snapshot.split('.')[1])), conflict);
  await add('2026-11-10', 6);
  await assert.rejects(domain.editLearning(owner, snapshotClear(summary.snapshot)), conflict);
  assert.equal(records.studyDays(owner).length, 2, 'inserted date invalidates compact snapshot');
  const latest = reads.studySummary(owner);
  assert.equal(latest.totalSeconds, 11);
  const afterRollback = reads.studySummary(owner);
  assert.throws(() => store.db.transaction(() => {
    store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='studyDays'").run(owner);
    throw new Error('rollback');
  })(), /rollback/);
  assert.equal(reads.studySummary(owner).snapshot, afterRollback.snapshot, 'heads roll back with business records');
  // Unrelated collections must not invalidate an observed summary.
  store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'cards','1','{}')").run(owner);
  assert.equal(reads.studySummary(owner).snapshot, afterRollback.snapshot);
  const epoch = store.db.prepare("SELECT value FROM app_state WHERE key='records-epoch'").get().value;
  store.db.prepare("UPDATE app_state SET value=? WHERE key='records-epoch'").run(crypto.randomUUID());
  await assert.rejects(domain.editLearning(owner, snapshotClear(latest.snapshot)), conflict);
  store.db.prepare("UPDATE app_state SET value=? WHERE key='records-epoch'").run(epoch);
  const compact = snapshotClear(reads.studySummary(owner).snapshot);
  const compactReceipt = await domain.editLearning(owner, compact);
  assert.equal(compactReceipt.versions.length, 2, 'clear retains exact-key receipt barriers');
  assert.deepEqual(records.studyDays(owner), []);
  await add('2026-11-11', 7);
  assert.deepEqual(await domain.editLearning(owner, compact), compactReceipt);
  assert.equal(records.studyDays(owner)[0].seconds, 7, 'compact lost-response retry never deletes later study');
  assert.equal(records.studyDays(other)[0].seconds, 75);
  const emptyCompact = snapshotClear(reads.studySummary('empty-owner').snapshot);
  await assert.rejects(domain.editLearning(owner, emptyCompact), conflict);
  const budgetOwner = 'budget-owner';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(budgetOwner, budgetOwner, new Date().toISOString());
  const insertBudget = store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'studyDays',?,?)");
  store.db.transaction(() => {
    for (let index = 0; index < 20001; index++) {
      const date = new Date(Date.UTC(1970, 0, 1 + index)).toISOString().slice(0, 10);
      insertBudget.run(budgetOwner, JSON.stringify(date), JSON.stringify({ date, seconds: 1, updatedAt: 1 }));
    }
  })();
  const budgetBaseline = reads.studySummary(budgetOwner);
  assert.equal(budgetBaseline.activeDays, 20001, 'read aggregation remains complete above clear materialization budget');
  const budgetRejected = error => error.code === 'client/domain' && error.details?.code === 'study_clear_budget_exceeded';
  await assert.rejects(domain.editLearning(budgetOwner, snapshotClear(budgetBaseline.snapshot)), budgetRejected);
  assert.equal(store.db.prepare("SELECT count(*) n FROM cloud_records WHERE owner_id=? AND table_name='studyDays' AND value IS NOT NULL").get(budgetOwner).n, 20001);
  // Oversized records are rejected by lengths before their JSON bodies load.
  const largeOwner = 'large-owner';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(largeOwner, largeOwner, new Date().toISOString());
  insertBudget.run(largeOwner, JSON.stringify('2026-11-10'), JSON.stringify({ date: '2026-11-10', seconds: 1, updatedAt: 1, future: 'x'.repeat(8 * 1024 * 1024) }));
  await assert.rejects(domain.editLearning(largeOwner, snapshotClear(reads.studySummary(largeOwner).snapshot)), budgetRejected);
  assert.equal(store.db.prepare("SELECT count(*) n FROM cloud_records WHERE owner_id=? AND value IS NOT NULL").get(largeOwner).n, 1);
  console.log('PASS study-time clear: whole-snapshot CAS, owner isolation, rollback, original receipts and later additions');
  console.log('PASS compact signed study baseline: aggregate-only read, tamper/scope/epoch/change rejection, rollback, unrelated-domain stability and replay');
  console.log('PASS clear preflight budgets: >20000 rows or >8MiB reject without mutation, while complete aggregate remains available');
} finally {
  domain.close();
  await plugins.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
