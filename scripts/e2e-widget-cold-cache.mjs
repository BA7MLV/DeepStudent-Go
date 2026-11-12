/** Focused real API/Chromium gate. No production data or paid provider. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/widget-cold-cache-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('provider execution forbidden'); } });
const evidence = { checks: [], environment: 'isolated API + Chromium, no account mirror or paid model' };
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import WidgetBlock from '/src/components/WidgetBlock.tsx';
import HtmlAnswer from '/src/components/HtmlAnswer.tsx';
import { ArtifactEditProvider } from '/src/components/ArtifactEditor.tsx';
import { db } from '/src/store/db.ts';
import { startCloud } from '/src/cloud/sync.ts';
import * as widgets from '/src/store/widgetState.ts';
import { openLegacyHtmlWork } from '/src/store/legacyHtmlWorks.ts';
import { disposeServerRuntime } from '/src/client/bootstrap.ts';
import '/src/i18n';
await startCloud(window.owner);
const root = createRoot(document.getElementById('root'));
window.probe = { get db() { return db; }, ...widgets, openLegacyHtmlWork, disposeServerRuntime };
window.renderWidget = (id, payload) => root.render(React.createElement(WidgetBlock, { key: id + ':' + payload.id, rowId: id, payload, dark: false, allowPopout: false }));
window.renderLegacy = (id, source) => root.render(React.createElement(ArtifactEditProvider, { key: id, rowId: id, content: source, disabled: false, onSaved() {} }, React.createElement(HtmlAnswer, { source, contentType: 'interactive', allowPopout: false })));
document.body.dataset.ready = 'yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'cache'),
    plugins: [{ name: 'widget-cold-cache-fixture', resolveId: id => id === '/__cold.js' ? '\0cold' : undefined,
      load: id => id === '\0cold' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__cold') return next();
        res.setHeader('content-type', 'text/html'); res.end('<main id="root"></main><script type="module" src="/__cold.js"></script>');
      }); } }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: null,
      proxy: { '/api': { target: api, changeOrigin: false, ws: true } } }, logLevel: 'warn' });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  // Playwright's serviceWorkers:block injects navigator.serviceWorker access
  // into opaque sandbox frames and itself raises SecurityError there.
  const context = await browser.newContext();
  await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: 'widget-cold-cache-password-123' } })).status(), 201);
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'widget-cold-cache-password-123' } });
  assert.equal(login.status(), 200); const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (key, value, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table: 'chats', key, before: records.get(account, 'chats', key), after: value }]);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: 1, before: null,
    after: { id: 1, videoId: '__library_assistant__', title: 'Cold widget', createdAt: 1 } }]);
  const payload = text => ({ id: text, ref: text, kind: 'html', schemaVersion: 1, revision: 1, source: 'tool', html: `<p>${text}</p>` });
  const original = payload('COLD_WIDGET_OK'), revised = payload('REVISED_WIDGET');
  const row = (id, widget = original) => ({ id, sessionId: 1, videoId: '__library_assistant__', role: 'assistant', content: 'Source', createdAt: id, widget });
  put(1, row(1)); put(2, row(2));
  const source = '<main><h1>COLD_LEGACY_OK</h1></main>';
  put(3, { ...row(3), widget: undefined, content: '```html interactive\n' + source + '\n```' });
  const other = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'other', new Date().toISOString());
  put(9, row(9), other);
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(); page.setDefaultTimeout(30000);
  const errors = [], frames = [], calls = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('websocket', socket => socket.on('framesent', frame => frames.push(String(frame.payload))));
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/clientRuntime/')) calls.push(request.postDataJSON()); });
  await page.goto(origin + '/__cold'); await page.locator('body[data-ready="yes"]').waitFor();
  assert.equal(await page.evaluate(() => probe.db.chats.count()), 0);
  await page.evaluate(p => renderWidget(1, p), original);
  await page.getByTestId('widget-frame').contentFrame().getByText('COLD_WIDGET_OK').waitFor();
  evidence.checks.push('cold historical widget opens from empty IDB');
  await page.evaluate(async p => { window.revisedBinding = await probe.openWidgetSession(1, p); }, original);
  put(1, row(1, revised));
  await page.getByTestId('widget-error').filter({ hasText: '已修改或删除' }).waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0);
  const modified = await page.evaluate(async () => {
    const result = [];
    for (const run of [() => probe.readWidgetState(revisedBinding), () => probe.saveWidgetState(revisedBinding, { modelContent: 'denied' })]) {
      try { await run(); result.push('unexpected success'); } catch (e) { result.push(e.message); }
    }
    return result;
  });
  modified.forEach(message => assert.match(message, /已修改或删除/));
  evidence.checks.push('server revision invalidates running frame without flush');
  await page.evaluate(p => renderWidget(2, p), original);
  await page.getByTestId('widget-frame').contentFrame().getByText('COLD_WIDGET_OK').waitFor();
  await page.evaluate(async p => { window.deletedBinding = await probe.openWidgetSession(2, p); }, original);
  put(2, null);
  await page.getByTestId('widget-error').filter({ hasText: '已修改或删除' }).waitFor();
  const stale = await page.evaluate(async () => {
    const result = [];
    for (const run of [() => probe.readWidgetState(deletedBinding), () => probe.saveWidgetState(deletedBinding, { modelContent: 'denied' })]) {
      try { await run(); result.push('unexpected success'); } catch (e) { result.push(e.message); }
    }
    return result;
  });
  stale.forEach(message => assert.match(message, /已修改或删除/));
  assert.equal(records.get(owner, 'chats', 2), null);
  evidence.checks.push('server deletion invalidates frame and read/save cannot resurrect');
  assert.equal(await page.evaluate(() => probe.db.chats.get(3)), undefined);
  await page.evaluate(source => renderLegacy(3, source), source);
  await page.getByTestId('widget-frame').contentFrame().getByRole('heading', { name: 'COLD_LEGACY_OK' }).waitFor();
  assert.equal(records.get(owner, 'chats', 3).content, '```html interactive\n' + source + '\n```');
  evidence.checks.push('cold legacy HTML adapts through real command and opens sandbox');
  put(3, { ...records.get(owner, 'chats', 3), content: 'HTML removed' });
  await page.getByTestId('widget-error').filter({ hasText: '已修改或删除' }).waitFor();
  assert.match(await page.evaluate(async source => { try { await probe.openLegacyHtmlWork(source, 3); return 'unexpected success'; } catch (e) { return e.message; } }, source), /已修改/);
  evidence.checks.push('legacy source revision invalidates frame even if cached adaptation survives');
  put(6, { ...row(6), widget: undefined, content: '```html interactive\n' + source + '\n```' });
  await page.evaluate(source => renderLegacy(6, source), source);
  await page.getByTestId('widget-frame').contentFrame().getByRole('heading', { name: 'COLD_LEGACY_OK' }).waitFor();
  put(6, null);
  await page.getByTestId('widget-error').filter({ hasText: '已修改或删除' }).waitFor();
  assert.equal(await page.getByTestId('widget-frame').count(), 0);
  assert.match(await page.evaluate(async source => { try { await probe.openLegacyHtmlWork(source, 6); return 'unexpected success'; } catch (e) { return e.message; } }, source), /已删除/);
  evidence.checks.push('legacy deletion destroys frame and refuses reopening');
  await page.evaluate(p => { window.waitingResult = 'pending'; probe.openWidgetSession(4, p, { waitForSource: true }).then(() => waitingResult = 'opened', e => waitingResult = e.message); }, original);
  await page.waitForFunction(() => probe.db.chats.get(4).then(row => row === undefined));
  assert.equal(await page.evaluate(() => waitingResult), 'pending');
  put(4, row(4)); await page.waitForFunction(() => waitingResult !== 'pending');
  assert.equal(await page.evaluate(() => waitingResult), 'opened');
  evidence.checks.push('missing not-yet-committed source waits then admits genuine server row');
  await page.evaluate(p => {
    window.cancel = new AbortController(); window.cancelResult = 'pending';
    probe.openWidgetSession(5, p, { waitForSource: true, signal: cancel.signal }).then(() => cancelResult = 'unexpected success', e => cancelResult = e.message);
  }, original);
  await page.evaluate(() => cancel.abort(new Error('fixture_cancelled')));
  await page.waitForFunction(() => cancelResult === 'fixture_cancelled'); put(5, row(5));
  assert.equal(await page.evaluate(() => cancelResult), 'fixture_cancelled');
  const denied = await page.evaluate(async p => { try { await probe.openWidgetSession(9, p); return 'unexpected success'; } catch (e) { return e.message; } }, original);
  assert.match(denied, /已修改或删除/);
  assert.equal(await page.evaluate(() => probe.db.chats.get(9)), undefined);
  evidence.checks.push('cancelled waiter stays rejected; foreign owner row never hydrated/admitted');
  await page.evaluate(p => renderWidget(8, p), original);
  await page.getByTestId('widget-error').filter({ hasText: '超时' }).waitFor({ timeout: 20000 });
  assert.equal(await page.getByTestId('widget-frame').count(), 0);
  put(8, row(8));
  // A late committed row does not revive a timed-out surface; explicit retry
  // is the only path back through normal source admission.
  await page.getByText('运行详情', { exact: true }).click();
  await page.getByRole('button', { name: '重试预览', exact: true }).click();
  await page.getByTestId('widget-frame').contentFrame().getByText('COLD_WIDGET_OK').waitFor();
  evidence.checks.push('bounded missing-source timeout and explicit retry after genuine commit');
  // Hold a real API response after the server read; invalidate A before releasing it.
  let release, reached, readsReached = 0;
  const barrier = new Promise(resolve => { release = resolve; });
  const intercepted = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/clientRuntime/**', async route => {
    const request = route.request().postDataJSON()?.payload?.args?.request;
    if (request?.kind !== 'recordKeys' || ![3, 4].includes(request.keys[0]?.key)) return route.continue();
    const response = await route.fetch(); if (++readsReached === 2) reached(); await barrier; await route.fulfill({ response }).catch(() => {});
  });
  await page.evaluate(p => { window.lateResult = 'pending'; probe.openWidgetSession(4, p).then(() => lateResult = 'unexpected success', e => lateResult = e.message); }, original);
  await page.evaluate(source => { window.lateHtml = 'pending'; probe.openLegacyHtmlWork(source, 3).then(() => lateHtml = 'unexpected success', e => lateHtml = e.message); }, source);
  await intercepted;
  await page.evaluate(p => {
    window.accountWait = 'pending';
    probe.openWidgetSession(7, p, { waitForSource: true }).then(() => accountWait = 'unexpected success', e => accountWait = e.message);
  }, original);
  await page.evaluate(() => probe.disposeServerRuntime()); release();
  await page.waitForFunction(() => lateResult !== 'pending');
  assert.match(await page.evaluate(() => lateResult), /client_account_changed|client_runtime_disposed|abort/i);
  await page.waitForFunction(() => lateHtml !== 'pending');
  assert.match(await page.evaluate(() => lateHtml), /client_account_changed|client_runtime_disposed|abort/i);
  await page.waitForFunction(() => accountWait !== 'pending');
  assert.match(await page.evaluate(() => accountWait), /client_account_changed|client_runtime_disposed|abort/i);
  assert.match(await page.evaluate(async () => { try { await probe.readWidgetState(deletedBinding); return 'unexpected success'; } catch (e) { return e.message; } }), /client_account_changed/);
  evidence.checks.push('late real HTTP response rejected after terminal account invalidation');
  assert.ok(!frames.some(frame => /followRecords|recordsPage|"kind":"records"/.test(frame)));
  assert.ok(!calls.some(call => /records|collectionPage/.test(call?.payload?.args?.request?.kind ?? '')));
  assert.deepEqual(errors, []);
  evidence.checks.push('no mirror/full-table request and no page errors');
  evidence.status = 'PASS';
} catch (error) { evidence.status = 'FAIL'; evidence.error = error.stack; process.exitCode = 1; }
finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ directory, ...evidence }, null, 2));
  await browser?.close(); await web?.close(); store?.close(); await app.close();
}
