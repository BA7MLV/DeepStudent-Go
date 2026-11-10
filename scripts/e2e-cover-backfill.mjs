/** Real API + coverQueue module without startCloud: bounded backfill must page
 * candidate keys instead of reading the account's course mirror. Not production
 * startup or cover-generation quality evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cover-backfill-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
const evidence = { checks: [], requests: [], errors: [] };
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import {cloud} from '/src/cloud/state.ts';import {db,useCloudDatabase} from '/src/store/db.ts';
import {backfillCovers} from '/src/pipelines/coverQueue.ts';
cloud.enabled=true;cloud.userId=window.owner;useCloudDatabase(window.owner);await db.open();
window.probe={backfill:limit=>backfillCovers(limit),videos:()=>db.videos.count(),covers:()=>db.covers.count()};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'cover-backfill', resolveId: id => id === '/__cover-entry.js' ? '\0cover-backfill' : undefined,
      load: id => id === '\0cover-backfill' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__cover') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__cover-entry.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const password = 'cover-backfill-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } }), owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  store.transaction(() => {
    for (let id = 0; id < 250; id++) put('videos', `course-${String(id).padStart(3, '0')}`, { id: `course-${String(id).padStart(3, '0')}`, name: `Course ${id}` });
    put('videos', 'course-skip', { id: 'course-skip', name: 'Skipped', coverState: 'skipped' });
    put('covers', 'course-000', { videoId: 'course-000', source: 'user', blob: { $file: 'existing' } });
  });
  await context.addInitScript(owner => { window.owner = owner; window.unhandled=[];addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason))); }, owner);
  const page = await context.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postData() }); });
  await page.goto(origin + '/__cover');await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => probe.backfill(5)), 5, 'backfill is bounded by its caller limit');
  assert.deepEqual(await page.evaluate(() => probe.videos()), 0, 'no account course mirror is written');
  assert.deepEqual(await page.evaluate(() => probe.covers()), 0);
  const keys = evidence.requests.map(request => { try { return JSON.parse(request.body).payload.args.request; } catch { return {}; } });
  assert.equal(keys.some(request => request.kind === 'coverCandidates'), true);
  assert.equal(keys.some(request => request.kind === 'records' || request.kind === 'collectionPage'), false);
  assert.equal(evidence.requests.some(request => /recordsPage|watchRecords/.test(request.path)), false);
  const first = keys.find(request => request.kind === 'coverCandidates');
  assert.equal(first.cursor, undefined);
  assert.deepEqual(await page.evaluate(() => window.unhandled), []);
  assert.deepEqual(evidence.errors, []);
  evidence.checks.push('250 cover-less courses never enter IDB; limit 5 issues one bounded keyset read (no recordsPage/collectionPage), excludes existing cover/skipped and keeps zero unhandled rejections');
  evidence.passed = true;
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS cover backfill demand: ${directory}`, evidence.checks);
} catch (error) { fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ ...evidence, error: String(error) }, null, 2)); throw error; }
finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
