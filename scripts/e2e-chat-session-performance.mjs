/** Production app, real SQLite/DSH/IDB/React; only model HTTP is scripted.
 * Opt-in DEV counters count component calls, not DOM mutation guesses. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-session-performance-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
let projections = 0, calls = 0, controller;
const original = ClientRuntimeDomain.prototype.sessionProjection;
ClientRuntimeDomain.prototype.sessionProjection = function (...args) { projections++; return original.apply(this, args); };
const sse = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const encoder = new TextEncoder();
const chunk = text => controller.enqueue(encoder.encode(sse({ content: text })));
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async url => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid'); calls++;
  return new Response(new ReadableStream({ start(value) { controller = value; chunk('流式开始。'); } }), { headers: { 'content-type': 'text/event-stream' } });
} });
let web, browser, page, store;
const evidence = { directory, renders: {}, assertions: [], errors: [], requests: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const password = 'chat-performance-fixture-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  const owner = (await (await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).json()).user.id;
  const config = await (await context.request.get(origin + '/api/v1/cloud/config')).json();
  assert.equal((await context.request.put(origin + '/api/v1/cloud/config', { data: { ...config,
    providers: [{ id: 'fixture', name: 'Offline model', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'free-only', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' } } })).status(), 200);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  put('chatSessions', 901, { id: 901, videoId: '__library_assistant__', title: '性能与订阅验证', createdAt: 901 });
  put('chatSessions', 902, { id: 902, videoId: '__library_assistant__', title: '分页与切换验证', createdAt: 900 });
  for (let n = 0; n < 65; n++) put('chats', 2000 + n, { id: 2000 + n, sessionId: 902, role: n % 2 ? 'assistant' : 'user', content: `分页历史 ${n}`, createdAt: n + 1 });
  put('chatSessions', 903, { id: 903, videoId: '__library_assistant__', title: '分页竞争验证', createdAt: 899 });
  for (let n = 0; n < 105; n++) put('chats', 3000 + n, { id: 3000 + n, sessionId: 903, role: n % 2 ? 'assistant' : 'user', content: `竞争历史 ${n}`, createdAt: n + 1 });
  for (let n = 0; n < 8; n++) put('chats', 1000 + n, { id: 1000 + n, sessionId: 901, role: n % 2 ? 'assistant' : 'user', content: `历史消息 ${n}`, createdAt: n + 1 });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) evidence.requests.push(new URL(request.url()).pathname); });
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://model.invalid/**', () => { throw new Error('browser model execution forbidden'); });
  await page.goto(origin);
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await input.waitFor({ timeout: 60000 });
  await page.locator('[data-chat-message="stored-1007"]').waitFor();
  await page.evaluate(async () => {
    const { observeChatRenders } = await import('/src/client/chat-diagnostics.ts');
    window.__renders = {};
    observeChatRenders((kind, id) => { const key = id ? `row:${id}` : kind; window.__renders[key] = (window.__renders[key] ?? 0) + 1; });
  });
  // Same identity, no running task: layout metadata must not be frozen with the
  // message membership array, while ordinary assistant chunks stay row-local.
  const idleAnswer = records.get(owner, 'chats', 1007);
  put('chats', 1007, { ...idleAnswer, interrupted: true, interruptReason: 'remote idle change' });
  await page.locator('[data-chat-message="stored-1007"]').getByTestId('chat-continue').waitFor();
  put('chats', 1007, { ...idleAnswer, interrupted: false });
  await page.locator('[data-chat-message="stored-1007"]').getByTestId('chat-continue').waitFor({ state: 'detached' });
  put('chats', 1006, { ...records.get(owner, 'chats', 1006), content: '更新后的用户导航' });
  await page.getByRole('button', { name: '第 4 条提问：更新后的用户导航', exact: true }).waitFor();
  evidence.assertions.push('idle same-key remote interrupted true/false toggles continue affordance; same-key user text updates navigation label');
  const geometry = () => page.getByTestId('course-chat-messages').evaluate(element => ({ top: element.getBoundingClientRect().top, height: element.clientHeight }));
  const beforeStudy = projections, beforeGeometry = await geometry();
  // Observe transient recovery UI across every frame, not merely the final DOM.
  await page.evaluate(() => {
    window.__recoveryFrames = 0;
    window.__recoveryObserver = new MutationObserver(() => {
      if ([...document.querySelectorAll('section')].some(node => /待提交修改|Pending changes/.test(node.getAttribute('aria-label') ?? ''))) window.__recoveryFrames++;
    });
    window.__recoveryObserver.observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.evaluate(async () => {
    const { submitLearning, learningEdit } = await import('/src/client/learning.ts');
    await submitLearning([learningEdit({ kind: 'studyTime', date: '2026-11-05', seconds: 60, updatedAt: Date.now() })], ['study:2026-11-05']);
  });
  await page.waitForTimeout(500);
  evidence.unrelatedStudy = { projections: projections - beforeStudy, before: beforeGeometry, after: await geometry(), recoveryFrames: await page.evaluate(() => window.__recoveryFrames) };
  assert.equal(evidence.unrelatedStudy.projections, 0, 'studyTime does not recapture a session projection');
  assert.deepEqual(evidence.unrelatedStudy.after, beforeGeometry, 'normal command does not change chat viewport');
  assert.equal(evidence.unrelatedStudy.recoveryFrames, 0);
  evidence.assertions.push('unrelated studyTime: zero session projection reads, zero transient recovery frames, unchanged chat viewport');
  await input.fill('开始可控的长回答'); await input.press('Enter');
  await page.getByText('流式开始。', { exact: false }).first().waitFor();
  await page.waitForTimeout(1000); // Finish the once-per-message entrance, outside measured token work.
  const before = await page.evaluate(() => ({ ...window.__renders }));
  const keys = await page.locator('[data-chat-message]').evaluateAll(elements => elements.map(element => element.dataset.chatMessage));
  const tail = keys.at(-1), historical = keys.filter(key => key !== tail);
  for (let n = 0; n < 12; n++) { chunk(` 第${n}段中文增量。`); await page.waitForTimeout(140); }
  await page.getByText('第11段中文增量。', { exact: false }).first().waitFor();
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({ ...window.__renders }));
  const delta = Object.fromEntries(Object.keys(after).map(key => [key, after[key] - (before[key] ?? 0)]));
  evidence.renders = { before, after, delta, tail, historical };
  assert.ok(before.CourseChat > 0 && before.CourseChatInputRegion > 0, 'probe observes actual component invocations during send');
  assert.ok(delta[`row:${tail}`] >= 6, 'tail really rendered multiple server checkpoints');
  for (const key of historical) assert.equal(delta[`row:${key}`] ?? 0, 0, `historical ${key} did not render on content growth`);
  assert.equal(delta.CourseChat ?? 0, 0, 'page root does not render on tail growth');
  assert.equal(delta.CourseChatInputRegion ?? 0, 0, 'input region does not render on tail growth');
  await page.screenshot({ path: path.join(directory, 'stream-desktop.png'), animations: 'disabled' });
  // Reader intent must survive subsequent growth.
  await page.getByTestId('course-chat-messages').hover();
  const followingTop = await page.getByTestId('course-chat-messages').evaluate(element => element.scrollTop);
  assert.ok(followingTop > 0, 'fixture has a scrollable history');
  await page.mouse.wheel(0, -700);
  // Playwright wheel returns before the browser applies the native scroll.
  await page.waitForFunction(top => document.querySelector('[data-testid="course-chat-messages"]').scrollTop < top, followingTop);
  await page.waitForTimeout(150);
  const readingTop = await page.getByTestId('course-chat-messages').evaluate(element => element.scrollTop);
  chunk('\n\n向上阅读时追加内容。'.repeat(30)); await page.waitForTimeout(300);
  assert.equal(await page.getByTestId('course-chat-messages').evaluate(element => element.scrollTop), readingTop);
  await page.setViewportSize({ width: 390, height: 844 }); await input.fill('窄屏原稿保持');
  await page.screenshot({ path: path.join(directory, 'stream-mobile.png'), animations: 'disabled' });
  controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); controller = undefined;
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  assert.equal(await input.innerText(), '窄屏原稿保持'); assert.equal(calls, 1);
  await page.reload(); await page.getByText('向上阅读时追加内容。', { exact: false }).first().waitFor();
  assert.equal(await page.locator('.t-stream-w').count(), 0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(902));
  await page.locator('[data-chat-message="stored-2064"]').waitFor();
  await page.getByTestId('course-chat-messages').hover(); await page.mouse.wheel(0, -150);
  await page.waitForTimeout(250);
  const anchor = await page.getByTestId('course-chat-messages').evaluate(element => {
    const top = element.getBoundingClientRect().top;
    const row = [...element.querySelectorAll('[data-chat-message]')].find(row => row.getBoundingClientRect().top > top + 80);
    return { key: row.dataset.chatMessage, top: row.getBoundingClientRect().top };
  });
  const olderBefore = await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().messages.length);
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadOlder());
  await page.waitForFunction(async count => (await import('/src/store/courseChat.ts')).useCourseChat.getState().messages.length > count, olderBefore);
  await page.waitForTimeout(250);
  const anchorAfter = await page.locator(`[data-chat-message="${anchor.key}"]`).evaluate(element => element.getBoundingClientRect().top);
  evidence.pagination = { anchor, after: anchorAfter, olderBefore, olderAfter: await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().messages.length) };
  assert.ok(Math.abs(anchor.top - anchorAfter) <= 2, 'prepend preserves the visible row anchor');
  await page.screenshot({ path: path.join(directory, 'pagination-desktop.png'), animations: 'disabled' });
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(903));
  await page.locator('[data-chat-message="stored-3104"]').waitFor();
  let fetched, resume;
  const fetchedPage = new Promise(resolve => { fetched = resolve; });
  const responseGate = new Promise(resolve => { resume = resolve; });
  await page.route('**/api/clientRuntime/read', async route => {
    const response = await route.fetch(); fetched(); await responseGate; await route.fulfill({ response });
  });
  const pendingOlder = page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadOlder());
  await fetchedPage; // HTTP older page contains 40 rows and hasOlder=true.
  store.transaction(() => {
    put('chats', 3000, null);
    store.db.prepare('UPDATE client_session_cursors SET floor=cursor WHERE owner_id=? AND session_id=903').run(owner);
    store.db.prepare('DELETE FROM client_session_events WHERE owner_id=? AND session_id=903').run(owner);
  });
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).retryChatSync(903));
  await page.waitForFunction(async () => {
    const state = (await import('/src/store/courseChat.ts')).useCourseChat.getState();
    return state.messages.length === 104 && state.hasOlder === false;
  });
  resume(); await pendingOlder; await page.unroute('**/api/clientRuntime/read');
  const race = await page.evaluate(async () => {
    const state = (await import('/src/store/courseChat.ts')).useCourseChat.getState();
    return { count: state.messages.length, hasOlder: state.hasOlder, loadingOlder: state.loadingOlder, deletedRowReappeared: state.messages.some(message => message.rowId === 3000) };
  });
  assert.deepEqual(race, { count: 104, hasOlder: false, loadingOlder: false, deletedRowReappeared: false });
  evidence.paginationRace = race;
  evidence.assertions.push('production loadOlder delayed HTTP hasOlder=true cannot overwrite a 104-row full gap baseline hasOlder=false');
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(901));
  await page.getByText('向上阅读时追加内容。', { exact: false }).first().waitFor();
  assert.equal(await page.locator('[data-chat-message="stored-2064"]').count(), 0, 'B history never leaks into A');
  evidence.assertions.push('real React A→B→A selection, older-page prepend retains visible row position within 2px');
  evidence.assertions.push('12 tail checkpoints: historical rows/root/input zero renders; manual reading preserved; desktop/mobile screenshots; reload uses durable answer');
  assert.deepEqual(evidence.errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS real render/network/viewport counters. Evidence: ${directory}`);
} catch (error) {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  if (page) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText()); }
  console.error('Evidence:', directory); throw error;
} finally {
  if (controller) { controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
  await browser?.close(); await web?.close(); await app.close(); store?.close();
  ClientRuntimeDomain.prototype.sessionProjection = original;
}
