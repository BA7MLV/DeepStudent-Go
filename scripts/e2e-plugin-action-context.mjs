import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-action-context-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
const scopeCatalog = PluginFiles.prototype.scopeCatalog;
let held = true, releaseScope, scopeReads = 0, failScope = false;
const scopeGate = new Promise(resolve => { releaseScope = resolve; });
// Delay only the requested host read, not its result or the RPC. The original
// owner/filesystem projection still runs after release, so no fake scope grants.
PluginFiles.prototype.scopeCatalog = function(owner, context) {
  if (context?.materialId && failScope) throw new Error('injected_scope_projection_failure');
  if (context?.materialId && held) { scopeReads++; return scopeGate.then(() => scopeCatalog.call(this, owner, context)); }
  return scopeCatalog.call(this, owner, context);
};
const evidence = { browser: process.env.BROWSER ?? 'chromium', errors: [], passed: false };
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen(); const origin = `http://localhost:${web.httpServer.address().port}`;
  process.env.PUBLIC_ORIGIN = origin;
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
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
  // Neither old nor new global catalog may enumerate this unbound material.
  const stale = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(`${origin}/#/library?folder=${folder.id}`);
  const entry = page.getByTestId('resource-entry').filter({ hasText: 'late.md' }); await entry.waitFor();
  const latest = await (await context.request.get(`${origin}/api/v1/plugins`)).json();
  const material = store.db.prepare('SELECT course_id AS id FROM resource_files WHERE owner_id=? AND project_id=? AND path=?').get(owner, folder.id, 'late.md');
  assert.ok(material && !stale.scopes.materials.some(m => m.id === material.id) && !latest.scopes.materials.some(m => m.id === material.id), 'newly indexed material stays out of the shared configuration catalog');
  await page.waitForFunction(() => document.querySelector('[data-plugin-renderer]') || document.querySelector('[data-testid="resource-entry"]'));
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => scopeReads ? resolve() : Date.now() > deadline ? reject(new Error('exact scope read not started')) : setTimeout(check, 25);
    check();
  });
  const action = entry.getByRole('button', { name: '打开学习卡片', exact: true });
  assert.equal(await action.count(), 0, 'do not expose a contribution before its material scope is known');
  held = false;
  releaseScope();
  await action.click();
  const dialog = page.getByRole('dialog', { name: '打开学习卡片', exact: true });
  await dialog.getByTestId('plugin-flashcards').getByText('late', { exact: true }).waitFor();
  await page.evaluate(async () => (await import('/src/plugins/catalog.ts')).refreshPlugins());
  assert.equal(await dialog.isVisible(), true, 'ordinary catalog refresh must preserve the open contribution');
  const records = new CloudRecords(store);
  const replace = row => records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: material.id, before: records.get(owner, 'videos', material.id), after: row,
    baseRevision: store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=?").get(owner, JSON.stringify(material.id)).revision }]);
  const baseline = records.get(owner, 'videos', material.id);
  // A real directory rescan repairs filename-derived course names. Inject the
  // failed server projection instead of racing that authority with corrupt data.
  // Actual metadata byte-budget rejection is covered by test-plugin-scope-demand.
  failScope = true;
  replace({ ...baseline, lastPosition: 12 });
  const scopeError = entry.getByRole('alert');
  await scopeError.waitFor();
  assert.equal(await dialog.isVisible(), true, 'scope read failure is not revocation and must preserve the mounted dialog and draft');
  assert.equal(await action.isDisabled(), true, 'stale host scope cannot authorize a new action');
  failScope = false; replace(baseline);
  await scopeError.getByRole('button', { name: '重试', exact: true }).click();
  await action.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-plugin-actions] > button')].some(button => !button.disabled));
  assert.equal(await dialog.isVisible(), true, 'explicit scope retry also preserves the open contribution');
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await entry.waitFor();
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  console.log(`Contribution context browser passed (${evidence.browser}): ${directory}; delayed exact scope, no global material index or premature action, correct material on open, refresh/injected server read failure/retry preserve dialog.`);
} finally { releaseScope(); PluginFiles.prototype.scopeCatalog = scopeCatalog; fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); await browser?.close(); await web?.close(); await app.close(); store?.close(); }
