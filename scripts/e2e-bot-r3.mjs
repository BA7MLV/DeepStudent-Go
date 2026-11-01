// Isolated API + Web + Playwright R3 interaction check; no real model or IM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-r3-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`;
process.env.PUBLIC_ORIGIN = origin;
const until = async (predicate, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
  throw new Error('condition_timeout');
};
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
let modelRequests = 0;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => {
  modelRequests++;
  return modelRequests === 1
    ? Response.json({ choices: [{ message: { tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'send_message', arguments: JSON.stringify({ kind: 'question', text: 'Which files should I compare?' }) } }] } }] })
    : Response.json({ choices: [{ message: { tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'wait', arguments: JSON.stringify({ seconds: 3600, reason: 'R3 UI wait' }) } }] } }] });
} });
let web, browser, store;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  const context = await (await chromium.launch({ headless: true })).newContext({ serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  browser = context.browser();
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'r3-test-password-123' }, { 'X-Bootstrap-Secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  assert.equal((await post('/auth/password/login', { password: 'r3-test-password-123' })).status(), 200);
  const configResponse = await context.request.get(`${origin}/api/v1/cloud/config`, { headers: { origin } });
  const config = await configResponse.json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { headers: { origin }, data: {
    ...config,
    providers: [{ id: 'offline', name: 'Offline', baseUrl: 'https://offline.invalid/v1', protocol: 'openai-chat', apiKey: 'test', serves: ['chat'] }],
    llmModel: { providerId: 'offline', model: 'scripted' },
  } })).status(), 200);
  const thread = await (await post('/threads', { mode: 'bot', title: 'R3 interaction' })).json();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const owner = store.db.prepare('SELECT owner_id AS owner FROM threads WHERE id=?').get(thread.id).owner;
  const at = new Date().toISOString(), run2 = crypto.randomUUID();
  assert.equal((await post(`/threads/${thread.id}/messages`, { clientNonce: crypto.randomUUID(), role: 'user', kind: 'text', content: 'Please compare my files.' })).status(), 201);
  await until(() => Boolean(store.db.prepare("SELECT 1 FROM run_questions WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?) AND status='pending'").get(thread.id)));
  const run = store.db.prepare("SELECT id FROM runs WHERE thread_id=? ORDER BY created_at DESC LIMIT 1").get(thread.id).id;
  const question = store.db.prepare("SELECT id FROM run_questions WHERE run_id=? ORDER BY created_at DESC LIMIT 1").get(run).id;
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run2, thread.id, 'bot', 'waiting_event', at);
  const page = await context.newPage();
  await page.goto(`${origin}/`);
  await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('en-US'); const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().setOpen(true); });
  await page.getByTestId('bot-panel-history').click();
  await page.getByRole('menu').getByText('R3 interaction', { exact: true }).click();
  const panel = page.getByTestId('bot-panel');
  await panel.getByRole('button', { name: 'Answer', exact: true }).click();
  await until(() => panel.getByText('Answering this question', { exact: true }).count().then(n => n === 1));
  await panel.locator('textarea').fill('Compare only the first three files.');
  await panel.locator('textarea').press('Enter');
  await until(() => store.db.prepare('SELECT status FROM run_questions WHERE id=?').get(question)?.status === 'answered');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE run_id=?').get(run).n, 0, 'ordinary answer must not create approval');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM run_inputs WHERE run_id=?').get(run).n, 1, 'answer must append to original run');
  // Keep the synthetic second run as the only active supplement target for
  // the following UI interaction; the first run has already accepted its
  // answer in this deterministic fixture.
  store.db.prepare("UPDATE runs SET status='completed',completed_at=? WHERE id=?").run(new Date().toISOString(), run);

  // Make a second question, then expire it between target selection and send.
  // The failed request must clear only the target and restore the draft.
  const run3 = crypto.randomUUID(), question2 = crypto.randomUUID(), qmsg2 = crypto.randomUUID();
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run3, thread.id, 'bot', 'waiting_user', at);
  const qseq = store.db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE thread_id=?').get(thread.id).n;
  store.db.prepare('INSERT INTO messages(id,thread_id,seq,role,kind,content,created_at) VALUES(?,?,?,?,?,?,?)').run(qmsg2, thread.id, qseq, 'assistant', 'question', 'Should I include hidden files?', at);
  store.db.prepare('INSERT INTO run_questions(id,run_id,message_id,status,created_at) VALUES(?,?,?,?,?)').run(question2, run3, qmsg2, 'pending', at);
  await page.reload();
  await page.evaluate(async () => { const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().setOpen(true); });
  await page.getByTestId('bot-panel-history').click();
  await page.getByRole('menu').getByText('R3 interaction', { exact: true }).click();
  const panel2 = page.getByTestId('bot-panel');
  await until(() => panel2.getByRole('button', { name: 'Answer', exact: true }).count().then(n => n >= 1));
  await panel2.getByRole('button', { name: 'Answer', exact: true }).last().click();
  store.db.prepare("UPDATE run_questions SET status='answered' WHERE id=?").run(question2);
  await panel2.locator('textarea').fill('Keep this draft after an expired target.');
  await panel2.locator('textarea').press('Enter');
  await until(() => panel2.locator('textarea').inputValue().then(value => value === 'Keep this draft after an expired target.'));
  assert.equal(await panel2.getByText('Answering this question', { exact: true }).count(), 0, 'expired target must clear');
  const screenshotDir = process.env.SCREENSHOT_DIR ?? path.join(process.cwd(), 'test-results/bot-r3');
  fs.mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: path.join(screenshotDir, 'expired-target.png'), fullPage: true });

  await until(() => panel.getByRole('button', { name: 'Add to current task', exact: true }).count().then(n => n > 0));
  await panel.getByRole('button', { name: 'Add to current task', exact: true }).click();
  assert.equal(await panel.getByText('Adding to the current run', { exact: true }).count(), 1);
  await panel.locator('textarea').fill('Also preserve the original requirement.');
  await panel.locator('textarea').press('Enter');
  await until(() => store.db.prepare('SELECT COUNT(*) AS n FROM run_inputs WHERE run_id=?').get(run2).n === 1);
  await until(() => panel.getByText('Adding to the current run', { exact: true }).count().then(n => n === 0));

  store.db.prepare("UPDATE runs SET status='waiting_event' WHERE id=?").run(run2);
  // Reload after the successful target request so the final evidence is not
  // polluted by the intentionally induced expired-target toast.
  await page.reload();
  await page.evaluate(async () => { const { useBotPanel } = await import('/src/store/botPanel.ts'); useBotPanel.getState().setOpen(true); });
  await page.getByTestId('bot-panel-history').click();
  await page.getByRole('menu').getByText('R3 interaction', { exact: true }).click();
  const finalPanel = page.getByTestId('bot-panel');
  await until(() => finalPanel.getByText('Waiting for background work', { exact: true }).count().then(n => n === 1));
  await page.keyboard.press('Escape');
  await until(() => page.getByRole('menu').count().then(n => n === 0));
  await until(() => finalPanel.locator('textarea').isEnabled());
  await until(() => finalPanel.getByLabel('正在发送', { exact: true }).count().then(n => n === 0));
  await page.screenshot({ path: path.join(screenshotDir, 'desktop-waiting.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await until(() => finalPanel.locator('textarea').isVisible());
  await page.screenshot({ path: path.join(screenshotDir, 'mobile-waiting.png'), fullPage: true });
  await finalPanel.getByTestId('bot-panel-more').click();
  const stop = page.getByRole('menuitem').filter({ hasText: /Stop current task/ });
  await stop.click();
  await until(() => store.db.prepare('SELECT status FROM runs WHERE id=?').get(run2)?.status === 'cancelled');
  console.log('Bot R3 Web E2E: question answer, run supplement target, approval separation, draft preservation, waiting stop and 390px viewport passed');
} finally {
  await browser?.close().catch(() => {});
  await web?.close().catch(() => {});
  await app.close().catch(() => {});
  store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
