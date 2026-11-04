import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-model-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, store;
const documentRequests = [];
const diagnostic = process.env.SESSION_RELOAD_DIAGNOSTIC === '1';
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { startCloud } from '/src/cloud/sync.ts';
import { useCourseChat } from '/src/store/courseChat.ts';
import CloudActivity from '/src/cloud/Activity.tsx';
import { serverRuntime, disposeServerRuntime } from '/src/client/bootstrap.ts';
import { submitCloudTask } from '/src/cloud/tasks.ts';
window.addEventListener('pagehide', () => console.log('lifecycle:pagehide-before-runtime'), { capture: true });
await startCloud(window.owner);
const runtime = await serverRuntime(window.owner);
const dispose = runtime.dispose;
runtime.dispose = () => { console.log('lifecycle:runtime-dispose-enter'); const result = dispose(); console.log('lifecycle:runtime-dispose-return'); return result.finally(() => console.log('lifecycle:runtime-dispose-done')); };
await useCourseChat.getState().bootstrap();
await useCourseChat.getState().loadSession(900001);
window.probe = { state: () => useCourseChat.getState(), load: id => useCourseChat.getState().loadSession(id), invalidate: disposeServerRuntime,
  older: () => useCourseChat.getState().loadOlder(), diagnostics: async () => (await serverRuntime(window.owner)).diagnostics(),
  sessionDiagnostics: async id => (await serverRuntime(window.owner)).session(id).diagnostics(),
   submit: (operationId = 'session-lost-response-operation') => submitCloudTask('chat', 'session:900001', { sessionId: 900001, text: 'retained lost-response draft' }, operationId) };
