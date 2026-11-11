import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
import sharp from 'sharp';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/attachment-demand-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('No external/model calls permitted'); } });
const fileResponses = [];
app.addHook('onSend', async (request, reply, payload) => {
  if (request.method === 'GET' && request.url.startsWith('/api/v1/files/')) fileResponses.push({ id: request.url.split('/').pop(), status: reply.statusCode, conditional: request.headers['if-none-match'] });
  return payload;
});
let web, browser;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite'),
    plugins: [{ name: 'attachment-fixture', resolveId: id => id === '/__attachment.js' ? '\0attachment' : undefined,
      load: id => id === '\0attachment' ? `import React from 'react'; import { createRoot } from 'react-dom/client'; import {ChatMessageAttachments} from '/src/components/ChatAttachments.tsx'; import '/src/i18n/index.ts'; window.fixture={React,createRoot,ChatMessageAttachments};` : undefined,
      configureServer(server) { server.middlewares.use('/attachment-fixture', (_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<!doctype html><html><body><div id="root"></div><script type="module" src="/__attachment.js"></script></body></html>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  const engine = process.env.ATTACHMENT_BROWSER === 'webkit' ? webkit : chromium;
  const contextOptions = { acceptDownloads: true, viewport: { width: 1000, height: 800 } };
  browser = engine === webkit
    ? await engine.launchPersistentContext(path.join(directory, 'webkit-profile'), { headless: true, ...contextOptions })
    : await engine.launch({ headless: true });
  const context = engine === webkit ? browser : await browser.newContext(contextOptions);
  await context.route('https://**', route => route.abort());
  const password = 'attachment-demand-private-test-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  const owner = (await (await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).json()).user.id;
  const page = await context.newPage(), requests = [], uploads = [], errors = [];
  page.on('pageerror', error => { errors.push(error.message); console.error(error.message); });
  page.on('request', req => { if (/\/api\/v1\/files\//.test(req.url()) && req.method() === 'GET') requests.push(new URL(req.url()).pathname.split('/').pop()); });
  page.on('request', req => { if (new URL(req.url()).pathname === '/api/v1/files' && req.method() === 'POST') uploads.push(req.url()); });
  await page.goto(origin + '/attachment-fixture');
  await page.waitForFunction(() => window.fixture);
  await page.evaluate(async owner => {
    const {React,createRoot,ChatMessageAttachments} = window.fixture;
    const { cloud } = await import('/src/cloud/state.ts');
    const database = await import('/src/store/db.ts');
    const lifecycle = await import('/src/client/account-lifecycle.ts');
    const helpers = await import('/src/chat/prepareAttachment.ts');
    cloud.enabled = true; cloud.userId = owner; database.useCloudDatabase(owner); lifecycle.accountLifetime(owner);
    const canvas = document.createElement('canvas'); canvas.width = 1000; canvas.height = 500;
    canvas.getContext('2d').fillRect(0, 0, 1000, 500);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const file = new File([blob], 'photo.png', { type: 'image/png' });
    const attachment = await helpers.prepareAttachment('test-photo', file, () => {});
    const root = createRoot(document.getElementById('root'));
    const revoked = [], created = [];
    const oldRevoke = URL.revokeObjectURL.bind(URL), oldCreate = URL.createObjectURL.bind(URL);
    URL.revokeObjectURL = url => { revoked.push(url); oldRevoke(url); };
    URL.createObjectURL = blob => { const url = oldCreate(blob); created.push(url); return url; };
    const render = (spacer = true, files = [attachment]) => root.render(React.createElement(React.Fragment, null,
      React.createElement('p', null, 'Text is readable before any image'),
      React.createElement('div', { style: { height: spacer ? '1800px' : '0px' } }),
      React.createElement(ChatMessageAttachments, { files })));
    window.probe = { root, render, attachment, file, database, cloud, lifecycle, helpers, created, revoked, original: await file.arrayBuffer() };
    render();
  }, owner);
  const attachment = await page.evaluate(() => probe.attachment);
  requests.length = 0;
  assert.ok(attachment.serverId && attachment.previewServerId);
  assert.equal(uploads.length, 1, 'one original image upload; no client preview upload');
  assert.equal(attachment.dataUrl, undefined); assert.equal(attachment.width, 1000); assert.equal(attachment.height, 500);
  const previewResponse = await context.request.get(`${origin}/api/v1/files/${attachment.previewServerId}`);
  assert.equal(previewResponse.headers()['content-type'], 'image/webp');
  const previewMetadata = await sharp(await previewResponse.body()).metadata();
  assert.equal(previewMetadata.format, 'webp'); assert.equal(previewMetadata.width, 640); assert.equal(previewMetadata.height, 320);
  assert.equal((await fetch(`${origin}/api/v1/files/${attachment.previewServerId}`)).status, 401, 'preview is authenticated');
  await page.getByText('Text is readable before any image').waitFor();
  await page.waitForTimeout(250);
  assert.deepEqual(requests, [], 'offscreen references fetch neither preview nor original');
  assert.equal(await page.locator('.chat-document').count(), 0, 'reference image is not a document');
  assert.equal(await page.locator('.chat-image-slot').evaluate(el => Math.round(el.getBoundingClientRect().height)), 96, 'placeholder holds product thumbnail geometry');
  let fail = true;
  await page.route(`**/files/${attachment.previewServerId}`, route => fail ? route.fulfill({ status: 503, body: 'temporary' }) : route.continue());
  await page.locator('.chat-image').scrollIntoViewIfNeeded();
  await page.getByLabel('重试图片预览 photo.png').waitFor();
  assert.ok(!requests.includes(attachment.serverId), 'near viewport requests only preview');
  fail = false; await page.getByLabel('重试图片预览 photo.png').click();
  await page.waitForFunction(() => document.querySelector('.chat-image img')?.naturalWidth > 0);
  await page.getByLabel('预览图片 photo.png', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-image-viewer"] img')?.naturalWidth === 1000);
  const downloadPromise = page.waitForEvent('download');
  await page.getByLabel('下载图片', { exact: true }).click();
  const download = await downloadPromise;
  assert.deepEqual(fs.readFileSync(await download.path()), Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(probe.original)))));
  assert.deepEqual(fileResponses.filter(response => response.id === attachment.serverId).map(response => response.status), [200, 304], 'download revalidates authorization and reuses original bytes via 304');
  await page.getByLabel('关闭图片预览').click();
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => probe.revoked.length > 0), 'viewer original URL released on close');

  // Malformed upload metadata cannot publish a half-ready draft. Cleanup only
  // deletes the unescaped original; the server cascades its generated preview.
  const staged = await page.evaluate(async () => {
    const { serverClient } = await import('/src/api/serverClient.ts');
    const upload = serverClient.uploadFile; let saved, error;
    serverClient.uploadFile = async file => { saved = await upload(file); return { ...saved, previewServerId: undefined }; };
    try { await probe.helpers.prepareAttachment('invalid-metadata', probe.file, () => {}); }
    catch (caught) { error = caught.message; }
    finally { serverClient.uploadFile = upload; }
    return { saved, error };
  });
  assert.ok(staged.error);
  assert.equal(uploads.length, 2, 'metadata failure also uploads only one original');
  for (const id of [staged.saved.id, staged.saved.previewServerId]) assert.equal((await context.request.get(`${origin}/api/v1/files/${id}`)).status(), 404);
  const small = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 160;
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    return probe.helpers.prepareAttachment('small', new File([blob], 'small.png', { type: 'image/png' }), () => {});
  });
  assert.equal(uploads.length, 3);
  assert.equal(small.width, 320); assert.equal(small.height, 160);
  const smallMetadata = await sharp(await (await context.request.get(`${origin}/api/v1/files/${small.previewServerId}`)).body()).metadata();
  assert.equal(smallMetadata.format, 'webp'); assert.equal(smallMetadata.width, 320); assert.equal(smallMetadata.height, 160, 'small image is not enlarged');
  await page.evaluate(file => probe.helpers.removeAttachmentFile(file), small);
  assert.equal((await context.request.get(`${origin}/api/v1/files/${small.previewServerId}`)).status(), 404, 'draft removal cascades the server-generated preview');

  // A slow original may finish for another cache waiter, but must never acquire
  // a URL or replace the active gallery item after navigation/close.
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const originalBytes = Buffer.from(await page.evaluate(() => Array.from(new Uint8Array(probe.original))));
  await page.route('**/files/slow-original', async route => { await slowGate; await route.fulfill({ status: 200, contentType: 'image/png', body: originalBytes }); });
  await page.evaluate(() => probe.render(false, [{ ...probe.attachment, id: 'slow', name: 'slow.png', serverId: 'slow-original' }, { ...probe.attachment, id: 'fast', name: 'fast.png' }]));
  const slowRequest = page.waitForRequest('**/files/slow-original');
  await page.getByLabel('查看 2 张图片').click(); await slowRequest;
  await page.getByLabel('下一张图片', { exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-image-viewer"] img')?.alt === 'fast.png');
  await page.getByLabel('关闭图片预览').click();
  const createdBeforeSlow = await page.evaluate(() => probe.created.length);
  releaseSlow(); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => probe.created.length), createdBeforeSlow, 'cancelled gallery original never acquires an object URL');

  // Missing originals fail independently of a working preview and can retry.
  await page.evaluate(() => probe.render(false, [{ ...probe.attachment, id: 'missing', serverId: 'missing-original' }]));
  await page.getByLabel('预览图片 photo.png', { exact: true }).click();
  await page.locator('[data-testid="chat-image-viewer"] [role="alert"]').waitFor();
  await page.locator('[data-testid="chat-image-viewer"]').getByText('重试', { exact: true }).click();
  await page.locator('[data-testid="chat-image-viewer"] [role="alert"]').waitFor();
  assert.ok(requests.filter(id => id === 'missing-original').length >= 2);
  await page.getByLabel('关闭图片预览').click();

  const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
  const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
  const committedStore = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  try {
    const records = new CloudRecords(committedStore);
    const committed = { id: 7711, sessionId: 771, role: 'user', content: 'retained attachment', createdAt: 1, attachments: [attachment] };
    records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: committed.id, before: null, after: committed }]);
    try {
      for (const id of [attachment.serverId, attachment.previewServerId]) assert.equal((await context.request.delete(`${origin}/api/v1/files/${id}`)).status(), 409, 'retained original and preview cannot be deleted');
    } finally { records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: committed.id, before: committed, after: null }]); }
  } finally { committedStore.close(); }

  assert.equal(await page.evaluate(async () => !!await probe.database.db.table('_fileCache').get(probe.attachment.serverId)), true);
  assert.equal((await context.request.delete(`${origin}/api/v1/files/${attachment.serverId}`)).status(), 200);
  assert.equal((await context.request.get(`${origin}/api/v1/files/${attachment.serverId}`)).status(), 404);
  assert.equal(await page.evaluate(async () => {
    try { await probe.helpers.readAttachmentBlob(probe.attachment); return false; } catch { return true; }
  }), true, 'server removal cannot be bypassed by same-account cached bytes');
  assert.equal(await page.evaluate(async () => !!await probe.database.db.table('_fileCache').get(probe.attachment.serverId)), false, 'revoked bytes are purged');
  assert.equal(await page.evaluate(async () => !!await probe.database.db.table('_fileCacheMeta').get(probe.attachment.serverId)), false, 'revoked cache metadata is purged');

  // Exercise the actual shared cache budget with real IndexedDB transactions.
  await page.route('**/files/budget-*', route => route.fulfill({ status: 200, contentType: 'application/octet-stream', body: Buffer.alloc(280 * 1024) }));
  const budget = await page.evaluate(async () => {
    const { resolveCloudBlob } = await import('/src/store/cloudBlob.ts');
    for (let n = 0; n < 132; n++) await resolveCloudBlob({ $file: `budget-${n}` });
    const rows = await probe.database.db.table('_fileCacheMeta').toArray();
    let storageError;
    if (!rows.length) {
      try { await probe.database.db.table('_fileCache').put({ id: 'storage-probe', blob: new Blob(['probe']) }); }
      catch (error) { storageError = `${error.name}: ${error.message}`; }
    }
    return { entries: rows.length, bytes: rows.reduce((sum, row) => sum + row.size, 0), ...(storageError ? { storageError } : {}) };
  });
  assert.ok(budget.entries > 0, JSON.stringify(budget));
  assert.ok(budget.entries <= 128 && budget.bytes <= 32 * 1024 * 1024);
  // Auth errors must never enter the successful cache.
  await page.route('**/files/denied-*', route => route.fulfill({ status: route.request().url().endsWith('401') ? 401 : 403, body: 'denied' }));
  assert.equal(await page.evaluate(async () => {
    const { resolveCloudBlob } = await import('/src/store/cloudBlob.ts');
    for (const status of [401, 403]) await resolveCloudBlob({ $file: `denied-${status}` }).catch(() => {});
    return !!await probe.database.db.table('_fileCache').get('denied-401') || !!await probe.database.db.table('_fileCache').get('denied-403');
  }), false);
  await page.evaluate(async () => {
    const file = await probe.helpers.prepareAttachment('account-cleanup', probe.file, () => {});
    probe.render(false, [file]);
  });
  assert.equal(uploads.length, 4, 'every image preparation uploads exactly one original');
  await page.waitForFunction(() => document.querySelector('.chat-image img')?.naturalWidth > 0);
  await page.evaluate(() => probe.lifecycle.invalidateAccountLifetime());
  await page.waitForFunction(() => !document.querySelector('.chat-image img'));
  assert.equal(await page.evaluate(() => probe.created.every(url => probe.revoked.includes(url))), true, 'all object URLs released on account disposal');
  await page.evaluate(() => {
    probe.root.unmount(); probe.cloud.userId = 'other-account'; probe.database.useCloudDatabase('other-account'); probe.lifecycle.accountLifetime('other-account');
  });
  assert.equal(await page.evaluate(() => probe.database.db.table('_fileCache').count()), 0, 'other account cannot see prior byte cache');
  assert.deepEqual(errors, []);
  console.log(`PASS ${engine.name()}: single original upload/server WebP metadata+640x320+no enlargement+auth, unpublished cleanup/cascade, text-first/offscreen, preview retry, gallery cancellation, original byte download/missing retry, account URL release, 128-entry/32MiB cache`, budget);
} finally { await browser?.close(); await web?.close(); await app.close(); }
