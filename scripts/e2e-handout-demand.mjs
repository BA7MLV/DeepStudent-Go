/** Real API + HandoutPanel source modules, no startCloud/global baseline. This
 * proves the domain adapter only, not production startup/scale/offline behavior. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';
import { buildHandoutDocx } from '../packages/study-core/src/handout/docx.ts';
import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/handout-demand-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { parseHandoutPersist, handoutEditBaseline } = await import('../apps/api/src/cloud/handout-edit.ts');
const { CloudTaskRunner } = await import('../apps/api/src/cloud/tasks.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], requests: [], errors: [], wireLeaks: [] };
let web, browser, store, runner;
try {
  // This private executor build never overwrites the shared production dist.
  fs.symlinkSync(path.resolve('node_modules'), path.join(directory, 'node_modules'), 'dir');
  await build({ entryPoints: ['apps/api/runtime/node.ts', 'apps/api/runtime/image-process.ts'], outdir: path.join(directory, 'runtime'), outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external' });
  const { executeNodeTask } = await import(pathToFileURL(path.join(directory, 'runtime/node.mjs')).href);
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import HandoutPanel from '/src/components/HandoutPanel.tsx';
import {FeedbackHost} from '/src/ui/feedback.tsx';
import {cloud} from '/src/cloud/state.ts';
import {db,useCloudDatabase} from '/src/store/db.ts';
import {markCloudApply} from '/src/cloud/cache.ts';
import {serverRuntime} from '/src/client/bootstrap.ts';
import {invalidateAccountLifetime} from '/src/client/account-lifecycle.ts';
import '/src/theme.css'; import '/src/i18n/index.ts';
cloud.enabled=true; cloud.userId=window.owner; useCloudDatabase(window.owner); await db.open();
await db.transaction('rw',db.handouts,async()=>{markCloudApply();await db.handouts.put({id:50121,videoId:'handout-course',createdAt:1,title:'stale IDB document',outlineJson:'{}',sectionsJson:'[]',blob:{$file:'stale-file'}});});
const runtime=await serverRuntime(window.owner);
const handles=[];const latestHandout=runtime.latestHandout;runtime.latestHandout=id=>{const handle=latestHandout(id);handles.push(handle);return handle;};
let select;
function App(){const [id,setId]=useState('handout-course');select=setId;return React.createElement(React.Fragment,null,React.createElement(FeedbackHost),React.createElement(HandoutPanel,{videoId:id,hasSubtitles:true}));}
const root=createRoot(document.getElementById('root')); root.render(React.createElement(App));
window.probe={select:id=>select(id),latest:async id=>(await runtime.read({kind:'latestHandout',videoId:id})).value,
count:()=>db.handouts.count(),commands:()=>db.table('_cloudMeta').where('id').startsWith('task-command:').toArray(),draft:id=>db.table('_cloudMeta').get('handout-edit-draft:'+id),
handles:()=>handles.map(handle=>handle.model.diagnostics()),invalidate:invalidateAccountLifetime,stop:()=>root.unmount()};document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'handout-demand-fixture', resolveId: id => id === '/__handout-entry.js' ? '\0handout-demand' : undefined,
    load: id => id === '\0handout-demand' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__handout') return next(); res.setHeader('content-type', 'text/html'); res.end('<style>#root{height:900px}</style><div id="root"></div><script type="module" src="/__handout-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1200, height: 1000 }, acceptDownloads: true });
  const password = 'handout-demand-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  runner = new CloudTaskRunner(store, { records, configuration: new CloudConfiguration(store, path.join(directory, 'config')), filesDir: path.join(directory, 'files'),
    fetch: async () => { throw new Error('manual_edit_must_not_call_model'); }, executors: { node: context => {
      assert.equal(context.task.kind, 'handoutEdit'); assert.equal(context.task.input.action, 'persist');
      return executeNodeTask(context);
    } } });
  runner.start(api);
  const put = (table, value) => {
    const key = value.id ?? value.videoId;
    records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
      baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  };
  const sections = [{ heading: 'Selected server section', blocks: [{ type: 'para', text: 'Complete authoritative content.' }, { type: 'figure', ts: 12.5, caption: 'Only referenced frame' }] }];
  const docx = Buffer.from(await (await buildHandoutDocx({ title: 'Server handout', courseName: 'Server course', date: '2026-11-10', summary: 'Server summary', sections, images: new Map() })).arrayBuffer());
  const upload = async (bytes, name, type) => {
    const response = await context.request.post(origin + '/api/v1/files', { headers: { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': type }, data: bytes });
    assert.equal(response.status(), 201, await response.text()); return (await response.json()).id;
  };
  const docFile = await upload(docx, 'selected.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJX8AAAAASUVORK5CYII=', 'base64');
  const frameFile = await upload(imageBytes, 'frame.png', 'image/png');
  const unusedFile = await upload(Buffer.from('unreferenced-file-original'), 'unused.txt', 'text/plain');
  put('videos', { id: 'handout-course', name: 'Server course', createdAt: 1, size: 1, duration: 30, status: 'transcribed' });
  put('videos', { id: 'empty-course', name: 'Empty course', createdAt: 2, size: 1, duration: 30, status: 'transcribed' });
  put('videos', { id: 'save-course', name: 'Save course', createdAt: 3, size: 1, duration: 30, status: 'transcribed', fileDeleted: true });
  put('handouts', { id: 67000, videoId: 'save-course', createdAt: 3, title: 'Successful manual edit', blob: { $file: docFile }, outlineJson: JSON.stringify({ summary: 'Editable summary' }),
    sectionsJson: JSON.stringify([{ heading: 'Complete section', blocks: [{ type: 'para', text: 'Complete retained paragraph' }] }]) });
  for (let index = 1; index <= 121; index++) put('handouts', { id: 50000 + index, videoId: 'handout-course', createdAt: index, title: index === 121 ? 'Server handout' : `historic-document-${index}`,
    blob: { $file: docFile }, outlineJson: JSON.stringify({ summary: index === 121 ? 'Server summary' : `UNRELATED_HISTORY_BODY_${index}` }),
    sectionsJson: index === 121 ? JSON.stringify(sections) : '[]' });
  for (let id = 1; id <= 61; id++) put('frames', { id: 80000 + id, videoId: 'handout-course', ts: id === 61 ? 12.5 : id + 100, kind: 'slide', blob: { $file: id === 61 ? frameFile : unusedFile }, caption: id === 61 ? 'reference-caption-not-requested' : 'UNRELATED_FRAME_BODY' });
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postData() }); });
  page.on('websocket', socket => socket.on('framereceived', frame => { if (/UNRELATED_HISTORY_BODY|UNRELATED_FRAME_BODY|reference-caption-not-requested/.test(String(frame.payload))) evidence.wireLeaks.push(String(frame.payload).slice(0, 200)); }));
  await page.goto(origin + '/__handout'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  await expect(page.getByTestId('handout-doc')).toContainText('Server summary');
  await expect(page.getByTestId('handout-doc')).toContainText('Server course');
  assert.equal(await page.evaluate(() => probe.count()), 1, 'selected projection does not promote a partial catalog into IDB');
  const selected = await page.evaluate(() => probe.latest('handout-course'));
  assert.equal(selected.record.key, 50121); assert.deepEqual(selected.media.frames, [{ ts: 12.5, blob: { $file: frameFile } }]);
  assert.ok(JSON.stringify(selected).length < 4096);
  await expect(page.getByTestId('handout-doc').locator('img')).toHaveAttribute('src', `/api/v1/files/${frameFile}`);
  assert.equal(evidence.requests.some(item => item.path.endsWith('/' + unusedFile)), false);
  const downloadWait = page.waitForEvent('download'); await page.getByTestId('handout-export').click();
  const download = await downloadWait; const saved = path.join(directory, download.suggestedFilename()); await download.saveAs(saved);
  assert.deepEqual(fs.readFileSync(saved), docx, 'export keeps the complete original DOCX bytes');
  evidence.checks.push('real panel selects latest of 121 complete versions despite stale IDB; only one referenced frame metadata (no caption/unreferenced body) and course title; actual export bytes equal complete server DOCX');
  await page.evaluate(() => probe.select('empty-course'));
  await expect(page.getByTestId('handout-empty')).toBeVisible();
  await expect(page.getByTestId('handout-doc')).toHaveCount(0);
  put('handouts', { ...records.get(owner, 'handouts', 50121), title: 'Old course changed while detached' });
  assert.equal((await page.evaluate(() => probe.handles())).filter(handle => handle.active).length, 1);
  await page.evaluate(() => probe.select('handout-course'));
  await expect(page.getByTestId('handout-doc')).toContainText('Server summary');
  const indexSql = store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='cloud_records_handout_latest'").get().sql;
  store.db.exec('DROP INDEX cloud_records_handout_latest');
  const original = records.get(owner, 'handouts', 50121);
  put('handouts', { ...original, title: 'Remote updated title' });
  await page.getByTestId('handout-read-error').waitFor();
  await expect(page.getByTestId('handout-doc')).toContainText('Server summary');
  await expect(page.getByTestId('handout-export')).toBeDisabled();
  await expect(page.getByTestId('handout-empty')).toHaveCount(0);
  store.db.exec(indexSql);
  await page.getByTestId('handout-read-error').getByRole('button').click();
  await expect(page.getByTestId('handout-doc')).toContainText('Remote updated title');
  await expect(page.getByTestId('handout-export')).toBeEnabled();
  evidence.checks.push('course switching never displays another course document as empty/current; real SQL read failure retains prior document, disables export, has explicit retry and recovers authoritative title');
  const summaryBlock = page.locator('[data-hd-anchor="sum"]'); await summaryBlock.hover();
  await summaryBlock.locator('.hd-hover-actions .hd-act-edit').click();
  const edit = page.getByTestId('handout-edit-input').locator('textarea');
  await edit.fill('USER UNSAVED SUMMARY');
  put('handouts', { ...records.get(owner, 'handouts', 50121), outlineJson: JSON.stringify({ summary: 'Concurrent committed summary' }) });
  put('handouts', { ...original, id: 50122, createdAt: 122, title: 'Newly generated document' });
  await expect.poll(() => page.evaluate(async () => (await probe.latest('handout-course')).record.key)).toBe(50122);
  await expect(page.locator('[data-handout-latest-id]')).toHaveAttribute('data-handout-latest-id', '50122');
  await expect(page.locator('[data-handout-id]')).toHaveAttribute('data-handout-id', '50121');
  await expect(edit).toHaveValue('USER UNSAVED SUMMARY');
  await expect(page.getByTestId('handout-doc')).not.toContainText('Newly generated document');
  await page.getByTestId('handout-edit-save').click();
  await expect.poll(() => page.evaluate(async () => (await probe.draft(50121))?.value.summary), { timeout: 30000 }).toBe('USER UNSAVED SUMMARY');
  await expect.poll(() => page.evaluate(async () => (await probe.draft(50121))?.value.status), { timeout: 30000 }).toBe('conflict');
  const rejectedCommand = (await page.evaluate(() => probe.commands()))[0];
  assert.equal(rejectedCommand.status, 'uncertain');
  assert.equal(rejectedCommand.command.input.expected.outlineJson, original.outlineJson);
  assert.throws(() => handoutEditBaseline(records, owner, parseHandoutPersist(rejectedCommand.command.input)), /handout_edit_conflict/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, rejectedCommand.command.operationId).n, 0, 'CAS rejects admission before executing any job');
  assert.equal(JSON.parse(records.get(owner, 'handouts', 50121).outlineJson).summary, 'Concurrent committed summary');
  assert.equal(records.get(owner, 'handouts', 50122).title, 'Newly generated document');
  await expect(page.getByTestId('handout-doc')).toContainText('USER UNSAVED SUMMARY');
  await page.screenshot({ path: path.join(directory, 'handout-draft-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(directory, 'handout-draft-mobile.png') });
  evidence.checks.push('same-document remote edit and newer generation during manual editing preserve the open input and original baseline; save conflicts, both remote versions and local durable draft/command survive');
  await page.evaluate(() => probe.select('save-course'));
  await expect(page.getByTestId('handout-doc')).toContainText('Editable summary');
  const saveSummary = page.locator('[data-hd-anchor="sum"]'); await saveSummary.hover();
  await saveSummary.locator('.hd-hover-actions .hd-act-edit').click();
  await page.getByTestId('handout-edit-input').locator('textarea').fill('SUCCESSFUL COMPLETE SERVER EDIT');
  await page.getByTestId('handout-edit-save').click();
  await expect.poll(() => JSON.parse(records.get(owner, 'handouts', 67000).outlineJson).summary, { timeout: 30000 }).toBe('SUCCESSFUL COMPLETE SERVER EDIT');
  await expect.poll(() => page.evaluate(async () => (await probe.draft(67000)) ?? null), { timeout: 30000 }).toBe(null);
  await expect(page.getByTestId('handout-doc')).toContainText('SUCCESSFUL COMPLETE SERVER EDIT');
  await expect(page.getByTestId('handout-doc')).toContainText('Complete retained paragraph');
  assert.notEqual(records.get(owner, 'handouts', 67000).blob.$file, docFile);
  const editedDownloadWait = page.waitForEvent('download'); await page.getByTestId('handout-export').click();
  const editedDownload = await editedDownloadWait; const editedPath = path.join(directory, 'edited.docx'); await editedDownload.saveAs(editedPath);
  assert.match(strFromU8(unzipSync(fs.readFileSync(editedPath))['word/document.xml']), /SUCCESSFUL COMPLETE SERVER EDIT/);
  const commandsAfterSave = await page.evaluate(() => probe.commands());
  assert.equal(commandsAfterSave.length, 2);
  assert.equal(commandsAfterSave.filter(row => row.status === 'accepted').length, 1);
  evidence.checks.push('successful real Node executor manual edit uses no model; exact-key completion retires local draft, updated complete DOCX exports correctly without any account baseline');
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.locator('[data-hd-anchor="sum"]').hover();
  await page.locator('[data-hd-anchor="sum"] .hd-hover-actions .hd-act-edit').click();
  await expect(page.getByTestId('handout-edit-input').locator('textarea')).toHaveValue('SUCCESSFUL COMPLETE SERVER EDIT');
  await page.evaluate(() => { probe.invalidate(); document.querySelector('[data-testid="handout-edit-save"]')?.click(); });
  await expect(page.getByTestId('handout-doc')).toHaveCount(0);
  assert.equal((await page.evaluate(() => probe.commands())).length, 2);
  assert.equal(await page.evaluate(async () => (await probe.draft(67000)) ?? null), null, 'same-turn invalidated editor cannot create a new intent');
  assert.equal(JSON.parse(records.get(owner, 'handouts', 67000).outlineJson).summary, 'SUCCESSFUL COMPLETE SERVER EDIT');
  assert.equal((await page.evaluate(() => probe.handles())).some(handle => handle.active || handle.refs || handle.listeners), false);
  assert.equal(evidence.requests.some(item => /recordsPage/.test(item.path) || /"kind":"records"|"kind":"collectionPage"/.test(item.body ?? '')), false);
  assert.deepEqual(evidence.wireLeaks, []); assert.deepEqual(evidence.errors, []);
  evidence.checks.push('terminal account invalidation rejects same-turn save and clears current/retained document; releases all model refs/listeners; conflict journal survives; no global record/collection request or historical/unreferenced body on WS');
  await page.evaluate(() => probe.stop()); evidence.passed = true;
  console.log('PASS handout demand:', directory, evidence.checks);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); await runner?.close(); store?.close(); await app.close();
  if (!evidence.passed) console.error('Handout evidence:', directory);
}
