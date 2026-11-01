// Isolated real API + Web. No production data, model or IM traffic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const temporary = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const root = fs.mkdtempSync(path.join(temporary, 'bot-sync-web-'));
const output = path.join(root, 'evidence'); fs.mkdirSync(output);
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: root, FILES_DIR: path.join(root, 'files'), BOOTSTRAP_SECRET_FILE: path.join(root, 'config/bootstrap-secret') });
const reservation = net.createServer(); await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`; process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const app = buildServer({ dbPath: path.join(root, 'db.sqlite'), fetch: async () => Response.json({ choices: [{ message: { content: 'Fixture reply' }, finish_reason: 'stop' }] }) });
let web, browser, store;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), server: { hmr: false, watch: null, host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'bot-sync-web-password' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const login = await post('/auth/password/login', { password: 'bot-sync-web-password' }); assert.equal(login.status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'Long sync fixture' })).json();
  const other = await (await post('/threads', { mode: 'bot', title: 'Other fixture' })).json();
  store = new DatabaseStore(path.join(root, 'db.sqlite'));
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  store.db.transaction(() => {
    for (let n = 0; n < 10000; n++) bot.append(thread.id, n % 2 ? 'assistant' : 'user', 'text', `消息编号 ${n}：${'不同高度的正文。'.repeat(n % 4 + 1)}`);
  })();
  const page = await context.newPage(); const errors = [], requests = [], snapshots = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/v1/threads')) requests.push({ url: new URL(request.url()).pathname, method: request.method(), at: Date.now() }); });
  let gapInjected = false;
  await page.route(`**/threads/${thread.id}/snapshot`, async route => {
    const response = await route.fetch(); const snapshot = await response.json(); snapshots.push(snapshot);
    if (!gapInjected) { gapInjected = true; bot.append(thread.id, 'assistant', 'text', '快照与订阅之间的新消息'); }
    await route.fulfill({ response });
  });
  await page.goto(origin, { timeout: 90000 });
  const panel = page.getByTestId('bot-panel');
  const open = async title => {
    await page.evaluate(async () => {
      const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('zh-CN');
      const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().setOpen(true);
    });
    await panel.getByTestId('bot-panel-history').click();
    await page.getByRole('menu').getByText(title, { exact: true }).click();
    await panel.locator('[data-chat-positioned="true"]').waitFor({ state: 'attached' });
  };
  await open(thread.title);
  await panel.getByText('快照与订阅之间的新消息', { exact: true }).waitFor();
  assert.equal(snapshots[0].messages.length, 50);
  assert.equal(snapshots[0].messages[0].seq, 9951);
  const mounted = await panel.locator('.imsg-row').count(); assert.ok(mounted < 40, `bounded DOM: ${mounted}`);
  const idleStart = requests.length;
  await page.waitForTimeout(Number(process.env.BOT_SYNC_IDLE_MS ?? 60_000));
  const idleRequests = requests.slice(idleStart);
  assert.equal(idleRequests.filter(item => /\/(events|state|sync-state|snapshot)$/.test(item.url)).length, 0, JSON.stringify(idleRequests));
  const beforeBurst = requests.length;
  store.db.transaction(() => { for (let n = 0; n < 500; n++) bot.append(thread.id, 'assistant', 'progress', `progress ${n}`); });
  const sentinel = bot.append(thread.id, 'assistant', 'text', '突发事件已全部应用');
  await panel.getByText(sentinel.content, { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(requests.slice(beforeBurst).filter(item => /\/(snapshot|sync-state)$/.test(item.url)).length, 0, 'progress does not invalidate state/history');
  const scroll = panel.locator('.bot-messages');
  await scroll.evaluate(element => { element.scrollTop = 350; }); await page.waitForTimeout(400);
  const anchor = await scroll.evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('[data-message-key]')].find(row => row.getBoundingClientRect().top > top + 100);
    return { key: row.dataset.messageKey, top: row.getBoundingClientRect().top };
  });
  // Trigger the actual button without moving the reading viewport (keyboard equivalent).
  const olderResponse = page.waitForResponse(response => response.url().includes(`/threads/${thread.id}/messages?beforeSeq=`));
  await panel.getByRole('button', { name: '加载更早消息', exact: true }).evaluate(button => button.click());
  await olderResponse;
  await page.waitForTimeout(500);
  const anchorAfter = await scroll.locator(`[data-message-key="${anchor.key}"]`).evaluate(row => row.getBoundingClientRect().top);
  assert.ok(Math.abs(anchorAfter - anchor.top) <= 2, `prepend anchor ${anchor.top} -> ${anchorAfter}`);
  bot.append(thread.id, 'assistant', 'text', '上翻时不吸底'); await page.waitForTimeout(500);
  const anchorWithAppend = await scroll.locator(`[data-message-key="${anchor.key}"]`).evaluate(row => row.getBoundingClientRect().top);
  assert.ok(Math.abs(anchorWithAppend - anchorAfter) <= 2, 'incoming message does not pull history readers to bottom');
  await open(other.title); await open(thread.title); await page.waitForTimeout(500);
  const restored = await scroll.locator(`[data-message-key="${anchor.key}"]`).evaluate(row => row.getBoundingClientRect().top);
  assert.ok(Math.abs(restored - anchorAfter) <= 2, `cached reading anchor ${anchorAfter} -> ${restored}`);
  assert.equal(snapshots.length, 1, 'switching back reuses snapshot and resumes event cursor');
  await panel.getByRole('button', { name: '回到最新', exact: true }).click();
  await panel.getByText('上翻时不吸底', { exact: true }).waitFor();
  await context.setOffline(true); await panel.getByText('连接已断开，正在重连…', { exact: true }).waitFor();
  bot.append(thread.id, 'assistant', 'text', '离线期间的新消息');
  await context.setOffline(false); await panel.getByText('离线期间的新消息', { exact: true }).waitFor({ timeout: 15000 });
  assert.equal(requests.filter(item => item.method === 'GET' && item.url === `/api/v1/threads/${thread.id}`).length, 0, 'no legacy full-history request');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(output, `bot-sync-${width}.png`), animations: 'disabled' });
  }
  // The shared virtualizer's default behavior must still pass ordinary-chat regression.
  assert.deepEqual(errors, []);
  const evidence = { history: 10000, firstPage: snapshots[0].messages.length, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshots[0])), mounted, idleSeconds: Number(process.env.BOT_SYNC_IDLE_MS ?? 60_000) / 1000, idleRequests, progressEvents: 500, anchorDelta: anchorAfter - anchor.top, restoreDelta: restored - anchorAfter, fullHistoryRequests: 0, screenshots: output };
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2));
  console.log('Bot sync E2E passed:', JSON.stringify(evidence));
  if (process.env.BOT_SYNC_REVIEW) { console.log(`Review ${origin}; password bot-sync-web-password`); await new Promise(resolve => process.once('SIGTERM', resolve)); }
} finally { await browser?.close(); await web?.close(); store?.close(); await app.close(); }
