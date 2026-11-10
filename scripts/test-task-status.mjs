import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TERMINAL_TASK_STATUSES, UNFINISHED_TASK_STATUSES, COMPUTING_TASK_STATUSES, ANSWERABLE_TASK_STATUSES,
  isTaskTerminal, isTaskUnfinished, taskOccupiesResource, isTaskComputing, taskAcceptsAnswer,
} from '../packages/contracts/src/task-status.ts';
import { chatTaskActive, chatTaskState } from '../apps/web/src/store/chatTaskState.ts';
import { createDsmlRecoverer, recoverDsmlText } from '../packages/study-core/src/api/dsml.ts';

const ALL_STATUSES = ['queued', 'running', 'waiting_user', 'waiting_event', 'completed', 'failed', 'cancelled', 'interrupted'];

test('task status matrix: every status is classified by each responsibility, no vague single active', () => {
  const expected = {
    queued: { terminal: false, unfinished: true, occupiesResource: true, computing: true, answerable: false },
    running: { terminal: false, unfinished: true, occupiesResource: true, computing: true, answerable: true },
    waiting_user: { terminal: false, unfinished: true, occupiesResource: true, computing: false, answerable: true },
    waiting_event: { terminal: false, unfinished: true, occupiesResource: true, computing: false, answerable: false },
    completed: { terminal: true, unfinished: false, occupiesResource: false, computing: false, answerable: false },
    failed: { terminal: true, unfinished: false, occupiesResource: false, computing: false, answerable: false },
    cancelled: { terminal: true, unfinished: false, occupiesResource: false, computing: false, answerable: false },
    interrupted: { terminal: true, unfinished: false, occupiesResource: false, computing: false, answerable: false },
  };
  for (const status of ALL_STATUSES) {
    const row = expected[status];
    assert.equal(isTaskTerminal(status), row.terminal, status);
    assert.equal(isTaskUnfinished(status), row.unfinished, status);
    assert.equal(taskOccupiesResource(status), row.occupiesResource, status);
    assert.equal(isTaskComputing(status), row.computing, status);
    assert.equal(taskAcceptsAnswer(status), row.answerable, status);
  }
  assert.deepEqual([...TERMINAL_TASK_STATUSES], ['completed', 'failed', 'cancelled', 'interrupted']);
  assert.deepEqual([...UNFINISHED_TASK_STATUSES], ['queued', 'running', 'waiting_user', 'waiting_event']);
  assert.deepEqual([...COMPUTING_TASK_STATUSES], ['queued', 'running']);
  assert.deepEqual([...ANSWERABLE_TASK_STATUSES], ['running', 'waiting_user']);
});

test('F01: waiting_event stays active in chat selectors instead of looking ended', () => {
  assert.equal(chatTaskActive({ status: 'waiting_event' }), true);
  assert.equal(chatTaskActive({ status: 'waiting_user' }), true);
  assert.equal(chatTaskActive({ status: 'completed' }), false);
  const task = { status: 'waiting_event', progress: null, error: null, createdAt: '2026-11-10T00:00:00Z' };
  const state = chatTaskState({ content: '' }, task);
  assert.equal(state.streaming, true);
  assert.equal(state.error, false);
  assert.equal(state.interrupted, false);
  const failed = chatTaskState({ content: '' }, { status: 'failed', error: 'x' });
  assert.equal(failed.error, true);
});

const DSML_SAMPLE = 'before <｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls> after';

function runChunked(input, chunks) {
  const recoverer = createDsmlRecoverer();
  const parts = chunks.flatMap(chunk => recoverer.push(chunk)).concat(recoverer.flush());
  const calls = parts.filter(p => p.kind === 'toolCall').map(p => ({ name: p.name, arguments: p.arguments }));
  const text = parts.filter(p => p.kind === 'text').map(p => p.text).join('');
  return { text, calls };
}

test('F10: DSML body whitespace is invariant under every single split point', () => {
  const oneShot = recoverDsmlText(DSML_SAMPLE);
  assert.equal(oneShot.text, 'before  after');
  assert.equal(oneShot.calls.length, 1);
  assert.equal(oneShot.calls[0].name, 'read');
  for (let split = 0; split <= DSML_SAMPLE.length; split++) {
    const result = runChunked(DSML_SAMPLE, [DSML_SAMPLE.slice(0, split), DSML_SAMPLE.slice(split)]);
    assert.deepEqual(result.text, oneShot.text, `split at ${split}`);
    assert.deepEqual(result.calls, oneShot.calls, `split at ${split}`);
  }
});

test('F10: DSML body whitespace is invariant under character-by-character streaming', () => {
  const oneShot = recoverDsmlText(DSML_SAMPLE);
  const result = runChunked(DSML_SAMPLE, [...DSML_SAMPLE]);
  assert.deepEqual(result.text, oneShot.text);
  assert.deepEqual(result.calls, oneShot.calls);
});

test('DSML structural whitespace between tags stays dropped under any chunking', () => {
  const input = 'a\n<｜DSML｜tool_calls>\n  <｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.md</｜DSML｜parameter></｜DSML｜invoke>\n</｜DSML｜tool_calls>\nb';
  const oneShot = recoverDsmlText(input);
  assert.equal(oneShot.text, 'a\n\nb');
  for (let split = 0; split <= input.length; split++) {
    const result = runChunked(input, [input.slice(0, split), input.slice(split)]);
    assert.deepEqual(result.text, oneShot.text, `split at ${split}`);
    assert.deepEqual(result.calls, oneShot.calls, `split at ${split}`);
  }
  const byChar = runChunked(input, [...input]);
  assert.deepEqual(byChar.text, oneShot.text);
  assert.deepEqual(byChar.calls, oneShot.calls);
});

test('DSML trailing structural whitespace at EOF is dropped consistently', () => {
  const input = 'x <｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>   ';
  const oneShot = recoverDsmlText(input);
  assert.equal(oneShot.text, 'x ');
  for (let split = 0; split <= input.length; split++) {
    const result = runChunked(input, [input.slice(0, split), input.slice(split)]);
    assert.deepEqual(result.text, oneShot.text, `split at ${split}`);
  }
});
