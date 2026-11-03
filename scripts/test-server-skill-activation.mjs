import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-activation-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const owner = crypto.randomUUID(), timestamp = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, timestamp);
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'test', name: 'Test', protocol: 'openai-chat', apiKey: 'test-only', baseUrl: 'https://skills.example/v1', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'test', model: 'fixture' } });
const requests = [];
let scripted = [];
const runner = new CloudTaskRunner(store, { records, configuration, filesDir: path.join(directory, 'files'), fetch: async (_url, init) => {
  requests.push(JSON.parse(init.body));
  return Response.json(scripted.shift() ?? { choices: [{ message: { role: 'assistant', content: '测试完成' }, finish_reason: 'stop' }] });
} });
const put = (table, id, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key: id, before: records.get(owner, table, id), after: value }]);
const patchSession = changes => put('chatSessions', 10, { ...records.get(owner, 'chatSessions', 10), ...changes });
const requestBody = () => JSON.stringify(requests.at(-1).messages);
async function run(kind, input, failed) {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, 'session:10', JSON.stringify({ sessionId: 10, text: '测试问题', ...input }), 'queued', timestamp, timestamp);
  const deadline = Date.now() + 15000;
  for (;;) {
    const task = taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
    if (['failed', 'completed', 'interrupted'].includes(task.status)) {
      assert.equal(task.status, failed ? 'failed' : 'completed', JSON.stringify(task));
      return task;
    }
    if (Date.now() > deadline) throw new Error('Task timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

try {
  put('chatSessions', 10, { id: 10, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
  for (const [id, body] of [[1001, 'TURN_BEGIN_' + '完整规范。'.repeat(1800) + '_TURN_END'], [1002, 'PINNED_V1']]) {
    put('skills', id, { id, name: `test-${id}`, description: '测试技能', body, enabled: 1, builtin: 0, updatedAt: Date.now() });
  }
  put('skillRefs', 1003, { id: 1003, skillId: 1001, path: 'references/guide.md', body: 'REFERENCE_LAZY_ONLY' });
  runner.start('http://127.0.0.1:1');
  await run('chat');
  assert.ok(requestBody().includes('test-1001'));
  assert.ok(!requestBody().includes('TURN_BEGIN_'));
  patchSession({ pinnedSkillIds: [1002] });
  const activated = await run('chat', { explicitSkillIds: [1001, 1001, 1002] });
  assert.ok(requestBody().includes('TURN_BEGIN_') && requestBody().includes('_TURN_END'));
  assert.equal(requestBody().match(/PINNED_V1/g).length, 1);
  assert.ok(!requestBody().includes('REFERENCE_LAZY_ONLY'));
  assert.equal(activated.result.tools.filter(tool => tool.name === 'use_skill' && tool.status === 'done').length, 2);
  assert.deepEqual(records.get(owner, 'chats', activated.result.userRowId).explicitSkillIds, [1002, 1001]);
  await run('chat');
  assert.ok(!requestBody().includes('TURN_BEGIN_'));
  assert.ok(requestBody().includes('PINNED_V1'));
  put('skills', 1002, { ...records.get(owner, 'skills', 1002), body: 'PINNED_V2', updatedAt: Date.now() });
  // Even a durable history checkpoint must not omit freshly loaded skill context.
  patchSession({ contextCheckpoint: { fromId: activated.result.userRowId, source: '测试问题' } });
  await run('chat');
  assert.ok(requestBody().includes('PINNED_V2'));
  assert.ok(!requestBody().includes('PINNED_V1'));
  console.log('PASS: native chat loads full/deduplicated instructions, persists IDs and receipts, reloads pins independently of history, and does not leak one-turn bodies.');

  const before = requests.length;
  patchSession({ skillIds: [] });
  assert.match((await run('chat', { explicitSkillIds: [1001] }, true)).error, /不在当前技能范围/);
  patchSession({ skillIds: undefined, pinnedSkillIds: [] });
  put('skills', 1001, { ...records.get(owner, 'skills', 1001), enabled: 0 });
  assert.match((await run('chat', { explicitSkillIds: [1001] }, true)).error, /已停用/);
  assert.match((await run('chat', { explicitSkillIds: [999999] }, true)).error, /已删除/);
  put('skills', 1001, { ...records.get(owner, 'skills', 1001), enabled: 1, mcpRequired: ['ungranted'] });
  assert.match((await run('chat', { explicitSkillIds: [1001] }, true)).error, /MCP/);
  assert.equal(requests.length, before);
  put('skills', 1001, { ...records.get(owner, 'skills', 1001), mcpRequired: undefined });
  const smallBody = records.get(owner, 'skills', 1002).body;
  put('skills', 1002, { ...records.get(owner, 'skills', 1002), body: '完整规范。'.repeat(70000) });
  assert.match((await run('chat', { explicitSkillIds: [1002] }, true)).error, /没有被截断/);
  assert.equal(requests.length, before);
  put('skills', 1002, { ...records.get(owner, 'skills', 1002), body: smallBody });
  console.log('PASS: native scope/enablement/deletion/dependency failures are visible before any model call.');

  for (const materialFormat of [undefined, 'pdf']) {
    put('videos', 'course', { id: 'course', name: '测试课程', ...(materialFormat ? { kind: 'material', materialFormat } : {}) });
    await run('qa', { videoId: 'course', explicitSkillIds: [1001] });
    assert.ok(requestBody().includes('_TURN_END'));
  }
  scripted = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'skill-read', type: 'function', function: { name: 'read', arguments: '{"path":"/skills/test-1001"}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'ref-read', type: 'function', function: { name: 'read', arguments: '{"path":"/skills/test-1001/references/references/guide.md"}' } }] }, finish_reason: 'tool_calls' }] },
  ];
  await run('chat');
  assert.ok(requestBody().includes('_TURN_END'));
  assert.ok(requestBody().includes('REFERENCE_LAZY_ONLY'));
  console.log('PASS: native video/PDF QA and lazy model-driven skill/reference reads use the same scope boundary.');

  put('chats', activated.result.rowId, { ...records.get(owner, 'chats', activated.result.rowId), interrupted: true });
  await run('chat', { action: 'continue', rowId: activated.result.rowId });
  assert.ok(requestBody().includes('_TURN_END'));
  console.log('PASS: native continuation reloads the original turn selection without persisting instruction bodies into traces.');
} finally {
  await runner.close();
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
