// Real widget bindings and confirmed projections. No fabricated browser rows.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/widget-ownership-'));
const shots = path.join(os.tmpdir(), 'opencode/skill-practice-evidence'); fs.mkdirSync(shots, { recursive: true });
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import WidgetBlock from '/src/components/WidgetBlock.tsx';
import { db } from '/src/store/db.ts';
import { startCloud, flushCloud } from '/src/cloud/sync.ts';
import { openWidgetSession, readWidgetState, saveWidgetState } from '/src/store/widgetState.ts';
import { accountLifecycle, accountLifetime } from '/src/client/account-lifecycle.ts';
import '/src/i18n';
await startCloud(window.owner);
const root = createRoot(document.getElementById('root'));
const reads = {}; const get = db.chats.get;
db.chats.get = function(key) { reads[key] = (reads[key] || 0) + 1; return get.call(this, key); };
window.probe = { db, reads, flushCloud, openWidgetSession, readWidgetState, saveWidgetState, accountLifecycle, accountLifetime };
window.renderWidget = (rowId, payload) => root.render(React.createElement(WidgetBlock, { key: rowId + ':' + payload.id, rowId, payload, dark: false, allowPopout: false }));
window.unmountWidget = () => root.render(React.createElement('p', null, '作品已卸载，正文仍可阅读'));
document.body.dataset.ready = 'yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'cache'),
    plugins: [{ name: 'widget-ownership-test', resolveId: id => id === '/__ownership.js' ? '\0ownership' : undefined,
      load: id => id === '\0ownership' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__ownership') return next();
        res.setHeader('content-type', 'text/html'); res.end('<main id="root"></main><script type="module" src="/__ownership.js"></script>');
      }); } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null, proxy: { '/api': { target: api, changeOrigin: false, ws: true } } }, logLevel: 'warn' });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 900, height: 720 } });
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim()
  }, data: { adminPassword: 'ownership-test-password-123' } })).status(), 201);
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'ownership-test-password-123' } });
  assert.equal(login.status(), 200); const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
  const payload = (id, text) => ({ id, ref: id, kind: 'html', schemaVersion: 1, revision: 1, source: 'tool', html: `<p>${text}</p>` });
  const old = payload('old-source', '旧版作品'), next = payload('new-source', '新版作品已自动运行');
  const row = (id, widget) => ({ id, sessionId: 1, videoId: '__library_assistant__', role: 'assistant', content: '正文不等待作品', createdAt: id, widget });
  put('chatSessions', 1, { id: 1, videoId: '__library_assistant__', title: 'Ownership test', createdAt: 1 });
  put('chats', 1, row(1, old)); put('chats', 2, row(2, old));
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/__ownership'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 30000 });
  assert.equal(await page.evaluate(() => probe.db.chats.count()), 0, 'startup does not mirror source messages');
  const sync = async () => page.evaluate(async () => {
    await probe.flushCloud(); await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const readCount = id => page.evaluate(id => probe.reads[id] || 0, id);

  // Existing row but *source version* not yet in the confirmed projection.
  await page.evaluate(p => window.renderWidget(2, p), next);
  await page.getByTestId('widget-loading').waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0);
  put('chats', 2, row(2, next)); await sync();
  await page.getByTestId('widget-frame').contentFrame().getByText('新版作品已自动运行').waitFor();
  assert.equal(await page.getByTestId('widget-error').count(), 0);

  // Abort releases the primary-key observer: later real delivery cannot revive it.
  await page.evaluate(p => {
    window.abortedController = new AbortController();
    window.abortedResult = probe.openWidgetSession(4, p, { waitForSource: true, signal: abortedController.signal })
      .then(() => 'unexpected success', e => e.message);
  }, old);
  await page.waitForFunction(() => probe.reads[4] > 0);
  await page.evaluate(() => abortedController.abort(new Error('fixture_cancelled')));
  assert.equal(await page.evaluate(() => abortedResult), 'fixture_cancelled');
  const cancelledReads = await readCount(4);
  put('chats', 4, row(4, old)); await sync();
  assert.equal(await readCount(4), cancelledReads, 'aborted waiter has no surviving liveQuery');

  // Unmount a waiting React surface before the confirmed row arrives.
  await page.evaluate(p => window.renderWidget(5, p), old);
  await page.getByTestId('widget-loading').waitFor(); await page.waitForFunction(() => probe.reads[5] > 0);
  await page.evaluate(() => window.unmountWidget()); await page.getByText('作品已卸载，正文仍可阅读').waitFor();
  const unmountedReads = await readCount(5);
  put('chats', 5, row(5, old)); await sync();
  assert.equal(await readCount(5), unmountedReads, 'unmount releases pending source subscription');
  assert.equal(await page.getByTestId('widget-frame').count(), 0);

  // Timeout is bounded, leaves no subscription, and explicit retry can reopen
  // after a delayed genuine projection finally arrives.
  await page.evaluate(p => window.renderWidget(7, p), old);
  await page.getByTestId('widget-error').filter({ hasText: '超时' }).waitFor({ timeout: 16000 });
  const timeoutReads = await readCount(7);
  put('chats', 7, row(7, old)); await sync();
  assert.equal(await readCount(7), timeoutReads, 'timeout releases pending source subscription');
  assert.equal(await page.getByTestId('widget-frame').count(), 0);
  await page.screenshot({ path: path.join(shots, 'widget-ownership-timeout.png') });
  await page.getByText('运行详情', { exact: true }).click(); await page.getByRole('button', { name: '重试预览', exact: true }).click();
  await page.getByTestId('widget-frame').contentFrame().getByText('旧版作品').waitFor();

  // Once admitted, a source change or deletion must reject immediately, never
  // enter the initial-admission wait again or resurrect an old message.
  await page.evaluate(async ({ old, next }) => {
    // UI payloads come from the session projection, not an account-wide IDB
    // mirror. openWidgetSession must authenticate/hydrate each real source.
    window.oldBinding = await probe.openWidgetSession(1, old);
    window.deletedBinding = await probe.openWidgetSession(4, old);
    window.liveBinding = await probe.openWidgetSession(2, next);
  }, { old, next });
  put('chats', 1, row(1, next)); put('chats', 4, null); await sync();
  const stale = await page.evaluate(async () => {
    const failures = [];
    for (const binding of [oldBinding, deletedBinding]) for (const action of [
      () => probe.readWidgetState(binding), () => probe.saveWidgetState(binding, { modelContent: 'not allowed' })
    ]) { try { await action(); failures.push('unexpected success'); } catch (e) { failures.push(e.message); } }
    return failures;
  });
  assert.equal(stale.length, 4); stale.forEach(message => assert.match(message, /已修改或删除/));
  assert.equal(records.get(owner, 'chats', 4), null);
  assert.equal(records.get(owner, 'chats', 1).widget.id, next.id);

  // A -> B -> A is still a terminal lifetime, even if the DB object is unchanged.
  await page.evaluate(p => {
    window.accountResult = probe.openWidgetSession(6, p, { waitForSource: true }).then(() => 'unexpected success', e => e.message);
  }, old);
  await page.waitForFunction(() => probe.reads[6] > 0);
  const account = await page.evaluate(async () => {
    probe.accountLifecycle.invalidate(); probe.accountLifetime('different-account'); probe.accountLifetime(window.owner);
    const waiting = await accountResult;
    let bound;
    try { await probe.readWidgetState(liveBinding); bound = 'unexpected success'; } catch (e) { bound = e.message; }
    return { waiting, bound };
  });
  assert.equal(account.waiting, 'client_account_changed'); assert.equal(account.bound, 'client_account_changed');
  assert.deepEqual(errors, []);
  const report = { status: 'PASS', coverage: ['wait exact source revision', 'abort unsubscribes', 'unmount unsubscribes', 'bounded timeout and explicit retry', 'stale revision read/save rejection', 'deleted source read/save rejection', 'A-B-A lifetime cancellation and old binding rejection'], pageErrors: errors };
  fs.writeFileSync(path.join(shots, 'ownership-report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
