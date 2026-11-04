import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/task-observer-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  // The fixture deliberately imports the production waiter and bootstrap, not
  // a test implementation of their scheduling, transport or cache logic.
  const fixture = `
import { cloud } from '/src/cloud/state.ts';
import { db, useCloudDatabase } from '/src/store/db.ts';
import { cloudTransaction } from '/src/cloud/transactions.ts';
import { markCloudApply } from '/src/cloud/cache.ts';
import { waitCloudTask } from '/src/cloud/tasks.ts';
import { serverRuntime, disposeServerRuntime } from '/src/client/bootstrap.ts';
cloud.enabled = true; cloud.userId = window.fixtureOwner; cloud.worker = false;
useCloudDatabase(cloud.userId); await db.open();
const runtime = await serverRuntime(cloud.userId);
const results = {}, controls = {}, progress = {};
window.probe = { results, progress, diagnostics: runtime.diagnostics,
  start(name, id, fail = false) {
    const control = controls[name] = new AbortController();
    void waitCloudTask({ id }, value => { progress[name] = value; if (fail) throw new Error('fixture_callback_failed'); }, control.signal)
      .then(value => { results[name] = { value }; }, error => { results[name] = { error: error.message }; });
  }, abort(name) { controls[name].abort(new Error('fixture_observer_cancelled')); },
  async cacheOwner(id) {
    await cloudTransaction(db, [db.chats], async () => { markCloudApply(); await db.chats.put({ id, videoId: 'fixture', role: 'assistant', content: '', createdAt: Date.now(), widgets: [{ id: 'widget', html: '<p>owner</p>' }] }); });
  },
  dispose: disposeServerRuntime,
};
document.body.dataset.ready = 'true';
`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'production-task-observer-fixture',
      resolveId: id => id === '/__task-entry.js' ? '\0task-observer-fixture' : undefined,
      load: id => id === '\0task-observer-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__task') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<script type="module" src="/__task-entry.js"></script>'); }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'task-observer-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'task-observer-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const at = new Date().toISOString();
  for (const id of ['shared', 'failure', 'owner', 'late-owner', 'disposed']) store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,'transcribe','fixture','{}','queued','browser',?,?)").run(id, owner, id, at, at);
  const page = await context.newPage(), errors = [], requests = [];
  const sockets = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method() }); });
  page.on('websocket', socket => { const record = { url: socket.url(), at: Date.now(), closed: false }; sockets.push(record); socket.on('close', () => { record.closed = true; }); });
  await page.goto(`${origin}/__task`);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  await page.evaluate(() => { probe.start('a', 'shared'); probe.start('b', 'shared'); });
  await page.waitForFunction(() => probe.diagnostics().models.some(model => model.refs === 2));
  await page.evaluate(() => probe.abort('a'));
  await page.waitForFunction(() => probe.results.a?.error === 'fixture_observer_cancelled');
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get('shared').status, 'queued');
  store.db.prepare("UPDATE cloud_tasks SET status='running',progress=?,updated_at=? WHERE id='shared'").run(JSON.stringify({ text: 'pushed-progress' }), new Date().toISOString());
  await page.waitForFunction(() => probe.progress.b?.text === 'pushed-progress');
  // A real 60-second idle window on the production waiter: no task HTTP.
  await page.waitForTimeout(60_000);
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result='42',updated_at=? WHERE id='shared'").run(new Date().toISOString());
  await page.waitForFunction(() => probe.results.b?.value === 42);
  await page.evaluate(() => probe.start('failure', 'failure', true));
  store.db.prepare("UPDATE cloud_tasks SET progress=?,updated_at=? WHERE id='failure'").run(JSON.stringify({ text: 'fail-callback' }), new Date().toISOString());
  await page.waitForFunction(() => probe.results.failure?.error === 'fixture_callback_failed');
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get('failure').status, 'queued');
  const completeWithOwner = (id, rowId) => store.db.prepare("UPDATE cloud_tasks SET status='completed',result='7',progress=?,updated_at=? WHERE id=?")
    .run(JSON.stringify({ rowId, widgets: [{ id: 'widget', html: '<p>owner</p>' }] }), new Date().toISOString(), id);
  await page.evaluate(() => probe.start('owner', 'owner'));
  completeWithOwner('owner', 1234);
  await page.waitForFunction(() => probe.diagnostics().models.every(model => model.refs === 0));
  assert.equal(await page.evaluate(() => probe.results.owner), undefined, 'terminal receipt alone cannot preview a missing widget owner');
  await page.evaluate(() => probe.cacheOwner(1234));
  await page.waitForFunction(() => probe.results.owner?.value === 7);
  await page.evaluate(() => probe.start('lateOwner', 'late-owner'));
  completeWithOwner('late-owner', 1235);
  await page.waitForFunction(() => probe.diagnostics().models.every(model => model.refs === 0));
  await page.evaluate(() => probe.start('disposed', 'disposed'));
  await page.waitForFunction(() => probe.diagnostics().models.some(model => model.refs === 1));
  await page.evaluate(() => probe.dispose());
  await page.waitForFunction(() => !!probe.results.disposed?.error);
  await page.waitForFunction(() => probe.results.lateOwner?.error === 'client_runtime_disposed');
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get('disposed').status, 'queued');
  assert.equal(sockets.filter(socket => new URL(socket.url).pathname === '/api/remote.mux').length, 1,
    `production waiters share one account mux socket (Vite dev socket counted separately): ${JSON.stringify(sockets)}`);
  assert.deepEqual(requests.filter(request => /\/tasks(?:\/|\?|$)/.test(request.url)), [], 'waiter never GETs tasks or sends cancel');
  assert.deepEqual(errors, []);
  console.log('PASS: production waitCloudTask + browser bootstrap + real HTTP/WS, shared waiters, pushed progress/result, cancel isolation, callback error, delayed widget cache/disposal, 60s idle without task HTTP');
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
