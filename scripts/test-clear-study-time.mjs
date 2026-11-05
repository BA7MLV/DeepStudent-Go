import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';

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
  console.log('PASS study-time clear: whole-snapshot CAS, owner isolation, rollback, original receipts and later additions');
} finally {
  domain.close();
  await plugins.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
