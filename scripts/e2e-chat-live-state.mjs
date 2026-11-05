/** Production app + API, legacy task fixture and controlled reasoning stream. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, 'opencode/chat-live-state-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
let calls = 0, release;
const gate = new Promise(resolve => { release = resolve; });
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async url => {
  assert.equal(new URL(String(url)).origin, 'https://fixture.invalid');
  const number = ++calls;
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ async start(controller) {
    const send = value => controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
    // Emit after the runtime's initial 100ms durable-progress throttle window.
    await new Promise(resolve => setTimeout(resolve, 180));
    send({ choices: [{ delta: { reasoning_content: '正在检查附件，任务仍在执行。' }, finish_reason: null }] });
    if (number === 1) await gate;
    send({ choices: [{ delta: { content: `诊断回答 ${number} 已完成。` }, finish_reason: null }] });
    send({ choices: [{ delta: {}, finish_reason: 'stop' }] });
    controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
} });
let web, browser, store, page;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const password = 'chat-state-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const config = new CloudConfiguration(store, directory);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,kind,resource,status,input,executor,nonce,created_at,updated_at) VALUES('legacy-cover',?,'cover','old','completed','{}','media','legacy-cover',?,?)")
    .run(owner, new Date().toISOString(), new Date().toISOString());
  page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.evaluate(() => {
    window.falseFailure = false;
    new MutationObserver(() => { if (document.body.innerText.includes('回答失败：未获得回答')) window.falseFailure = true; })
      .observe(document.body, { subtree: true, childList: true, characterData: true });
    const data = new DataTransfer();
    data.items.add(new File(['附件归档测试'], '诊断资料.txt', { type: 'text/plain' }));
    document.querySelector('textarea.course-chat__input').closest('[class*="composer"]')
      .dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForFunction(() => document.querySelector('[data-testid="chat-attachment-draft"] [data-state="ready"]'));
  const input = page.locator('textarea.course-chat__input');
  await input.fill('读取诊断资料'); await input.press('Enter');
  await page.getByRole('button', { name: '展开全部思考过程' }).waitFor({ timeout: 30000 });
  await input.fill('第二条排队问题'); await input.press('Enter');
  await page.getByTestId('chat-queue-input').waitFor();
  await page.screenshot({ path: path.join(directory, 'thinking-and-queue.png') });
  assert.equal(await page.evaluate(() => window.falseFailure), false);
  release();
  await page.getByText('诊断回答 2 已完成。', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByRole('button', { name: '停止生成（已写出的内容会保留）' }).waitFor({ state: 'hidden', timeout: 30000 });
  assert.equal(await page.getByTestId('chat-queue-input').count(), 0);
  assert.equal(await page.evaluate(() => window.falseFailure), false);
  assert.equal(calls, 2);
  await page.reload();
  await page.getByText('诊断回答 2 已完成。', { exact: false }).first().waitFor({ timeout: 30000 });
  await page.getByTestId('nav-rail-home').click();
  await page.getByText('聊天附件', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.getByText('聊天附件', { exact: true }).first().dblclick();
  await page.getByText('读取诊断资料', { exact: true }).last().waitFor({ timeout: 30000 });
  await page.getByText('读取诊断资料', { exact: true }).last().dblclick();
  await page.getByText('诊断资料.txt', { exact: true }).first().waitFor({ timeout: 30000 });
  await page.screenshot({ path: path.join(directory, 'session-attachments.png') });
  assert.deepEqual(errors, []);
  console.log('PASS full app: legacy task, reasoning checkpoint, automatic queue, terminal state, reload and session attachment library. Evidence: ' + directory);
} catch (error) {
  console.log('EVIDENCE', directory, 'MODEL_CALLS', calls);
  console.log(store?.db.prepare("SELECT status,error,progress FROM cloud_tasks WHERE kind='chat'").all());
  if (page) { console.log(await page.locator('body').innerText()); await page.screenshot({ path: path.join(directory, 'failure.png') }); }
  throw error;
} finally { release(); await browser?.close(); await web?.close(); await app.close(); store?.close(); }
