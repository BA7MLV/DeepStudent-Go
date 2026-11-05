import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { pluginTool } from '../apps/api/src/plugins/tool.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { executePluginsTool } from '../apps/api/runtime/board.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { readLearningMarkdown } from '../apps/api/src/plugins/learning-files.ts';
import { parseWrongbook } from '../packages/study-core/src/study/wrongbook.ts';

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'plugin-unplug-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const dbPath = path.join(directory, 'db.sqlite'), systemRoot = path.join(directory, 'files/system-files'), filesDir = process.env.FILES_DIR;
let app = buildServer({ dbPath }), store, service, runner;
const api = (url, payload) => app.inject({ method: payload ? 'POST' : 'GET', url: `/api/v1${url}`, headers: { cookie }, ...(payload ? { payload } : {}) });
let cookie, owner;
const other = crypto.randomUUID();
const lifecycle = async (id, source, status) => {
  const current = (await api('/plugins')).json().layout;
  const result = await api(`/plugins/${id}/lifecycle`, { source, status, expected: current.content, revision: current.revision });
  assert.equal(result.statusCode, 200, result.body);
};
const invoke = (pkg, method, args = {}, user = owner, instance = `unplug-${pkg.id}`) => service.invoke(user, pkg.id, instance, pkg.revision, method, args);
const put = (table, key, after, user = owner) => { const records = new CloudRecords(store); records.apply(user, [{ id: crypto.randomUUID(), table, key, before: records.get(user, table, key), after }]); };
async function waitFor(read, label) {
  const until = Date.now() + 15000;
  while (Date.now() < until) { const value = read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error(`timeout:${label}`);
}
try {
  await app.ready();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'plugin-unplug-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'plugin-unplug-password-123' } });
  owner = login.json().user.id; cookie = login.headers['set-cookie'].split(';')[0];
  store = new DatabaseStore(dbPath, systemRoot); service = new PluginService(store, undefined, undefined, { filesDir });
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Independent account', new Date().toISOString());
  for (const user of [owner, other]) {
    put('videos', 'material', { id: 'material', name: '插拔测试资料', kind: 'material', materialFormat: 'md' }, user);
    put('materialBlocks', 1, { id: 1, materialId: 'material', idx: 0, text: '从真实资料生成卡片，再验证停用不会丢掉任务与产物。' }, user);
  }
  const packages = service.files.catalog(owner).filter(p => !p.error);
  assert.equal(packages.length, 8);
  for (const user of [owner, other]) {
    const doc = service.files.layout(user), layout = JSON.parse(doc.content);
    for (const pkg of packages) {
      layout.instances.push({ id: `unplug-${pkg.id}`, pluginId: pkg.id, scope: pkg.source === 'builtin' ? { kind: 'material', id: 'material' } : { kind: 'account' } });
      for (const [index, surface] of ['board.main', 'chat.sidepanel', 'reader.sidepanel'].entries()) layout.placements.push({ id: `unplug-${pkg.id}-${index}`, pluginId: pkg.id, instanceId: `unplug-${pkg.id}`, viewId: Object.keys(pkg.manifest.views)[0], surface, scope: { kind: 'account' }, order: index });
    }
    service.files.save(user, doc.path, JSON.stringify(layout), doc.content, doc.revision);
  }
  const methods = { flashcards: 'cards.list', practice: 'practice.list', review: 'review.list', 'material-tools': 'learning.materials' };
  const methodFor = pkg => methods[pkg.id] ?? (pkg.manifest.capabilities.includes('state') ? 'state.read' : pkg.manifest.capabilities.includes('schedules') ? 'schedules.read' : 'tasks.list');
  // Each compiled or old file package really mounts, calls, disables, uninstalls,
  // reconstructs its service and restores the exact references and state.
  for (const pkg of packages) {
    const method = methodFor(pkg);
    const before = invoke(pkg, method);
    const placements = JSON.parse(service.files.layout(owner).content).placements.filter(p => p.pluginId === pkg.id);
    assert.ok(placements.length >= 3);
    await lifecycle(pkg.id, pkg.source, 'disabled');
    assert.throws(() => invoke(pkg, method), /unavailable/);
    invoke(pkg, method, {}, other);
    const discovery = service.tool(owner, { operation: 'list' }).plugins.find(p => p.id === pkg.id);
    assert.deepEqual(discovery.actions, []); assert.deepEqual(discovery.views, {});
    const raw = await api(`/plugins/${pkg.id}/instances/unplug-${pkg.id}/rpc`, { revision: pkg.revision, method, args: {} });
    assert.notEqual(raw.statusCode, 200);
    if (pkg.source === 'v1') assert.notEqual((await api(`/board/plugins/${pkg.id}/rpc`, { revision: pkg.revision, method, args: {} })).statusCode, 200, 'old RPC cannot bypass unified lifecycle');
    await lifecycle(pkg.id, pkg.source, 'uninstalled');
    await service.close(); service = new PluginService(store, undefined, undefined, { filesDir });
    assert.throws(() => invoke(pkg, method), /unavailable/);
    assert.equal(service.files.catalog(owner).find(p => p.id === pkg.id).installation, 'uninstalled');
    await lifecycle(pkg.id, pkg.source, 'enabled');
    const restored = invoke(pkg, method);
    if (before.content) { assert.equal(restored.path, before.path); assert.deepEqual(JSON.parse(restored.content), JSON.parse(before.content)); }
    else {
      // Review projections carry the real observation clock; lifecycle must
      // preserve content, not freeze time between independent reads.
      const { asOf: oldClock, ...oldValue } = before;
      const { asOf: newClock, ...newValue } = restored;
      assert.deepEqual(newValue, oldValue);
      if (oldClock !== undefined) assert.ok(newClock >= oldClock);
    }
    assert.deepEqual(JSON.parse(service.files.layout(owner).content).placements.filter(p => p.pluginId === pkg.id), placements);
  }
  const flashcards = service.files.plugin(owner, 'flashcards'), tools = service.files.plugin(owner, 'material-tools');
  const generated = invoke(flashcards, 'cards.generate', { materialId: 'material', clientNonce: 'accepted-before-disable' });
  assert.ok(generated.input._pluginProviders.includes('flashcards'));
  await lifecycle('flashcards', 'builtin', 'disabled');
  const count = () => store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks').get().n;
  const beforeRejected = count();
  const deniedArgs = { materialId: 'material', clientNonce: 'never-accepted' };
  assert.throws(() => invoke(tools, 'cards.generate', deniedArgs), /undeclared/);
  assert.equal((await api('/plugins/material-tools/instances/unplug-material-tools/rpc', { revision: tools.revision, method: 'cards.generate', args: deniedArgs })).json().error, 'plugin_method_undeclared');
  assert.notEqual((await api('/plugins/material-tools/instances/unplug-material-tools/actions/generate', { revision: tools.revision, args: deniedArgs })).statusCode, 200);
  const named = { operation: 'invoke', pluginId: 'flashcards', instanceId: 'unplug-flashcards', revision: flashcards.revision, actionId: 'generate', args: deniedArgs };
  assert.notEqual((await api('/plugins/tool', named)).statusCode, 200);
  const ctx = { owner, thread: 'none', run: 'none', checkActive() {} };
  await assert.rejects(async () => pluginTool(service).execute(named, ctx), /unavailable/);
  await assert.rejects(() => executePluginsTool({ owner, pluginService: service, configuration: { taskPolicy: () => ({ read: 'allow', write: 'allow' }) }, task: { id: 'native' }, checkActive() {} }, named), /unavailable/);
  assert.equal((await api('/cloud/tasks', { nonce: 'old-http-bypass', kind: 'cards', resource: 'course:material', input: { videoId: 'material', _pluginProviders: ['flashcards'] } })).statusCode, 403);
  assert.equal(count(), beforeRejected, 'rejected methods create no new tasks');
  const study = new StudyTools(store, new CloudConfiguration(store, path.join(directory, 'config')), filesDir);
  const botContext = { ...ctx, step: 'disabled-bot-create', signal: new AbortController().signal, append() {} };
  assert.ok(!study.definitions(owner).find(d => d.function.name === 'study_task').function.parameters.properties.kind.enum.includes('cards'));
  await assert.rejects(() => study.plugins.get('study_task').execute({ action: 'create', kind: 'cards', courseId: 'material' }, botContext), /unavailable/);
  await lifecycle('material-tools', 'builtin', 'disabled');
  assert.ok(!study.definitions(owner).find(d => d.function.name === 'study_task').function.parameters.properties.action.enum.includes('create'));
  assert.ok(study.definitions(other).find(d => d.function.name === 'study_task').function.parameters.properties.action.enum.includes('create'), 'Bot discovery is account scoped');
  for (const kind of ['handout', 'material']) await assert.rejects(() => study.plugins.get('study_task').execute({ action: 'create', kind, courseId: 'material' }, botContext), /unavailable/);
  for (const kind of ['handout', 'handoutEdit', 'comments', 'danmaku', 'transcribe', 'material', 'cover']) {
    assert.equal((await api('/cloud/tasks', { nonce: `disabled-${kind}`, kind, resource: 'course:material', input: { videoId: 'material', _pluginProviders: ['material-tools'] } })).statusCode, 403, `raw ${kind} rejects forged admission snapshot`);
  }
  await lifecycle('material-tools', 'builtin', 'enabled');
  await lifecycle('practice', 'builtin', 'disabled');
  for (const input of [{ pluginPractice: true }, { pluginExtraction: true }]) assert.equal((await api('/cloud/tasks', { nonce: crypto.randomUUID(), kind: 'qa', resource: 'course:material', input: { videoId: 'material', ...input } })).statusCode, 403);
  await lifecycle('practice', 'builtin', 'enabled');
  assert.equal(count(), beforeRejected);
  // A declared, dependency-bound alternative uses the same host action boundary.
  const alternative = { apiVersion: 2, id: 'cards-reader', name: '替代卡片列表', version: '2.0.0', enabled: true, capabilities: ['learning'], services: { 'learning-data': 1 }, requires: { flashcards: 2 }, views: { main: { entry: 'views/main.html', surfaces: ['board.main', 'chat.sidepanel', 'app.page'] } }, actions: { list: { title: '同一权威卡片', service: 'cards.list', schema: {} } } };
  service.files.save(owner, '/system/plugins/cards-reader/views/main.html', '<p>Alternative</p>', '', 0);
  service.files.save(owner, '/system/plugins/cards-reader/manifest.json', JSON.stringify(alternative), '', 0);
  assert.equal(service.files.catalog(owner).find(p => p.id === alternative.id).error, 'plugin_dependency_unavailable');
  const config = new CloudConfiguration(store, path.join(directory, 'config'));
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  let modelCalls = 0;
  runner = new CloudTaskRunner(store, { records: new CloudRecords(store), configuration: config, filesDir, fetch: async () => { modelCalls++; return Response.json({ choices: [{ message: { content: '[{"time":"00:01","q":"插拔后的产物？","a":"仍然持久保存。"}]' } }] }); } });
  await lifecycle('flashcards', 'builtin', 'uninstalled');
  runner.start('http://127.0.0.1:1');
  await waitFor(() => store.db.prepare("SELECT id FROM cloud_tasks WHERE id=? AND status='completed'").get(generated.id), 'accepted-task-completes');
  await waitFor(() => store.db.prepare('SELECT delivered_at FROM plugin_learning_tasks WHERE task_id=?').get(generated.id)?.delivered_at, 'receipt-delivery-without-plugin');
  assert.equal(modelCalls, 1); assert.equal(new CloudRecords(store).list(owner, 0).filter(r => r.table === 'cards' && r.value).length, 1);
  await lifecycle('flashcards', 'builtin', 'enabled');
  const alt = service.files.plugin(owner, alternative.id), layoutDoc = service.files.layout(owner), altLayout = JSON.parse(layoutDoc.content);
  altLayout.instances.push({ id: 'alternative', pluginId: alt.id, scope: { kind: 'material', id: 'material' } });
  for (const [index, surface] of ['board.main', 'chat.sidepanel'].entries()) altLayout.placements.push({ id: `alternative-${index}`, instanceId: 'alternative', pluginId: alt.id, viewId: 'main', surface, scope: { kind: 'account' }, order: index });
  service.files.save(owner, layoutDoc.path, JSON.stringify(altLayout), layoutDoc.content, layoutDoc.revision);
  assert.deepEqual(invoke(alt, 'cards.list', {}, owner, 'alternative'), invoke(flashcards, 'cards.list'));
  await lifecycle('flashcards', 'builtin', 'disabled');
  assert.throws(() => invoke(alt, 'cards.list', {}, owner, 'alternative'), /unavailable/);
  await lifecycle('flashcards', 'builtin', 'enabled');
  assert.equal(invoke(alt, 'cards.list', {}, owner, 'alternative').cards.length, 1); assert.equal(modelCalls, 1);
  const badDoc = service.files.read(owner, '/system/plugins/cards-reader/manifest.json');
  service.files.save(owner, badDoc.path, JSON.stringify({ ...alternative, requires: undefined }), badDoc.content, badDoc.revision);
  assert.throws(() => invoke(service.files.plugin(owner, alt.id), 'cards.list', {}, owner, 'alternative'), /dependency_undeclared/);
  // Compiled registration owns real action disposers, rather than only view flags.
  const native = { id: 'fixture-native', source: 'builtin', path: 'builtin:fixture-native', revision: 1, manifest: { apiVersion: 2, id: 'fixture-native', name: 'Native registration fixture', version: '2.0.0', enabled: true, capabilities: ['learning'], services: { 'learning-data': 1 }, views: { main: { entry: 'views/main.html', surfaces: ['board.main'] } }, actions: { ping: { title: 'ping', service: 'fixture.ping', schema: {} } } } };
  let setups = 0, calls = 0;
  const setup = () => { setups++; service.register({ id: 'fixture.ping', capability: 'learning', access: 'read', schema: { type: 'object', additionalProperties: false }, run: () => ++calls }); };
  const off = service.registerProvider(native, setup);
  const nativeDoc = service.files.layout(owner), nativeLayout = JSON.parse(nativeDoc.content);
  nativeLayout.instances.push({ id: 'fixture-instance', pluginId: native.id, scope: { kind: 'account' } });
  service.files.save(owner, nativeDoc.path, JSON.stringify(nativeLayout), nativeDoc.content, nativeDoc.revision);
  assert.equal(invoke(native, 'fixture.ping', {}, owner, 'fixture-instance'), 1);
   const releasing = off();
   assert.throws(() => invoke(native, 'fixture.ping', {}, owner, 'fixture-instance'), /unavailable/, 'authorization revokes before async teardown settles');
   await releasing; await off(); assert.equal(service.context.get('action.fixture.ping'), undefined);
  assert.equal(service.files.catalog(owner).find(p => p.id === native.id).error, 'plugin_provider_unavailable');
  assert.throws(() => invoke(native, 'fixture.ping', {}, owner, 'fixture-instance'), /unavailable/);
  const offAgain = service.registerProvider(native, setup);
  assert.equal(invoke(native, 'fixture.ping', {}, owner, 'fixture-instance'), 2);
   assert.equal(setups, 2); await offAgain();
  assert.equal(pluginTool(service).capability({ operation: 'lifecycle' }), 'write');
  await assert.rejects(() => executePluginsTool({ owner, pluginService: service, configuration: { taskPolicy: () => ({ read: 'allow', write: 'deny' }) }, task: { id: 'native' }, checkActive() {} }, { operation: 'lifecycle', pluginId: 'flashcards', status: 'uninstalled' }), /policy_denied/);
  // Persisted quiz submission is delivered even after both providers are removed.
  const q = { stem: '停用后的错题投递', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '原文答案', answerSource: 'original', source: { courseId: 'material' } };
  const bytes = Buffer.from(`\`\`\`quiz\n${JSON.stringify({ questions: [q] })}\n\`\`\`\n`);
  const file = await receiveFile(store, filesDir, owner, Readable.from([bytes]), 'questions.md', 'text/markdown', bytes.length, bytes.length);
  put('videos', '__course_questions__material', { id: '__course_questions__material', name: '题库', kind: 'material', materialFormat: 'md' });
  put('files', '__course_questions__material', { id: '__course_questions__material', blob: { $file: file.id } });
  const practice = service.files.plugin(owner, 'practice');
  const session = invoke(practice, 'practice.present', { materialId: 'material', clientNonce: 'once' });
  invoke(practice, 'practice.submit', { rowId: session.rowId, questionIndex: 0, pick: 1, durationSeconds: 3 });
  await lifecycle('practice', 'builtin', 'uninstalled');
  assert.equal(service.files.catalog(owner).find(p => p.id === 'review').error, 'plugin_dependency_unavailable');
  await waitFor(() => store.db.prepare('SELECT delivered_at FROM plugin_practice_submissions WHERE row_id=? AND question_index=0').get(session.rowId)?.delivered_at, 'notebook-delivery-without-provider');
  assert.equal(parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text).find(p => p.question.stem === q.stem).attempts.length, 1);
  for (const pkg of packages) await lifecycle(pkg.id, pkg.source, 'uninstalled');
  await runner.close(); runner = undefined; await service.close(); service = undefined; store.close(); store = undefined; await app.close();
  app = buildServer({ dbPath }); await app.ready();
  const reopened = (await api('/plugins')).json();
  for (const pkg of packages) assert.equal(reopened.plugins.find(p => p.id === pkg.id && p.source === pkg.source).installation, 'uninstalled', 'real API restart cannot seed packages back');
  for (const pkg of packages) await lifecycle(pkg.id, pkg.source, 'enabled');
  store = new DatabaseStore(dbPath, systemRoot); service = new PluginService(store, undefined, undefined, { filesDir });
  assert.equal(invoke(flashcards, 'cards.list').cards.length, 1);
  assert.equal(invoke(practice, 'practice.get', { rowId: session.rowId }).row.quiz.picks[0], 1);
  invoke(practice, 'practice.submit', { rowId: session.rowId, questionIndex: 0, pick: 1, durationSeconds: 3 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM plugin_learning_receipts WHERE task_id=?').get(generated.id).n, 1);
  assert.equal(parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text).find(p => p.question.stem === q.stem).attempts.length, 1);
  console.log('Pluggability passed: eight packages, three mounts, raw/named/HTTP/Chat/Bot/old RPC denial, account isolation, declared provider dependencies and alternative implementation, accepted native generation and notebook delivery while uninstalled, durable tombstones across API restart, recovery without duplicate side effects.');
} finally {
  await runner?.close(); await service?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
