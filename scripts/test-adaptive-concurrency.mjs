import assert from 'node:assert/strict';
import test from 'node:test';
import { AdaptiveLimit, adaptivePool } from '../packages/study-core/src/utils/concurrency.ts';

test('collecting failures rejects even when the first rejection reason is falsy', async () => {
  for (const reason of [undefined, null, false, 0, '']) {
    const visited = [];
    const outcome = await adaptivePool([0, 1, 2], new AdaptiveLimit(1), async item => {
      visited.push(item);
      if (item === 0) throw reason;
      if (item === 1) throw new Error('later failure');
    }, { failFast: false }).then(() => ({ ok: true }), error => ({ ok: false, error }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.error, reason, 'preserve the first rejection, not the first truthy one');
    assert.deepEqual(visited, [0, 1, 2]);
  }
});

test('synchronous callback exceptions follow the same non-fail-fast policy', async () => {
  const error = new Error('synchronous failure');
  const visited = [];
  await assert.rejects(adaptivePool([0, 1, 2], new AdaptiveLimit(1), item => {
    visited.push(item);
    if (item === 0) throw error;
    return Promise.resolve();
  }, { failFast: false }), value => value === error);
  assert.deepEqual(visited, [0, 1, 2]);
});

test('fail-fast stops new work and successful work still respects concurrency', async () => {
  const visited = [];
  await assert.rejects(adaptivePool([0, 1, 2], new AdaptiveLimit(1), async item => {
    visited.push(item);
    throw new Error('stop');
  }), /stop/);
  assert.deepEqual(visited, [0]);
  let active = 0, peak = 0;
  await adaptivePool([0, 1, 2, 3], new AdaptiveLimit(2), async () => {
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
  });
  assert.equal(peak, 2);
  assert.equal(active, 0);
});