function Conversation() { const messages = useCourseChat(s => s.messages); return React.createElement('pre', { id: 'messages' }, JSON.stringify(messages)); }
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null, React.createElement(CloudActivity), React.createElement(Conversation)));
document.body.dataset.ready = 'yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'production-session-fixture', resolveId: id => id === '/__session-entry.js' ? '\0session-fixture' : undefined,
      load: id => id === '\0session-fixture' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__session') return next(); documentRequests.push({ at: Date.now(), url: req.url }); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__session-entry.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true, ...(process.env.SESSION_BROWSER_CHANNEL ? { channel: process.env.SESSION_BROWSER_CHANNEL } : {}), ...(diagnostic ? { args: [`--js-flags=--prof --logfile=${directory}/v8.log`] } : {}) });
  const context = await browser.newContext();
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'session-model-password-123' } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'session-model-password-123' } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  records.apply(owner, [900001, 900002].map(id => ({ id: `session-${id}`, table: 'chatSessions', key: id, before: null, after: { id, title: `Session ${id}`, createdAt: id } })));
  records.apply(owner, Array.from({ length: 65 }, (_, index) => ({ id: `session-row-${index}`, table: 'chats', key: 910000 + index, before: null,
    after: { id: 910000 + index, sessionId: 900001, role: 'assistant', content: `History ${index}`, createdAt: index } })));
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(), errors = [], requests = [], sockets = [];
  const lifecycle = [];
  page.on('console', message => { if (message.text().startsWith('lifecycle:')) lifecycle.push(message.text()); });
  const inflight = new Map();
  page.on('request', request => inflight.set(request, { url: request.url(), at: Date.now() }));
  page.on('requestfinished', request => inflight.delete(request));
  page.on('requestfailed', request => inflight.delete(request));
  page.on('dialog', dialog => void dialog.accept());
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { const pathname = new URL(request.url()).pathname; if (pathname.startsWith('/api/')) requests.push(pathname); });
  page.on('websocket', socket => { if (new URL(socket.url()).pathname === '/api/remote.mux') sockets.push(socket); });
  await page.goto(`${origin}/__session`);
  await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  await page.waitForFunction(() => probe.state().messages.length === 40);
  assert.equal(await page.evaluate(() => probe.state().hasOlder), true);
  await page.evaluate(() => probe.older());
  await page.waitForFunction(() => probe.state().messages.length === 65);
  records.apply(owner, [{ id: 'session-external-row', table: 'chats', key: 920000, before: null, after: { id: 920000, sessionId: 900001, role: 'assistant', content: 'pushed committed answer', createdAt: 70 } }]);
  await page.waitForFunction(() => probe.state().messages.some(message => message.content === 'pushed committed answer'));
  assert.equal(await page.evaluate(() => probe.state().messages.length), 66, 'tail push preserves paginated history');
  const now = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,progress,created_at,updated_at) VALUES('session-progress',?,'session-progress','chat','session:900001',?,'running',?,?,?)")
    .run(owner, JSON.stringify({ sessionId: 900001, text: 'remote pending question' }), JSON.stringify({ content: 'typed remote progress' }), now, now);
  await page.waitForFunction(() => probe.state().messages.some(message => message.content === 'typed remote progress' && message.streaming));
  records.apply(owner, [{ id: 'session-progress-committed', table: 'chats', key: 920001, before: null, after: { id: 920001, sessionId: 900001, taskId: 'session-progress', role: 'assistant', content: 'terminal committed answer', createdAt: 80 } }]);
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result=? WHERE id='session-progress'").run(JSON.stringify({ rowId: 920001, content: 'terminal committed answer' }));
  await page.waitForFunction(() => probe.state().messages.filter(message => message.taskId === 'session-progress' && message.role === 'ai').length === 1 && probe.state().messages.some(message => message.content === 'terminal committed answer' && !message.syncPending));
  await page.waitForTimeout(500);
  requests.length = 0;
  await page.waitForTimeout(diagnostic ? 0 : 60000);
  assert.deepEqual(requests, [], 'production ordinary conversation has zero idle API requests');
  const idleRequests = [...requests];
  const socketsBeforeReload = sockets.length;
  assert.equal(sockets.length, 1, 'records/session/tasks share one business socket');
  await page.evaluate(() => probe.load(900002));
  await page.waitForFunction(async () => !(await probe.sessionDiagnostics(900001)).active);
  // The server commits admission, then the response is lost. Recovery must query
  // the durable nonce rather than silently creating a second model invocation.
  await page.route('**/api/clientRuntime/submitTask', async route => { await route.fetch(); await route.abort('failed'); });
  const failedSubmit = await page.evaluate(async () => { try { await probe.submit(); return false; } catch { return true; } });
  assert.equal(failedSubmit, true);
  await page.getByRole('button', { name: '核对收据并使用原命令重试' }).waitFor();
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, 'session-lost-response-operation').n, 1);
  await page.unroute('**/api/clientRuntime/submitTask');
  assert.equal((await context.request.get(`${origin}/__session`, { timeout: 10000 })).status(), 200, 'fixture server still serves the document before reload');
  const debuggerSession = await context.newCDPSession(page);
  if (process.env.SESSION_DEBUGGER === '1') await debuggerSession.send('Debugger.enable');
  debuggerSession.on('Debugger.paused', event => {
    fs.writeFileSync(path.join(directory, 'reload-stack.json'), JSON.stringify(event, null, 2));
    void debuggerSession.send('Debugger.resume').catch(() => {});
  });
  const stackTimer = setTimeout(() => {
    if (process.env.SESSION_DEBUGGER === '1') void debuggerSession.send('Debugger.pause').catch(() => {});
  }, 8000);
  try { await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }); }
  catch (error) {
    fs.writeFileSync(path.join(directory, 'reload-failure.json'), JSON.stringify({ lifecycle, documentRequests, inflight: [...inflight.values()], errors, requests, tasks: store.db.prepare('SELECT id,nonce,status FROM cloud_tasks').all() }, null, 2));
    console.error('Reload failure evidence', directory);
    throw error;
  } finally { clearTimeout(stackTimer); void debuggerSession.detach().catch(() => {}); }
  await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  assert.equal(await page.getByRole('button', { name: '核对收据并使用原命令重试' }).count(), 0, 'accepted lost response reconciles on restart');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, 'session-lost-response-operation').n, 1, 'restart never dispatches a second task');
  // A request lost before admission is a different recovery case: startup may
  // only read its receipt. Only this explicit UI action can resubmit the draft.
  await page.route('**/api/clientRuntime/submitTask', route => route.abort('failed'));
  assert.equal(await page.evaluate(async () => { try { await probe.submit('session-missing-admission-operation'); return false; } catch { return true; } }), true);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, 'session-missing-admission-operation').n, 0);
  await page.unroute('**/api/clientRuntime/submitTask');
  const submissionsBeforeMissingReload = requests.filter(path => path === '/api/clientRuntime/submitTask').length;
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: '核对收据并使用原命令重试', exact: true }).waitFor();
  assert.equal(requests.filter(path => path === '/api/clientRuntime/submitTask').length, submissionsBeforeMissingReload, 'missing admission restart must never dispatch');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, 'session-missing-admission-operation').n, 0);
  await page.getByRole('button', { name: '核对收据并使用原命令重试', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '发送尚未确认。原命令已保留' }).waitFor({ state: 'hidden' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner, 'session-missing-admission-operation').n, 1, 'explicit retry reuses the original operation once');
  const performanceSession = await context.newCDPSession(page);
  await performanceSession.send('Performance.enable');
  const beforeInvalidation = await performanceSession.send('Performance.getMetrics');
  const heartbeat = page.evaluate(() => new Promise(resolve => { probe.invalidate(); setTimeout(() => resolve('event-loop-yielded'), 1000); }));
  let heartbeatTimer;
  try { assert.equal(await Promise.race([heartbeat, new Promise((_, reject) => { heartbeatTimer = setTimeout(() => reject(new Error('runtime_invalidation_starved_event_loop')), 5000); })]), 'event-loop-yielded'); }
  finally { clearTimeout(heartbeatTimer); }
  const afterInvalidation = await performanceSession.send('Performance.getMetrics');
  const metric = (result, name) => result.metrics.find(item => item.name === name)?.value ?? 0;
  const invalidationTaskSeconds = metric(afterInvalidation, 'TaskDuration') - metric(beforeInvalidation, 'TaskDuration');
  assert.ok(invalidationTaskSeconds < 0.5, `invalidated runtime must not burn a full CPU: ${invalidationTaskSeconds}s task time over 1s`);
  await performanceSession.detach();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ history: 65, idleSeconds: diagnostic ? 0 : 60, idleRequests, socketsBeforeReload, socketsAcrossReload: sockets.length, lifecycle, invalidationTaskSeconds, errors }, null, 2));
  console.log(`${diagnostic ? 'DIAGNOSTIC ONLY (no idle acceptance)' : 'PASS production courseChat + SessionTimelineModel + typed SessionModel + Activity/records mux, pagination/progress/terminal identity/60s idle'}. Evidence: ${directory}`);
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
