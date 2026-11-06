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

test('activity task projection drops historical result and the duplicate transcript', () => {
  const base = { id: 'task', kind: 'chat', resource: 'r', status: 'completed', input: '{"sessionId":1}',
    progress: JSON.stringify({ phase: 'answer', content: 'final answer', modelTranscript: { version: 1, messages: [] } }),
    result: JSON.stringify({ content: 'final answer', rowId: 2 }), error: null, created_at: new Date().toISOString(), executor: 'node' };
  const task = taskDto(base, 'activity');
  assert.equal(task.result, null, 'historical results are not repeated to every live subscriber');
  assert.deepEqual(task.progress, { phase: 'answer' }, 'terminal prose stays in the record projection');
  assert.equal(task.progress.modelTranscript, undefined);
  const running = { ...base, status: 'running', progress: JSON.stringify({ phase: 'answer', content: 'streaming', modelTranscript: { version: 1, messages: [] } }) };
  const activity = taskDto(running, 'activity');
  assert.deepEqual(activity.progress, { phase: 'answer' }, 'the global task list does not repeat the open answer');
  const session = taskDto(running, 'session');
  assert.equal(session.progress.content, 'streaming', 'the open conversation still receives its live text');
  assert.equal(session.progress.modelTranscript, undefined, 'progress never duplicates the stored model trace');
  const full = taskDto(base, 'full');
  assert.deepEqual(full.result, { content: 'final answer', rowId: 2 }, 'one-shot readers still receive the full task');
  assert.deepEqual(full.progress, { phase: 'answer', content: 'final answer', modelTranscript: { version: 1, messages: [] } });
  const codec = TYPERT_REMOTE.methods['clientRuntime/watchTasks'].result.create();
  assert.doesNotThrow(() => codec.parse(JSON.parse(JSON.stringify({ type: 'snapshot', revision: 1, value: { tasks: [task, activity, session] } }))));
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
