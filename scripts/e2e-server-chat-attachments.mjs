/** Full Chat: real login, drag/drop, upload, task admission, native executor,
 * server history and reload. Only the provider HTTP response is scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'opencode', 'chat-attachments-e2e-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const bodies = [], errors = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://attachment-model.invalid');
  const body = JSON.parse(init.body);
  bodies.push(body);
  const content = `已读取拖入的资料，第 ${bodies.length} 次回答。`;
  if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
} });
let web, browser, page, store, release;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const password = 'attachment-fixture-password-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const config = new CloudConfiguration(store, directory), records = new CloudRecords(store);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Offline', protocol: 'openai-chat',
    baseUrl: 'https://attachment-model.invalid/v1', apiKey: 'fixture', serves: ['chat'], catalogId: '' }],
  llmModel: { providerId: 'fixture', model: 'fixture' } });
  page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('**/chat/completions', route => { throw new Error('browser model call forbidden: ' + route.request().url()); });
  const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0;
  await page.route('**/api/v1/files', async route => {
    if (route.request().method() === 'POST') { uploads++; await gate; }
    await route.continue();
  });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  const input = page.locator('textarea.course-chat__input');
  await input.waitFor();
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File(['DRAGGED_FILE_MARKER：原题第一题，选项 A B C D。'], '拖入的原题.txt', { type: 'text/plain' }));
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#4180b0'; ctx.fillRect(0, 0, 80, 80);
    const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]), char => char.charCodeAt(0));
    data.items.add(new File([bytes], '示意图.png', { type: 'image/png' }));
    document.querySelector('textarea.course-chat__input').closest('[class*="composer"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment-draft"] [data-testid="chat-attachment"]').length === 2);
  await input.fill('分析拖入的文件和图片');
  const send = page.getByTestId('chat-send');
  assert.ok(await send.isDisabled());
  await input.press('Enter');
  assert.equal(bodies.length, 0);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cloud_tasks WHERE kind='chat'").get().n, 0);
  release();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="chat-attachment-draft"] [data-state="ready"]').length === 2);
  assert.equal(uploads, 2);
  await send.click();
  const until = async predicate => { const deadline = Date.now() + 30000; while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  } throw new Error('attachment_e2e_timeout'); };
  const latest = () => store.db.prepare("SELECT * FROM cloud_tasks WHERE kind='chat' ORDER BY created_at DESC LIMIT 1").get();
  await until(() => latest()?.status === 'completed' || latest()?.status === 'failed');
  assert.equal(latest().status, 'completed', latest().error);
  const result = JSON.parse(latest().result), taskInput = JSON.parse(latest().input);
  const row = records.get(owner, 'chats', result.userRowId);
  assert.equal(row.attachments.length, 2);
  assert.ok(row.attachments.every(file => file.serverId));
  assert.ok(JSON.stringify(bodies[0].messages).includes('DRAGGED_FILE_MARKER'));
  assert.ok(bodies[0].messages.some(message => Array.isArray(message.content) && message.content.some(part => part.type === 'image_url')));
  await page.getByText('已读取拖入的资料，第 1 次回答。', { exact: false }).first().waitFor();
  await page.reload();
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.getByText('已读取拖入的资料，第 1 次回答。', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByTestId('chat-message-attachments').waitFor();
  await input.fill('接着分析刚才附件里的原题');
  await input.press('Enter');
  await until(() => bodies.length === 2 && latest()?.status === 'completed');
  assert.ok(JSON.stringify(bodies[1].messages).includes('DRAGGED_FILE_MARKER'));
  assert.ok(JSON.stringify(bodies[1].messages).includes(row.attachments.find(file => file.dataUrl).dataUrl));
  assert.equal(JSON.parse(latest().input).sessionId, taskInput.sessionId);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'attachment-chat.png'), fullPage: true });
  console.log(`PASS real Chat drag/drop + upload blocking + multimodal model input + server persistence + reload + follow-up: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
  throw error;
} finally {
  release?.();
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ modelCalls: bodies.length, errors }, null, 2));
  await browser?.close(); await web?.close(); await app.close(); store?.close();
}
