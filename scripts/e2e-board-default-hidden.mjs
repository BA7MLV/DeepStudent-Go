import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Everything on the board is a user component: no seed, no entry, until one is written.
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/board-default-hidden-');
delete process.env.BOARD_SEED_DIR;
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 800 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'board-hidden-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password: 'board-hidden-password-123' })).status(), 200);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/`);
  await page.getByTestId('nav-rail-home').first().waitFor({ timeout: 60000 });
  // Catalog has loaded once the nav renders from it; give the stream a moment.
  await page.waitForFunction(async () => { const { pluginCatalogDiagnostics } = await import('/src/plugins/catalog.ts'); return pluginCatalogDiagnostics().status === 'ready'; }, null, { timeout: 30000 });
  assert.equal(await page.getByTestId('nav-rail-tasks').count(), 0, 'fresh account: no board entry');
  const listing = await (await context.request.get(`${origin}/api/v1/system/files?path=${encodeURIComponent('/system/board/plugins')}`)).json();
  assert.deepEqual(listing.directories ?? [], [], 'fresh account: no built-in components');

  // The user writes a component as an ordinary resource file; the entry appears live.
  const write = async (resource, content) => assert.equal((await post('/system/file', { path: resource, expected: '', revision: 0, content })).status(), 200, resource);
  await write('/system/board/plugins/counter/index.html', '<p data-testid="counter">我的计数器</p>');
  await write('/system/board/plugins/counter/manifest.json', JSON.stringify({ apiVersion: 1, id: 'counter', name: '计数器', version: '1.0.0', entry: 'index.html', enabled: true, capabilities: ['state'] }));
  await page.getByTestId('nav-rail-tasks').first().waitFor({ timeout: 30000 });
  await page.getByTestId('nav-rail-tasks').first().click();
  await page.getByTestId('board-plugin-counter').waitFor({ timeout: 30000 });

  // Sync notices float: an error appearing must not change the chat viewport.
  await page.goto(`${origin}/#/`);
  await page.locator('.course-chat').first().waitFor({ timeout: 30000 });
  const height = () => page.getByTestId('course-chat-page').evaluate(node => node.getBoundingClientRect().height);
  const before = await height();
  assert.ok(before > 600, `measured the chat page (${before}px)`);
  await page.evaluate(async () => { const { useCloudSync } = await import('/src/cloud/sync.ts'); useCloudSync.setState({ error: '同步冲突：fixture' }); });
  await page.getByTestId('cloud-activity').getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('cloud-activity').evaluate(node => getComputedStyle(node).position), 'fixed');
  assert.equal(await height(), before, 'sync notice does not resize the page');
  // Transient degradation stays silent below the threshold.
  await page.evaluate(async () => { const { useCloudSync } = await import('/src/cloud/sync.ts'); useCloudSync.setState({ error: '', degradedSince: Date.now() }); });
  await page.waitForTimeout(1500);
  assert.equal(await page.getByTestId('cloud-activity').getByRole('status').count(), 0, 'brief reconnect is silent');
  assert.deepEqual(errors, []);
  console.log(`PASS: empty default board, no nav entry, user-written component appears live, fixed non-shifting sync dock, silent brief degradation. Evidence: ${directory}`);
} finally { await browser?.close(); await web?.close(); await app.close(); }
