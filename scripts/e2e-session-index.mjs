/** Real product sidebar with isolated API; no model/external network calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-index-ui-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, web, store, page;
const errors = [];
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const init = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'session-index-ui-123' } });
  assert.equal(init.statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'session-index-ui-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const write = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
  write('preferences', 'uiLanguage', { id: 'uiLanguage', value: 'zh-CN' });
  store.transaction(() => {
    for (let id = 1; id <= 121; id++) {
      write('chatSessions', id, { id, videoId: '__library_assistant__', title: `Index fixture ${id}`, createdAt: id, ...(id === 1 ? { skillIds: [7], mcpServerIds: ['server-fixture'] } : {}) });
      write('chats', id, { id, sessionId: id, videoId: '__library_assistant__', role: 'user', createdAt: id, content: `private body ${id}` });
    }
    for (let id = 1001; id <= 1061; id++) write('chatSessions', id, { id, videoId: '__library_assistant__', title: `Archived fixture ${id}`, createdAt: id, archived: true });
  });
  process.env.WANGKE_API_PROXY = backend;
  web = await createServer({ root: path.resolve('apps/web'), cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } }); await web.listen();
  const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
  await context.route('https://**', route => route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  const rows = page.locator('[role="option"][data-testid^="chat-recent-"]');
  const assertLastPage = async () => {
    const ids = await rows.evaluateAll(elements => elements.map(element => Number(element.dataset.testid.slice('chat-recent-'.length))));
    assert.deepEqual(ids.filter(id => id <= 21).sort((a, b) => a - b), Array.from({ length: 21 }, (_, index) => index + 1));
    const extras = ids.filter(id => id > 21);
    assert.ok(extras.length <= 1, 'oldest 21 fixtures plus at most one active conversation');
    if (extras.length) assert.equal(await page.getByTestId(`chat-recent-${extras[0]}`).getAttribute('aria-selected'), 'true');
  };
  await page.getByTestId('chat-recent-121').waitFor({ timeout: 60000 });
  assert.ok(await rows.count() <= 51, '50 navigation rows plus the active conversation at most');
  await page.getByTestId('chat-recent-next').click();
  await page.getByTestId('chat-recent-71').waitFor();
  assert.ok(await rows.count() <= 51);
  await page.getByTestId('chat-recent-previous').click();
  await page.getByTestId('chat-recent-121').waitFor();
  assert.equal(await page.getByTestId('chat-recent-previous').count(), 0);
  // Actual HTTP finishes before a newer pushed head, then arrives late.
  let resume, fetched, delivered;
  const gate = new Promise(resolve => { resume = resolve; }), read = new Promise(resolve => { fetched = resolve; });
  const delivery = new Promise(resolve => { delivered = resolve; });
  await page.route('**/api/clientRuntime/read', async route => {
    const request = route.request().postDataJSON()?.payload?.args?.request;
    if (request?.kind !== 'sessionIndex' || !request.cursor) return route.continue();
    const response = await route.fetch(); fetched(); await gate; await route.fulfill({ response }); delivered();
  });
  await page.getByTestId('chat-recent-next').click(); await read;
  write('chatSessions', 121, { ...records.get(owner, 'chatSessions', 121), title: 'Pushed newer head' });
  await page.getByTestId('chat-recent-121').getByText('Pushed newer head', { exact: true }).waitFor();
  resume(); await delivery; await page.unrouteAll({ behavior: 'wait' });
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId('chat-recent-71').count(), 0, 'late old page cannot overwrite pushed navigation');
  await page.route('**/api/clientRuntime/read', route => {
    const request = route.request().postDataJSON()?.payload?.args?.request;
    return request?.kind === 'sessionIndex' && request.cursor
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue();
  });
  await page.getByTestId('chat-recent-next').click();
  await page.getByText('会话列表暂时无法更新', { exact: true }).waitFor();
  assert.equal(await page.getByTestId('chat-recent-121').count(), 1, 'failed page preserves the previous view');
  await page.unroute('**/api/clientRuntime/read');
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByTestId('chat-recent-next').click(); await page.getByTestId('chat-recent-71').waitFor();
  await page.getByTestId('chat-recent-next').click(); await page.getByTestId('chat-recent-1').waitFor();
  await assertLastPage();
  // The oldest conversation is outside the store's 50-row landing projection.
  // Poison only its disposable metadata cache: opening must read server truth.
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { markCloudApply } = await import('/src/cloud/cache.ts');
    await db.transaction('rw', db.chatSessions, async () => {
      markCloudApply();
      await db.chatSessions.put({ id: 1, videoId: '__library_assistant__', title: 'stale local metadata', createdAt: 1, skillIds: [999] });
    });
  });
  await page.getByTestId('chat-recent-1').click();
  await page.waitForFunction(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    const state = useCourseChat.getState();
    return state.activeId === 1 && state.skillIds?.[0] === 7 && state.mcpServerIds?.[0] === 'server-fixture';
  });
  assert.ok(await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().sessions.length <= 51));
  assert.equal(await page.getByTestId('chat-recent-next').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  // Narrow layout opens the same persistent bounded navigation in its drawer.
  const menu = page.getByRole('button', { name: '打开导航', exact: true });
  await menu.click();
  await page.getByTestId('chat-recent-1').waitFor({ state: 'visible' });
  await page.getByTestId('chat-recent-previous').click();
  await page.getByTestId('chat-recent-71').waitFor({ state: 'visible' });
  assert.ok(await rows.count() <= 51);
  await page.getByTestId('chat-recent-next').click();
  await page.getByTestId('chat-recent-1').waitFor({ state: 'visible' });
  await assertLastPage();
  await page.screenshot({ path: path.join(directory, 'sidebar.png') });
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByTestId('nav-rail-account').click();
  await page.getByTestId('account-menu-archived').click();
  await page.getByTestId('archived-1061').waitFor();
  const archivedRows = page.locator('[data-testid^="archived-restore-"]');
  assert.equal(await archivedRows.count(), 50);
  await page.getByTestId('archived-next').click();
  await page.getByTestId('archived-1001').waitFor();
  assert.equal(await archivedRows.count(), 11);
  await page.getByTestId('archived-previous').click();
  await page.getByTestId('archived-restore-1061').click();
  await page.getByTestId('archived-1061').waitFor({ state: 'detached' });
  assert.equal(records.get(owner, 'chatSessions', 1061).archived, undefined, 'restore is a server command, not a local projection edit');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, browser: process.env.BROWSER ?? 'chromium', checks: ['50-row forward/backward navigation', 'late HTTP vs pushed scope head', '503 retains previous page and retry recovers', 'complete traversal reaches oldest conversation', 'exact selected-session read replaces stale IDB metadata', 'narrow drawer forward/backward pagination', 'archived 61-session forward/backward pages and server restore'], errors }, null, 2));
  console.log(`PASS real sidebar session index: ${directory}`);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(directory, 'failure.png') }); fs.writeFileSync(path.join(directory, 'failure.txt'), await page.locator('body').innerText()); }
  throw error;
} finally { await browser?.close(); await web?.close(); await api.close(); store?.close(); }
