import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/library-import-ui-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external request forbidden'); } });
let vite, browser;
const network = [];
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'library-import-ui-password' } })).statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'library-import-ui-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'library-import-login', configureServer(server) { server.middlewares.use('/__login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/settings/data' }); res.end(); }); } }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
  context.on('request', request => { if (request.url().includes('/api/v1/files?operationId=')) network.push({ url: request.url(), at: new Date().toISOString() }); });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  await page.goto(`${origin}/__login`);
  await page.getByTestId('cloud-sync-card').waitFor({ timeout: 60000 });
  await page.evaluate(async () => {
    const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js');
    const legacy = new Dexie('wangke');
    legacy.version(1).stores({ videos: 'id', files: 'id', chatSessions: 'id', chats: 'id', _cloudOutbox: 'id' });
    await legacy.open();
    await legacy.transaction('rw', legacy.tables, async () => {
      await legacy.table('videos').put({ id: 'original-md', name: '原始正文', mimeType: 'text/markdown', size: 42, duration: 0, createdAt: 1, status: 'new', kind: 'material', materialFormat: 'md' });
      await legacy.table('files').bulkPut([{ id: 'original-md', blob: new Blob(['# 原始正文\n\n不可丢失的内容。'], { type: 'text/markdown' }) }, { id: 'original-attachment', blob: new Blob(['附件原始字节'], { type: 'text/plain' }) }]);
      await legacy.table('chatSessions').put({ id: 42, videoId: '', title: '原始会话', createdAt: 1 });
      await legacy.table('chats').put({ id: 43, sessionId: 42, videoId: '', role: 'user', content: '原始问题', createdAt: 1, attachments: [{ id: 'original-attachment', storage: 'local', name: 'notes.txt' }] });
      await legacy.table('_cloudOutbox').put({ id: 'unknown-original-operation', table: 'unknown', blob: new Blob(['原事务']), operationId: 'keep-original' });
    });
    legacy.close();
    window.readImportDraft = async () => {
      const name = '/src/store/db.ts';
      const { db } = await import(performance.getEntriesByType('resource').findLast(e => new URL(e.name).pathname === name)?.name ?? name);
      const draft = (await db.table('_cloudMeta').get('library-import'))?.value;
      return draft ? { operationId: draft.operationId, sourceId: draft.source.sourceId, state: draft.state, uploads: Object.values(draft.uploads).map(row => ({ operationId: row.request.operationId, state: row.state })) } : null;
    };
  });
  const readDraft = () => page.evaluate(async owner => {
    const request = indexedDB.open(`wangke-cloud-${owner}`);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const draft = (await new Promise((resolve, reject) => { const get = database.transaction('_cloudMeta').objectStore('_cloudMeta').get('library-import'); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); }))?.value;
      return draft ? { operationId: draft.operationId, sourceId: draft.source.sourceId, state: draft.state, uploads: Object.values(draft.uploads).map(row => ({ operationId: row.request.operationId, state: row.state })) } : null;
    } finally { database.close(); }
  }, login.json().user.id);
  const importUI = async () => {
    await page.getByTestId('cloud-sync-card').getByRole('button', { name: '导入', exact: true }).click();
    await page.getByTestId('confirm-dialog-confirm').click();
  };
  // A sync error toast does not prove that the separate import action stopped.
  const importStopped = () => page.waitForFunction(() => [...document.querySelectorAll('[data-testid="cloud-sync-card"] button')].some(button => button.textContent.trim() === '导入' && !button.disabled), null, { timeout: 30000 });
  // True browser offline: persist snapshot and identity without a server write.
  await page.evaluate(() => import('/src/cloud/migrate.ts'));
  await context.setOffline(true);
  await importUI();
  await page.getByText(/Failed to fetch|fetch|网络|offline/i).last().waitFor({ timeout: 30000 });
  try { await page.waitForFunction(async owner => {
    const request = indexedDB.open(`wangke-cloud-${owner}`);
    const database = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { const row = await new Promise((resolve, reject) => { const get = database.transaction('_cloudMeta').objectStore('_cloudMeta').get('library-import'); get.onsuccess = () => resolve(get.result); get.onerror = () => reject(get.error); }); return !!row?.value?.operationId; }
    finally { database.close(); }
  }, login.json().user.id); }
  catch (error) { console.error(await page.locator('body').innerText()); throw error; }
  await importStopped();
  const offline = await readDraft();
  assert.ok(offline?.operationId);
  assert.equal(network.length, 0, 'offline attempt finishes without a binary request');
  await context.setOffline(false);
  await page.reload(); await page.getByTestId('cloud-sync-card').waitFor();
  let uploads = 0, commands = 0;
  const commandIds = [];
  let binaryLost, snapshotLost;
  const binaryFailure = new Promise(resolve => { binaryLost = resolve; });
  const snapshotFailure = new Promise(resolve => { snapshotLost = resolve; });
  const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('import fault was not reached')), 30000); timer.unref(); })]);
  await context.route('**/api/v1/files?operationId=*', async route => {
    uploads++;
    const response = await route.fetch(); assert.equal(response.status(), 201, await response.text());
    if (uploads === 1) { await route.abort('failed'); binaryLost(); } else await route.fulfill({ response });
  });
  await importUI();
  await bounded(binaryFailure);
  await page.getByText(/Failed to fetch|fetch|网络/i).last().waitFor({ timeout: 30000 });
  await importStopped();
  assert.equal(uploads, 1);
  await page.reload(); await page.getByTestId('cloud-sync-card').waitFor();
  let releaseSnapshot;
  const snapshotBarrier = new Promise(resolve => { releaseSnapshot = resolve; });
  await context.route('**/api/clientRuntime/resourceCommand', async route => {
    const request = route.request().postDataJSON().payload?.args?.request;
    if (request?.operation.kind !== 'importLibrary') return route.continue();
    commands++; commandIds.push(request.operationId);
    const response = await route.fetch();
    assert.equal(response.status(), 200); assert.equal((await response.json()).result.ok, true);
    snapshotLost();
    await snapshotBarrier;
    await route.abort('failed');
  });
  await importUI();
  await bounded(snapshotFailure);
  assert.equal(uploads, 2, 'both distinct blobs uploaded before the snapshot fault');
  releaseSnapshot();
  await page.getByText(/Failed to fetch|fetch|网络/i).last().waitFor({ timeout: 30000 });
  await importStopped();
  assert.equal(commands, 1); assert.equal(uploads, 2, 'successful first binary was resolved by receipt, not retransmitted');
  await page.reload(); await page.getByTestId('cloud-sync-card').waitFor();
  await importUI();
  await page.getByText('导入完成', { exact: true }).waitFor({ timeout: 30000 });
  const final = await readDraft();
  assert.equal(final.state, 'completed'); assert.equal(final.operationId, offline.operationId); assert.equal(final.sourceId, offline.sourceId);
  assert.deepEqual(commandIds, [offline.operationId]); assert.equal(uploads, 2);
  const original = await page.evaluate(async () => {
    const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js'); const db = new Dexie('wangke'); await db.open();
    try { return { files: await db.table('files').count(), messages: await db.table('chats').count(), outbox: await db.table('_cloudOutbox').get('unknown-original-operation').then(async row => ({ operationId: row.operationId, text: await row.blob.text() })) }; } finally { db.close(); }
  });
  assert.deepEqual(original, { files: 2, messages: 1, outbox: { operationId: 'keep-original', text: '原事务' } });
  const doc = await api.inject({ method: 'GET', url: '/api/v1/resources/courses/original-md', headers: { cookie } });
  assert.equal(doc.statusCode, 200); assert.match(doc.body, /不可丢失的内容/);
  await page.screenshot({ path: path.join(directory, 'import-completed.png') });
  // A new browser's unsupported legacy field must stop before any upload and
  // remain available in a lossless export alongside its original side effects.
  const reviewContext = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true });
  await reviewContext.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const reviewPage = await reviewContext.newPage();
  await reviewPage.goto(`${origin}/__login`);
  await reviewPage.getByTestId('cloud-sync-card').waitFor({ timeout: 60000 });
  await reviewPage.evaluate(async () => {
    const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js');
    const legacy = new Dexie('wangke'); legacy.version(1).stores({ videos: 'id', _cloudOutbox: 'id' });
    await legacy.open();
    await legacy.table('videos').put({ id: 'unknown-source', name: '保全未知字段', futureLegacyData: { body: new Blob(['未知字段原稿']) } });
    await legacy.table('_cloudOutbox').put({ id: 'original-txn', operationId: 'never-replay', blob: new Blob(['未知副作用']) });
    legacy.close();
  });
  const reviewWrites = [];
  reviewPage.on('request', request => { if (request.method() === 'POST' && /\/api\/(clientRuntime\/resourceCommand|v1\/files)/.test(request.url())) reviewWrites.push(request.url()); });
  await reviewPage.getByTestId('cloud-sync-card').getByRole('button', { name: '导入', exact: true }).click();
  await reviewPage.getByTestId('confirm-dialog-confirm').click();
  await reviewPage.getByText(/旧库字段需显式转换/).waitFor();
  const downloadEvent = reviewPage.waitForEvent('download');
  await reviewPage.getByRole('button', { name: '导出导入快照', exact: true }).click();
  const download = await downloadEvent;
  const exportPath = path.join(directory, 'unsupported-legacy-export.json'); await download.saveAs(exportPath);
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(Buffer.from(exported.draft.source.archive.videos[0].futureLegacyData.body.$blob, 'base64').toString(), '未知字段原稿');
  assert.equal(exported.draft.source.archive._cloudOutbox[0].operationId, 'never-replay');
  assert.equal(Buffer.from(exported.draft.source.archive._cloudOutbox[0].blob.$blob, 'base64').toString(), '未知副作用');
  assert.deepEqual(reviewWrites, [], 'unsupported snapshot has no external write or blob upload');
  await reviewContext.close();
  const nestedContext = await browser.newContext({ locale: 'zh-CN', acceptDownloads: true });
  await nestedContext.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const nestedPage = await nestedContext.newPage();
  await nestedPage.goto(`${origin}/__login`); await nestedPage.getByTestId('cloud-sync-card').waitFor({ timeout: 60000 });
  await nestedPage.evaluate(async () => {
    const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js');
    const legacy = new Dexie('wangke'); legacy.version(1).stores({ videos: 'id', files: 'id' }); await legacy.open();
    await legacy.table('videos').put({ id: 'nested-source', name: '保全嵌套字段', size: 6, mimeType: 'text/markdown', duration: 0, createdAt: 1, status: 'new', biliSource: { bvid: 'BV-original', aid: 1, cid: 2, page: 1, futureNested: { retain: 'nested-original' } } });
    await legacy.table('files').put({ id: 'nested-source', blob: new Blob(['nested']) }); legacy.close();
  });
  const nestedWrites = [];
  nestedPage.on('request', request => { if (request.method() === 'POST' && /\/api\/(clientRuntime\/resourceCommand|v1\/files)/.test(request.url())) nestedWrites.push(request.url()); });
  await nestedPage.getByTestId('cloud-sync-card').getByRole('button', { name: '导入', exact: true }).click(); await nestedPage.getByTestId('confirm-dialog-confirm').click();
  await nestedPage.getByText(/未声明的嵌套字段/).waitFor();
  const nestedDownloadEvent = nestedPage.waitForEvent('download');
  await nestedPage.getByRole('button', { name: '导出导入快照', exact: true }).click();
  const nestedPath = path.join(directory, 'unsupported-nested-export.json'); await (await nestedDownloadEvent).saveAs(nestedPath);
  const nestedExport = JSON.parse(fs.readFileSync(nestedPath, 'utf8'));
  assert.deepEqual(nestedExport.draft.source.archive.videos[0].biliSource.futureNested, { retain: 'nested-original' });
  assert.equal(Buffer.from(nestedExport.draft.source.archive.files[0].blob.$blob, 'base64').toString(), 'nested');
  assert.deepEqual(nestedWrites, [], 'projecting codec cannot silently drop nested fields before binary admission');
  await nestedContext.close();
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, offline, final, uploads, commands, original, checks: ['real settings UI', 'true offline', 'binary committed response lost', 'snapshot committed response lost', 'reload', 'same command identity', 'zero successful binary retransmission', 'source IDB/outbox unchanged', 'real resource authority'] }, null, 2));
  console.log(`PASS legacy library UI/offline/lost-response/reload and unsupported-field lossless export (${directory})`);
} finally { fs.writeFileSync(path.join(directory, 'network.json'), JSON.stringify(network, null, 2)); await browser?.close(); await vite?.close(); await api.close(); }
