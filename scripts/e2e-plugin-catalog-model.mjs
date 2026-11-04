import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/catalog-model-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { recordLearningReceipt, reconcileLearningResults } = await import('../apps/api/src/plugins/learning-results.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { BrowserRouter } from 'react-router-dom';
import '/src/i18n';
import { cloud } from '/src/cloud/state.ts';
import { usePluginCatalog, refreshPlugins } from '/src/plugins/catalog.ts';
import { PluginHost } from '/src/plugins/PluginHost.tsx';
import { serverRuntime, disposeServerRuntime } from '/src/client/bootstrap.ts';
cloud.enabled = true; cloud.userId = window.fixtureOwner;
const runtime = await serverRuntime(cloud.userId);
const root = createRoot(document.getElementById('root'));
let frames = false, framePlugin = 'todo';
function View({ id }) {
  const snapshot = usePluginCatalog();
  const plugin = snapshot.data?.plugins.find(p => p.id === framePlugin);
  const layout = snapshot.data ? JSON.parse(snapshot.data.layout.content) : undefined;
  const instance = layout?.instances.find(i => i.id === 'legacy-' + framePlugin);
  const placement = layout?.placements.find(p => p.instanceId === instance?.id);
  return React.createElement(React.Fragment, null,
    React.createElement('p', { 'data-placement': id, 'data-status': snapshot.status }, snapshot.data?.layout.content ?? snapshot.error ?? 'loading'),
    frames && plugin && instance && placement ? React.createElement('div', { 'data-frame': id }, React.createElement(PluginHost, {
      plugin, instance, placement: { ...placement, id: 'fixture-' + id },
       context: { surface: 'board.main', revision: 'fixture', materialId: framePlugin === 'flashcards' ? 'learning-fixture' : undefined, width: 720, locale: 'zh-CN', theme: 'light', mode: 'compact' },
    })) : null);
}
const mount = count => flushSync(() => root.render(React.createElement(React.StrictMode, null,
  React.createElement(BrowserRouter, null, ...Array.from({ length: count }, (_, id) => React.createElement(View, { key: id, id }))))));
window.probe = { mount, refresh: refreshPlugins, diagnostics: runtime.diagnostics,
  enableFrames: () => { frames = true; mount(3); },
   enableTaskFrames: () => { framePlugin = 'tasks'; mount(3); },
   enableLearning: () => { framePlugin = 'flashcards'; mount(3); },
  dispose: async () => { root.unmount(); disposeServerRuntime(); } };
mount(3);
`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'production-catalog-fixture',
      resolveId: id => id === '/__catalog-entry.js' ? '\0catalog-fixture' : undefined,
      load: id => id === '\0catalog-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__catalog') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__catalog-entry.js"></script>'); }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'catalog-model-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'catalog-model-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store); files.layout(owner);
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('plugin-watch',?,'plugin-watch','transcribe','fixture','{}','queued','browser',?,?)").run(owner, at, at);
  const page = await context.newPage(), errors = [], requests = [], sockets = [];
  page.on('pageerror', error => { errors.push(error.message); console.error('Browser exception:', error.message); });
  page.on('console', message => { if (message.type() === 'error') console.error('Browser console:', message.text()); });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push(request.url()); });
  page.on('websocket', socket => { if (socket.url().includes('/api/remote.mux')) sockets.push(socket.url()); });
  await page.goto(`${origin}/__catalog`);
  await page.locator('[data-placement="2"][data-status="ready"]').waitFor({ timeout: 30000 });
  assert.equal(sockets.length, 1);
  assert.equal((await page.evaluate(() => probe.diagnostics())).models.filter(model => model.active).length, 1);
  const previous = files.layout(owner), layout = JSON.parse(previous.content);
  layout.instances[0].title = 'External catalog update';
  files.save(owner, previous.path, JSON.stringify(layout), previous.content, previous.revision);
  for (const id of [0, 1, 2]) await page.locator(`[data-placement="${id}"]`).filter({ hasText: 'External catalog update' }).waitFor();
  await page.evaluate(() => probe.refresh());
  await page.waitForTimeout(60000);
  assert.equal(requests.length, 0, `catalog performs no HTTP business polling: ${requests.join(', ')}`);
  await page.evaluate(async () => {
    for (let i = 0; i < 100; i++) { probe.mount(0); probe.mount(3); await new Promise(resolve => setTimeout(resolve, 0)); }
    probe.mount(0);
  });
  await page.waitForFunction(() => probe.diagnostics().models.every(model => !model.active && model.refs === 0 && model.listeners === 0));
  await page.evaluate(() => probe.enableFrames());
  try {
    for (const id of [0, 1, 2]) await page.frameLocator(`[data-frame="${id}"] iframe`).locator('#items').filter({ hasText: /暂无待办|Your list is clear/ }).waitFor();
  } catch (error) { throw new Error(`${error.message}\nBody: ${await page.locator('body').innerHTML()}\nErrors: ${JSON.stringify(errors)}`); }
  await page.waitForFunction(() => probe.diagnostics().models.some(model => model.active && model.refs === 3));
  const state = files.readState(owner, 'todo', 'legacy-todo', 'state');
  files.writeState(owner, 'todo', 'legacy-todo', 'state', { items: [{ id: 'external', title: 'Cross-device state', done: false }] }, state.content, state.revision);
  for (const id of [0, 1, 2]) await page.frameLocator(`[data-frame="${id}"] iframe`).getByText('Cross-device state', { exact: true }).waitFor();
  const first = page.frameLocator('[data-frame="0"] iframe');
  await first.locator('#title').fill('Generated command receipt');
  await first.locator('#add').click();
  for (const id of [0, 1, 2]) await page.frameLocator(`[data-frame="${id}"] iframe`).getByText('Generated command receipt', { exact: true }).waitFor();
  // A second update proves the installed HTML consumes Host events, not just
  // its initial GET or the writing frame's command response.
  const quiet = requests.length;
  await page.waitForTimeout(60000);
  assert.equal(requests.length, quiet, 'production todo HTML has no hidden 5s poll');
  await page.evaluate(() => probe.enableTaskFrames());
  const taskFrames = [];
  for (const id of [0, 1, 2]) {
    const element = await page.locator(`[data-frame="${id}"] iframe`).elementHandle();
    const frame = await element.contentFrame();
    await frame.waitForFunction(() => !!window.plugin?.tasks?.watch);
    await frame.evaluate(() => {
      window.observed = []; window.watchErrors = []; window.watchControl = new AbortController();
      window.stopTask = plugin.tasks.watch('plugin-watch', task => observed.push(task.status), { signal: watchControl.signal, onError: error => watchErrors.push(error.message) });
    });
    taskFrames.push(frame);
  }
  for (const frame of taskFrames) await frame.waitForFunction(() => observed.includes('queued'));
  await page.waitForFunction(() => probe.diagnostics().models.some(model => model.active && model.refs === 3));
  await taskFrames[0].evaluate(() => watchControl.abort());
  store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id='plugin-watch'").run();
  for (const frame of taskFrames.slice(1)) await frame.waitForFunction(() => observed.includes('running'));
  assert.equal(store.db.prepare("SELECT status FROM cloud_tasks WHERE id='plugin-watch'").get().status, 'running', 'aborting sandbox observation does not cancel accepted work');
  store.db.prepare("UPDATE cloud_tasks SET status='completed' WHERE id='plugin-watch'").run();
  for (const frame of taskFrames.slice(1)) await frame.waitForFunction(() => observed.includes('completed'));
  for (const frame of taskFrames) assert.deepEqual(await frame.evaluate(() => watchErrors), []);
  const tasksQuiet = requests.length;
  await page.waitForTimeout(60000);
  assert.equal(requests.length, tasksQuiet, 'production tasks list and scoped watches perform no HTTP business polling');
  const records = new CloudRecords(store);
  const material = { id: 'learning-fixture', name: 'Push learning fixture', kind: 'material', status: 'transcribed' };
  const card = { id: 991, videoId: material.id, q: 'Shared learning question', a: 'Authoritative answer', status: 0, time: 0 };
  records.apply(owner, [{ id: 'learning-material', table: 'videos', key: material.id, before: null, after: material },
    { id: 'learning-card', table: 'cards', key: card.id, before: null, after: card }]);
  const learningBefore = files.layout(owner), learningLayout = JSON.parse(learningBefore.content);
  learningLayout.instances.push({ id: 'legacy-flashcards', pluginId: 'flashcards', scope: { kind: 'account' } });
  learningLayout.placements.push({ id: 'learning-placement', pluginId: 'flashcards', instanceId: 'legacy-flashcards', viewId: 'main', surface: 'board.main', scope: { kind: 'account' }, order: 50 });
  files.save(owner, learningBefore.path, JSON.stringify(learningLayout), learningBefore.content, learningBefore.revision);
  await page.evaluate(() => probe.enableLearning());
  for (const id of [0, 1, 2]) await page.locator(`[data-frame="${id}"]`).getByText('1 张卡片 · 已保留 0 张', { exact: true }).waitFor();
  await page.waitForFunction(() => {
    const active = probe.diagnostics().models.filter(model => model.active);
    // Both renderer source adapters aggregate their three committed subscribers
    // into one retain. There are still exactly two logical domain subscriptions.
    return active.length === 2 && active.every(model => model.refs === 1);
  });
  records.apply(owner, [{ id: 'learning-card-update', table: 'cards', key: card.id, before: card, after: { ...card, status: 1 } }]);
  for (const id of [0, 1, 2]) await page.locator(`[data-frame="${id}"]`).getByText('1 张卡片 · 已保留 1 张', { exact: true }).waitFor();
  await page.locator('[data-frame="0"]').getByRole('button', { name: '丢弃', exact: true }).click();
  for (const id of [0, 1, 2]) await page.locator(`[data-frame="${id}"]`).getByRole('button', { name: '丢弃', exact: true }).and(page.locator('[aria-pressed="true"]')).waitFor();
  store.transaction(() => {
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('learning-push-task',?,'learning-push-task','cards','course:learning-fixture',?,'completed','node',?,?)").run(owner, JSON.stringify({ videoId: material.id }), at, at);
    store.db.prepare("INSERT INTO plugin_learning_tasks(task_id,owner_id,plugin_id,instance_id,action_id,material_id,request) VALUES('learning-push-task',?,'flashcards','legacy-flashcards','cards.generate',?,'{}')").run(owner, material.id);
  });
  for (const id of [0, 1, 2]) await page.locator(`[data-frame="${id}"]`).getByText('执行已结束，等待产物收据', { exact: true }).waitFor();
  // A late durable receipt changes no task/card row. Its own notification must
  // update all mounted views, without restoring the removed polling fallback.
  recordLearningReceipt(store, 'learning-push-task', { kind: 'cards', count: 1, cardIds: [card.id] });
  reconcileLearningResults(store);
  for (const id of [0, 1, 2]) await page.locator(`[data-frame="${id}"]`).getByText('已保存 1 张卡片', { exact: true }).waitFor();
  const learningQuiet = requests.length;
  await page.waitForTimeout(60000);
  assert.equal(requests.length, learningQuiet, 'production flashcards composite projection has no HTTP business polling');
  assert.equal(sockets.length, 1, 'catalog, sandbox and learning use one shared connection');
  await page.evaluate(() => probe.mount(0));
  await page.waitForFunction(() => probe.diagnostics().models.every(model => !model.active && model.refs === 0 && model.listeners === 0));
  assert.deepEqual(errors, []);
  await page.evaluate(() => probe.dispose());
  console.log('PASS: production catalog, PluginHost/todo and flashcards, shared state/task/composite streams, external updates, generated commands, scoped sandbox watch/cancellation, 60s zero HTTP per slice and 100 catalog lifecycle cycles');
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
