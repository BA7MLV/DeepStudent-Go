import assert from 'node:assert/strict';
import test from 'node:test';
import { BotHistoryModel } from '../packages/client-core/src/bot-history.ts';
import { BotFollowModel } from '../packages/client-core/src/bot-follow.ts';

test('Bot follow owns ordered activity/state cursors and ignores events after disposal', async () => {
  const history = new BotHistoryModel({ server: 'fixture', account: 'one', scope: 'bot' });
  history.update({ t: { id: 't', messages: [] } });
  const view = { cursor: 0, stateCursor: 0, activityCursor: 0, legacy: false, hasOlder: false, hasNewer: false, follow: true };
  let completeState, receive, changed = 0;
  const state = new Promise(resolve => { completeState = resolve; });
  const follow = new BotFollowModel(history, 't', view, {
    available: () => true, current: () => true, state: () => state,
    snapshot: () => { throw new Error('unexpected_recovery'); },
    follow: (_cursor, callback, signal) => { receive = callback; return new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })); },
    fatal: () => false, retryAfter: () => 0, status: () => {}, announce: () => {}, changed: () => changed++,
  });
  const stop = follow.start();
  const activity = { phase: 'running', label: 'new activity' };
  receive({ type: 'thread.activity', activity }, 20);
  receive({ type: 'thread.activity', activity: null }, 19);
  assert.equal(view.activity, activity);
  assert.equal(view.cursor, 20);
  completeState({ eventCursor: 10, activity: null, approvals: [], questions: [], runs: [], running: false });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.stateCursor, 10);
  assert.equal(view.activityCursor, 20);
  assert.equal(view.activity, activity, 'an older state snapshot cannot roll back newer activity');
  stop(); stop();
  const notifications = changed;
  receive({ type: 'thread.activity', activity: null }, 21);
  assert.equal(changed, notifications);
  assert.equal(view.cursor, 20, 'disposed follow never advances its durable watermark');
  history.dispose();
});

test('Bot follow release does not wait for a provider and rejects its late state', async () => {
  const history = new BotHistoryModel({ server: 'fixture', account: 'old', scope: 'bot' });
  history.update({ t: { id: 't', messages: [] } });
  const original = history.getSnapshot();
  const view = { cursor: 0, stateCursor: 0, activityCursor: 0, legacy: false, hasOlder: false, hasNewer: false, follow: true };
  let completeState;
  const follow = new BotFollowModel(history, 't', view, {
    available: () => true, current: () => true,
    state: () => new Promise(resolve => { completeState = resolve; }),
    snapshot: () => { throw new Error('unexpected_recovery'); },
    follow: (_cursor, _receive, signal) => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })),
    fatal: () => false, retryAfter: () => 0, status: () => {}, announce: () => {}, changed: () => assert.fail('late state published'),
  });
  follow.start()();
  completeState({ eventCursor: 50, activity: null, approvals: [], questions: [], runs: [], running: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(view.stateCursor, 0);
  assert.equal(history.getSnapshot(), original);
  history.dispose();
});
