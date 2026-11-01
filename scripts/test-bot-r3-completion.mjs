import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';

const root = fs.mkdtempSync(path.join('/tmp', 'bot-r3-'));
process.env.MODEL_API_KEY = 'local-r3-probe';
const call = (name, args) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function runCase(mode, background = false) {
  const store = new DatabaseStore(path.join(root, `${mode}-${background}.sqlite`));
  const owner = crypto.randomUUID(), thread = crypto.randomUUID(), run = crypto.randomUUID(), task = crypto.randomUUID();
  const at = new Date().toISOString();
  const marker = ['question', 'approval'].includes(mode) ? 'INTERACTION_REQUIRED' : 'PREMATURE';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'R3', at);
  store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(thread, owner, 'bot', 'R3', at, at);
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run, thread, 'bot', 'queued', at);
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(task, owner, task, 'handout', 'course:r3', JSON.stringify({ background }), 'running', at, at, run);
  let requests = 0;
  const runner = new BotRunner(store, { fetch: async () => {
    requests++;
    const message = requests > 1
        ? { tool_calls: [call('wait', { seconds: 3600, reason: 'R3 test' })] }
        : mode === 'send_message'
          ? { tool_calls: [call('send_message', { kind: 'text', text: 'PREMATURE', complete: true })] }
          : mode === 'question' || mode === 'approval'
            ? { tool_calls: [call('send_message', { kind: mode, text: 'INTERACTION_REQUIRED' })] }
        : mode === 'finish_turn'
          ? { content: 'PREMATURE', tool_calls: [call('finish_turn', {})] }
          : { content: 'PREMATURE' };
    return new Response(JSON.stringify({ choices: [{ message }] }));
  } });
  try {
    runner.start();
    for (let i = 0; i < 500; i++) {
      const row = store.db.prepare('SELECT status,wake_at FROM runs WHERE id=?').get(run);
      if (row?.wake_at || ['completed', 'failed', 'paused', 'waiting_user'].includes(row?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const visible = store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND role='assistant' AND content=?").get(thread, marker);
    const events = store.db.prepare("SELECT 1 FROM message_events WHERE thread_id=? AND payload LIKE ?").get(thread, `%${marker}%`);
    if (mode === 'question') {
      const question = store.db.prepare('SELECT id FROM run_questions WHERE run_id=?').get(run);
      const service = new BotApplicationService(store, runner);
      const answer = service.send(owner, thread, { clientNonce: 'answer', content: 'Use only the first three files.', target: { kind: 'question', questionId: question.id } });
      assert.equal(answer.receipt.runId, run);
      for (let i = 0; i < 500 && !store.db.prepare('SELECT wake_at FROM runs WHERE id=?').get(run)?.wake_at; i++) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(store.db.prepare('SELECT status FROM run_questions WHERE id=?').get(question.id).status, 'answered');
      assert.ok(store.db.prepare('SELECT consumed_at FROM run_inputs WHERE message_id=?').get(answer.id).consumed_at);
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id=?').get(run).n, 0);
    }
    if (mode === 'approval') {
      const approval = store.db.prepare('SELECT id FROM approvals WHERE run_id=?').get(run);
      const service = new BotApplicationService(store, runner);
      assert.throws(() => service.send(owner, thread, { clientNonce: 'not-an-approval', content: 'yes', target: { kind: 'question', questionId: approval.id } }), /target_expired/);
      assert.equal(store.db.prepare('SELECT status FROM approvals WHERE id=?').get(approval.id).status, 'pending', 'ordinary answer cannot authorize approval');
    }
    return {
      visible: Boolean(visible),
      event: Boolean(events),
      status: store.db.prepare('SELECT status,error_code FROM runs WHERE id=?').get(run),
      questions: store.db.prepare('SELECT COUNT(*) AS n FROM run_questions WHERE run_id=?').get(run).n,
      approvals: store.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id=?').get(run).n,
    };
  } finally { await runner.close(); store.close(); }
}

async function runInputDuringToolCase(finalTool = 'send_message') {
  const store = new DatabaseStore(path.join(root, `input-during-tool-${finalTool}.sqlite`));
  const owner = crypto.randomUUID(), thread = crypto.randomUUID(), run = crypto.randomUUID();
  const at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'R3', at);
  store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(thread, owner, 'bot', 'R3', at, at);
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run, thread, 'bot', 'queued', at);
  const configuration = new CloudConfiguration(store, path.join(root, 'input-config'));
  const defaults = configuration.get(owner, true);
  configuration.save(owner, { ...defaults, policy: { ...defaults.policy, shell: 'allow' } });
  let service;
  let requests = 0;
  let secondWire;
  const study = new StudyTools(store, configuration, path.join(root, 'files'));
  let parallelStarted = 0;
  let releaseReads;
  const readsGate = new Promise(resolve => { releaseReads = resolve; });
  study.register({ name: 'probe_read', description: 'Controlled concurrent read', properties: { index: { type: 'integer' } }, required: ['index'], capability: () => 'read', parallelSafe: () => true,
    execute: async ({ index }) => {
      if (++parallelStarted === 2) {
        service.send(owner, thread, { clientNonce: 'during-reads', content: 'REVISED REQUIREMENT: do not deliver the old result', target: { kind: 'run', runId: run } });
        releaseReads();
      }
      await readsGate;
      return { retainedRead: index };
    },
  });
  const runner = new BotRunner(store, {
    configuration,
    study,
    sandbox: async () => {
      service.send(owner, thread, { clientNonce: 'during-tool', content: 'REVISED REQUIREMENT: do not deliver the old result', target: { kind: 'run', runId: run } });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    fetch: async (_url, init) => {
      requests++;
      if (requests === 2) secondWire = JSON.parse(init.body);
      const message = requests === 1
        ? { tool_calls: [...(finalTool === 'parallel' ? [call('probe_read', { index: 0 }), call('probe_read', { index: 1 })] : [call('shell', { command: 'true' })]), ['send_message', 'parallel'].includes(finalTool)
          ? call('send_message', { kind: 'text', text: 'STALE_RESULT', complete: true })
          : finalTool === 'finish_turn' ? call('finish_turn', {}) : call('study_send_file', { fileId: 'stale-file', caption: 'STALE_FILE' })] }
        : { tool_calls: [call('wait', { seconds: 3600, reason: 'R3 input test' })] };
      return new Response(JSON.stringify({ choices: [{ message }] }));
    },
  });
  service = new BotApplicationService(store, runner);
  try {
    runner.start();
    for (let i = 0; i < 500; i++) {
      const row = store.db.prepare('SELECT status,wake_at FROM runs WHERE id=?').get(run);
      if (row?.wake_at || ['completed', 'failed', 'paused'].includes(row?.status)) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const visible = store.db.prepare("SELECT 1 FROM messages WHERE thread_id=? AND (content LIKE '%STALE_RESULT%' OR content LIKE '%STALE_FILE%')").get(thread);
    const events = store.db.prepare("SELECT 1 FROM message_events WHERE thread_id=? AND (payload LIKE '%STALE_RESULT%' OR payload LIKE '%STALE_FILE%')").get(thread);
    const input = store.db.prepare('SELECT consumed_at FROM run_inputs WHERE run_id=?').get(run);
    const context = store.db.prepare('SELECT context_json FROM runs WHERE id=?').get(run);
    assert.equal(Boolean(visible), false, `stale ${finalTool} tool-batch reply was delivered`);
    assert.equal(Boolean(events), false, 'stale tool-batch reply emitted an event');
    assert.ok(requests >= 2, 'runner did not re-plan after tool-time input');
    assert.ok(input?.consumed_at, 'follow-up input remained unconsumed');
    assert.match(context.context_json, /REVISED REQUIREMENT/);
    assert.match(JSON.stringify(secondWire), /REVISED REQUIREMENT/, 'next model request must contain the accepted follow-up');
    const messages = secondWire.messages;
    const batchMessage = messages.find(message => message.role === 'assistant' && message.tool_calls);
    const toolResults = messages.filter(message => message.role === 'tool');
    assert.equal(toolResults.length, batchMessage.tool_calls.length, 'every stale tool call needs exactly one paired result');
    assert.deepEqual(toolResults.map(message => message.tool_call_id), batchMessage.tool_calls.map(call => call.id), 'parallel results preserve transcript order');
    assert.match(toolResults[0].content, finalTool === 'parallel' ? /retainedRead/ : /stdout/, 'completed tool result must survive re-planning');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE thread_id=?').get(thread).n, 1, 'supplement must not fork a run');
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM gateway_outbox WHERE payload LIKE '%STALE_RESULT%' OR payload LIKE '%STALE_FILE%'").get().n, 0);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM run_steps WHERE run_id=? AND status='interrupted' AND result LIKE 'Not executed: superseded%'").get(run).n, 1);
  } finally { await runner.close(); store.close(); }
}

try {
  for (const mode of ['send_message', 'finish_turn', 'plain_text']) {
    const result = await runCase(mode);
    assert.equal(result.visible, false, `${mode} delivered before foreground task completion`);
    assert.equal(result.event, false, `${mode} emitted an early message event`);
  }
  const background = await runCase('send_message', true);
  assert.equal(background.visible, true, 'explicit background task did not permit started delivery');
  for (const mode of ['question', 'approval']) {
    const result = await runCase(mode);
    assert.equal(result.visible, true, `${mode} was incorrectly blocked by completion dependency`);
    assert.equal(result.status.status, mode === 'question' ? 'queued' : 'waiting_user', `${mode} did not wait/resume correctly`);
    assert.equal(result.questions, mode === 'question' ? 1 : 0, `${mode} created an incorrect question identity`);
    assert.equal(result.approvals, mode === 'approval' ? 1 : 0, `${mode} created an incorrect approval identity`);
  }
  await runInputDuringToolCase('send_message');
  await runInputDuringToolCase('finish_turn');
  await runInputDuringToolCase('study_send_file');
  await runInputDuringToolCase('parallel');
  console.log('Bot R3 completion gates: premature exits blocked, background delivery allowed, question/approval remain visible, tool-time input re-planned without stale delivery');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
