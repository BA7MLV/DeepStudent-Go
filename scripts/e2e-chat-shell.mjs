import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'vite';

const out = process.env.SHOTS || 'test-results/chat-shell';
await mkdir(out, { recursive: true });
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-shell-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
let releaseModel;
const answer = new Promise(resolve => { releaseModel = resolve; });
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  await answer;
  if (!JSON.parse(init.body).stream) return Response.json({ choices: [{ message: { content: '收到你的消息' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10 } });
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到你的消息' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
} });
const backend = await api.listen({ host: '127.0.0.1', port: 0 });
const initialized = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'chat-shell-test-password' } });
assert.equal(initialized.statusCode, 201);
const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'chat-shell-test-password' } });
const cookie = login.headers['set-cookie'].split(';')[0];
const config = (await api.inject({ method: 'GET', url: '/api/v1/cloud/config', headers: { cookie } })).json();
const configured = await api.inject({ method: 'PUT', url: '/api/v1/cloud/config', headers: { cookie }, payload: { ...config, providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', protocol: 'openai-chat', apiKey: 'local-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } } });
assert.equal(configured.statusCode, 200, configured.body);
const threadResponse = await api.inject({ method: 'POST', url: '/api/v1/threads', headers: { cookie }, payload: { mode: 'bot', title: '测试会话' } });
assert.equal(threadResponse.statusCode, 201, threadResponse.body);
const thread = threadResponse.json();
process.env.WANGKE_API_PROXY = backend;
const vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'chat-shell-login', resolveId(id) { if (id === '/__receipt-fixture') return '\0receipt-fixture'; }, load(id) { if (id === '\0receipt-fixture') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import {I18nextProvider} from 'react-i18next'; import i18n from '/src/i18n/index.ts'; import Receipt from '/src/components/DeliveryReceipt.tsx'; export function mount() { const host=document.createElement('div'); host.id='receipt-fixture'; document.body.append(host); createRoot(host).render(React.createElement(I18nextProvider,{i18n},React.createElement(Receipt,{status:'read',createdAt:Date.now()}),React.createElement(Receipt,{status:'read',createdAt:Date.now()-60000}))); }`; }, configureServer(server) { server.middlewares.use('/__login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/library' }); res.end(); }); } }] });
await vite.listen();
const base = `http://127.0.0.1:${vite.httpServer.address().port}`;
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.loadTestModule = path => {
      const entry = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === path);
      return import(entry?.name ?? path);
    };
  });
  await page.goto(`${base}/__login`);
  await page.getByTestId('nav-rail-home').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="nav-rail-home"]')?.getAttribute('aria-current') === 'page');
  assert.ok(await page.getByTestId('nav-rail-home').evaluate(el => parseFloat(getComputedStyle(el).borderRadius) >= el.clientHeight / 2));
  assert.equal(await page.locator('.page-shell__surface').evaluate(el => getComputedStyle(el).borderRadius), '24px');
  await page.evaluate(() => {
    window.railWidths = [];
    const until = performance.now() + 800;
    const sample = () => {
      const rail = document.querySelector('.page-shell__rail');
      const surface = document.querySelector('.page-shell__surface');
      window.railWidths.push([rail.getBoundingClientRect().width, surface.getBoundingClientRect().left]);
      if (performance.now() < until) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.waitForFunction(() => Math.round(document.querySelector('.page-shell__rail').getBoundingClientRect().width) === 60);
  assert.ok(await page.evaluate(() => window.railWidths.some(([width, left]) => width > 61 && width < 263 && Math.abs(width - left) < 1)), 'sidebar and main content move together through intermediate widths');
  assert.equal(Math.round((await page.getByTestId('nav-rail-compact').boundingBox()).width), 60);
  assert.equal(await page.getByTestId('nav-rail-home').getAttribute('aria-current'), 'page');
  await page.getByTestId('nav-rail-chat').click();
  await page.getByTestId('course-chat-page').waitFor();
  await page.reload();
  await page.getByTestId('nav-rail-compact').waitFor();
  await page.screenshot({ path: `${out}/desktop-collapsed.png`, animations: 'disabled' });
  await page.getByTestId('nav-rail-toggle').click();
  await page.getByTestId('nav-rail').waitFor();
  await page.screenshot({ path: `${out}/desktop-expanded.png`, animations: 'disabled' });

  // Real Bot UI and generated HTTP/WS transport; only the model is local.
  await page.evaluate(async () => {
    (await window.loadTestModule('/src/store/botPanel.ts')).useBotPanel.getState().setOpen(true);
  });
  const bot = page.getByTestId('bot-panel');
  const input = bot.locator('textarea');
  await input.waitFor();
  assert.equal(await bot.locator('.study-composer__input').count(), 1, 'Bot uses the shared composer input');
  assert.equal(await page.getByTestId('app-aside').evaluate(el => getComputedStyle(el).borderRadius), '24px');
  await input.fill('第一行');
  await input.press('Shift+Enter');
  await input.press('b');
  assert.equal(await input.inputValue(), '第一行\nb');
  await input.dispatchEvent('compositionstart');
  await input.press('Enter');
  const beforeSend = (await api.inject({ method: 'GET', url: `/api/v1/threads/${thread.id}/snapshot`, headers: { cookie } })).json();
  assert.equal(beforeSend.messages.length, 0, 'IME confirmation does not send');
  await input.dispatchEvent('compositionend');
  await bot.getByRole('button', { name: '发送', exact: true }).click();
  const receipt = bot.getByTestId('message-receipt');
  await receipt.waitFor({ state: 'attached' });
  assert.equal(await receipt.textContent(), '', 'no immediate receipt');
  await page.waitForFunction(() => document.querySelector('[data-testid="message-receipt"]')?.dataset.status === 'sent');
  assert.equal(await receipt.textContent(), '已送达');
  await page.waitForTimeout(1100);
  assert.equal(await receipt.textContent(), '已送达', 'optimistic running does not claim read');
  await receipt.locator('.t-text-swap').evaluate(el => {
    window.receiptExits = [];
    new MutationObserver(records => {
      window.receiptExits.push(...records.map(record => record.oldValue));
    }).observe(el, { attributes: true, attributeFilter: ['class'], attributeOldValue: true });
  });
  releaseModel();
  try { await bot.getByText('收到你的消息', { exact: true }).waitFor(); }
  catch (error) { console.error('BOT', await bot.innerText(), 'THREAD', (await api.inject({ method: 'GET', url: `/api/v1/threads/${thread.id}`, headers: { cookie } })).body); throw error; }
  assert.equal(await receipt.textContent(), '已送达', 'read is not displayed immediately on reply');
  await page.waitForFunction(() => document.querySelector('[data-testid="message-receipt"]')?.textContent === '已读');
  assert.ok(await page.evaluate(() => window.receiptExits.some(value => value?.includes('is-exit'))), 'read uses the three-phase transitions.dev swap');
  await page.screenshot({ path: `${out}/desktop-bot.png`, animations: 'disabled' });
  for (const width of [390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByTestId('bot-panel').waitFor();
    await page.screenshot({ path: `${out}/bot-${width}.png`, animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const bounds = await page.getByTestId('bot-panel').locator('.study-composer').boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
  }
  await page.getByTestId('bot-panel-close').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await page.getByTestId('nav-rail-home').click();
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  assert.ok(await page.getByTestId('nav-rail-home').evaluate(el => parseFloat(getComputedStyle(el).borderRadius) >= el.clientHeight / 2));
  // A very fast reply must still show delivery before read; restored history is already settled.
  await page.evaluate(async () => (await import('/__receipt-fixture')).mount());
  const fast = page.locator('#receipt-fixture [data-testid="message-receipt"]').first();
  const history = page.locator('#receipt-fixture [data-testid="message-receipt"]').last();
  try { await history.waitFor({ state: 'attached' }); }
  catch (error) { console.error('Receipt fixture errors', errors, await page.locator('#receipt-fixture').innerHTML()); throw error; }
  assert.equal(await history.textContent(), '已读');
  assert.equal(await fast.textContent(), '');
  await page.waitForFunction(() => document.querySelector('#receipt-fixture [data-testid="message-receipt"]')?.textContent === '已送达');
  await page.waitForTimeout(400);
  assert.equal(await fast.textContent(), '已送达', 'fast read cannot skip the delivery hold');
  await page.waitForFunction(() => document.querySelector('#receipt-fixture [data-testid="message-receipt"]')?.textContent === '已读');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await fast.locator('.t-text-swap').evaluate(el => getComputedStyle(el).transitionDuration), '0s');
  assert.deepEqual(errors, []);
  console.log('PASS: rounded selection/surfaces, persistent compact navigation, shared Bot composer, IME/newlines, delayed receipts, actual read event with text swap, mobile/tablet fit.');
} finally { releaseModel(); await browser.close(); await vite.close(); await api.close(); }
