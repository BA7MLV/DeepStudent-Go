import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { McpRepository } from '../apps/api/src/mcp/repository.ts';

// Exercise the actual host -> scheduler -> bundled native runtime -> MCP SDK,
// not only a mocked catalog or a manually injected TaskContext.
const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'server-mcp-'));
process.env.NODE_ENV = 'test';
process.env.DATA_DIR = directory;
process.env.FILES_DIR = path.join(directory, 'files');
process.env.BOOTSTRAP_SECRET_FILE = path.join(directory, 'config/bootstrap-secret');
delete process.env.CLOUD_WORKER_DISABLED;
delete process.env.MODEL_API_KEY;

const calls = [];
let cancelStarted, cancelRelease;
const remote = http.createServer(async (request, response) => {
  if (request.url === '/offline') { response.writeHead(503).end(); return; }
  if (request.headers.authorization !== 'Bearer server-test-secret') { response.writeHead(401).end(); return; }
  if (request.method !== 'POST') { response.writeHead(405).end(); return; }
  let body = ''; for await (const chunk of request) body += chunk;
  const rpc = JSON.parse(body);
  if (rpc.id === undefined) { response.writeHead(202).end(); return; }
  let result;
  if (rpc.method === 'initialize') result = { protocolVersion: '2025-03-26', capabilities: { tools: {}, resources: {}, prompts: {} }, serverInfo: { name: 'native-fixture', version: '1' } };
  else if (rpc.method === 'tools/list') result = { tools: request.url === '/many'
    ? Array.from({ length: 81 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: 'object', properties: {} } }))
    : [{ name: 'echo', description: 'Echo a test value', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] };
  else if (rpc.method === 'tools/call') {
    calls.push(rpc.params);
    if (rpc.params.arguments?.text === 'cancel') {
      cancelStarted();
      await new Promise(resolve => { cancelRelease = resolve; });
    }
    if (request.url === '/slow') await new Promise(resolve => setTimeout(resolve, 1500));
    result = { content: [{ type: 'text', text: `native-mcp:${rpc.params.arguments?.text ?? rpc.params.name}` }], ...(request.url === '/error' ? { isError: true } : {}) };
  } else if (rpc.method === 'resources/list') result = { resources: [{ uri: 'study://fact', name: 'Fact' }] };
  else if (rpc.method === 'resources/read') result = { contents: [{ uri: 'study://fact', text: 'NATIVE_RESOURCE_FACT' }] };
  else if (rpc.method === 'prompts/get') result = { messages: [{ role: 'user', content: { type: 'text', text: `Explain ${rpc.params.arguments.topic}` } }] };
  else { response.writeHead(400).end(); return; }
  if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
});
await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${remote.address().port}`;
const requests = [];
let scripted = [];
const { buildServer } = await import('../apps/api/src/server.ts');
const dbPath = path.join(directory, 'db.sqlite');
const app = buildServer({ dbPath, fetch: async (_url, init) => {
  const body = JSON.parse(init.body);
  requests.push(body);
  const next = scripted.shift();
  return Response.json(typeof next === 'function' ? await next(body) : next ?? answer());
} });
const answer = () => ({ choices: [{ message: { role: 'assistant', content: '已完成 MCP 验证' }, finish_reason: 'stop' }] });
const invoke = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
const findTool = (body, label) => {
  const tool = body.tools?.find(tool => tool.function.description.includes(label));
  assert.ok(tool, `Missing tool: ${label}`);
  return tool.function.name;
};
let store;
try {
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'native-mcp-test-password' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'native-mcp-test-password' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const api = (method, url, payload) => app.inject({ method, url: `/api/v1/cloud${url}`, headers: { cookie }, payload });
  store = new DatabaseStore(dbPath, path.join(directory, 'files/system-files'));
  const owner = store.db.prepare('SELECT id FROM users').get().id;
  const records = new CloudRecords(store);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  const repository = new McpRepository(store, configuration);
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'mock', name: 'Mock', protocol: 'openai-chat', apiKey: 'model-test-secret', baseUrl: 'https://model.example/v1', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'mock', model: 'fixture' } });
  const put = (table, id, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key: id, before: records.get(owner, table, id), after: value }]);
  const patchSession = changes => put('chatSessions', 10, { ...records.get(owner, 'chatSessions', 10), ...changes });
  const input = (name, endpoint = '/mcp') => ({ name, url: base + endpoint, transport: 'streamable-http', enabled: true, auth: 'bearer', token: 'server-test-secret', timeoutMs: 1000, disabledTools: [] });
  const save = async value => {
    const response = await api('POST', '/mcp', value);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const server = await save(input('Study MCP'));
  put('chatSessions', 10, { id: 10, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
  put('skills', 1001, { id: 1001, name: 'mcp-skill', description: 'MCP test skill', body: 'NATIVE_MCP_SKILL_BODY', enabled: 1, builtin: 0, updatedAt: Date.now(), mcpRequired: ['Study MCP'] });
  const submit = async (kind = 'chat', input = {}) => {
    const response = await api('POST', '/tasks', { kind, nonce: crypto.randomUUID(), resource: 'session:10', input: { sessionId: 10, text: '请执行测试', ...input } });
    assert.equal(response.statusCode, 201, response.body);
    return response.json().id;
  };
  const wait = async (id, status = 'completed') => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const task = (await api('GET', `/tasks/${id}`)).json();
      if (['failed', 'completed', 'interrupted', 'cancelled'].includes(task.status)) {
        assert.equal(task.status, status, JSON.stringify(task));
        assert.equal(scripted.length, 0, 'all scripted model rounds consumed');
        return task;
      }
      if (Date.now() > deadline) throw new Error(`Task timed out: ${id}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  const run = async (kind = 'chat', input = {}, status = 'completed') => wait(await submit(kind, input), status);
  await app.listen({ host: '127.0.0.1', port: 0 });

  let echoName;
  scripted = [body => {
    assert.match(JSON.stringify(body.messages), /NATIVE_MCP_SKILL_BODY/);
    echoName = findTool(body, '[MCP: Study MCP / echo]');
    return invoke(echoName, { text: 'chat' });
  }];
  const activated = await run('chat', { explicitSkillIds: [1001] });
  assert.match(JSON.stringify(requests.at(-1).messages), /native-mcp:chat/);
  const echoLabel = 'MCP · Study MCP / echo';
  assert.equal(activated.result.tools.find(tool => tool.name === echoLabel).status, 'done');
  assert.ok(activated.result.tools.some(tool => tool.name === 'use_skill'));
  assert.ok(records.get(owner, 'chats', activated.result.rowId).tools.some(tool => tool.name === echoLabel));
  for (const materialFormat of [undefined, 'pdf']) {
    put('videos', 'course', { id: 'course', name: '测试课程', ...(materialFormat ? { kind: 'material', materialFormat } : {}) });
    scripted = [body => invoke(findTool(body, '[MCP: Study MCP / echo]'), { text: materialFormat ?? 'video' })];
    await run('qa', { videoId: 'course', explicitSkillIds: [1001] });
    assert.match(JSON.stringify(requests.at(-1).messages), new RegExp(`native-mcp:${materialFormat ?? 'video'}`));
  }
  console.log('PASS: real host wiring exposes MCP in native library chat, video/PDF QA, loads dependent Skills, and persists actual results.');

  const beforeScope = calls.length;
  patchSession({ mcpServerIds: [] });
  scripted = [body => {
    assert.ok(!body.tools.some(tool => tool.function.name.startsWith('mcp_')));
    return invoke(echoName, { text: 'forged' });
  }];
  const forged = await run('chat', { mcpServerIds: [server.id] });
  assert.equal(forged.result.tools.find(tool => tool.name === echoName).status, 'error');
  const beforeModel = requests.length;
  assert.match((await run('chat', { explicitSkillIds: [1001] }, 'failed')).error, /MCP 依赖/);
  assert.equal(requests.length, beforeModel);
  patchSession({ mcpServerIds: 'invalid' });
  assert.match((await run('chat', {}, 'failed')).error, /mcp_invalid_scope/);
  assert.equal(requests.length, beforeModel);
  patchSession({ mcpServerIds: [server.id] });
  scripted = [() => {
    patchSession({ mcpServerIds: [] });
    return invoke(echoName, { text: 'revoked' });
  }];
  const revoked = await run();
  assert.equal(revoked.result.tools.find(tool => tool.name === echoLabel).status, 'error');
  assert.equal(calls.length, beforeScope, 'neither forged payloads nor revoked grants can execute');
  patchSession({ mcpServerIds: [server.id] });
  scripted = [async () => {
    const response = await api('PUT', `/mcp/${server.id}`, { ...input('Study MCP'), disabledTools: ['echo'], revision: repository.get(owner, server.id).revision });
    assert.equal(response.statusCode, 200, response.body);
    return invoke(echoName, { text: 'disabled' });
  }];
  const disabled = await run();
  assert.equal(disabled.result.tools.find(tool => tool.name === echoLabel).status, 'error');
  assert.equal(calls.length, beforeScope);
  await api('PUT', `/mcp/${server.id}`, input('Study MCP'));
  console.log('PASS: live session grants, malformed scopes, disabled tools, and untrusted payloads cannot bypass MCP permissions.');

  const other = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other', new Date().toISOString());
  const foreign = repository.save(other, input('Foreign MCP'));
  patchSession({ mcpServerIds: [foreign.id] });
  scripted = [body => {
    assert.ok(!body.tools.some(tool => tool.function.name.startsWith('mcp_')));
    return invoke(echoName, { text: 'foreign' });
  }];
  await run();
  assert.equal(calls.length, beforeScope);
  patchSession({ mcpServerIds: [server.id] });
  scripted = [body => invoke(findTool(body, '[MCP: Study MCP / @mcp/gateway]'), { action: 'resource', uri: 'study://fact' }),
    body => invoke(findTool(body, '[MCP: Study MCP / @mcp/gateway]'), { action: 'prompt', name: 'explain', arguments: { topic: 'algebra' } })];
  await run();
  const resourceRequest = requests.at(-1).messages;
  assert.ok(resourceRequest.some(message => message.role === 'tool' && message.content.includes('NATIVE_RESOURCE_FACT')));
  assert.ok(resourceRequest.some(message => message.role === 'tool' && message.content.includes('Explain algebra')));
  assert.ok(!resourceRequest.some(message => message.role === 'system' && message.content.includes('Explain algebra')));
  const many = await save(input('Many MCP', '/many'));
  patchSession({ mcpServerIds: [many.id] });
  scripted = [body => {
    assert.equal(body.tools.filter(tool => tool.function.name.startsWith('mcp_')).length, 1);
    return invoke(findTool(body, '[MCP: Many MCP / @mcp/gateway]'), { action: 'tools', query: 'tool_80' });
  }, body => invoke(findTool(body, '[MCP: Many MCP / @mcp/gateway]'), { action: 'call', name: 'tool_80', arguments: {} })];
  await run();
  assert.match(JSON.stringify(requests.at(-1).messages), /native-mcp:tool_80/);
  console.log('PASS: owner isolation, resource/prompt gateway data, and large-catalog progressive discovery work in native chat.');

  const stdio = await save({ name: 'Local MCP', url: '', transport: 'stdio', command: process.execPath, args: [path.resolve('scripts/fixtures/mcp-stdio.mjs')], env: {}, enabled: true, auth: 'none', timeoutMs: 3000, disabledTools: [] });
  patchSession({ mcpServerIds: [stdio.id] });
  const catalog = (await api('POST', '/mcp/catalog', { sessionId: 10 })).json();
  const pid = (await api('GET', '/mcp')).json().servers.find(item => item.id === stdio.id).pid;
  assert.ok(pid);
  scripted = [body => invoke(findTool(body, '[MCP: Local MCP / echo]'), {})];
  await run();
  assert.match(JSON.stringify(requests.at(-1).messages), new RegExp(`stdio:${pid}`));
  assert.equal(catalog.tools[0].name, findTool(requests.at(-1), '[MCP: Local MCP / echo]'));
  console.log('PASS: native stdio calls reuse the exact process/connection established by the HTTP MCP catalog.');

  for (const [endpoint, expected] of [['/error', /native-mcp:failure/], ['/slow', /not retried/]]) {
    const errorServer = await save(input(endpoint, endpoint));
    patchSession({ mcpServerIds: [errorServer.id] });
    const count = calls.length;
    scripted = [body => invoke(findTool(body, `[MCP: ${endpoint} / echo]`), { text: 'failure' })];
    const task = await run();
    assert.equal(task.result.tools.find(tool => tool.name.startsWith('MCP · ')).status, 'error');
    assert.match(JSON.stringify(requests.at(-1).messages), expected);
    assert.equal(calls.length, count + 1, 'no automatic replay of external side effects');
  }
  const offline = await save(input('Offline MCP', '/offline'));
  patchSession({ mcpServerIds: [offline.id] });
  const warning = await run();
  assert.ok(warning.result.tools.some(tool => tool.name === 'mcp_catalog' && tool.status === 'error'));
  const noFallback = requests.length;
  assert.match((await run('chat', { explicitSkillIds: [1001] }, 'failed')).error, /MCP 依赖/);
  assert.equal(requests.length, noFallback);
  console.log('PASS: MCP tool errors/timeouts are visible, calls are not replayed, and discovery failures leave a durable warning.');

  put('chats', activated.result.rowId, { ...records.get(owner, 'chats', activated.result.rowId), interrupted: true });
  patchSession({ mcpServerIds: [] });
  assert.match((await run('chat', { action: 'continue', rowId: activated.result.rowId }, 'failed')).error, /MCP 依赖/);
  patchSession({ mcpServerIds: [server.id] });
  scripted = [body => {
    assert.match(JSON.stringify(body.messages), /NATIVE_MCP_SKILL_BODY/);
    assert.ok(!body.tools?.length, 'text continuation remains tool-free');
    return answer();
  }];
  await run('chat', { action: 'continue', rowId: activated.result.rowId });
  console.log('PASS: continuation reloads dependent Skills against current grants without executing tools.');

  const started = new Promise(resolve => { cancelStarted = resolve; });
  scripted = [() => invoke(echoName, { text: 'cancel' })];
  const cancelId = await submit();
  await started;
  const beforeCancel = requests.length;
  assert.equal((await api('POST', `/tasks/${cancelId}/cancel`)).statusCode, 200);
  cancelRelease();
  await wait(cancelId, 'cancelled');
  assert.equal(requests.length, beforeCancel, 'cancelled calls do not enter another model round');
  console.log('PASS: cancelling a native task aborts its in-flight MCP call and prevents further model rounds.');
} finally {
  cancelRelease?.();
  await app.close();
  store?.close();
  remote.closeAllConnections();
  await new Promise(resolve => remote.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
