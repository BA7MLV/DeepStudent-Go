/** Real components + API + IDB with no startCloud. Display metadata adapter
 * evidence only, not production startup, directory pagination or offline UI. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/course-metadata-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], requests: [], errors: [], leaks: [] };
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {MemoryRouter,Routes,Route} from 'react-router-dom';
import FolderPlanCard from '/src/components/FolderPlanCard.tsx';import {ResourceFileIcon} from '/src/components/ResourceFileIcon.tsx';
import Player from '/src/pages/Player.tsx';import {captureCourseAccess} from '/src/client/course-access.ts';
import {cloud} from '/src/cloud/state.ts';import {db,useCloudDatabase} from '/src/store/db.ts';import {markCloudApply} from '/src/cloud/cache.ts';
import {serverRuntime} from '/src/client/bootstrap.ts';import {invalidateAccountLifetime} from '/src/client/account-lifecycle.ts';
import '/src/theme.css';import '/src/i18n/index.ts';
cloud.enabled=true;cloud.userId=window.owner;useCloudDatabase(window.owner);await db.open();
await db.transaction('rw',db.videos,async()=>{markCloudApply();await db.videos.bulkPut([{id:'course-0',name:'STALE_LOCAL_NAME'}, {id:'ghost',name:'STALE_GHOST'}, {id:'icon-course',name:'Old material',kind:'material'}]);});
const courseAccess=captureCourseAccess();
const runtime=await serverRuntime(window.owner),handles=[];const factory=runtime.courseMetadata;runtime.courseMetadata=(...args)=>{const h=factory(...args);handles.push(h);return h;};
const plan={summary:'Fixture plan',applied:0,folders:[{name:'First',courseIds:Array.from({length:60},(_,i)=>'course-'+i)},{name:'Last',courseIds:['course-60','ghost']}]};
const icon=(id)=>React.createElement(ResourceFileIcon,{entry:{kind:'file',projectId:'fixture',path:'/lecture',name:'Lecture',courseId:id,revision:1}});
let mount;window.confirmations=0;
function App(){const [shown,setShown]=useState(true);mount=setShown;return React.createElement(MemoryRouter,{initialEntries:['/player/player-fixture']},shown==='player'?React.createElement(Routes,null,React.createElement(Route,{path:'/player/:id',element:React.createElement(Player)})):shown?React.createElement(React.Fragment,null,
React.createElement('div',{'data-testid':'visible-icon'},icon('icon-course')),
React.createElement(FolderPlanCard,{plan,active:true,onConfirm:()=>window.confirmations++,onCancel:()=>{}}),
React.createElement('div',{style:{marginTop:10000},'data-testid':'offscreen-icon'},icon('offscreen-course'))):null);}
const root=createRoot(document.getElementById('root'));root.render(React.createElement(App));
window.probe={mount:shown=>mount(shown),invalid:invalidateAccountLifetime,handles:()=>handles.map(h=>h.model.diagnostics()),count:()=>db.videos.count(),runtime:()=>runtime.diagnostics(),
readCourse:id=>courseAccess.read(id),savePlayback:(id,position)=>courseAccess.recordPlayback(id,position),
commands:()=>db.table('_cloudMeta').where('id').startsWith('resource-command:').toArray()};document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'course-metadata-fixture', resolveId: id => id === '/__course-metadata-entry.js' ? '\0course-metadata' : undefined,
    load: id => id === '\0course-metadata' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__course-metadata') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__course-metadata-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
  const password = 'course-metadata-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } }); const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files')); const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  for (let i = 0; i < 61; i++) put('videos', `course-${i}`, { id: `course-${i}`, name: `Authoritative course ${i}`, privateBody: 'UNREQUESTED_COURSE_BODY'.repeat(1000) });
  put('videos', 'icon-course', { id: 'icon-course', name: 'Extensionless video', privateBody: 'UNREQUESTED_ICON_BODY' });
  put('videos', 'offscreen-course', { id: 'offscreen-course', name: 'OFFSCREEN_METADATA_NOT_REQUESTED' });
  put('videos', 'player-fixture', { id: 'player-fixture', name: 'Authoritative player course', status: 'new', mimeType: 'video/mp4', duration: 120, lastPosition: 37, size: 10, createdAt: 1 });
   const upload = async (name, data) => {
    const response = await context.request.post(origin + '/api/v1/files', { headers: { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': 'image/png' },
      data: data ?? Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJX8AAAAASUVORK5CYII=', 'base64') });
    assert.equal(response.status(), 201); return (await response.json()).id;
  };
  const firstFile = await upload('first.png'), secondFile = await upload('second.png');
  put('covers', 'icon-course', { videoId: 'icon-course', source: 'user', blob: { $file: firstFile, type: 'image/png' }, privateBody: 'UNREQUESTED_COVER_BODY' });
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', req => { if (new URL(req.url()).pathname.startsWith('/api/')) evidence.requests.push({ path: new URL(req.url()).pathname, body: req.postData() }); });
  page.on('websocket', socket => socket.on('framereceived', frame => { if (/UNREQUESTED_|OFFSCREEN_METADATA_NOT_REQUESTED/.test(String(frame.payload))) evidence.leaks.push(String(frame.payload).slice(0, 200)); }));
  await page.goto(origin + '/__course-metadata'); await page.locator('body[data-ready="yes"]').waitFor({ state: 'attached', timeout: 60000 });
  await expect(page.getByTestId('plan-card')).toContainText('Authoritative course 0');
  await expect(page.getByTestId('plan-card')).toContainText('Authoritative course 60');
  await expect(page.getByTestId('plan-folder-unknown')).toHaveCount(1);
  await expect(page.getByTestId('plan-folder-unknown')).toContainText('1');
  await expect(page.getByTestId('plan-confirm')).toBeEnabled();
  await expect(page.getByTestId('visible-icon').locator('img')).toHaveAttribute('src', `/api/v1/files/${firstFile}`);
  await expect(page.getByTestId('visible-icon')).toContainText('VIDEO');
  assert.equal(await page.evaluate(() => probe.count()), 3, 'metadata does not promote partial videos/cover records into IDB');
  assert.equal(evidence.requests.some(req => req.body?.includes('offscreen-course')), false);
  evidence.checks.push('real folder card resolves 61 remote courses beyond one page despite stale/absent IDB, distinguishes one missing ID, shows authoritative extensionless video/cover; offscreen icon requests no metadata, partial DTOs never enter IDB');
  put('videos', 'course-0', { id: 'course-0', name: 'Renamed remotely' });
  put('covers', 'icon-course', { videoId: 'icon-course', source: 'user', blob: { $file: secondFile, type: 'image/png' } });
  await expect(page.getByTestId('plan-card')).toContainText('Renamed remotely');
  await expect(page.getByTestId('visible-icon').locator('img')).toHaveAttribute('src', `/api/v1/files/${secondFile}`);
  put('videos', 'course-60', null);
  await expect(page.getByTestId('plan-folder-unknown')).toHaveCount(1);
  await expect(page.getByTestId('plan-folder-unknown')).toContainText('2');
  evidence.checks.push('external exact-key rename/cover replacement/tombstone revalidate retained views without a global records or collection feed');

  put('videos', 'course-0', { id: 'course-0', name: 'x'.repeat(512 * 1024) });
  await page.getByTestId('plan-metadata-error').waitFor();
  await expect(page.getByTestId('plan-confirm')).toBeDisabled();
  await expect(page.getByTestId('plan-folder-unknown')).toHaveCount(0);
  put('videos', 'course-0', { id: 'course-0', name: 'Repaired course' });
  await page.getByTestId('plan-metadata-error').getByRole('button').click();
  await expect(page.getByTestId('plan-card')).toContainText('Repaired course');
  await expect(page.getByTestId('plan-confirm')).toBeEnabled();
  evidence.checks.push('real server metadata byte-budget failure is not reported as deletion, disables confirmation, preserves server rows and explicitly retries after repair');
  await page.screenshot({ path: path.join(directory, 'desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await page.screenshot({ path: path.join(directory, 'mobile.png') });
  const colorPng = await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#237cc2'; ctx.fillRect(0, 0, 32, 32);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const colorFile = await upload('color.png', Buffer.from(colorPng, 'base64'));
  for (let id = 0; id < 120; id++) put('frames', 900000 + id, { id: 900000 + id, videoId: 'player-fixture', ts: id, kind: id === 80 ? 'slide' : 'scene',
    blob: { $file: id === 80 ? colorFile : firstFile, type: 'image/png' }, privateBody: 'UNREQUESTED_COLOR_FRAME_BODY'.repeat(100) });
  const requestsBeforePlayer = evidence.requests.length;
  await page.evaluate(() => probe.mount('player'));
  await expect(page.locator('.page-player')).toContainText('Authoritative player course');
  await expect(page.getByTestId('player-skeleton')).toHaveCount(0);
  await expect(page.locator('.page-player')).toHaveAttribute('data-dyn-color', 'on');
  assert.equal(evidence.requests.slice(requestsBeforePlayer).filter(req => req.path === `/api/v1/files/${colorFile}`).length, 1);
  assert.equal(await page.evaluate(async () => (await import('/src/store/db.ts')).db.frames.count()), 0, 'colour metadata does not publish full frames to IDB');
  assert.equal((await page.evaluate(() => probe.readCourse('player-fixture'))).lastPosition, 37);
  put('videos', 'player-fixture', { ...records.get(owner, 'videos', 'player-fixture'), lastPosition: 68 });
  assert.equal((await page.evaluate(() => probe.readCourse('player-fixture'))).lastPosition, 68, 'resume reads fresh remote progress, not an old IDB baseline');
  assert.equal(evidence.requests.slice(requestsBeforePlayer).some(req => /"kind":"(?:records|collectionPage)"/.test(req.body ?? '') || /recordsPage/.test(req.path)), false);
  evidence.checks.push('actual Player opens a remotely present course absent from IDB without startCloud; resume reads fresh remote progress; dynamic colour uses one slide-first file from 120 remote frames, paints the page, and publishes no frame bodies to IDB');
  await page.evaluate(() => probe.mount(false));
  await expect.poll(() => page.evaluate(() => probe.handles().every(h => h.refs === 0 && h.listeners === 0 && !h.active))).toBe(true);
  await page.evaluate(() => probe.mount(true)); await expect(page.getByTestId('plan-confirm')).toBeEnabled();
  await page.evaluate(() => { probe.invalid(); document.querySelector('[data-testid="plan-confirm"]').click(); });
  assert.equal(await page.evaluate(() => window.confirmations), 0, 'same-turn stale confirmation must never be submitted');
  await expect(page.getByTestId('plan-confirm')).toBeDisabled();
  await expect(page.getByTestId('visible-icon').locator('img')).toHaveCount(0);
  const handlesAfterDisposal = await page.evaluate(() => probe.handles().length);
  // Force another mounted render/viewport turn. Terminal disposal is not just
  // a transient loading state that may reopen an authenticated observation.
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await page.evaluate(() => probe.handles().length), handlesAfterDisposal);
  await expect(page.getByTestId('plan-confirm')).toBeDisabled();
  assert.ok((await page.evaluate(() => probe.handles())).every(h => h.refs === 0 && h.listeners === 0 && !h.active));
  const oldCommands = await page.evaluate(() => probe.commands());
  const oldPlayback = await page.evaluate(() => probe.savePlayback('player-fixture', 88).then(()=>'WRONGLY_ACCEPTED',error=>error.message));
  assert.equal(oldPlayback, 'client_account_changed');
  assert.deepEqual(await page.evaluate(() => probe.commands()), oldCommands, 'late playback callback never creates a new-account resource command');
  assert.equal(evidence.requests.some(req => /"kind":"(?:records|collectionPage)"/.test(req.body ?? '') || /recordsPage/.test(req.path)), false);
  assert.deepEqual(evidence.leaks, []); assert.deepEqual(evidence.errors, []);
  evidence.checks.push('unmount/remount and terminal account invalidation release all model refs/listeners; same-turn confirmation rejected and cover cleared; no global/collection records requests or unrequested bodies on WS; selected Player video key is explicit');
  evidence.passed = true; console.log(`PASS course metadata (${evidence.browser}): ${directory}`, evidence.checks);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); store?.close(); await app.close();
}
