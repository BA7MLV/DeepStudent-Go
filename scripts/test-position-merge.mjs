import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords, CloudConflict } from '../apps/api/src/cloud/records.ts';

/** 位置类字段按 positionAt 时钟合并：离线旧设备回连不得把进度拖回去；
 * 内容字段冲突仍照常上报；没有时钟的旧客户端保持后到者赢。 */
test('position fields merge by client write clock instead of arrival order', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-position-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new DatabaseStore(path.join(dir, 'db.sqlite'));
  const owner = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const records = new CloudRecords(store);
  const mutation = (before, after) => ({ id: crypto.randomUUID(), table: 'videos', key: 'a', before, after });

  const base = { id: 'a', name: 'lecture', duration: 600, createdAt: 1, size: 1, mimeType: 'video/mp4', status: 'transcribed' };
  records.apply(owner, [mutation(null, base)]);

  // 新设备先落库一条更新的进度（positionAt = 2000）。
  records.apply(owner, [mutation(base, { ...base, lastPosition: 300, positionAt: 2000 })]);
  // 离线旧设备随后回连，携带更早的进度（positionAt = 1000）：不得覆盖。
  const newer = { ...base, lastPosition: 300, positionAt: 2000 };
  records.apply(owner, [mutation(base, { ...base, lastPosition: 30, positionAt: 1000 })]);
  assert.equal(records.get(owner, 'videos', 'a')?.lastPosition, 300);
  assert.equal(records.get(owner, 'videos', 'a')?.positionAt, 2000);

  // 旧进度之后又有一条真正更新的（positionAt = 3000）：正常前进。
  records.apply(owner, [mutation(newer, { ...newer, lastPosition: 480, positionAt: 3000 })]);
  assert.equal(records.get(owner, 'videos', 'a')?.lastPosition, 480);

  // finished 跟随同一时钟：新一轮观看显式归零不能被更早的“已看完”覆盖。
  const watched = { ...newer, lastPosition: 480, positionAt: 3000, finished: 1 };
  records.apply(owner, [mutation(watched, { ...watched, lastPosition: 0, finished: 0, positionAt: 4000 })]);
  const rewound = records.get(owner, 'videos', 'a');
  assert.equal(rewound?.finished, 0);
  records.apply(owner, [mutation(rewound, { ...(rewound), finished: 1, positionAt: 1000 })]);
  assert.equal(records.get(owner, 'videos', 'a')?.finished, 0);

  // 没有时钟的旧客户端保持后到者赢（向后兼容）。
  const noClock = records.get(owner, 'videos', 'a');
  records.apply(owner, [mutation(noClock, { ...noClock, lastPosition: 500 })]);
  assert.equal(records.get(owner, 'videos', 'a')?.lastPosition, 500);

  // 同一条 mutation 里内容字段冲突仍然整体上报，位置时钟不是逃逸口。
  const stale = records.get(owner, 'videos', 'a');
  assert.throws(() => records.apply(owner, [mutation({ ...stale, name: '旧名字' }, { ...stale, name: '别的名字', positionAt: 9000 })]), CloudConflict);
});
