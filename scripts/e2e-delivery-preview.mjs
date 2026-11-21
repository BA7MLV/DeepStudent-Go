import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { zipSync, strToU8 } from 'fflate';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'delivery-preview-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const doc = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const presentation = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const drawing = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const zip = files => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key, value]) => [key, strToU8(value)]))));
const slide = text => `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}"><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
const fixtures = [
  ['notes.md', 'text/markdown', '# Delivery notes\n\n**Markdown body**'],
  ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip({ 'word/document.xml': `<w:document xmlns:w="${doc}"><w:body><w:p><w:r><w:t>Word report body</w:t></w:r></w:p></w:body></w:document>` })],
  ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip({
    'ppt/presentation.xml': `<p:presentation xmlns:p="${presentation}" xmlns:r="${rels}"><p:sldIdLst><p:sldId id="257" r:id="rId2"/><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="slides/slide1.xml"/><Relationship Id="rId2" Target="slides/slide2.xml"/></Relationships>',
    'ppt/slides/slide1.xml': slide('Closing slide'), 'ppt/slides/slide2.xml': slide('Opening slide'),
  })],
  ['page.html', 'text/html', '<!doctype html><html><head><style>h1 { color: rgb(24, 80, 120) }</style></head><body><h1>Standalone HTML</h1><img src="https://preview-assets.invalid/sample.png"><script>document.body.textContent = "Script ran"</script></body></html>'],
  ['legacy.ppt', 'application/vnd.ms-powerpoint', 'legacy fixture'],
];
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, store, web;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch();
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1600, height: 950 }, locale: 'en-US' });
  const password = 'delivery-preview-fixture-password';
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { data, headers: { origin, ...headers } });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: password }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password })).status(), 200);
  const response = await post('/threads', { mode: 'bot', title: 'Delivered documents' });
  assert.equal(response.status(), 201);
  const thread = await response.json();
  const other = await (await post('/threads', { mode: 'bot', title: 'Other thread' })).json();
  const attachments = [];
  for (const [name, mimeType, content] of fixtures) {
    const upload = await post('/files', Buffer.from(content), { 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': mimeType });
    assert.equal(upload.status(), 201, `${name}: ${await upload.text()}`);
    const file = await upload.json();
    attachments.push({ fileId: file.id, name, mimeType, sizeBytes: Buffer.byteLength(content) });
  }
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const bot = new BotApplicationService(store, { enqueue() {} });
  for (const file of attachments) bot.append(thread.id, 'assistant', 'attachment', JSON.stringify(file));
  bot.append(other.id, 'assistant', 'text', 'A different conversation');

  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  let previewRequests = 0, remoteRequests = 0;
  page.on('request', request => { if (request.url().startsWith(`${origin}/api/v1/files/`)) previewRequests++; });
  await page.route('https://preview-assets.invalid/**', route => { remoteRequests++; return route.abort(); });
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(async id => {
    (await import('/src/i18n/index.ts')).applyLocale('en-US');
    (await import('/src/store/botPanel.ts')).useBotPanel.getState().openThread(id);
  }, thread.id);
  const botPanel = page.getByTestId('bot-panel');
  const preview = page.getByTestId('delivery-preview');
  const pick = name => botPanel.getByRole('button', { name: `Preview attachment ${name}`, exact: true }).click();
  await botPanel.getByRole('button', { name: 'Preview attachment notes.md', exact: true }).waitFor();
  assert.equal(previewRequests, 0, 'no preview bytes fetched before user opens a file');
  await pick('notes.md');
  await preview.getByRole('heading', { name: 'Delivery notes' }).waitFor();
  assert.ok(await preview.locator('strong').filter({ hasText: 'Markdown body' }).isVisible());
  const botBox = await botPanel.boundingBox(), previewBox = await preview.boundingBox();
  assert.ok(previewBox.width >= 320 && previewBox.x >= botBox.x + botBox.width - 1, 'preview occupies its own column to the right of Bot');
  await pick('report.docx');
  await preview.getByText('Word report body', { exact: true }).waitFor();
  assert.equal(await preview.getByText('Delivery notes').count(), 0);
  await pick('slides.pptx');
  await preview.getByText('Opening slide', { exact: true }).waitFor();
  assert.deepEqual(await preview.locator('li p').allTextContents(), ['Opening slide', 'Closing slide']);
  const downloadEvent = page.waitForEvent('download');
  await preview.getByRole('link', { name: 'Download original' }).click();
  assert.equal((await downloadEvent).suggestedFilename(), 'slides.pptx');
  await pick('page.html');
  await preview.frameLocator('iframe').getByRole('heading', { name: 'Standalone HTML' }).waitFor();
  assert.equal(await preview.frameLocator('iframe').locator('h1').evaluate(h1 => getComputedStyle(h1).color), 'rgb(24, 80, 120)');
  assert.equal(await preview.locator('iframe').getAttribute('sandbox'), '');
  assert.equal(remoteRequests, 0, 'HTML preview cannot load external assets');
  const legacyRequests = previewRequests;
  await pick('legacy.ppt');
  await preview.getByText('Legacy .doc and .ppt files cannot be previewed.', { exact: false }).waitFor();
  assert.equal(previewRequests, legacyRequests, 'legacy formats are not fetched for preview');
  await botPanel.getByTestId('bot-panel-history').click();
  await page.getByRole('menu').getByText('Other thread', { exact: true }).click();
  await preview.waitFor({ state: 'hidden' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('dialog', { name: 'Bot', exact: true }).waitFor();
  await page.evaluate(async id => (await import('/src/store/botPanel.ts')).useBotPanel.getState().openThread(id), thread.id);
  await pick('notes.md');
  await preview.getByRole('heading', { name: 'Delivery notes' }).waitFor();
  assert.equal(await preview.getAttribute('role'), 'dialog');
  await preview.getByRole('button', { name: 'Close file preview' }).click();
  await preview.waitFor({ state: 'hidden' });
  assert.ok(await botPanel.getByRole('button', { name: 'Preview attachment notes.md' }).isVisible());
  console.log('PASS delivered file preview: on demand, Markdown, Word, ordered PowerPoint, sandboxed HTML, original downloads, thread isolation and mobile drawer.');
} finally {
  await browser?.close(); await web?.close(); await app.close(); store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
