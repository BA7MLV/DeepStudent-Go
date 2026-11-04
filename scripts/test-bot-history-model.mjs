import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BotHistoryModel, mergeMessages } from '../packages/client-core/src/bot-history.ts';

const identity = { server: 'https://fixture.invalid', account: 'a', scope: 'bot' };
const message = (id, seq, extra = {}) => ({ id, seq, threadId: 't', role: 'assistant', kind: 'text', content: id, createdAt: '2026-11-03', clientNonce: null, replyTo: null, ...extra });
const thread = (id, messages = [message(id, 1)]) => ({ id, mode: 'bot', title: id, createdAt: '2026-11-03', updatedAt: '2026-11-03', messages });

test('Bot projection is observable, stable on no-op, and independent across identities', () => {
  const model = new BotHistoryModel(identity), other = new BotHistoryModel({ ...identity, account: 'b' });
  let notifications = 0;
  const off = model.subscribe(() => notifications++);
  const detail = thread('t'); model.update({ t: detail });
  const snapshot = model.getSnapshot();
  model.update(old => old); model.patch('t', old => old);
  assert.equal(model.getSnapshot(), snapshot); assert.equal(notifications, 1);
  assert.deepEqual(other.getSnapshot(), {});
  assert.equal(model.getSnapshot().t, detail);
  off(); off(); model.dispose(); model.dispose();
  assert.equal(model.diagnostics().listeners, 0);
  assert.throws(() => model.update({}), /bot_model_disposed/);
  assert.throws(() => model.subscribe(() => {}), /bot_model_disposed/);
});

test('LRU budget preserves active/new/pending threads without mutating a caller snapshot', () => {
  const model = new BotHistoryModel(identity, { threads: 2, bytes: 1000 });
  const original = { a: thread('a'), b: thread('b') }; model.update(original); model.touch('a');
  model.update(old => ({ ...old, c: thread('c') }));
  assert.deepEqual(Object.keys(model.getSnapshot()).sort(), ['a', 'c']);
  assert.deepEqual(Object.keys(original), ['a', 'b']);
  const previous = model.getSnapshot();
  model.update(old => ({ ...old, d: thread('d', [message('pending-nonce', 1)]) }), new Set(['a']));
  assert.deepEqual(Object.keys(model.getSnapshot()).sort(), ['a', 'd']);
  assert.deepEqual(Object.keys(previous).sort(), ['a', 'c']);
  model.update(old => ({ ...old, e: thread('e') }), new Set(['a']));
  assert.ok(model.getSnapshot().a && model.getSnapshot().d && model.getSnapshot().e, 'pending/active may exceed soft budget');
});

test('late state cannot reopen resolved cards and unloaded resolved cards are pruned', () => {
  const model = new BotHistoryModel(identity);
  const approval = { id: 'approval', messageId: 'm', threadId: 't', status: 'approved', createdAt: '', resolvedAt: '', resolution: '' };
  model.update({ t: { ...thread('t', [message('m', 1)]), approvals: [approval] } });
  model.applyState('t', { approvals: [{ ...approval, status: 'pending' }], questions: [], runs: [], running: false, eventCursor: 10 });
  assert.equal(model.getSnapshot().t.approvals[0], approval);
  model.patch('t', old => ({ ...old, messages: [] }));
  assert.deepEqual(model.getSnapshot().t.approvals, []);
});

test('nonce reconciliation retains stable messages and consumes no browser/React services', () => {
  const stable = message('stable', 1), pending = message('pending-nonce', 2, { clientNonce: 'nonce' });
  const committed = message('server', 2, { clientNonce: 'nonce' });
  const next = mergeMessages([stable, pending], [committed]);
  assert.equal(next[0], stable); assert.deepEqual(next.map(item => item.id), ['stable', 'server']);
  assert.equal(mergeMessages(next, [committed]), next);
});

test('1000-message window, progress exclusion, deferred tail and overlapping latest page', () => {
  const model = new BotHistoryModel(identity);
  const messages = Array.from({ length: 1000 }, (_, index) => message(`m${index + 1}`, index + 1));
  model.update({ t: thread('t', messages) });
  let window = { follow: false, hasOlder: false, hasNewer: false };
  const original = model.getSnapshot();
  for (let n = 0; n < 500; n++) window = model.append('t', message(`p${n}`, 1001 + n, { kind: 'progress' }), window);
  assert.equal(model.getSnapshot(), original, 'ephemeral progress does not rewrite history');
  const deferred = message('deferred', 1501);
  window = model.append('t', deferred, window);
  assert.equal(window.hasNewer, true); assert.equal(model.getSnapshot().t.messages, messages);
  const page = { messages: [message('m1000', 1000)], approvals: [], questions: [], hasOlder: true, nextBeforeSeq: 1000 };
  model.latest('t', page);
  assert.deepEqual(model.getSnapshot().t.messages.map(item => item.id), ['m1000', 'deferred']);
  model.update({ t: thread('t', messages) });
  const following = model.append('t', message('new', 1001), { follow: true, hasOlder: false, hasNewer: false });
  assert.equal(following.hasOlder, true); assert.equal(following.hasNewer, false);
  assert.equal(model.getSnapshot().t.messages.length, 1000);
  assert.equal(model.getSnapshot().t.messages[0], messages[1]);
  const pending = message('pending-send', 0, { role: 'user', clientNonce: 'pending' });
  model.update({ t: thread('t', [pending, ...messages]) });
  model.append('t', message('newer', 1001), { follow: true, hasOlder: false, hasNewer: false });
  assert.equal(model.getSnapshot().t.messages[0], pending, 'trimming remote history never drops an unacknowledged send');
});
