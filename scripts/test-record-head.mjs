import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';
import { applyRuntimePatch } from '../packages/contracts/src/runtime-projection.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/record-head-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system'));
const owner = 'head-owner', other = 'head-other';
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
const domain = new ClientRuntimeDomain(store, {});
const abort = new AbortController(), stream = domain.watch(owner, { kind: 'recordHead' }, abort.signal)[Symbol.asyncIterator]();
const records = new CloudRecords(store);
const put = (id, who = owner, value = { id, sessionId: 1, role: 'user', content: 'private'.repeat(1024) }) =>
  records.apply(who, [{ id: crypto.randomUUID(), table: 'chats', key: id, before: records.get(who, 'chats', id), after: value }]);
const next = async () => {
  const frame = (await stream.next()).value;
  assert.ok(Buffer.byteLength(JSON.stringify(frame)) < 512, 'head delivery has a fixed metadata budget');
  return frame;
};
try {
  const initial = await next();
  assert.deepEqual(Object.keys(initial.value).sort(), ['epoch', 'version']);
  assert.equal(initial.value.version, 0);
  // Derived table heads update in the same transaction. Account payloads are
  // deliberately large; none are parsed or serialized by recordHead.
  store.transaction(() => { for (let id = 1; id <= 1000; id++) put(id); });
  domain.pump();
  const changed = await next();
  let head = changed.type === 'snapshot' ? changed.value : applyRuntimePatch(initial.value, changed.changes);
  assert.ok(head.version > initial.value.version);
  assert.equal(head.epoch, initial.value.epoch);
  const beforeForeign = await domain.read(owner, { kind: 'recordHead' });
  put(9001, other);
  assert.deepEqual((await domain.read(owner, { kind: 'recordHead' })).value, beforeForeign.value, 'another account does not change this head');
  put(1, owner, null);
  const deleted = (await domain.read(owner, { kind: 'recordHead' })).value;
  assert.ok(deleted.version > head.version, 'tombstone advances the invalidation head');
  store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key='1'").run(owner);
  assert.ok((await domain.read(owner, { kind: 'recordHead' })).value.version > deleted.version, 'physical removal cannot rewind the derived head');
  domain.pump(); await next();
  const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT COALESCE(SUM(version),0) FROM client_collection_heads WHERE owner_id=? AND parent='*'").all(owner);
  assert.ok(plan.every(row => !row.detail.includes('cloud_records')), 'head queries never scan record bodies');

  // Reset the generation and rewind invalidation revisions while the watch is
  // alive. The frame must replace rather than delta across different epochs.
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run('new-head-epoch', 'records-epoch');
  store.db.prepare('DELETE FROM client_changes').run();
  domain.pump();
  const reset = await next();
  assert.equal(reset.type, 'snapshot');
  assert.equal(reset.value.epoch, 'new-head-epoch');
  assert.equal(reset.revision, 0);

  const command = { operationId: crypto.randomUUID(), edits: [{ kind: 'conversationSession', mutationId: crypto.randomUUID(), expected: null,
    value: { id: 77, videoId: '__library_assistant__', title: 'Epoch receipt', createdAt: 77 } }] };
  const receipt = await domain.editLearning(owner, command);
  assert.equal(receipt.epoch, 'new-head-epoch');
  assert.deepEqual(await domain.editLearning(owner, command), receipt, 'idempotent replay preserves receipt epoch');
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run('third-head-epoch', 'records-epoch');
  assert.equal((await domain.editLearning(owner, command)).epoch, 'new-head-epoch', 'a stored receipt must not be stamped with a later epoch');
  console.log(`PASS recordHead scalar payload, owner isolation, tombstones, indexed derived heads, live epoch rewind and immutable learning receipt epoch: ${directory}`);
} finally {
  abort.abort(); await stream.return?.(); domain.close(); store.close();
}
