import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/sync-locks-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import { startCloud, flushCloud } from '/src/cloud/sync.ts';
import { db } from '/src/store/db.ts';
await startCloud(window.fixtureOwner);
window.probe = { results: {}, flush(name, background = false) {
  void flushCloud(background).then(() => this.results[name] = 'done', error => this.results[name] = error.message);
 }, async edit() { await db.studyDays.put({ date: '2026-11-03', seconds: 60 }); },
 pending: () => db.table('_cloudOutbox').count(),
  value: () => db.studyDays.get('2026-11-03'),
   async write(seconds) { await db.studyDays.put({ date: '2026-11-03', seconds }); return db.table('_cloudOutbox').toArray(); } };
document.body.dataset.ready = 'true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'production-sync-lock-fixture',
      resolveId: id => id === '/__sync-entry.js' ? '\0sync-lock-fixture' : undefined,
      load: id => id === '\0sync-lock-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (!['/__sync', '/__holder'].includes(req.url)) return next();
        res.setHeader('Content-Type', 'text/html');
        res.end(req.url === '/__sync' ? '<script type="module" src="/__sync-entry.js"></script>' : '<p>Lock holder</p>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'sync-lock-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'sync-lock-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, owner);
  const page = await context.newPage(), holder = await context.newPage(), errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/clientRuntime/recordsPage') requests.push('pull');
    if (pathname === '/api/clientRuntime/commitRecords') requests.push('commit');
    if (pathname === '/api/v1/cloud/records') requests.push(`legacy:${request.method()}`);
  });
  await page.goto(`${origin}/__sync`);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  await page.evaluate(() => probe.flush('settled'));
  await page.waitForFunction(() => probe.results.settled === 'done');
  await holder.goto(`${origin}/__holder`);
  await holder.evaluate(owner => {
    void navigator.locks.request(`cloud-sync:${owner}`, async () => {
      window.held = true;
      await new Promise(resolve => { window.release = resolve; });
    });
  }, owner);
  await holder.waitForFunction(() => window.held);
  requests.length = 0;
  await page.evaluate(() => probe.flush('idleBackground', true));
  await page.waitForFunction(() => probe.results.idleBackground === 'done');
  assert.equal((await page.evaluate(() => navigator.locks.query())).pending.length, 0, 'idle maintenance never queues');
  await page.evaluate(() => probe.edit());
  const pending = await page.evaluate(() => probe.pending());
  assert.ok(pending > 0);
   // Longer than the deleted periodic interval, under a real cross-tab lock.
  await page.waitForTimeout(3500);
  assert.equal((await page.evaluate(() => navigator.locks.query())).pending.length, 1, 'one real committed edit queues one coalesced writer, not periodic ticks');
  assert.equal(await page.evaluate(() => probe.pending()), pending, 'skipping never acknowledges or removes edits');
  assert.deepEqual(requests, [], 'no sync network work without the lock');
  await page.evaluate(() => { probe.flush('skipped', true); probe.flush('explicit'); });
  await page.waitForFunction(async () => (await navigator.locks.query()).pending.length === 1);
  assert.equal(await page.evaluate(() => probe.results.explicit), undefined, 'explicit flush waits for ownership');
  await holder.evaluate(() => window.release());
  await page.waitForFunction(() => probe.results.explicit === 'done');
  assert.equal(await page.evaluate(() => probe.pending()), 0);
  assert.ok(requests.includes('commit') && requests.includes('pull'), 'explicit flush uses typed commit and baseline commands');
  assert.equal(requests.some(request => request.startsWith('legacy:')), false, 'account adapter never returns to legacy records HTTP');
  // Also cover joining a skipped attempt with no outbox: explicit flush still reads.
  await holder.evaluate(owner => {
    window.held = false;
    void navigator.locks.request(`cloud-sync:${owner}`, async () => {
      window.held = true;
      await new Promise(resolve => { window.release = resolve; });
    });
  }, owner);
  await holder.waitForFunction(() => window.held);
  requests.length = 0;
  await page.evaluate(() => { probe.flush('emptyBackground', true); probe.flush('emptyExplicit'); });
  await page.waitForFunction(async () => (await navigator.locks.query()).pending.length === 1);
  assert.equal(await page.evaluate(() => probe.results.emptyExplicit), undefined);
  await holder.evaluate(() => window.release());
  await page.waitForFunction(() => probe.results.emptyExplicit === 'done');
  assert.ok(requests.includes('pull'), 'no-outbox explicit flush cannot mistake a skipped attempt for a baseline');
  // Ordinary edits must drain from committed IndexedDB notifications without
  // a caller remembering flushCloud or a periodic timer.
   const editOutbox = await page.evaluate(() => probe.write(120));
  assert.ok(editOutbox.length, 'committed edit must create its durable outbox before wakeup');
   await page.waitForFunction(async () => (await probe.value())?.seconds === 120 && await probe.pending() === 0);
  try {
    const records = new CloudRecords(store);
     assert.equal(records.get(owner, 'studyDays', '2026-11-03').seconds, 120, JSON.stringify({ editOutbox, requests, local: await page.evaluate(() => probe.value()) }));
     const before = records.get(owner, 'studyDays', '2026-11-03');
     records.apply(owner, [{ id: 'external-learning-update', table: 'studyDays', key: '2026-11-03', before, after: { date: '2026-11-03', seconds: 180 } }]);
     await page.waitForFunction(async () => (await probe.value())?.seconds === 180);
  } finally { store.close(); }
  await page.waitForTimeout(500);
  requests.length = 0;
  await page.waitForTimeout(60000);
  assert.deepEqual(requests, [], '60 seconds of production sync idle has zero record unary requests');
  assert.deepEqual(errors, []);
  console.log('PASS: production sync + real API + cross-tab Web Locks; background skips without queue/network/data loss, explicit flush joins safely and drains or pulls an empty-outbox baseline');
 } finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
