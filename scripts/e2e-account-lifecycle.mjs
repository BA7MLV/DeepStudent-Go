/** Real API/Remote/IDB: no local catalog authority, runtime rebuild and recovery retention. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/account-lifecycle-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import {startCloud,clearCloudLocalData} from '/src/cloud/sync.ts';
import {db,useCloudDatabase} from '/src/store/db.ts';
import {cloud} from '/src/cloud/state.ts';
import {serverRuntime,disposeServerRuntime,isCurrentServerRuntime} from '/src/client/bootstrap.ts';
import {accountLifecycle,accountLifetime} from '/src/client/account-lifecycle.ts';
import {pluginCatalogSource,refreshPlugins,pluginCatalogDiagnostics} from '/src/plugins/catalog.ts';
import {assertPluginAvailable} from '/src/plugins/availability.ts';
await startCloud(window.fixtureOwner);
let updates=0,stop=pluginCatalogSource.subscribe(()=>updates++);
window.probe={snapshot:pluginCatalogSource.getSnapshot,diagnostics:pluginCatalogDiagnostics,
  async reset(){const before=await serverRuntime(cloud.userId),lifetime=accountLifetime(cloud.userId);disposeServerRuntime();const after=await serverRuntime(cloud.userId);return {same:before===after,oldCurrent:isCurrentServerRuntime(before),oldLifetime:lifetime.current(),newCurrent:isCurrentServerRuntime(after)};},
  async databaseRoundtrip(){const before=accountLifetime(cloud.userId);useCloudDatabase('temporary-other-account');useCloudDatabase(cloud.userId);await db.open();return {oldCurrent:before.current(),newCurrent:accountLifetime(cloud.userId).current()};},
  async offline(){localStorage.setItem('wangke:local-plugin-layout:v2','{"apiVersion":2,"instances":[],"placements":[]}');cloud.enabled=false;disposeServerRuntime();try{await assertPluginAvailable('flashcards');return 'WRONGLY_AVAILABLE';}catch(e){return e.message;}},
  async restart(){await startCloud(window.fixtureOwner);},
  async refreshAfterReset(){const runtime=await serverRuntime(cloud.userId),model=runtime.catalog(),original=model.refresh;model.refresh=()=>{};const pending=refreshPlugins().then(()=> 'WRONGLY_COMPLETED',error=>error.message);disposeServerRuntime();model.refresh=original;return pending;},
  async preserve(){stop();disposeServerRuntime();
    sessionStorage.setItem('plugin-draft:fixture','original plugin draft');
    await db.table('_cloudMeta').put({id:'draft-original',value:{blob:new Blob(['original upload bytes'])}});
    await db.table('_learningCommands').add({operationId:'original-id',state:'conflict',request:{operationId:'original-id',edits:[]}});
    await db.table('_cloudOutbox').add({id:'original-mutation',transaction:'original-transaction',table:'files',key:'original-file',after:{blob:new Blob(['original journal bytes'])}});
    await db.table('_historyTransactions').put({id:'original-evidence',rows:[{id:'original-history-operation'}]});
    await clearCloudLocalData();
    return {draft:await (await db.table('_cloudMeta').get('draft-original')).value.blob.text(),
      journal:(await db.table('_learningCommands').toArray()).map(row=>row.operationId),
      original:await (await db.table('_cloudOutbox').where('transaction').equals('original-transaction').first()).after.blob.text(),
      history:(await db.table('_historyTransactions').get('original-evidence')).rows[0].id,
      pluginDraft:sessionStorage.getItem('plugin-draft:fixture'),preferences:await db.table('preferences').count()};},
};document.body.dataset.ready='true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'account-lifecycle-fixture', resolveId: id => id === '/__account.js' ? '\0account-fixture' : undefined,
      load: id => id === '\0account-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__account') return next(); res.setHeader('Content-Type', 'text/html');
        res.end('<body><script type="module" src="/__account.js"></script></body>');
      }); } }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'account-lifecycle-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'account-lifecycle-password-123' } });
  assert.equal(login.status(), 200);
  await context.addInitScript(owner => { window.fixtureOwner = owner; }, (await login.json()).user.id);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/__account`);
  await page.locator('body[data-ready="true"]').waitFor({ timeout: 30000 });
  await page.waitForFunction(() => probe.snapshot().status === 'ready');
  assert.deepEqual(await page.evaluate(() => probe.reset()), { same: false, oldCurrent: false, oldLifetime: false, newCurrent: true });
  await page.waitForFunction(() => probe.snapshot().status === 'ready');
  assert.equal(await page.evaluate(() => probe.refreshAfterReset()), 'plugin_session_changed');
  await page.waitForFunction(() => probe.snapshot().status === 'ready');
  assert.deepEqual(await page.evaluate(() => probe.databaseRoundtrip()), { oldCurrent: false, newCurrent: true });
  await page.waitForFunction(() => probe.snapshot().status === 'ready');
  assert.equal(await page.evaluate(() => probe.offline()), 'client_unauthenticated');
  await page.waitForFunction(() => probe.snapshot().status === 'error');
  assert.equal(await page.evaluate(() => probe.snapshot().data), undefined, 'local layout never becomes an authoritative fallback');
  await page.evaluate(() => probe.restart());
  await page.waitForFunction(() => probe.snapshot().status === 'ready');
  const retained = await page.evaluate(() => probe.preserve());
  assert.deepEqual(retained, { draft: 'original upload bytes', journal: ['original-id'], original: 'original journal bytes', history: 'original-history-operation', pluginDraft: 'original plugin draft', preferences: 0 });
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ retained, errors }, null, 2));
  console.log(`PASS account root rebuild, catalog reacquisition/refresh cancellation, database roundtrip, no local fallback, retained journals/Blobs/history/drafts (${directory})`);
} finally { await browser?.close(); await web?.close(); await app.close(); }
