import assert from 'node:assert/strict';
import test from 'node:test';
import { chatTaskState } from '../apps/web/src/store/chatTaskState.ts';
import { SessionTimelineModel } from '../packages/client-core/src/session.ts';
import { taskDto } from '../apps/api/src/cloud/tasks.ts';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';

test('historical media receipt cannot poison the task-list wire baseline', () => {
  const task = taskDto({ id: 'old-cover', kind: 'cover', resource: 'old', status: 'completed', input: '{}', error: null, created_at: new Date().toISOString(), executor: 'media' });
  const codec = TYPERT_REMOTE.methods['clientRuntime/watchTasks'].result.create();
  assert.doesNotThrow(() => codec.parse(JSON.parse(JSON.stringify({ type: 'snapshot', revision: 1, value: { tasks: [task] } }))));
  assert.equal(task.executor, 'node');
});

test('thinking checkpoints stay streaming through history reconciliation; terminal error preserves cause', () => {
  let task = { id: 't', status: 'running', createdAt: new Date().toISOString(), progress: { phase: 'thinking' } };
  const convert = row => ({ key: 'stored', rowId: row.id, role: 'ai', taskId: 't', ...chatTaskState(row, task) });
  const model = new SessionTimelineModel(1, convert);
  const row = { id: 2, sessionId: 1, taskId: 't', role: 'assistant', createdAt: 1, content: '', interrupted: true, reasoning: 'still thinking' };
  let messages = model.reconcile([{ key: 'optimistic', taskId: 't', role: 'ai', content: '', streaming: true }], [row]);
  assert.equal(messages[0].content, ''); assert.equal(messages[0].streaming, true); assert.equal(messages[0].error, false);
  task = { ...task, status: 'completed' };
  messages = model.reconcile(messages, [{ ...row, content: 'answer', interrupted: false }]);
  assert.equal(messages[0].streaming, false); assert.equal(messages[0].content, 'answer');
  task = { ...task, status: 'failed', error: 'model_timeout' };
  const failed = chatTaskState(row, task);
  assert.equal(failed.content, '回答失败：model_timeout');
  assert.equal(failed.error, true);
  const partial = chatTaskState({ ...row, content: 'partial answer' }, task);
  assert.equal(partial.content, 'partial answer'); assert.equal(partial.interrupted, true);
  assert.equal(chatTaskState(row, { ...task, status: 'cancelled' }).error, false);
});
