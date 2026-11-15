import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { WangkeDB, cloudDatabaseName, useCloudDatabase, db } from '../apps/web/src/store/db.ts';
import { cloud } from '../apps/web/src/cloud/state.ts';
import { resolveLearningCommand } from '../apps/web/src/client/learning.ts';

/** 冲突解决只动本地日志:丢弃保留云端并把原稿转入恢复证据;重试把原命令重新排队。
 * 网络提交是独立的一步,离线环境下失败也不改变日志语义。 */
test('conflict resolution settles the durable journal without touching the network', async t => {
  const owner = crypto.randomUUID();
  cloud.enabled = true; cloud.userId = owner;
  useCloudDatabase(owner);
  t.after(async () => { cloud.enabled = false; cloud.userId = ''; await db.delete(); });

  const row = { operationId: 'op-conflict', request: { operationId: 'op-conflict', edits: [] }, entities: ['message:1'],
    state: 'conflict', createdAt: Date.now(), error: 'client/record-conflict' };
  await db.table('_learningCommands').add(row);
  await db.table('_learningCommands').add({ ...row, sequence: undefined, operationId: 'op-other', entities: ['session:2'], state: 'uncertain' });

  // 重试:仅冲突命令可重新排队;网络提交在离线环境失败,但排队状态已原子落盘。
  await assert.rejects(resolveLearningCommand('op-other', 'retry'), /learning_command_not_in_conflict/);
  await assert.rejects(resolveLearningCommand('op-conflict', 'retry'), /client_unauthenticated|client_account_changed|location is not defined/);
  const retried = await db.table('_learningCommands').where('operationId').equals('op-conflict').first();
  assert.equal(retried.state, 'queued');
  assert.equal(retried.error, undefined);

  // 丢弃:保留云端,命令出队,原稿转入恢复证据,不静默消失。
  await resolveLearningCommand('op-conflict', 'discard');
  assert.equal(await db.table('_learningCommands').where('operationId').equals('op-conflict').first(), undefined);
  const evidence = await db.table('_cloudMeta').get('learning-discarded:op-conflict');
  assert.equal(evidence.value.request.operationId, 'op-conflict');
  assert.deepEqual(evidence.value.entities, ['message:1']);
  assert.equal(typeof evidence.value.discardedAt, 'number');

  // 其它命令不受影响。
  assert.equal((await db.table('_learningCommands').where('operationId').equals('op-other').first()).state, 'uncertain');
  await assert.rejects(resolveLearningCommand('missing', 'discard'), /learning_command_missing/);
});
