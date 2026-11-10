/** Real SubtitlePanel/API without startCloud. Domain evidence, not production startup/scale. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/subtitle-demand-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], errors: [], requests: [], leaks: [] };
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import SubtitlePanel from '/src/components/SubtitlePanel.tsx';import {cloud} from '/src/cloud/state.ts';
import {db,useCloudDatabase} from '/src/store/db.ts';import {serverRuntime} from '/src/client/bootstrap.ts';
import {invalidateAccountLifetime} from '/src/client/account-lifecycle.ts';import {saveImportedSubtitles} from '/src/store/subtitles.ts';
import '/src/theme.css';import '/src/i18n/index.ts';
cloud.enabled=true;cloud.userId=window.owner;useCloudDatabase(window.owner);await db.open();
const runtime=await serverRuntime(window.owner),handles=[];const factory=runtime.courseSubtitlePages;
runtime.courseSubtitlePages=(...args)=>{const h=factory(...args);handles.push(h);return h;};
let select;const ref={current:null};let latest=[];const change=cues=>{latest=cues;};let loaded=false;const load=value=>{loaded=value;};
function App(){const [id,setId]=useState('course');select=setId;return React.createElement(SubtitlePanel,{videoId:id,playerRef:ref,playbackSource:'',followPlayback:false,onSegmentsChange:change,onLoadedChange:load});}
const root=createRoot(document.getElementById('root'));root.render(React.createElement(App));
window.probe={select:id=>select(id),latest:()=>latest,loaded:()=>loaded,count:async()=>({segments:await db.segments.count(),tracks:await db.subtitleTracks.count()}),
handles:()=>handles.map(h=>[h.segments,h.tracks,h.course].map(m=>m.diagnostics())),invalidate:invalidateAccountLifetime,
import:()=>saveImportedSubtitles('course',{primary:{lan:'zh',lanDoc:'中文',cues:[{start:0,end:1,text:'Imported subtitle'}]},tracks:[]}),stop:()=>root.unmount()};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'subtitle-demand', resolveId: id => id === '/__subtitle-entry.js' ? '\0subtitle-demand' : undefined,
      load: id => id === '\0subtitle-demand' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__subtitle') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__subtitle-entry.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const password = 'subtitle-demand-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } }), owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  const segment = (id, text = `Complete subtitle ${id}`, videoId = 'course') => ({ id, videoId, idx: id, start: id * 2, end: id * 2 + 1, status: 1, text });
  put('videos', 'course', { id: 'course', name: 'Course', status: 'transcribed' });
  put('videos', 'empty', { id: 'empty', name: 'Empty', status: 'new' });
  store.transaction(() => {
    for (let id = 1; id <= 121; id++) put('segments', id, segment(id));
    put('subtitleTracks', 1, { id: 1, videoId: 'course', lang: 'en', lanDoc: 'English', cues: [{ start: 2, end: 3, text: 'Complete translation' }] });
    for (let id = 1; id <= 1000; id++) put('segments', 10000 + id, segment(10000 + id, 'UNRELATED_SUBTITLE_BODY', 'unrelated'));
  });
  await context.addInitScript(owner => { window.owner = owner; window.unhandled=[];addEventListener('unhandledrejection',event=>window.unhandled.push(String(event.reason))); }, owner);
  const page = await context.newPage();page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'warning' || message.type() === 'error') evidence.console = [...(evidence.console ?? []), message.text()]; });
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postData() }); });
  page.on('websocket', socket => socket.on('framereceived', frame => { if (String(frame.payload).includes('UNRELATED_SUBTITLE_BODY')) evidence.leaks.push(String(frame.payload).slice(0, 200)); }));
  await page.goto(origin + '/__subtitle');await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  await expect(page.getByTestId('subs-row')).toHaveCount(121);
  await page.waitForFunction(() => probe.loaded());
  assert.equal(await page.evaluate(() => probe.latest().length), 121);
  assert.deepEqual(await page.evaluate(() => probe.count()), { segments: 0, tracks: 0 });
  const downloadEvent = page.waitForEvent('download');await page.getByTestId('subs-download-srt').click();const download = await downloadEvent;
  const exported = fs.readFileSync(await download.path(), 'utf8');assert.ok(exported.includes('Complete subtitle 1'));assert.ok(exported.includes('Complete subtitle 121'));
  evidence.checks.push('121 authoritative segments cross 3 bounded pages; IDB remains empty; full SRT includes first and last segment');

  put('segments', 121, segment(121, 'Complete subtitle 122'));
  await expect(page.getByTestId('subs-row').last()).toContainText('Complete subtitle 122');
  await page.evaluate(() => probe.import());
  await expect(page.getByTestId('subs-row')).toHaveCount(1);await expect(page.getByTestId('subs-row')).toContainText('Imported subtitle');
  evidence.checks.push('exact collection invalidation updates a non-head row; real subtitle import atomically replaces display without global flush');

  // Corrupt only the current collection so watch fails in the actual server.
  const old = records.get(owner, 'segments', store.db.prepare("SELECT CAST(record_key AS INTEGER) id FROM cloud_records WHERE owner_id=? AND table_name='segments' AND value IS NOT NULL AND json_extract(value,'$.videoId')='course'").get(owner).id);
  const huge = { ...old, text: 'x'.repeat(16 * 1024 * 1024 + 1) };
  put('segments', old.id, huge);
  await page.getByTestId('subs-load-retry').waitFor();
  await expect(page.getByTestId('subs-row')).toContainText('Imported subtitle');
  assert.equal(await page.evaluate(() => probe.loaded()), false);
  assert.equal(await page.getByTestId('subs-empty').count(), 0);
  put('segments', old.id, { ...old, text: 'Repaired subtitle' });
  await page.getByTestId('subs-load-retry').click();
  await expect(page.getByTestId('subs-row')).toContainText('Repaired subtitle');await page.waitForFunction(() => probe.loaded());
  evidence.checks.push('real domain budget failure retains previous complete text, stays not-ready/not-empty, and actual retry recovers');

  await page.evaluate(() => probe.select('empty'));await page.getByTestId('subs-empty').waitFor();
  await page.waitForFunction(() => probe.handles()[0].every(model=>model.refs===0&&!model.active&&model.listeners===0));
  await page.evaluate(() => probe.invalidate());
  await page.waitForFunction(() => probe.handles().flat().every(model=>model.refs===0&&!model.active&&model.listeners===0));
  assert.equal(await page.getByTestId('subs-row').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.unhandled), []);assert.deepEqual(evidence.errors, []);assert.deepEqual(evidence.leaks, []);
  assert.equal(evidence.requests.some(request => /recordsPage|watchRecords/.test(request.path) || request.body?.includes('"kind":"records"')), false);
  evidence.checks.push('course switch and account invalidation release all 3 observations/body snapshots; zero unrelated bodies/global records reads or unhandled errors');
  await page.screenshot({ path: path.join(directory, 'subtitle.png') });
  evidence.passed = true;fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS subtitle demand ${evidence.browser}: ${directory}`, evidence.checks);
} catch (error) { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ ...evidence, error: String(error) }, null, 2)); throw error; }
finally { await browser?.close();await web?.close();store?.close();await app.close(); }
