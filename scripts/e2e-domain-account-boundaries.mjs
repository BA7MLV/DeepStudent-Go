import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/domain-account-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, store, browser;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import {cloud} from '/src/cloud/state.ts';
import {db,useCloudDatabase,WangkeDB,cloudDatabaseName} from '/src/store/db.ts';
import {serverRuntime,disposeServerRuntime} from '/src/client/bootstrap.ts';
import {startPreferences,stopPreferences,flushPreferences,inspectPreferenceCommand,resolvePreferenceCommand} from '/src/cloud/preferences.ts';
import {resourceCommand,inspectResourceCommand,archiveResourceCommand,recordReadingPosition,setReadingView} from '/src/client/resources.ts';
import {useSettings} from '/src/store/settings.ts';
const errors=[];window.addEventListener('cloud-preferences-error',event=>errors.push(event.detail));
let inspection;
window.probe={
 async select(owner){stopPreferences();disposeServerRuntime();cloud.enabled=true;cloud.worker=false;cloud.userId=owner;useCloudDatabase(owner);await db.open();},
 start:startPreferences,
 async preference(theme){useSettings.setState({theme});await flushPreferences();},
 theme:()=>useSettings.getState().theme,
 errors:()=>errors,
 async rows(owner){const database=new WangkeDB(cloudDatabaseName(owner));try{await database.open();return await database.table('_cloudMeta').toArray();}finally{database.close();}},
 async seedInspection(){const operationId='account-preference-draft-0001';await db.table('_cloudMeta').put({id:'preferences-command:'+operationId,value:{operationId,request:{operationId,changes:[{key:'theme',value:'dark',expected:null}]},state:'conflict'}});inspection=await inspectPreferenceCommand(operationId);return operationId;},
 async rejectInspection(imported=false){try{await resolvePreferenceCommand(inspection.command.operationId,imported?JSON.parse(JSON.stringify(inspection)):inspection,'discard');return false;}catch(error){return error.message==='client_account_changed';}},
 async renew(){disposeServerRuntime();await serverRuntime(cloud.userId);},
 resource:resourceCommand,
 async seedCourse(courseId){const {markCloudApply}=await import('/src/cloud/cache.ts');await db.transaction('rw',db.videos,async()=>{markCloudApply();await db.videos.put({id:courseId,name:'Reading fixture',duration:0,createdAt:1,status:'transcribed',lastUnit:1,htmlView:'raw'});});},
 async course(courseId){return db.videos.get(courseId);},
 async reading(courseId){await recordReadingPosition(courseId,4);await setReadingView(courseId,'blocks');},
 async offlineReading(courseId){try{await recordReadingPosition(courseId,9);return false;}catch{return true;}},
 async inspectResource(operationId){try{await inspectResourceCommand(operationId);return 'accepted';}catch(error){return error.message;}},
};document.body.textContent='Account boundary fixture';document.body.dataset.ready='true';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite'), plugins: [{ name: 'domain-account-fixture', configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split('?')[0] !== '/account-fixture') return next();
        response.setHeader('content-type', 'text/html'); response.end('<body><script type="module" src="/account-fixture.js"></script>');
      });
    }, resolveId(id) { if (id === '/account-fixture.js') return '\0account-fixture'; }, load(id) { if (id === '\0account-fixture') return fixture; } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext(), page = await context.newPage();
  const pageErrors = []; page.on('pageerror', error => { pageErrors.push(error.message); console.error(error.message); });
  const init = await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: 'account-boundary-test-123' } }); assert.equal(init.status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'account-boundary-test-123' } });
  assert.equal(login.status(), 200); const ownerA = (await login.json()).user.id;
  const cookieA = (await context.cookies()).find(cookie => cookie.name === 'wangke_session');
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const ownerB = crypto.randomUUID(), tokenB = crypto.randomUUID(), at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(ownerB, 'Second local fixture account', at);
  store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), ownerB, crypto.createHash('sha256').update(tokenB).digest('hex'), at, new Date(Date.now() + 3600000).toISOString());
  const records = new CloudRecords(store);
  for (const [owner, theme] of [[ownerA, 'light'], [ownerB, 'dark']]) records.apply(owner, [
    { id: crypto.randomUUID(), table: 'preferences', key: 'theme', before: null, after: { id: 'theme', value: theme } },
    { id: crypto.randomUUID(), table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } },
  ]);
  const select = async (owner, cookie) => {
    await context.addCookies([{ name: 'wangke_session', value: cookie, url: origin }]);
    await page.evaluate(owner => probe.select(owner), owner);
  };
  await page.goto(`${origin}/account-fixture`); await page.locator('body[data-ready="true"]').waitFor();
  await select(ownerA, cookieA.value); await page.evaluate(() => probe.start());
  assert.equal(await page.evaluate(() => probe.theme()), 'light');
  const readingCourseId = 'account-reading-fixture-course';
  records.apply(ownerA, [{ id: crypto.randomUUID(), table: 'videos', key: readingCourseId, before: null,
    after: { id: readingCourseId, name: 'Reading fixture', duration: 0, createdAt: 1, status: 'transcribed', lastUnit: 1, htmlView: 'raw' } }]);
  await page.evaluate(courseId => probe.seedCourse(courseId), readingCourseId);
  await page.evaluate(courseId => probe.reading(courseId), readingCourseId);
  assert.equal(records.get(ownerA, 'videos', readingCourseId).lastUnit, 4);
  assert.equal(records.get(ownerA, 'videos', readingCourseId).htmlView, 'blocks');
  // The command reply is not an authority for replacing the cached whole row.
  assert.equal((await page.evaluate(courseId => probe.course(courseId), readingCourseId)).lastUnit, 1);
  await page.route('**/api/clientRuntime/resourceCommand', route => route.abort('connectionreset'));
  assert.equal(await page.evaluate(courseId => probe.offlineReading(courseId), readingCourseId), true);
  assert.equal((await page.evaluate(courseId => probe.course(courseId), readingCourseId)).lastUnit, 1, 'offline command never falls back to local authoritative progress');
  assert.equal(records.get(ownerA, 'videos', readingCourseId).lastUnit, 4);
  await page.unroute('**/api/clientRuntime/resourceCommand');
  let unblock, captured;
  const held = new Promise(resolve => { captured = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  await page.route('**/api/clientRuntime/setPreferences', async route => {
    const response = await route.fetch(); captured(); await gate;
    try { await route.fulfill({ response }); } catch { /* old Runtime aborted its carrier */ }
  });
  await page.evaluate(() => { window.preferenceFlight = probe.preference('auto').catch(error => error.message); });
  await held;
  // The first account committed, but its response arrives only after switching
  // cookie principal AND local Runtime/database to the second real account.
  await select(ownerB, tokenB); await page.evaluate(() => probe.start());
  assert.equal(await page.evaluate(() => probe.theme()), 'dark');
  unblock(); await page.unroute('**/api/clientRuntime/setPreferences');
  await page.evaluate(() => window.preferenceFlight);
  assert.equal(await page.evaluate(() => probe.theme()), 'dark');
  assert.equal(records.get(ownerA, 'preferences', 'theme').value, 'auto');
  assert.equal(records.get(ownerB, 'preferences', 'theme').value, 'dark');
  assert.ok((await page.evaluate(owner => probe.rows(owner), ownerA)).some(row => row.id.startsWith('preferences-command:')), 'unacknowledged old account draft retained');
  assert.equal((await page.evaluate(owner => probe.rows(owner), ownerB)).some(row => row.id.startsWith('preferences-command:')), false);
  assert.deepEqual(await page.evaluate(() => probe.errors()), [], 'old async rejection does not notify new account');
  await page.evaluate(() => probe.seedInspection());
  assert.equal(await page.evaluate(() => probe.rejectInspection(true)), true, 'imported JSON is not recovery authority');
  await page.evaluate(() => probe.renew());
  assert.equal(await page.evaluate(() => probe.rejectInspection()), true, 'same account new Runtime rejects old preference inspection');
  // Resource command commits under B, then its late reply cannot clear/archive
  // a journal belonging to a subsequently selected A database.
  let releaseResource, captureResource;
  const resourceGate = new Promise(resolve => { releaseResource = resolve; }), resourceHeld = new Promise(resolve => { captureResource = resolve; });
  await page.route('**/api/clientRuntime/resourceCommand', async route => {
    const response = await route.fetch(); captureResource(); await resourceGate;
    try { await route.fulfill({ response }); } catch {}
  });
  await page.evaluate(() => { window.resourceFlight = probe.resource({ kind: 'createFolder', name: 'Original B resource' }).catch(error => error.message); });
  await resourceHeld;
  await select(ownerA, cookieA.value);
  releaseResource(); await page.unroute('**/api/clientRuntime/resourceCommand'); await page.evaluate(() => window.resourceFlight);
  const oldResources = await page.evaluate(owner => probe.rows(owner), ownerB);
  assert.ok(oldResources.some(row => row.id.startsWith('resource-command:')), 'old B resource draft retained for recovery');
  assert.equal((await page.evaluate(owner => probe.rows(owner), ownerA)).some(row => row.id.startsWith('resource-command:') && row.value.request.operation.kind === 'createFolder'), false);
  assert.deepEqual(pageErrors, []);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, authenticatedAccountSwitch: true,
    preferenceLateReply: true, oldDraftRetained: true, newAccountUntouched: true, importedInspectionRejected: true,
    sameAccountNewRuntimeRejected: true, resourceLateReply: true, readingCommands: true, offlineReadingNoFallback: true, pageErrors }, null, 2));
  console.log(`PASS real authenticated account switch, preference/resource late responses, retained original drafts, no new-account pollution and inspection identity (${directory})`);
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
