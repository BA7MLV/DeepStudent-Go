import assert from 'node:assert/strict';
import test from 'node:test';
import { SerialFeedback } from '../apps/web/src/ui/serialFeedback.ts';
import { ChatCompletionTracker } from '../apps/web/src/store/chatCompletion.ts';

test('feedback bursts stay FIFO; waiting messages do not reach the host', () => {
  const shown = [];
  let occupied = false;
  const queue = new SerialFeedback((value, id) => { occupied = true; shown.push([value, id]); }, () => occupied);
  const first = queue.add('first');
  const removed = queue.add('cancelled');
  queue.add('third'); queue.remove(removed);
  assert.deepEqual(shown, [['first', first]]);
  queue.advance(); assert.equal(shown.length, 1, 'exit animation still occupies the host');
  occupied = false; queue.advance();
  assert.equal(shown[1][0], 'third');
  queue.add('old account'); queue.clear();
  occupied = false; queue.advance();
  assert.equal(shown.length, 2, 'account cleanup drops pending feedback');
});

test('only newly observed chat completions mark unread, once across both streams', () => {
  const tracker = new ChatCompletionTracker(), unread = [];
  const task = (id, status, action = 'send', sessionId = 42) => ({ id, status, input: { action, sessionId } });
  const observe = tasks => tracker.observe(tasks, id => unread.push(id));
  observe([task('historical', 'completed')]);
  observe([task('a', 'running')]); observe([task('a', 'completed')]);
  observe([task('a', 'completed')]);
  observe([task('a', 'running')]); observe([task('a', 'completed')]);
  assert.deepEqual(unread, [42], 'reconnect and lagging global snapshots do not replay completion');
  observe([task('compress', 'running', 'compressContext')]); observe([task('compress', 'completed', 'compressContext')]);
  observe([task('cancel', 'queued')]); observe([task('cancel', 'cancelled')]);
  assert.deepEqual(unread, [42]);
  observe([task('failure', 'waiting_event', 'send', 43)]); observe([task('failure', 'failed', 'send', 43)]);
  assert.deepEqual(unread, [42, 43]);
  tracker.clear(); observe([task('other-account', 'completed')]);
  assert.deepEqual(unread, [42, 43]);
});
