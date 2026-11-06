import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cloud-activity-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import CloudActivity from '/src/cloud/Activity.tsx';
import { cloud } from '/src/cloud/state.ts';
import { db, useCloudDatabase } from '/src/store/db.ts';
import { serverRuntime } from '/src/client/bootstrap.ts';
import { useCloudActivity } from '/src/cloud/activityStore.ts';
cloud.enabled = true; cloud.userId = window.fixtureOwner; cloud.worker = false;
useCloudDatabase(cloud.userId); await db.open();
const runtime = await serverRuntime(cloud.userId);
const root = createRoot(document.getElementById('root'));
window.probe = {
  mount() { flushSync(() => root.render(React.createElement(React.StrictMode, null, React.createElement(CloudActivity)))); },
  unmount() { flushSync(() => root.render(null)); },
  state: useCloudActivity.getState,
  diagnostics: runtime.diagnostics,
};
probe.mount(); document.body.dataset.ready = 'true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'production-cloud-activity-fixture',
      resolveId: id => id === '/__activity-entry.js' ? '\0cloud-activity-fixture' : undefined,
      load: id => id === '\0cloud-activity-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__activity') return next();
        res.setHeader('Content-Type', 'text/html');
        res.end('<div id="root"></div><script type="module" src="/__activity-entry.js"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'activity-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'activity-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const page = await context.newPage(), errors = [], requests = [], sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ url: request.url(), method: request.method() }); });
  page.on('websocket', socket => sockets.push(socket.url()));
  await page.goto(`${origin}/__activity`);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => probe.state().tasks !== null);
   assert.equal(await page.evaluate(() => probe.diagnostics().models.filter(m => m.active).length), 2, 'task list and file-intent recovery share the same carrier');
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('activity-task',?,'activity-nonce','qa','fixture','{}','queued','browser',?,?)").run(owner, at, at);
  await page.waitForFunction(() => probe.state().tasks?.some(t => t.id === 'activity-task' && t.status === 'queued'));
  store.db.prepare("UPDATE cloud_tasks SET status='running',progress=? WHERE id='activity-task'").run(JSON.stringify({ content: 'pushed progress' }));
  await page.waitForFunction(() => probe.state().tasks?.find(t => t.id === 'activity-task')?.progress?.content === 'pushed progress');
  await page.waitForTimeout(60000);
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result='42' WHERE id='activity-task'").run();
  await page.waitForFunction(() => probe.state().tasks?.find(t => t.id === 'activity-task')?.status === 'completed');
  assert.equal(await page.evaluate(() => probe.state().tasks?.find(t => t.id === 'activity-task')?.result), null,
    'the activity projection does not replay a finished task result to every subscriber');
  await page.evaluate(() => probe.unmount());
  await page.waitForFunction(() => probe.diagnostics().models.every(m => !m.active && m.refs === 0 && m.listeners === 0));
  for (let i = 0; i < 100; i++) await page.evaluate(async () => { probe.mount(); await Promise.resolve(); probe.unmount(); });
  await page.waitForFunction(() => probe.diagnostics().models.every(m => !m.active && m.refs === 0 && m.listeners === 0));
  assert.deepEqual(requests.filter(r => /\/cloud\/tasks(?:[/?]|$)/.test(r.url)), [], 'activity never polls tasks');
  assert.equal(sockets.filter(url => new URL(url).pathname === '/api/remote.mux').length, 1);
  assert.deepEqual(errors, []);
  console.log('PASS: production CloudActivity, generated task-list stream, real API/WS, pushed insert/progress/terminal, 60s zero task HTTP, StrictMode and 100 lifecycle releases');
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
