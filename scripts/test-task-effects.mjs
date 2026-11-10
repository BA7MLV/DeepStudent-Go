/** Real runner + stub executor: terminal task receipts carry the exact record
 * versions the task's committed mutations touched. Real SQLite; no models,
 * browsers or network. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { submitOwnerTask } from '../apps/api/src/cloud/task-commands.ts';
import { CloudTaskRunner, taskDto, taskEffectsValue, parseTaskEffects, TASK_EFFECTS_CAP } from '../apps/api/src/cloud/tasks.ts';
import { commitTask, recordMutation } from '../apps/api/src/cloud/execution.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'task-effects-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), now = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, now);
const put = (table, key, after, account = owner) =>
  records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after }]);
put('videos', 'course', { id: 'course', name: '课程' });
put('videos', 'other', { id: 'other', name: '别人的课程' }, other);
const revisionOf = (table, key, account = owner) =>
  (store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?')
    .get(account, table, JSON.stringify(key))).revision;
const full = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
async function until(id) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const task = full(id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(task.status)) return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('task_effects_timeout');
}

let stub;
const runner = new CloudTaskRunner(store, { records, configuration, filesDir: path.join(directory, 'files'),
  fetch: async () => { throw new Error('task_effects_must_not_fetch'); },
  executors: { node: async context => stub(context) } });
runner.start('task-effects-test');
try {
  // 1. A task that commits records carries exactly those versions.
  stub = context => {
    const before = records.get(owner, 'videos', 'course');
    commitTask(context, [recordMutation('videos', 'course', before, { ...before, status: 'done' })]);
    commitTask(context, [recordMutation('videos', 'other', null, { id: 'other', name: '新建' })]);
    return { ok: true };
  };
  let task = await until(submitOwnerTask(store, records, configuration, owner,
    { kind: 'transcribe', resource: 'course:course', operationId: crypto.randomUUID(), input: { videoId: 'course', skipBiliSubtitles: true } }).id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.ok(Array.isArray(task.effects), 'terminal task must carry effects');
  assert.deepEqual(task.effects.map(effect => effect.table), ['videos', 'videos']);
  assert.deepEqual(task.effects.map(effect => effect.key), ['course', 'other']);
  for (const effect of task.effects) assert.equal(effect.revision, revisionOf(effect.table, effect.key), 'receipt revision must equal the committed revision');
  assert.ok(task.effects.every(effect => effect.revision > 0));

  // 2. A task that writes no records carries an explicit empty receipt.
  stub = () => ({ ok: true });
  task = await until(submitOwnerTask(store, records, configuration, owner,
    { kind: 'transcribe', resource: 'course:course', operationId: crypto.randomUUID(), input: { videoId: 'course', skipBiliSubtitles: true } }).id);
  assert.equal(task.status, 'completed');
  assert.deepEqual(task.effects, [], 'a task that wrote nothing carries an empty receipt, not an absent one');

  // 3. Overflow keeps the sentinel: no partial effects, clients fall back.
  stub = context => {
    const mutations = Array.from({ length: TASK_EFFECTS_CAP + 1 }, (_, index) =>
      recordMutation('danmakus', index + 1, null, { videoId: 'course', id: index + 1, text: `d-${index}` }));
    commitTask(context, mutations);
    return { ok: true };
  };
  task = await until(submitOwnerTask(store, records, configuration, owner,
    { kind: 'cover', resource: 'course:course', operationId: crypto.randomUUID(), input: { videoId: 'course' } }).id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.equal(task.effects, undefined, 'overflow must not publish a partial receipt');
  assert.equal(store.db.prepare('SELECT effects FROM cloud_tasks WHERE id=?').get(task.id).effects, 'overflow');

  // 4. Serialization helpers round-trip and reject garbage.
  const effects = [{ table: 'videos', key: 'course', revision: 7 }, { table: 'chats', key: 12, revision: 9 }];
  assert.deepEqual(parseTaskEffects(taskEffectsValue(effects)), { effects });
  assert.deepEqual(parseTaskEffects('overflow'), {}, 'overflow parses to an absent field');
  assert.deepEqual(parseTaskEffects('not json'), {}, 'garbage never becomes effects');
  assert.deepEqual(parseTaskEffects(JSON.stringify([{ table: 'videos', key: { bad: true }, revision: 1 }])), {}, 'invalid shapes are dropped');
  assert.deepEqual(parseTaskEffects(null), {});

  // 5. A failed task still carries the versions it managed to commit.
  stub = context => {
    const before = records.get(owner, 'videos', 'course');
    commitTask(context, [recordMutation('videos', 'course', before, { ...before, status: 'failed-write' })]);
    throw new Error('executor_failed_after_commit');
  };
  task = await until(submitOwnerTask(store, records, configuration, owner,
    { kind: 'transcribe', resource: 'course:course', operationId: crypto.randomUUID(), input: { videoId: 'course', skipBiliSubtitles: true } }).id);
  assert.equal(task.status, 'failed');
  assert.ok(task.effects.length >= 1, 'a failed task keeps its partial receipt');
  assert.equal(task.effects[0].revision, revisionOf('videos', 'course'));

  // 6. Effects never leak across owners: the other account's task row is unreadable here.
  const foreign = submitOwnerTask(store, records, configuration, other,
    { kind: 'transcribe', resource: 'course:other', operationId: crypto.randomUUID(), input: { videoId: 'other', skipBiliSubtitles: true } });
  const foreignTask = await until(foreign.id);
  assert.ok(foreignTask.effects.every(effect => revisionOf(effect.table, effect.key, other) === effect.revision));
  const cross = store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND effects IS NOT NULL AND id IN (SELECT id FROM cloud_tasks WHERE owner_id=?)').get(owner, other);
  assert.equal(cross.n, 0);
} finally {
  await runner.quiesce(100);
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('PASS: terminal task receipts carry exact affected record versions, with overflow and failure semantics');
