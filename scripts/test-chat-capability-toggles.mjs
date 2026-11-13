/** 会话级能力开关：关闭课程引用/联网搜索时，服务端不提供对应工具并拒绝越权调用。 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';

const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'chat-toggles-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, directory);
const owner = crypto.randomUUID(), timestamp = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, timestamp);
configuration.save(owner, {
  ...configuration.get(owner),
  providers: [{ id: 'p0', name: 'openai-chat', protocol: 'openai-chat', apiKey: 'test-only', baseUrl: 'https://p0.invalid/v1', serves: ['chat'], catalogId: '' }],
  llmModel: { providerId: 'p0', model: 'fixture' },
});
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const session = (id, overrides = {}) => put('chatSessions', id, { id, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now(), ...overrides });
put('videos', 'course-1', { id: 'course-1', name: '线性代数', createdAt: Date.now() });
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('toggle_fixture_timeout');
};
const enqueue = (sessionId, input = {}) => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, 'chat', `session:${sessionId}`, JSON.stringify({ sessionId, text: '这门课讲了什么？', ...input }), 'queued', timestamp, timestamp);
  return id;
};
const complete = async id => {
  await until(() => ['completed', 'failed'].includes(get(id).status));
  assert.equal(get(id).status, 'completed', JSON.stringify(get(id).error));
  assert.equal(script.length, 0);
  return get(id);
};
let script = [];
const seenTools = [];
const mockFetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/p0\.invalid/);
  const next = script.shift();
  assert.ok(next, 'unexpected extra model request');
  const body = JSON.parse(init.body);
  seenTools.push(body.tools?.map(tool => tool.function.name) ?? []);
  const value = await next(body, init);
  const { text = '', calls = [], finish = calls.length ? 'tool_calls' : 'stop' } = value;
  return Response.json({ choices: [{ message: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }, finish_reason: finish }] });
};
const webSearch = {
  definitions: () => [{ type: 'function', function: { name: 'websearch', description: 'Search the public web.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }],
  call: async () => ({ kind: 'web_search', query: 'q', provider: 'stub', sources: [], durationMs: 1 }),
};
const runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch, webSearch });
const call = (id, name, args) => ({ id, name, args });

try {
  runner.start('http://127.0.0.1:1');

  // 默认会话：课程工具与联网搜索都在模型请求里。
  session(1);
  script = [() => ({ text: '默认开启。' })];
  await complete(enqueue(1));
  assert.ok(seenTools.at(-1).includes('search_course_library'), JSON.stringify(seenTools.at(-1)));
  assert.ok(seenTools.at(-1).includes('websearch'), JSON.stringify(seenTools.at(-1)));
  assert.ok(seenTools.at(-1).includes('read'));

  // 关闭课程引用：课程工具不下发；模型仍硬调用时不会得到任何课程数据。
  session(2, { courseReferenceEnabled: false });
  script = [() => ({ calls: [call('t1', 'search_course_library', { query: '线性代数' })] }), () => ({ text: '本会话未开启课程引用。' })];
  const denied = await complete(enqueue(2));
  assert.ok(!seenTools.at(-2).includes('search_course_library'), JSON.stringify(seenTools.at(-2)));
  assert.ok(!seenTools.at(-2).includes('list_courses'));
  assert.ok(!seenTools.at(-2).includes('get_course_details'));
  assert.ok(seenTools.at(-2).includes('read'), 'read/ask/edit 等非课程工具保留');
  const denial = denied.progress.tools.find(tool => tool.name === 'search_course_library');
  assert.ok(denial, JSON.stringify(denied.progress.tools));
  assert.equal(denial.status, 'error');
  assert.match(String(denial.result), /tool_not_available/);
  assert.doesNotMatch(String(denial.result), /线性代数/);

  // 关闭联网搜索：websearch 不下发，课程工具保留。
  session(3, { webSearchEnabled: false });
  script = [() => ({ text: '仅关闭联网搜索。' })];
  await complete(enqueue(3));
  assert.ok(!seenTools.at(-1).includes('websearch'), JSON.stringify(seenTools.at(-1)));
  assert.ok(seenTools.at(-1).includes('search_course_library'));

  // 两个开关都关：只剩通用工具。
  session(4, { courseReferenceEnabled: false, webSearchEnabled: false });
  script = [() => ({ text: '都关了。' })];
  await complete(enqueue(4));
  assert.ok(!seenTools.at(-1).includes('websearch') && !seenTools.at(-1).includes('search_course_library'), JSON.stringify(seenTools.at(-1)));

  console.log('chat capability toggles: ok');
} finally { await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
