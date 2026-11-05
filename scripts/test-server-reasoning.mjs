/** Real task runner + Gateway + persistence, with an injected offline transport. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'server-reasoning-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), timestamp = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, timestamp);
const providers = [
  { id: 'openai', protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', protocol: 'openai-chat', baseUrl: 'https://api.deepseek.com' },
  { id: 'claude', protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com/v1' },
].map(p => ({ ...p, name: p.id, catalogId: '', apiKey: 'offline-fixture', serves: ['chat'] }));
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const rows = sessionId => store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner)
  .map(row => JSON.parse(row.value)).filter(row => row.sessionId === sessionId);
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
let script = [];
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body);
  assert.ok(script.length, 'unexpected model/network request');
  const { call, thought = 'Plan', text: answer = 'Answer' } = script.shift()(body);
  const text = call ? null : answer;
  const args = JSON.stringify({ action: 'read', path: '/system/board/README.md' });
  if (url.endsWith('/responses')) return Response.json({ status: 'completed', output: [
    { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: thought }], encrypted_content: 'opaque' },
    ...(call ? [{ type: 'function_call', call_id: 'call', name: 'board', arguments: args }] : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }]),
  ] });
  if (url.endsWith('/messages')) return Response.json({ stop_reason: call ? 'tool_use' : 'end_turn', content: [
    { type: 'thinking', thinking: thought, signature: 'signed' },
    ...(call ? [{ type: 'tool_use', id: 'call', name: 'board', input: JSON.parse(args) }] : [{ type: 'text', text }]),
  ] });
  return Response.json({ choices: [{ message: { role: 'assistant', content: text, reasoning_content: thought,
    ...(call ? { tool_calls: [{ id: 'call', type: 'function', function: { name: 'board', arguments: args } }] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }] });
};
const runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch });
const completed = async (sessionId, kind, extra = {}) => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, `session:${sessionId}`, JSON.stringify({ sessionId, text: 'offline test', ...extra }), 'queued', timestamp, timestamp);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const task = get(id);
    if (['completed', 'failed', 'cancelled'].includes(task.status)) {
      assert.equal(task.status, 'completed', JSON.stringify(task));
      assert.equal(script.length, 0);
      return task;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for offline task');
};

try {
  runner.start('http://127.0.0.1:1');
  put('preferences', 'thinkingEnabled', { id: 'thinkingEnabled', value: true });
  put('preferences', 'thinkingEffort', { id: 'thinkingEffort', value: 'low' });
  let sid = 10;
  for (const [providerId, model] of [['openai', 'gpt-5.2'], ['deepseek', 'deepseek-flash'], ['claude', 'claude-sonnet-4-6']]) {
    configuration.save(owner, { ...configuration.get(owner), providers, llmModel: { providerId, model }, policy: { ...configuration.get(owner).policy, maxSteps: 1 } });
    const check = level => body => {
      if (providerId === 'openai') assert.deepEqual(body.reasoning, { effort: level, ...(level !== 'none' ? { summary: 'auto' } : {}) });
      if (providerId === 'deepseek') {
        assert.equal(body.thinking.type, level === 'none' ? 'disabled' : 'enabled');
        assert.equal(body.reasoning_effort, level === 'none' ? undefined : level);
        assert.equal(body.enable_thinking, undefined);
      }
      if (providerId === 'claude') {
        assert.deepEqual(body.thinking, { type: level === 'none' ? 'disabled' : 'adaptive' });
        assert.equal(body.output_config.effort, level === 'none' ? 'high' : level);
      }
    };
    for (const kind of ['chat', 'qa']) {
      const sessionId = sid++;
      put('chatSessions', sessionId, { id: sessionId, videoId: kind === 'chat' ? '__library_assistant__' : 'course', title: '新会话', createdAt: Date.now() });
      put('videos', 'course', { id: 'course', name: 'Fixture course', kind: 'material', materialFormat: 'md' });
      // A one-round budget forces the separate final-answer call. Both must
      // honor the submitted snapshot rather than the lower synced preference.
      script = [body => { check('high')(body); return { call: true }; }, body => { check('high')(body); return {}; }];
      const task = await completed(sessionId, kind, { videoId: 'course', thinkingLevel: 'high' });
      assert.equal(task.result.content, 'Answer');
      assert.equal(task.result.reasoning, 'PlanPlan');
      assert.equal(rows(sessionId).find(row => row.role === 'assistant').reasoning, 'PlanPlan');
      assert.equal(task.result.tools.at(-1).reasoningOffset, 'Plan'.length, 'tool stays between the two reasoning rounds');
      if (kind === 'chat') {
        const rowId = task.result.rowId;
        const row = records.get(owner, 'chats', rowId);
        put('chats', rowId, { ...row, interrupted: true });
        script = [body => { check('none')(body); return { thought: '' }; }];
        await completed(sessionId, 'chat', { action: 'continue', rowId, thinkingLevel: 'none' });
      }
    }
    const sessionId = sid++;
    put('chatSessions', sessionId, { id: sessionId, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
    script = [body => { check('low')(body); return {}; }];
    await completed(sessionId, 'chat', { thinkingLevel: 'invalid' });
  }
  const sessionId = sid++;
  put('chatSessions', sessionId, { id: sessionId, videoId: '__library_assistant__', title: 'Long stream', createdAt: Date.now() });
  const text = 'long text '.repeat(2300), thought = 'plan '.repeat(1800);
  script = [() => ({ text, thought })];
  const long = await completed(sessionId, 'chat');
  assert.equal(long.progress.content, text, 'live progress never truncates a long saved answer');
  assert.equal(long.progress.reasoning, thought, 'live reasoning and history have the same prefix');
  assert.equal(rows(sessionId).find(row => row.role === 'assistant').content, long.progress.content);
  console.log('PASS: chat + QA + forced final answer + continue, snapshot priority, preference fallback, host-derived Gateway adapter, reasoning persistence (offline)');
} finally {
  await runner.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
