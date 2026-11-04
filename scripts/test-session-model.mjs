import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionTimelineModel } from '../packages/client-core/src/session.ts';

const row = (id, content, extra = {}) => ({ id, sessionId: 1, createdAt: id, content, role: 'assistant', ...extra });
const convert = value => ({ key: `row-${value.id}`, rowId: value.id, role: value.role === 'assistant' ? 'ai' : 'user', content: value.content, createdAt: value.createdAt, taskId: value.taskId });
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
