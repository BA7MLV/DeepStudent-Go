import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTimelineModel, shareSessionValue } from '../packages/client-core/src/session.ts';
import { ConversationSessionModel } from '../packages/client-core/src/session-state.ts';

const row = (id, content, extra = {}) => ({ id, sessionId: 1, createdAt: id, content, role: 'assistant', ...extra });
const convert = value => ({ key: `row-${value.id}`, rowId: value.id, role: value.role === 'assistant' ? 'ai' : 'user', content: value.content, createdAt: value.createdAt, taskId: value.taskId });
test('structural sharing preserves own prototype-named wire keys without changing the result prototype', () => {
  const previous = JSON.parse('{"__proto__":{"content":"before"},"constructor":"first"}');
  const next = JSON.parse('{"__proto__":{"content":"after"},"constructor":"second"}');
  const result = shareSessionValue(previous, next);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.deepEqual(result, next);
  assert.equal(shareSessionValue(result, JSON.parse(JSON.stringify(next))), result);
  assert.deepEqual(shareSessionValue({ a: undefined }, { b: undefined }), { b: undefined });
});
test('session reconciliation preserves pending identities, drops authoritative deletions and ignores other sessions', () => {
  const model = new SessionTimelineModel(1, convert);
  const optimistic = { key: 'optimistic-1', role: 'ai', content: 'partial', streaming: true, taskId: 'one' };
  const pending = { key: 'unsent', role: 'user', content: 'never discard me' };
  const messages = model.reconcile([convert(row(1, 'deleted')), optimistic, pending], [row(2, 'committed', { taskId: 'one' }), row(3, 'foreign', { sessionId: 2 })]);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].key, optimistic.key);
  assert.equal(messages[0].rowId, 2);
  assert.equal(messages[0].streaming, false);
  assert.equal(messages[1], pending);
  assert.equal(model.getSnapshot(), messages);
});

test('equal inputs retain snapshot/nested identities and tail updates notify only its selector', () => {
  const state = new ConversationSessionModel(1, { messages: [], tasks: [], hasOlder: false, loading: false }, convert);
  const first = state.timeline.reconcile([], [row(1, 'history'), row(2, 'tail')]);
  state.set({ messages: first });
  const snapshot = state.getSnapshot();
  state.set({ messages: state.timeline.reconcile(first, [row(1, 'history'), row(2, 'tail')]), tasks: [] });
  assert.equal(state.getSnapshot(), snapshot);
  let history = 0, tail = 0, input = 0;
  state.subscribeSelector(value => value.messages[0], () => history++);
  state.subscribeSelector(value => value.messages[1], () => tail++);
  state.subscribeSelector(value => value.loading, () => input++);
  state.set({ messages: state.timeline.reconcile(first, [row(1, 'history'), row(2, 'tail grows')]) });
  assert.equal(state.getSnapshot().messages[0], first[0]);
  assert.deepEqual({ history, tail, input }, { history: 0, tail: 1, input: 0 });
  const prepended = state.timeline.reconcile(state.getSnapshot().messages, [row(0, 'older'), row(1, 'history'), row(2, 'tail grows')]);
  assert.equal(prepended[1], first[0], 'prepending does not replace existing message identities');
  state.dispose();
});

test('frame publication coalesces progress but terminal/interaction delivery is synchronous and disposal cancels pending work', () => {
  const frames = new Set();
  const state = new ConversationSessionModel(1, { content: '', loading: true }, convert, callback => {
    frames.add(callback); return () => frames.delete(callback);
  });
  let notifications = 0;
  state.subscribe(() => notifications++);
  state.set({ content: 'a' }, true); state.set({ content: 'ab' }, true);
  assert.equal(frames.size, 1); assert.equal(notifications, 0);
  state.set({ content: 'answer', loading: false });
  assert.equal(notifications, 1); assert.equal(frames.size, 0);
  assert.deepEqual(state.getSnapshot(), { content: 'answer', loading: false });
  state.set({ content: 'pending' }, true); state.dispose();
  assert.equal(frames.size, 0); assert.equal(notifications, 1);
});
test('session progress reuses continue target and records uncertain commands without resubmitting', () => {
  const model = new SessionTimelineModel(1, convert);
  const first = convert(row(10, 'old answer'));
  const answer = { key: 'new-transport-key', taskId: 'continue', role: 'ai', content: 'continued', streaming: true };
  const messages = model.progress([first], { id: 'continue', input: { action: 'continue', rowId: 10 } }, undefined, answer);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].key, first.key);
  model.begin('operation'); model.uncertain('operation');
  assert.deepEqual(model.pendingCommands(), [{ operationId: 'operation', status: 'uncertain' }]);
  model.accept('operation', 'task');
  assert.deepEqual(model.pendingCommands(), [{ operationId: 'operation', status: 'accepted', taskId: 'task' }]);
  const generation = model.invalidate();
  model.dispose();
  assert.equal(model.current(generation), false);
  assert.deepEqual(model.pendingCommands(), []);
});
