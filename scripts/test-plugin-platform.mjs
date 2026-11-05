import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { splitAssistantContent, nextVisualRound } from '../apps/web/src/utils/streamingHtml.ts';
import { Context } from '@deepseek-ai/cordis';
import { parsePluginManifest, parsePluginLayout, pluginPath, resolvePluginDependencies } from '../packages/contracts/src/plugins.ts';

const registry = new Context();
let effects = 0;
const dependant = registry.inject(['learning'], ctx => { effects++; ctx.effect(() => () => { effects--; }); ctx.provide('view', 'mounted'); });
assert.equal(registry.get('view'), undefined);
const provider = registry.plugin(ctx => { ctx.provide('learning', { ready: true }); });
await provider;
await dependant;
assert.equal(registry.get('view'), 'mounted'); assert.equal(effects, 1);
assert.throws(() => registry.provide('learning', true), /registered/);
await provider.dispose(); await provider.dispose(); assert.equal(effects, 0); assert.equal(registry.get('view'), undefined);
const remount = registry.plugin(ctx => { ctx.provide('learning', true); });
await remount;
await dependant;
assert.equal(effects, 1); await dependant.dispose(); await remount.dispose(); assert.equal(effects, 0);
await registry.fiber.dispose();
assert.equal(pluginPath('/system/plugins/test/views/../secret'), false);
assert.equal(pluginPath('/system/plugins/test/views/nested/list.html'), true);
const manifest = { apiVersion: 2, id: 'counter', name: 'Counter', version: '1.0.0', enabled: true, capabilities: ['state'], views: { list: { entry: 'views/nested/list.html', surfaces: ['board.main', 'chat.sidepanel', 'reader.sidepanel', 'app.page', 'chat.message'] } }, actions: { inspect: { title: 'Read counter', service: 'state.read', schema: {} }, update: { title: 'Update counter', service: 'state.write', schema: {} } } };
assert.throws(() => parsePluginManifest({ ...manifest, views: { list: { entry: '../escape.html', surfaces: ['board.main'] } } }, 'counter'));
assert.throws(() => parsePluginManifest({ ...manifest, contributions: { bad: { title: 'Bad', surfaces: ['resource.actions'], viewId: 'missing' } } }, 'counter'));
assert.throws(() => parsePluginManifest({ ...manifest, contributions: { bad: { title: 'Bad', surfaces: ['resource.actions'], actionId: 'inspect', contextArgs: { materialId: 'owner' } } } }, 'counter'));
const dependencyPackage = (id, version, requires = {}, optional = {}) => ({ id, path: `/system/plugins/${id}`, source: 'v2', manifest: { ...manifest, id, version, requires, optional } });
assert.equal(resolvePluginDependencies([dependencyPackage('consumer', '1.0.0', { provider: 2 }), dependencyPackage('provider', '2.1.0')])[0].error, undefined);
assert.deepEqual(resolvePluginDependencies([dependencyPackage('consumer', '1.0.0', { provider: 2 }), dependencyPackage('provider', '1.0.0')])[0].dependencies.required, ['provider']);
assert.equal(resolvePluginDependencies([dependencyPackage('a', '1.0.0', { b: 1 }), dependencyPackage('b', '1.0.0', { a: 1 })])[0].error, 'plugin_dependency_unavailable');
const optionalPackage = resolvePluginDependencies([dependencyPackage('optional-consumer', '1.0.0', {}, { absent: 1 })])[0];
assert.equal(optionalPackage.error, undefined); assert.deepEqual(optionalPackage.dependencies.optional, ['absent']);
const chain = [dependencyPackage('leaf', '1.0.0', { middle: 1 }), dependencyPackage('middle', '1.0.0', { root: 2 }), dependencyPackage('root', '2.0.0')];
assert.ok(resolvePluginDependencies(chain).every(p => !p.error), 'pure resolver handles reverse-ordered dependency chains');
assert.ok(resolvePluginDependencies(chain.map(p => p.id === 'root' ? { ...p, manifest: { ...p.manifest, enabled: false } } : p)).slice(0, 2).every(p => p.error === 'plugin_dependency_unavailable'), 'revocation closes transitive dependency availability');
assert.equal(resolvePluginDependencies([dependencyPackage('consumer', '1.0.0', { malformed: 1 }), dependencyPackage('malformed', 'not-a-release')])[0].error, 'plugin_dependency_unavailable');
const unavailableHost = dependencyPackage('host-consumer', '1.0.0'); unavailableHost.manifest.services = { 'learning-data': 2 };
assert.deepEqual(resolvePluginDependencies([unavailableHost])[0].dependencies.required, ['host.learning-data']);
assert.throws(() => parsePluginLayout({ apiVersion: 2, instances: [], placements: [{ id: 'bad', pluginId: 'counter', instanceId: 'missing', viewId: 'list', surface: 'board.main', scope: { kind: 'account' }, order: 0 }] }));

