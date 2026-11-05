// Skill HTML -> real show_widget tool -> WidgetBlock -> existing save channel.
// Disposable API/SQLite/account; the model returns the executable skill example.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/skill-practice-'));
const shots = process.env.SHOTS_DIR ?? path.join(os.tmpdir(), 'opencode/skill-practice-evidence');
fs.mkdirSync(shots, { recursive: true });
const reference = fs.readFileSync(new URL('../packages/study-core/assets/builtin/interactive-explainer/references/practice.md', import.meta.url), 'utf8');
const html = reference.match(/```html\n([\s\S]*?)\n```/)[1];
const reservation = net.createServer();
await new Promise(r => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port; await new Promise(r => reservation.close(r));
const origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), PUBLIC_ORIGIN: origin, SERVE_WEB: 'false' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
let modelCalls = 0;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  modelCalls++;
  const body = JSON.parse(init.body);
  assert.ok(body.tools.some(t => t.function?.name === 'show_widget'));
  assert.match(JSON.stringify(body.messages), /重新练习/);
  const receipt = body.messages.filter(m => m.role === 'tool' && m.name === 'show_widget').at(-1);
  if (!receipt) return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [
    { id: 'skill-practice-widget', type: 'function', function: { name: 'show_widget', arguments: JSON.stringify({ format: 'html', code: html }) } }
  ] }, finish_reason: 'tool_calls' }] });
  const ref = receipt.content.match(/```wbw-widget\n[^\n]+\n```/)?.[0]; assert.ok(ref, receipt.content);
  return Response.json({ choices: [{ message: { role: 'assistant', content: `先读图，再提交你的答案。\n\n${ref}` }, finish_reason: 'stop' }] });
} });
let web, browser, store;
try {
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim()
  }, payload: { adminPassword: 'skill-practice-password-123' } })).statusCode, 201);
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { watch: null, hmr: false, host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false, ws: true } } }, logLevel: 'warn' });
  await web.listen(); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  await context.addInitScript(() => {
    if (window !== window.top) return;
    window.__practiceStateRequests = 0;
    window.addEventListener('message', event => {
      if (event.origin === 'null' && event.data?.__wbw === 'wbw:state') window.__practiceStateRequests++;
    });
  });
  await context.route('https://models.dev/**', r => r.fulfill({ json: {} }));
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'skill-practice-password-123' } });
  assert.equal(login.status(), 200); const owner = (await login.json()).user.id;
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  assert.equal((await context.request.put(`${origin}/api/v1/cloud/config`, { data: { ...config,
    providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture-only', baseUrl: 'https://fixture.example/v1', serves: ['chat'] }],
    llmModel: { providerId: 'fixture', model: 'fixture-model' } } })).status(), 200);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let dialogs = 0; page.on('dialog', d => { dialogs++; void d.dismiss(); });
  await page.goto(`${origin}/#/chat`);
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await input.waitFor();
  // Delay the *real* confirmed-cache transaction before it opens, without
  // changing data, session events, RPC replies or widget reads. Releasing it
  // executes the original transaction normally. Text/session delivery stays live.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const original = db.transaction, pending = [];
    window.__heldWidgetCacheTransactions = 0;
    db.transaction = function (mode, ...args) {
      const names = args.slice(0, -1).flat(Infinity).map(table => table?.name ?? table);
      if (names.includes('chats') && names.includes('_cloudMeta')) {
        window.__heldWidgetCacheTransactions++;
        return new Promise((resolve, reject) => pending.push(() => Promise.resolve(original.call(this, mode, ...args)).then(resolve, reject)));
      }
      return original.call(this, mode, ...args);
    };
    window.__releaseWidgetCache = () => { db.transaction = original; for (const resume of pending.splice(0)) resume(); };
  });
  await input.fill('请用交互式讲解做一个可视化参考练习，提交后自动显示答案解析，并能重新练习。'); await input.press('Enter');
  const frame = () => page.getByTestId('widget-frame').contentFrame();
  const root = () => frame().locator('#curve-practice');
  await page.getByText('先读图，再提交你的答案。', { exact: true }).waitFor({ timeout: 30000 });
  await page.getByTestId('widget-loading').waitFor();
  assert.equal(await page.getByTestId('widget-error').count(), 0, 'lagging cache is not a permanent ownership error');
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'iframe waits for real confirmed ownership');
  assert.equal(await page.evaluate(async () => (await import('/src/store/db.ts')).db.chats.count()), 0, 'session text arrives without forged cache rows');
  await page.waitForFunction(() => window.__heldWidgetCacheTransactions > 0);
  await page.screenshot({ path: path.join(shots, 'practice-waiting-for-ownership.png') });
  await page.evaluate(() => window.__releaseWidgetCache());
  try { await root().waitFor({ timeout: 30000 }); }
  catch (error) {
    console.error('Practice setup diagnostics', { modelCalls, errors, tasks: store.db.prepare('SELECT status,error FROM cloud_tasks').all(), body: await page.locator('body').innerText(), localRows: await page.evaluate(async () => (await import('/src/store/db.ts')).db.chats.toArray().then(rows => rows.map(r => ({ id: r.id, widgets: r.widgets?.map(w => w.id) })))) });
    await page.screenshot({ path: path.join(shots, 'practice-setup-failure.png') }); throw error;
  }
  await page.getByTestId('chat-stop').waitFor({ state: 'detached', timeout: 30000 });
  const callsAfterGeneration = modelCalls; assert.equal(callsAfterGeneration, 2);
  const rows = () => store.db.prepare("SELECT record_key,value,revision FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner).map(r => ({ ...r, row: JSON.parse(r.value) }));
  const work = () => rows().find(r => r.row.widgets?.some(w => w.html === html) || r.row.widget?.html === html);
  assert.ok(work(), 'show_widget persisted its own server-owned payload');
  const saved = () => {
    const row = work().row;
    return Object.values(row.widgetStates ?? {})[0]?.privateContent ?? row.widgetState?.value.privateContent;
  };
  const waitSaved = async (phase, choice) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (saved()?.phase === phase && saved()?.choice === choice) {
        await frame().locator('[data-save]').filter({ hasText: '正在保存' }).waitFor({ state: 'hidden' });
        return;
      }
      await new Promise(r => setTimeout(r, 40));
    }
    throw new Error(`State not saved: ${JSON.stringify(saved())}; ${await root().innerText()}`);
  };
  const choose = async value => { await frame().getByRole('radio', { name: value, exact: true }).check(); await waitSaved('answering', ['2', '4', '8'].indexOf(value)); };
  const reveal = async (choice, text) => {
    await frame().getByRole('button', { name: '提交答案', exact: true }).click();
    await frame().locator('[data-result]').filter({ hasText: text }).waitFor();
    assert.equal(await frame().getByText('参考答案：4', { exact: true }).isVisible(), true);
    assert.equal(await frame().getByText('解析：把 x = 2 代入 y = x²，得到 y = 2 × 2 = 4。', { exact: true }).isVisible(), true);
    await waitSaved('revealed', choice);
  };
  assert.equal(await frame().locator('[data-feedback]').isVisible(), false, 'answer and explanation hidden before submit');
  assert.equal(await frame().getByRole('button', { name: '提交答案', exact: true }).isEnabled(), false);
  const initialRevision = work().revision;
  // Restoring an explicit snapshot or initial null must not create a write loop.
  await root().evaluate(async () => {
    window.dispatchEvent(new CustomEvent('wbw:statechange'));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  assert.equal(await page.evaluate(() => window.__practiceStateRequests), 0, 'initial load/restore sends no state write request');
  assert.equal(work().revision, initialRevision);
  await page.screenshot({ path: path.join(shots, 'practice-before-submit-desktop.png') });
  await choose('2'); await reveal(0, '再想一想');
  await page.screenshot({ path: path.join(shots, 'practice-reference-incorrect-desktop.png') });
  await root().screenshot({ path: path.join(shots, 'practice-reference-incorrect-widget.png') });
  // Real browser-storage failure: reject journaling once, before any network edit.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const original = db.transaction;
    db.transaction = function (...args) {
      if (args.some(x => x?.name === '_learningCommands')) {
        db.transaction = original; return Promise.reject(new Error('fixture_storage_full'));
      }
      return original.apply(this, args);
    };
  });
  await frame().getByRole('button', { name: '重新练习', exact: true }).click();
  await frame().getByRole('alert').filter({ hasText: 'fixture_storage_full' }).waitFor();
  assert.equal(saved().phase, 'revealed', 'failed reset preserves last committed snapshot');
  assert.equal(await frame().locator('[data-feedback]').isVisible(), false, 'local reset does not keep old feedback');
  await frame().getByRole('button', { name: '重试保存', exact: true }).click(); await waitSaved('answering', null);
  assert.equal(saved().elapsedMs, 0);
  assert.equal(await frame().locator('input:checked').count(), 0);
  assert.equal(await frame().locator('[data-result]').innerText(), '');
  assert.equal(await frame().locator('[data-score]').innerText(), '');
  await page.reload(); await root().waitFor({ timeout: 30000 });
  assert.equal(await frame().locator('input:checked').count(), 0, 'refresh preserves saved blank reset');
  assert.equal(await frame().locator('[data-feedback]').isVisible(), false);
  await choose('4'); await reveal(1, '答对了');
  await page.reload(); await root().waitFor({ timeout: 30000 });
  await frame().locator('[data-result]').filter({ hasText: '答对了' }).waitFor();
  assert.equal(await frame().getByRole('radio', { name: '4', exact: true }).isChecked(), true);
  const beforeRestore = work().revision;
  await root().evaluate(async () => {
    window.dispatchEvent(new CustomEvent('wbw:statechange'));
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  assert.equal(await page.evaluate(() => window.__practiceStateRequests), 0, 'saved-state replay sends no state write request');
  assert.equal(work().revision, beforeRestore, 'restoration is read-only');
  await page.setViewportSize({ width: 320, height: 780 });
  await root().scrollIntoViewIfNeeded();
  assert.ok(await root().evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px iframe fits');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px host fits');
  await page.screenshot({ path: path.join(shots, 'practice-reference-correct-320px.png') });
  await root().screenshot({ path: path.join(shots, 'practice-reference-correct-widget-320px.png') });
  await frame().getByRole('button', { name: '重新练习', exact: true }).click(); await waitSaved('answering', null);
  await page.screenshot({ path: path.join(shots, 'practice-reset-320px.png') });
  assert.equal(modelCalls, callsAfterGeneration, 'answer, retry, restart and refresh never call the model');
  assert.equal(dialogs, 0, 'local teaching practice needs no blocking modal');
  assert.equal(rows().filter(r => r.row.quiz).length, 0, 'no formal quiz or score records');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM plugin_practice_snapshots').get().n, 0);
  assert.deepEqual(errors, []);
  const report = { status: 'PASS', modelCalls, formalPracticeRows: 0, dialogs,
    setup: 'Live first generation; real confirmed-cache transaction deliberately delayed while session/text stream remains live; automatic ownership handoff with no flushCloud/reload.',
    screenshots: fs.readdirSync(shots).filter(n => n.endsWith('.png') && !n.includes('failure')),
    covered: ['live show_widget first render + WidgetBlock', 'delayed confirmed cache with uninterrupted session text', 'automatic ownership handoff without flush/reload', 'hidden answer', 'wrong and correct AI reference', 'automatic explanation', 'reset and retry', 'storage failure and explicit retry', 'server-persisted state and refresh', 'no restore/save loop', '320px', 'no extra model calls'] };
  fs.writeFileSync(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, evidence: shots }, null, 2));
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
