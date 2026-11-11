/** Real startCloud/API/IDB. Isolated fixture, no model/external requests. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/account-demand-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], requests: [], errors: [], leaks: [], globalReads: [] };
let browser, web, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import '/src/i18n/index.ts';
import {startCloud,flushCloud,readRecordKeys,reconcileLearningProjection,refreshRecordScope,useCloudSync} from '/src/cloud/sync.ts';
import {db} from '/src/store/db.ts';import {cloud} from '/src/cloud/state.ts';
import {serverRuntime} from '/src/client/bootstrap.ts';import {loadCollection} from '/src/client/collections.ts';
import {queueLearning,learningEdit,drainLearning} from '/src/client/learning.ts';
import {invalidateAccountLifetime} from '/src/client/account-lifecycle.ts';
import {refreshTaskScope} from '/src/cloud/tasks.ts';
import React from 'react';import {createRoot} from 'react-dom/client';
import {useCourseCollection} from '/src/components/useCourseCollection.tsx';
await startCloud(window.owner); const runtime=await serverRuntime(window.owner);
let viewRoot;function View(){const scope=useCourseCollection('cards','course');return React.createElement('section',null,
  React.createElement('output',{id:'view-state','data-ready':String(scope.ready)},String(scope.rows.length)),
  scope.error&&React.createElement('button',{id:'view-retry','data-error':scope.error,onClick:scope.reload},'retry'));}
window.probe={flush:flushCloud,rows:()=>loadCollection('cards','course'),read:keys=>readRecordKeys('cards',keys),
  openView:()=>{const target=document.createElement('div');document.body.append(target);viewRoot=createRoot(target);viewRoot.render(React.createElement(View));},
  counts:async()=>({chats:await db.chats.count(),cards:await db.cards.count(),segments:await db.segments.count()}),
  commands:()=>db.table('_learningCommands').toArray(),meta:key=>db.table('_cloudMeta').get(key),
  stage:async(id,status)=>{await queueLearning([learningEdit({kind:'reviewCard',courseId:'course',cardId:1,expected:status,status:status===0?1:0})],['card:1'],id);},
  drain:drainLearning,head:()=>runtime.read({kind:'recordHead'}),revision:()=>useCloudSync.getState().recordsRevision,
  fallback:()=>refreshTaskScope({id:'fallback',kind:'cards',resource:'course:course',input:{videoId:'course'},status:'done',progress:null,result:null,error:null,createdAt:''}),
  putEvidence:()=>db.table('_cloudMeta').put({id:'private-draft-evidence',value:'ORIGINAL_USER_INTENT'}),
  legacyReceipt:async()=>{const original=(await db.table('_learningCommands').toArray())[0];const legacy={...original,operationId:'legacy-unversioned-receipt',state:'confirmed'};delete legacy.sequence;delete legacy.receipt.epoch;await db.table('_learningCommands').add(legacy);await drainLearning();},
  invalidate:()=>{invalidateAccountLifetime();cloud.enabled=false;cloud.userId='';},diagnostics:()=>runtime.diagnostics()};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'account-demand', resolveId: id => id === '/__account-demand.js' ? '\0account-demand' : undefined,
      load: id => id === '\0account-demand' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__account-demand') return next(); res.setHeader('content-type', 'text/html'); res.end('<body><script type="module" src="/__account-demand.js"></script></body>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext();
  const password = 'account-demand-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  const card = (id, q = `Card ${id}`) => ({ id, videoId: 'course', q, a: 'Answer', time: id, status: 0, createdAt: id });
  store.transaction(() => {
    put('videos', 'course', { id: 'course', name: 'Course', status: 'transcribed' });
    for (let id = 1; id <= 121; id++) put('cards', id, card(id));
    for (let id = 1; id <= 10000; id++) put('chats', id, { id, sessionId: 999, role: 'user', content: 'UNOPENED_PRIVATE_BODY'.repeat(50), createdAt: id });
  });
  await context.addInitScript(owner => { window.owner = owner; window.unhandled = []; addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason))); }, owner);
  const page = await context.newPage(); page.setDefaultTimeout(45000);
  let rejectKeys = false, rejectCollections = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), body = request.postData() ?? '';
    if (/recordsPage|watchRecords/.test(request.url()) || body.includes('"kind":"records"')) { evidence.globalReads.push(request.url()); return route.abort(); }
    if (rejectKeys && body.includes('"kind":"recordKeys"')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"injected_projection_outage"}' });
    if (rejectCollections && body.includes('"kind":"collectionPage"')) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"injected_collection_outage"}' });
    return route.continue();
  });
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postData() }); });
  page.on('response', async response => { if (response.url().includes('/api/')) { try { if ((await response.text()).includes('UNOPENED_PRIVATE_BODY')) evidence.leaks.push(response.url()); } catch {} } });
  page.on('websocket', socket => {
    socket.on('framesent', frame => { if (/watchRecords|"kind":"records"/.test(String(frame.payload))) evidence.globalReads.push(String(frame.payload).slice(0, 200)); });
    socket.on('framereceived', frame => { if (String(frame.payload).includes('UNOPENED_PRIVATE_BODY')) evidence.leaks.push('WS'); });
  });
  await page.goto(origin + '/__account-demand'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 90000 });
  assert.deepEqual(await page.evaluate(() => probe.counts()), { chats: 0, cards: 0, segments: 0 });
  await page.evaluate(() => probe.flush());
  assert.deepEqual(await page.evaluate(() => probe.counts()), { chats: 0, cards: 0, segments: 0 });
  evidence.checks.push('real cold startCloud + explicit flushCloud transfer zero business rows despite 10k unrelated messages');

  assert.equal(await page.evaluate(async () => (await probe.rows()).length), 121);
  assert.equal(await page.evaluate(async () => (await probe.counts()).cards), 0);
  await page.evaluate(() => probe.openView());
  await page.waitForFunction(() => document.querySelector('#view-state')?.dataset.ready==='true' && document.querySelector('#view-state')?.textContent==='121');
  put('cards', 121, { ...card(121), q: 'x'.repeat(17 * 1024 * 1024) });
  await page.locator('#view-retry').waitFor();
  assert.equal(await page.locator('#view-state').textContent(), '121');
  assert.equal(await page.locator('#view-state').getAttribute('data-ready'), 'false');
  rejectCollections = true;
  put('cards', 121, card(121));
  await page.waitForFunction(() => /503|injected_collection_outage/.test(document.querySelector('#view-retry')?.dataset.error??''));
  rejectCollections = false;
  await page.locator('#view-retry').click();
  await page.waitForFunction(() => document.querySelector('#view-state')?.dataset.ready==='true');
  evidence.checks.push('real React scope hook fails visibly on oversized collection, retains previous complete rows as not-ready, and explicit retry recovers');
  await page.evaluate(() => probe.read([1]));
  assert.equal(await page.evaluate(async () => (await probe.counts()).cards), 1);
  const operation = crypto.randomUUID(); await page.evaluate(id => probe.stage(id, 0), operation);
  rejectKeys = true; assert.match(await page.evaluate(async () => { try { await probe.drain(); return 'unexpected'; } catch (error) { return String(error); } }), /503|injected_projection_outage/);
  assert.equal((await page.evaluate(() => probe.commands()))[0].state, 'confirmed');
  rejectKeys = false; await page.evaluate(() => probe.drain());
  assert.equal((await page.evaluate(() => probe.commands())).length, 0);
  assert.equal(records.get(owner, 'cards', 1).status, 1);
  evidence.checks.push('explicit 121-row collection walk stays out of IDB; exact read hydrates one key; failed receipt read retains journal and retry retires only after exact atomic publication');

  await page.evaluate(() => probe.fallback());
  assert.equal(await page.evaluate(async () => (await probe.counts()).cards), 121);
  put('cards', 121, null); await page.evaluate(() => probe.fallback());
  assert.equal(await page.evaluate(async () => (await probe.counts()).cards), 120);
  evidence.checks.push('missing/overflow task fallback explicitly refreshes named course, including remote tombstone; no account feed');

  await page.evaluate(() => probe.putEvidence());
  const oldOperation = crypto.randomUUID(); await page.evaluate(id => probe.stage(id, 1), oldOperation);
  rejectKeys = true; await page.evaluate(async () => { try { await probe.drain(); } catch {} }); rejectKeys = false;
  const oldEpoch = (await page.evaluate(() => probe.head())).value.epoch;
  store.db.prepare('UPDATE app_state SET value=? WHERE key=?').run('account-demand-reset', 'records-epoch');
  await page.evaluate(() => probe.flush());
  assert.notEqual((await page.evaluate(() => probe.head())).value.epoch, oldEpoch);
  assert.equal((await page.evaluate(() => probe.commands()))[0].state, 'conflict');
  assert.equal((await page.evaluate(() => probe.meta('private-draft-evidence'))).value, 'ORIGINAL_USER_INTENT');
  assert.deepEqual(await page.evaluate(() => probe.counts()), { chats: 0, cards: 0, segments: 0 });
  assert.equal(await page.evaluate(async () => (await probe.read([1]))[0].status), 0);
  await page.evaluate(() => probe.legacyReceipt());
  assert.equal((await page.evaluate(() => probe.commands())).length, 2);
  assert.ok((await page.evaluate(() => probe.commands())).every(command => command.state === 'conflict'));
  await page.evaluate(() => probe.read([2]));
  store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='cards' AND record_key='2'").run(owner);
  assert.equal(await page.evaluate(async () => (await probe.read([2]))[0] === undefined), true);
  evidence.checks.push('physical missing key at revision zero removes its stale exact projection only behind unchanged-head/publication barriers');
  evidence.checks.push('epoch reset invalidates disposable projections, preserves old confirmed intent as conflict and retains private recovery evidence; new exact read recovers');

  await context.setOffline(true); await context.setOffline(false);
  await page.evaluate(() => probe.flush());
  assert.equal(await page.evaluate(async () => (await probe.counts()).chats), 0);
  const logout = await context.request.post(origin + '/api/v1/auth/logout'); assert.equal(logout.ok(), true);
  await page.evaluate(() => probe.invalidate());
  await page.waitForFunction(() => probe.diagnostics().models.every(model => model.refs === 0 && !model.active));
  await page.waitForFunction(() => document.querySelector('#view-state')?.textContent==='0');
  assert.equal((await page.evaluate(() => probe.commands())).length, 2);
  assert.deepEqual(await page.evaluate(() => window.unhandled), []);
  assert.deepEqual(evidence.errors, []); assert.deepEqual(evidence.leaks, []); assert.deepEqual(evidence.globalReads, []);
  evidence.checks.push('offline/online explicit recovery transfers no unused bodies; authenticated logout + lifetime invalidation releases observations without deleting journal');
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ ...evidence, passed: true }, null, 2));
  console.log(`PASS account demand ${evidence.browser}: ${directory}`, evidence.checks);
} catch (error) { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ ...evidence, error: String(error) }, null, 2)); throw error; }
finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
