import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/plugin-action-context-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen(); const origin = `http://localhost:${web.httpServer.address().port}`;
  process.env.PUBLIC_ORIGIN = origin;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, extra = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...extra }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'action-context-password' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'action-context-password' })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store), current = files.layout(owner), layout = JSON.parse(current.content);
  layout.instances.push({ id: 'context-cards', pluginId: 'flashcards', scope: { kind: 'account' } });
  layout.placements.push({ id: 'context-resource', pluginId: 'flashcards', instanceId: 'context-cards', viewId: 'open', surface: 'resource.actions', scope: { kind: 'account' }, order: 0 });
  files.save(owner, current.path, JSON.stringify(layout), current.content, current.revision);
  const folder = await (await post('/resources/folders', { name: '延迟资料归属' })).json();
  await context.request.put(`${origin}/api/v1/projects/${folder.id}/text?path=late.md`, { headers: { origin }, data: { text: '# 迟到的目录元数据', expectedRevision: null } });
  // Resource listing indexes newly discovered files after the first catalog read.
  // Hold that earlier real snapshot, not the actions/RPC or their assertions.
  const stale = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  let held = true;
  const page = await context.newPage();
  await page.route('**/api/v1/plugins', route => held ? route.fulfill({ json: stale }) : route.continue());
  await page.goto(`${origin}/#/library?folder=${folder.id}`);
  const entry = page.getByTestId('resource-entry').filter({ hasText: 'late.md' }); await entry.waitFor();
  const latest = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  const material = latest.scopes.materials.find(m => m.name === 'late');
  assert.ok(material && !stale.scopes.materials.some(m => m.id === material.id), 'listing really introduced a previously unknown material');
  const action = entry.getByRole('button', { name: '打开学习卡片', exact: true });
  assert.equal(await action.count(), 0, 'do not expose a contribution before its material scope is known');
  held = false;
  await page.evaluate(async () => (await import('/src/plugins/catalog.ts')).refreshPlugins());
  await action.click();
  const dialog = page.getByRole('dialog', { name: '打开学习卡片', exact: true });
  await dialog.getByTestId('plugin-flashcards').getByText('late', { exact: true }).waitFor();
  await page.evaluate(async () => (await import('/src/plugins/catalog.ts')).refreshPlugins());
  assert.equal(await dialog.isVisible(), true, 'ordinary catalog refresh must preserve the open contribution');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await entry.waitFor();
  console.log('Contribution context browser passed: delayed material indexing, no premature action, correct material on open, refresh preserves the dialog.');
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true }); }
