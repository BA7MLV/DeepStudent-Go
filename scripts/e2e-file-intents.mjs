import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/file-intents-e2e-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store, page;
const errors = [], consoleMessages = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `import React from 'react'; import { createRoot } from 'react-dom/client';
    import FileIntentRecovery from '/src/cloud/FileIntentRecovery.tsx'; import { cloud } from '/src/cloud/state.ts';
    cloud.enabled=true; cloud.userId=window.owner;
    createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(FileIntentRecovery)));`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'file-intent-fixture', resolveId: id => id === '/__intent.js' ? '\0intent-fixture' : undefined, load: id => id === '\0intent-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__intent') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__intent.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'file-intent-test-password' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'file-intent-test-password' } });
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const resource = '/system/AGENTS.md', filename = path.join(directory, 'files/system-files', crypto.createHash('sha256').update(owner).digest('hex'), 'system/AGENTS.md');
  store.systemFiles.write(owner, resource, 'baseline');
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => consoleMessages.push(message.text()));
  await page.goto(`${origin}/__intent`);
  store.db.transaction(() => store.systemFiles.write(owner, resource, 'retained original draft', 'baseline'))();
  const id = store.systemFiles.entry(owner, resource).intent_id;
  fs.writeFileSync(filename, 'external newer version');
  assert.throws(() => store.systemFiles.flush(), /system_file_changed/);
  await page.getByRole('button', { name: '核对文件意图', exact: true }).click();
  await page.getByText('retained original draft', { exact: true }).waitFor();
  await page.getByText('external newer version', { exact: true }).waitFor();
  fs.writeFileSync(filename, 'external edit after inspection');
  await page.getByRole('button', { name: '按已核对版本恢复原稿', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '处理尚未确认' }).waitFor();
  assert.equal(fs.readFileSync(filename, 'utf8'), 'external edit after inspection', 'stale UI cannot overwrite a newer external edit');
  assert.equal(store.systemFiles.receipt(owner, id).status, 'conflict');
  await page.getByRole('button', { name: '重新查询原收据', exact: true }).click();
  await page.getByText('external edit after inspection', { exact: true }).waitFor();
  await page.route('**/api/clientRuntime/resolveFileIntent', async route => { await route.fetch(); await route.abort('failed'); });
  await page.getByRole('button', { name: '按已核对版本恢复原稿', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '处理尚未确认' }).waitFor();
  assert.equal(fs.readFileSync(filename, 'utf8'), 'retained original draft');
  const receipt = store.systemFiles.receipt(owner, id), successor = receipt.successor_id;
  assert.equal(receipt.status, 'superseded'); assert.equal(store.systemFiles.receipt(owner, successor).status, 'applied');
  await page.unroute('**/api/clientRuntime/resolveFileIntent');
  await page.getByRole('button', { name: '重新查询原收据', exact: true }).click();
  await page.getByRole('button', { name: '查询恢复收据', exact: true }).click();
  await page.getByText(new RegExp(`${successor}.*applied`)).waitFor();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM system_file_intents WHERE id=?').get(successor).n, 1);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ id, successor, status: 'applied', errors }, null, 2));
  console.log(`PASS typed file intent stream/UI/CAS recovery/lost response receipt/reload. Evidence: ${directory}`);
} catch (error) {
  const evidence = { errors, consoleMessages, body: await page?.locator('body').innerText().catch(() => ''), intents: store?.db.prepare('SELECT id,path,status FROM system_file_intents').all() };
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify(evidence, null, 2)); console.error('File intent evidence', directory, evidence); throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
