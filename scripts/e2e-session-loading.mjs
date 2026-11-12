import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import sharp from 'sharp';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-loading-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const readyReached = deferred(), readyGate = deferred();
const watch = ClientRuntimeDomain.prototype.watchSessionJournal;
ClientRuntimeDomain.prototype.watchSessionJournal = async function* (owner, request, signal) {
  for await (const frame of watch.call(this, owner, request, signal)) {
    if (request.sessionId === 903 && frame.type === 'ready') { readyReached.resolve(); await readyGate.promise; }
    yield frame;
  }
};
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('External/model execution forbidden'); } });
let web, browser, store;
const metadataReached = deferred(), metadataGate = deferred(), requests = [], errors = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await context.route('https://**', route => route.abort());
  const password = 'session-loading-test-password-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const owner = (await (await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after }]);
  for (const id of Array.from({ length: 14 }, (_, index) => 901 + index)) {
    put('chatSessions', id, { id, videoId: '__library_assistant__', title: `Session ${id}`, createdAt: 1000 - id, skillIds: [id] });
    for (let n = 1; n <= 65; n++) put('chats', id * 100 + n, { id: id * 100 + n, sessionId: id, role: n % 2 ? 'user' : 'assistant', content: `History ${id}/${n}`, createdAt: n });
  }
  const frameBytes = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
  const frameUpload = await context.request.post(origin + '/api/v1/files', { headers: {
    'content-type': 'application/octet-stream', 'x-file-name': 'frame.png', 'x-file-mime': 'image/png',
  }, data: frameBytes });
  assert.equal(frameUpload.status(), 201);
  const frameFile = await frameUpload.json();
  put('videos', 'source-video', { id: 'source-video', name: 'Reference source', kind: 'video', createdAt: 1 });
  put('frames', 700, { id: 700, videoId: 'source-video', kind: 'slide', ts: 10.25, caption: 'Reference frame', blob: { $file: frameFile.id, type: 'image/png' } });
  const page = await context.newPage(); page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/clientRuntime/read') requests.push(request.postDataJSON().payload.args.request);
  });
  await page.goto(origin);
  await page.locator('[data-chat-message="stored-90165"]').waitFor();
  await page.route('**/api/clientRuntime/read', async route => {
    const read = route.request().postDataJSON().payload.args.request;
    if (read.kind === 'recordKeys' && read.keys.some(key => key.table === 'chatSessions' && key.key === 902)) {
      const response = await route.fetch(); metadataReached.resolve(); await metadataGate.promise; await route.fulfill({ response });
    } else await route.continue();
  });
  await page.evaluate(async () => {
    const { useCourseChat: store } = await import('/src/store/courseChat.ts');
    window.loadingProbe = { store, settled: 0 };
    const first = store.getState().loadSession(902), second = store.getState().loadSession(902);
    window.loadingProbe.first = first; window.loadingProbe.second = second;
    void first.then(() => window.loadingProbe.settled++);
    void second.then(() => window.loadingProbe.settled++);
  });
  await metadataReached.promise;
  await page.waitForFunction(() => loadingProbe.store.getState().loaded && loadingProbe.store.getState().activeId === 902);
  await page.evaluate(async () => {
    await loadingProbe.store.getState().loadSession(901);
    loadingProbe.third = loadingProbe.store.getState().loadSession(902);
  });
  assert.deepEqual(await page.evaluate(() => ({ same: loadingProbe.first === loadingProbe.second && loadingProbe.first === loadingProbe.third,
    settled: loadingProbe.settled, messages: loadingProbe.store.getState().messages.length })), { same: true, settled: 0, messages: 40 });
  assert.equal(requests.filter(r => r.kind === 'recordKeys' && r.keys.some(k => k.table === 'chatSessions' && k.key === 902)).length, 1,
    'click, page effect, repeated call and A→B→A share one metadata read');
  metadataGate.resolve();
  await page.evaluate(() => Promise.all([loadingProbe.first, loadingProbe.second, loadingProbe.third]));
  assert.deepEqual(await page.evaluate(() => loadingProbe.store.getState().skillIds), [902]);
  await page.unroute('**/api/clientRuntime/read');

  await page.evaluate(() => {
    loadingProbe.settled = 0;
    loadingProbe.first = loadingProbe.store.getState().loadSession(903);
    loadingProbe.second = loadingProbe.store.getState().loadSession(903);
    void loadingProbe.first.then(() => loadingProbe.settled++);
    void loadingProbe.second.then(() => loadingProbe.settled++);
  });
  await readyReached.promise;
  assert.deepEqual(await page.evaluate(() => ({ same: loadingProbe.first === loadingProbe.second, settled: loadingProbe.settled,
    loaded: loadingProbe.store.getState().loaded })), { same: true, settled: 0, loaded: false }, 'neither caller completes before journal ready');
  readyGate.resolve();
  await page.evaluate(() => Promise.all([loadingProbe.first, loadingProbe.second]));
  await page.locator('[data-chat-message="stored-90365"]').waitFor();
  await page.evaluate(() => loadingProbe.store.getState().loadOlder());
  assert.equal(await page.evaluate(() => loadingProbe.store.getState().messages.length), 65);
  await page.evaluate(async () => { await loadingProbe.store.getState().loadSession(901); await loadingProbe.store.getState().loadSession(902); });
  await page.locator('[data-chat-message="stored-90265"]').waitFor();
  assert.deepEqual(await page.evaluate(() => ({ active: loadingProbe.store.getState().activeId, error: loadingProbe.store.getState().historyError,
    foreign: loadingProbe.store.getState().messages.some(message => !message.content.startsWith('History 902/')) })), { active: 902, error: null, foreign: false });
  const budget = await page.evaluate(async () => {
    const { serverRuntime } = await import('/src/client/bootstrap.ts');
    const { cloud } = await import('/src/cloud/state.ts');
    const runtime = await serverRuntime(cloud.userId);
    const oldest = runtime.session(903);
    for (let id = 904; id <= 914; id++) await loadingProbe.store.getState().loadSession(id);
    const retained = [...loadingProbe.store.models.keys()].filter(id => id !== 0);
    const evicted = !loadingProbe.store.models.has(903);
    const recreated = runtime.session(903) !== oldest;
    // Inspecting the evicted entry above intentionally creates one idle remote
    // model; remove this diagnostic probe before restoring through the UI.
    runtime.evictSession(903);
    await loadingProbe.store.getState().loadSession(903);
    return { retained, evicted, recreated, messages: loadingProbe.store.getState().messages.length,
      error: loadingProbe.store.getState().historyError };
  });
  assert.ok(budget.retained.length <= 7, 'only active plus six idle presentation windows remain');
  assert.equal(budget.evicted, true);
  assert.equal(budget.recreated, true, 'remote journal snapshots are evicted together with idle UI windows');
  assert.equal(budget.messages, 40, 'an evicted view reloads a fresh bounded baseline, not a stale paginated cache');
  assert.equal(budget.error, null);
  const materialImage = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { loadMaterialImage } = await import('/src/materials/images.ts');
    const { videoFrameKey } = await import('/src/materials/imageRefs.ts');
    if (await db.frames.count() || await db.videos.get('source-video')) throw new Error('image fixture unexpectedly mirrored before explicit lookup');
    const result = await loadMaterialImage('source-video', videoFrameKey(10.25));
    return { name: result.courseName, caption: result.image.label, bytes: [...new Uint8Array(await result.blob.arrayBuffer())], localFrames: await db.frames.count() };
  });
  assert.equal(materialImage.name, 'Reference source');
  assert.equal(materialImage.caption, 'Reference frame');
  assert.deepEqual(Buffer.from(materialImage.bytes), frameBytes, 'frame reference resolves exact authenticated bytes with no mirrored course/frame records');
  assert.equal(materialImage.localFrames, 0, 'explicit image lookup does not reintroduce the business mirror');
  assert.ok(requests.some(request => request.kind === 'collectionPage' && request.table === 'frames' && request.parent === 'source-video'));
  assert.deepEqual(errors, []);
  console.log('PASS real React session loading: shared request, metadata/ready barriers, A→B→A, pagination and bounded idle UI/journal eviction with fresh reload');
} finally {
  metadataGate.resolve(); readyGate.resolve();
  await browser?.close(); await web?.close(); store?.close(); await app.close();
  ClientRuntimeDomain.prototype.watchSessionJournal = watch;
}