const root = path.join(os.tmpdir(), 'opencode'); fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'plugin-platform-'));
// Board samples are test fixtures; the product seeds no components.
process.env.BOARD_SEED_DIR = path.resolve("scripts/fixtures/board-plugins");
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { notebookTools } = await import('../apps/api/src/agent/notebook-tools.ts');
const { executeBoardTool } = await import('../apps/api/runtime/board.ts');
const { executePluginsTool } = await import('../apps/api/runtime/board.ts');
const { PluginService } = await import('../apps/api/src/plugins/service.ts');
const { pluginTool } = await import('../apps/api/src/plugins/tool.ts');
const { BoardScheduler } = await import('../apps/api/src/board/scheduler.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const { BotRunner } = await import('../apps/api/src/agent/runner.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let store;
try {
  await app.ready();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'plugins-test-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'plugins-test-password-123' } });
  const owner = login.json().user.id, cookie = login.headers['set-cookie'].split(';')[0];
  const api = (url, payload, headers = {}) => app.inject({ method: payload ? 'POST' : 'GET', url: `/api/v1${url==='/plugins/layout'&&payload?'/plugins/tool':url}`, headers: { cookie, ...headers }, ...(payload ? { payload:url==='/plugins/layout'?{operation:'configure',...payload}:payload } : {}) });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/plugins' })).statusCode, 401);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store), other = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other', new Date().toISOString());
  const first = (await api('/plugins')).json(); assert.equal(first.plugins.filter(p => p.source === 'v1').length, 4);
  assert.equal(JSON.parse(first.layout.content).placements.length, 4);
  const tools = notebookTools(store), edit = tools.find(t => t.name === 'edit'), read = tools.find(t => t.name === 'read');
  const context = { owner, thread: 'none', run: 'none', checkActive() {} };
  for (const [name, content] of Object.entries({ 'views/nested/list.html': '<p>Counter</p>', 'defaults.json': '{"count":0}', 'manifest.json': JSON.stringify(manifest) })) {
    await edit.execute({ path: `/system/plugins/counter/${name}`, create: true, content, revision: 0 }, context);
  }
  assert.equal((await read.execute({ path: '/system/plugins/counter/views/nested' }, context)).files.length, 1);
  assert.equal((await api('/plugins/counter/views/list')).json().html, '<p>Counter</p>');
  const previous = files.layout(owner), layout = JSON.parse(previous.content);
  layout.instances.push({ id: 'one', pluginId: 'counter', scope: { kind: 'account' } }, { id: 'two', pluginId: 'counter', scope: { kind: 'account' } });
  for (const [index, surface] of ['board.main', 'chat.sidepanel', 'reader.sidepanel'].entries()) layout.placements.push({ id: `mount-${index}`, instanceId: 'one', pluginId: 'counter', viewId: 'list', surface, scope: { kind: 'account' }, order: index });
  const saved = await api('/plugins/layout', { content: JSON.stringify(layout), expected: previous.content, revision: previous.revision }); assert.equal(saved.statusCode, 200, saved.body);
  assert.equal((await api('/plugins/layout', { content: JSON.stringify(layout), expected: previous.content, revision: previous.revision })).statusCode, 409);
  const pkg = files.plugin(owner, 'counter');
  const rpc = (id, method, args = {}, revision = pkg.revision) => api(`/plugins/counter/instances/${id}/rpc`, { method, args, revision });
  const one = (await rpc('one', 'state.read')).json(); assert.equal(JSON.parse(one.content).count, 0);
  const changed = (await rpc('one', 'state.write', { data: { count: 3 }, expected: one.content, revision: one.revision })).json();
  assert.equal(JSON.parse((await rpc('one', 'state.read')).json().content).count, 3);
  assert.equal(JSON.parse((await rpc('two', 'state.read')).json().content).count, 0);
  assert.equal((await rpc('one', 'state.write', { data: {}, expected: one.content, revision: one.revision })).statusCode, 409);
  assert.equal((await rpc('one', 'state.read', {}, pkg.revision + 1)).statusCode, 409);
  assert.equal((await rpc('missing', 'state.read')).statusCode, 404);
  const discovered = (await api('/plugins/tool', { operation: 'list' })).json();
  assert.ok(discovered.plugins.some(p => p.id === 'counter'));
  assert.ok(discovered.surfaces.includes('reader.selection.actions'));
  assert.equal(discovered.layout.instances.find(i => i.id === 'one').pluginId, 'counter');
  const described = (await api('/plugins/tool', { operation: 'describe', pluginId: 'counter' })).json();
  assert.equal(described.actions.find(a => a.id === 'update').schema.additionalProperties, false, 'host schema, not manifest placeholder, is published');
  const toolInvoke = { operation: 'invoke', pluginId: 'counter', instanceId: 'one', revision: pkg.revision, actionId: 'inspect', args: {} };
  const referenced = (await api('/plugins/tool', { operation: 'reference', pluginId: 'counter', instanceId: 'one', viewId: 'list', summary: '历史计数器结果摘要' })).json();
  assert.equal(referenced.reference.revision, pkg.revision);
  assert.equal(splitAssistantContent(referenced.markdown)[0].kind, 'plugin');
  assert.ok(nextVisualRound(referenced.markdown).includes('历史计数器结果摘要'));
  assert.equal((await api('/plugins/tool', { operation: 'reference', pluginId: 'counter', instanceId: 'missing', viewId: 'list', summary: 'forged' })).statusCode, 404);
  assert.equal(JSON.parse((await api('/plugins/tool', toolInvoke)).json().content).count, 3);
  assert.equal((await api('/plugins/tool', { ...toolInvoke, actionId: 'update', args: { data: {}, expected: one.content, revision: one.revision } })).statusCode, 409);
  assert.equal((await api('/plugins/tool', { ...toolInvoke, owner: other })).statusCode, 400);
  const toolLayout = (await api('/plugins/tool', { operation: 'layout' })).json();
  assert.equal((await api('/plugins/tool', { operation: 'configure', content: toolLayout.content, expected: 'stale', revision: toolLayout.revision })).statusCode, 409);
  const toolService = new PluginService(store, undefined, undefined, { filesDir: process.env.FILES_DIR });
  const originalCatalog = toolService.files.catalog.bind(toolService.files);
  let listScans = 0;
  toolService.files.catalog = (...args) => { listScans++; return originalCatalog(...args); };
  try {
    assert.ok(toolService.tool(owner, { operation: 'list' }).plugins.length >= 4);
    assert.equal(listScans, 2, 'one package snapshot plus live legacy layout reconciliation, not recursive rescans per package');
  } finally { toolService.files.catalog = originalCatalog; }
  try {
    const botTool = pluginTool(toolService);
    assert.deepEqual(botTool.permissions({ operation: 'invoke' }), ['read', 'write']);
    assert.equal(botTool.systemResource, undefined, 'mutating plugin calls cannot bypass Bot approval');
    assert.equal(JSON.parse((await botTool.execute(toolInvoke, context)).content).count, 3);
    const native = { owner, pluginService: toolService, configuration: { taskPolicy: () => ({ read: 'allow', write: 'allow' }) }, task: { id: 'native-chat' }, checkActive() {} };
    assert.equal(JSON.parse(JSON.parse(await executePluginsTool(native, toolInvoke)).content).count, 3);
    await assert.rejects(() => executePluginsTool({ ...native, configuration: { taskPolicy: () => ({ read: 'allow', write: 'ask' }) } }, { ...toolInvoke, actionId: 'update' }), /policy_denied/);
    await assert.rejects(() => executePluginsTool({ ...native, configuration: { taskPolicy: () => ({ read: 'deny', write: 'allow' }) } }, { operation: 'list' }), /policy_denied/);
    assert.throws(() => toolService.tool(other, toolInvoke), /unavailable/);
  } finally { await toolService.close(); }
  assert.throws(() => files.readState(other, 'counter', 'one', 'state'), /unavailable/);
  assert.equal((await api('/plugins/layout', { content: '{}', expected: '', revision: 0 }, { origin: 'https://untrusted.example' })).statusCode, 403);
  const old = files.board.read(owner, '/system/board/plugins/todo/state.json');
  assert.equal(files.readState(owner, 'todo', 'legacy-todo', 'state').content, old.content);
  files.writeState(owner, 'todo', 'legacy-todo', 'state', { items: [{ id: 'x', title: 'Shared', done: false }] }, old.content, old.revision);
  assert.equal(JSON.parse(files.board.read(owner, old.path).content).items[0].title, 'Shared');
  const currentLayout = files.layout(owner), hidden = JSON.parse(currentLayout.content); hidden.placements = hidden.placements.filter(p => p.instanceId !== 'one');
  files.save(owner, currentLayout.path, JSON.stringify(hidden), currentLayout.content, currentLayout.revision);
  assert.equal(files.readState(owner, 'counter', 'one', 'state').content, changed.content, 'removing placement does not remove data');
  const reopened = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  try { assert.equal(new PluginFiles(reopened).readState(owner, 'counter', 'one', 'state').content, changed.content); } finally { reopened.close(); }
  assert.equal(JSON.parse(executeBoardTool({ owner, store, configuration: { taskPolicy: () => ({ read: 'allow' }) }, task: { id: 'x' }, checkActive() {} }, { action: 'read', path: changed.path })).content, changed.content);
  // Independent schedule instances do not depend on the number of mounted views.
  const schedule = { ...manifest, id: 'jobs', capabilities: ['state', 'tasks', 'schedules'] };
  for (const [name, content] of Object.entries({ 'views/nested/list.html': '<p>Jobs</p>', 'manifest.json': JSON.stringify(schedule) })) files.save(owner, `/system/plugins/jobs/${name}`, content, '', 0);
  const beforeJobs = files.layout(owner), jobsLayout = JSON.parse(beforeJobs.content);
  jobsLayout.instances.push({ id: 'jobs-one', pluginId: 'jobs', scope: { kind: 'account' } });
  for (const [i, surface] of ['board.main', 'chat.sidepanel', 'reader.sidepanel'].entries()) jobsLayout.placements.push({ id: `job-mount-${i}`, pluginId: 'jobs', instanceId: 'jobs-one', viewId: 'list', surface, scope: { kind: 'account' }, order: i });
  files.save(owner, beforeJobs.path, JSON.stringify(jobsLayout), beforeJobs.content, beforeJobs.revision);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture-only', baseUrl: 'https://fixture.invalid/v1', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  const botRunner = new BotRunner(store, { configuration });
  // Exercise real frozen-model admission but do not execute paid background work.
  botRunner.enqueue = () => {};
  const bots = new BotApplicationService(store, botRunner), thread = bots.create(owner, 'bot', 'Plugin schedules');
  const blank = files.readState(owner, 'jobs', 'jobs-one', 'schedules'), time = Date.now();
  files.writeState(owner, 'jobs', 'jobs-one', 'schedules', { jobs: [{ id: 'once', threadId: thread.id, prompt: 'Only one dispatch', nextRunAt: new Date(time - 1000).toISOString(), enabled: true }] }, blank.content, blank.revision);
  const scheduler = new BoardScheduler(files.board, bots); scheduler.tick(time); scheduler.tick(time);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id=?').get(thread.id).n, 1, `three mounts schedule one job: ${files.readState(owner, 'jobs', 'jobs-one', 'schedules').content}`);
  const delivered = JSON.parse(files.readState(owner, 'jobs', 'jobs-one', 'schedules').content).jobs[0];
  assert.equal(delivered.lastTask.status, 'queued');
  const jobManifest = files.read(owner, '/system/plugins/jobs/manifest.json');
  files.save(owner, jobManifest.path, JSON.stringify({ ...schedule, enabled: false }), jobManifest.content, jobManifest.revision);
  store.db.prepare("UPDATE runs SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), delivered.lastTask.id.slice(4));
  new BoardScheduler(files.board, bots).tick(time + 5000);
  assert.equal(JSON.parse(files.read(owner, '/system/plugin-data/jobs/instances/jobs-one/schedules.json').content).jobs[0].lastTask.status, 'completed', 'disabled provider still reconciles dispatched work');
  // Install the exact shipped templates through the normal package file boundary.
  for (const name of ['counter', 'material-note', 'bot-task']) {
    const templateRoot = path.resolve('docs/plugins/templates', name), id = `template-${name}`;
    const html = fs.readFileSync(path.join(templateRoot, 'views/main.html'), 'utf8');
    for (const match of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
    files.save(owner, `/system/plugins/${id}/views/main.html`, html, '', 0);
    files.save(owner, `/system/plugins/${id}/defaults.json`, fs.readFileSync(path.join(templateRoot, 'defaults.json'), 'utf8'), '', 0);
    const templateManifest = { ...JSON.parse(fs.readFileSync(path.join(templateRoot, 'manifest.json'), 'utf8')), id };
    files.save(owner, `/system/plugins/${id}/manifest.json`, JSON.stringify(templateManifest), '', 0);
    assert.equal(files.plugin(owner, id).manifest.views.main.entry, 'views/main.html');
    const previous = files.layout(owner), next = JSON.parse(previous.content);
    next.instances.push({ id, pluginId: id, scope: { kind: 'account' } });
    files.save(owner, previous.path, JSON.stringify(next), previous.content, previous.revision);
  }
  let templateService = new PluginService(store, bots, undefined, { filesDir: process.env.FILES_DIR });
  const templateId = 'template-bot-task', taskRevision = files.plugin(owner, templateId).revision;
  const taskArgs = { threadId: thread.id, prompt: 'Template durable dispatch', clientNonce: 'template-once' };
  let templateTask;
  try {
    templateTask = templateService.invokeNamed(owner, templateId, templateId, taskRevision, 'start', taskArgs);
    assert.equal(templateService.invokeNamed(owner, templateId, templateId, taskRevision, 'start', taskArgs).id, templateTask.id);
    assert.throws(() => templateService.invokeNamed(owner, templateId, templateId, taskRevision, 'start', { ...taskArgs, prompt: 'changed' }), /nonce_conflict/);
  } finally { await templateService.close(); }
  templateService = new PluginService(store, bots, undefined, { filesDir: process.env.FILES_DIR });
  try {
    assert.equal(templateService.invokeNamed(owner, templateId, templateId, taskRevision, 'start', taskArgs).id, templateTask.id, 'template request recovery finds the original run');
  } finally { await templateService.close(); }
  // Collision resolution is explicit and CAS-protected, never first-directory-wins.
  const collision = { ...manifest, id: 'todo' };
  files.save(owner, '/system/plugins/todo/views/nested/list.html', '<p>Alternative todo</p>', '', 0);
  files.save(owner, '/system/plugins/todo/manifest.json', JSON.stringify(collision), '', 0);
  assert.equal(files.catalog(owner).filter(p => p.id === 'todo' && p.error === 'plugin_source_conflict').length, 2);
  assert.throws(() => files.plugin(owner, 'todo'), /unavailable/);
  const collidingLayout = files.layout(owner), selected = JSON.parse(collidingLayout.content); selected.sources = { todo: 'v1' };
  files.save(owner, collidingLayout.path, JSON.stringify(selected), collidingLayout.content, collidingLayout.revision);
  assert.equal(files.plugin(owner, 'todo').source, 'v1');
  assert.equal(files.readState(owner, 'todo', 'legacy-todo', 'state').path, old.path);
  const m = files.read(owner, '/system/plugins/counter/manifest.json');
  const dependentManifest = { ...manifest, id: 'dependent', requires: { counter: 1 } };
  files.save(owner, '/system/plugins/dependent/views/nested/list.html', '<p>Dependent</p>', '', 0);
  files.save(owner, '/system/plugins/dependent/manifest.json', JSON.stringify(dependentManifest), '', 0);
  assert.equal(files.plugin(owner, 'dependent').id, 'dependent');
  files.save(owner, m.path, JSON.stringify({ ...manifest, enabled: false }), m.content, m.revision);
  assert.equal(files.catalog(owner).find(p => p.id === 'dependent').error, 'plugin_dependency_unavailable');
  assert.equal((await rpc('one', 'state.read')).statusCode, 400);
  const disabledCounter = files.read(owner, m.path);
  files.save(owner, m.path, JSON.stringify(manifest), disabledCounter.content, disabledCounter.revision);
  assert.equal(files.plugin(owner, 'dependent').id, 'dependent', 'restoring a dependency recovers the package without changing its own manifest');
  // Sidebar navigation is an explicit reference to a validated app.page placement,
  // shared by HTTP, Bot and native Chat rather than a browser-only bookmark.
  const navigationBefore = files.layout(owner), navigationLayout = JSON.parse(navigationBefore.content);
  navigationLayout.placements.push({ id: 'page-second', instanceId: 'one', pluginId: 'counter', viewId: 'list', surface: 'app.page', scope: { kind: 'account' }, order: 0 });
  navigationLayout.navigation = [{ id: 'sidebar-counter', placementId: 'page-second', title: '我的计数', order: 0 }];
  assert.equal((await api('/plugins/tool', { operation: 'configure', content: JSON.stringify(navigationLayout), expected: navigationBefore.content, revision: navigationBefore.revision })).statusCode, 200);
  assert.deepEqual(JSON.parse((await api('/plugins')).json().layout.content).navigation, navigationLayout.navigation);
  assert.equal((await api('/plugins/layout', { content: navigationBefore.content, expected: navigationBefore.content, revision: navigationBefore.revision })).statusCode, 409);
  assert.throws(() => parsePluginLayout({ ...navigationLayout, navigation: [{ id: 'bad-nav', placementId: 'mount-0', order: 0 }] }), /invalid_plugin_layout/, 'only page placements can be pinned');
  assert.throws(() => parsePluginLayout({ ...navigationLayout, navigation: [{ id: 'bad-nav', placementId: 'missing', order: 0 }] }), /invalid_plugin_layout/);
  assert.throws(() => parsePluginLayout({ ...navigationLayout, navigation: [...navigationLayout.navigation, ...navigationLayout.navigation] }), /invalid_plugin_layout/);
  const navService = new PluginService(store, undefined, undefined, { filesDir: process.env.FILES_DIR });
  try {
    const native = { owner, pluginService: navService, configuration: { taskPolicy: () => ({ read: 'allow', write: 'allow' }) }, task: { id: 'native-navigation' }, checkActive() {} };
    const document = navService.tool(owner, { operation: 'layout' });
    const renamed = JSON.parse(document.content); renamed.navigation[0].title = '原生聊天改名';
    await executePluginsTool(native, { operation: 'configure', content: JSON.stringify(renamed), expected: document.content, revision: document.revision });
    const botDocument = await pluginTool(navService).execute({ operation: 'layout' }, context);
    const botLayout = JSON.parse(botDocument.content); assert.equal(botLayout.navigation[0].title, '原生聊天改名');
    botLayout.navigation[0].title = 'Bot 改名';
    await pluginTool(navService).execute({ operation: 'configure', content: JSON.stringify(botLayout), expected: botDocument.content, revision: botDocument.revision }, context);
    assert.equal(JSON.parse(files.layout(owner).content).navigation[0].title, 'Bot 改名');
    assert.equal(JSON.parse(files.layout(other).content).navigation?.length ?? 0, 0, 'navigation remains owner-scoped');
  } finally { await navService.close(); }
  parsePluginManifest({ ...manifest, views: { list: { ...manifest.views.list, title: '概览', description: '查看计数' } } }, 'counter');
  assert.throws(() => parsePluginManifest({ ...manifest, views: { list: { ...manifest.views.list, title: '' } } }, 'counter'));
  const independentBefore = files.layout(owner), independentLayout = JSON.parse(independentBefore.content);
  independentLayout.instances.push({ id: 'independent-todo', pluginId: 'todo', scope: { kind: 'account' }, title: '单独待办' });
  files.save(owner, independentBefore.path, JSON.stringify(independentLayout), independentBefore.content, independentBefore.revision);
  const liveTodo = files.readState(owner, 'todo', 'legacy-todo', 'state');
  files.writeState(owner, 'todo', 'legacy-todo', 'state', { items: [{ id: 'private', title: '只属于原内容', done: false }] }, liveTodo.content, liveTodo.revision);
  assert.deepEqual(JSON.parse(files.readState(owner, 'todo', 'independent-todo', 'state').content), { items: [] }, 'new v1 content uses static defaults, not live legacy state');
  assert.equal(JSON.parse(files.readState(owner, 'todo', 'legacy-todo', 'state').content).items[0].title, '只属于原内容', 'legacy user content stays untouched');
  console.log('Plugin platform passed: disposable lifecycle and real package dependencies, v2 nested files, unified HTTP/Bot/native plugin tools and policy guards, v1 state alias, origin/CAS, three placements, isolated instances, hide/remount persistence, installable templates and durable Bot nonce recovery.');
} finally { await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
