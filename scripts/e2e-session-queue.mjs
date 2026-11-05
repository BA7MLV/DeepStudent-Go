import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-queue-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, web, store;
const evidence = { assertions: [], requests: [], errors: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import { startCloud } from '/src/cloud/sync.ts';
import { cloud } from '/src/cloud/state.ts';
import { useCourseChat, flushChatQueue } from '/src/store/courseChat.ts';
import { browserChatQueue } from '/src/client/chat-queue.ts';
import { retryPendingTaskCommand, submitCloudTask, reconcileTaskAdmissions } from '/src/cloud/tasks.ts';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import CloudActivity from '/src/cloud/Activity.tsx';
import { serverRuntime, disposeServerRuntime } from '/src/client/bootstrap.ts';
import { db } from '/src/store/db.ts';
await startCloud(window.owner);
await useCourseChat.getState().bootstrap();
if (!useCourseChat.getState().queued.length) await useCourseChat.getState().loadSession(Number(new URL(location.href).searchParams.get('session') || 900001));
window.probe = {
 state: () => useCourseChat.getState(),
 enqueue: async (text, files = []) => { useCourseChat.getState().enqueue(text, files, [42]); await flushChatQueue(); return useCourseChat.getState().queued.at(-1); },
 edit: async (id, text) => { useCourseChat.getState().updateQueued(id,text); await flushChatQueue(); },
 clear: async () => { useCourseChat.getState().clearQueue(); await flushChatQueue(); },
 remove: async id => { useCourseChat.getState().removeQueued(id); await flushChatQueue(); },
 send: id => useCourseChat.getState().sendQueuedNow(id),
 retry: retryPendingTaskCommand,
 reconcile: reconcileTaskAdmissions,
 mountActivity: () => { if (!window.activityRoot) { window.activityRoot = createRoot(document.getElementById('activity')); window.activityRoot.render(createElement(CloudActivity)); } },
 unmountActivity: () => { window.activityRoot?.unmount(); window.activityRoot = undefined; },
 nonchat: operationId => submitCloudTask('modelOnce','fixture:model',{text:'nonchat original'},operationId),
 retireRuntime: async () => { disposeServerRuntime(); await serverRuntime(window.owner); },
 direct: text => useCourseChat.getState().send(text),
 newDraft: () => useCourseChat.getState().createSession(),
 rows: () => db.chats.toArray(),
 continue: () => { const message = useCourseChat.getState().messages.find(item => item.rowId === 910001); if (!message) throw new Error('continuation fixture missing'); return useCourseChat.getState().retryMessage(message.key); },
 meta: () => db.table('_cloudMeta').toArray(),
 file: id => db.files.get(id),
 putFile: id => db.files.put({ id, name: id, blob: new Blob(['fixture']), mimeType: 'text/plain', size: 7 }),
 list: () => browserChatQueue().list(900001),
 switchAccount: () => { cloud.userId = 'another-account'; window.dispatchEvent(new Event('wangke:bot-session-ended')); },
};
const activity = document.createElement('main'); activity.id = 'activity'; document.body.append(activity);
document.body.dataset.ready = 'yes';`;
  const localFixture = `
import { useCourseChat, flushChatQueue } from '/src/store/courseChat.ts';
import { db } from '/src/store/db.ts';
window.modelCalls = 0;
const nativeFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
 if (!String(url).includes('/chat/completions')) return nativeFetch(url,init);
 window.modelCalls++;
 throw new Error('browser_model_execution_forbidden');
};
await useCourseChat.getState().bootstrap();
window.probe = { state: () => useCourseChat.getState(), newDraft: () => useCourseChat.getState().createSession(), enqueue: async (text, files = []) => { useCourseChat.getState().enqueue(text, files); await flushChatQueue(); return useCourseChat.getState().queued.at(-1); }, send: id => useCourseChat.getState().sendQueuedNow(id), rows: () => db.chats.toArray(),
  putFile: id => db.files.put({ id, blob: new Blob(['fixture']) }), file: id => db.files.get(id),
  edit: async (id, text) => { useCourseChat.getState().updateQueued(id, text); await flushChatQueue(); },
  clear: async () => { useCourseChat.getState().clearQueue(); await flushChatQueue(); },
};
document.body.dataset.ready = 'yes';`;
  const isolationFixture = `
import { cloud } from '/src/cloud/state.ts';
import { useCloudDatabase } from '/src/store/db.ts';
import { browserChatQueue } from '/src/client/chat-queue.ts';
cloud.enabled = true; cloud.userId = window.owner; useCloudDatabase(window.owner);
window.isolatedQueue = await browserChatQueue().list(900001);
document.body.dataset.ready = 'yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'session-queue-production-fixture', resolveId: id => ({'/__queue-entry.js':'\0queue-fixture','/__local-entry.js':'\0local-fixture','/__isolation-entry.js':'\0isolation-fixture'})[id],
      load: id => ({'\0queue-fixture':fixture,'\0local-fixture':localFixture,'\0isolation-fixture':isolationFixture})[id],
      configureServer(server) { server.middlewares.use((req,res,next) => { const entry = ({'/__queue':'queue','/__local-queue':'local','/__queue-isolation':'isolation'})[req.url.split('?')[0]]; if (!entry) return next(); res.setHeader('content-type','text/html'); res.end('<script type="module" src="/__'+entry+'-entry.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: Number(process.env.SESSION_QUEUE_PORT || 52941), strictPort: true, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE,'utf8').trim() }, data: { adminPassword: 'queue-password-123' } });
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'queue-password-123' } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory,'db.sqlite'),path.join(directory,'files/system-files'));
  const configuration = new CloudConfiguration(store, directory);
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fixture', name: 'Queue fixture (worker disabled)', protocol: 'openai-chat', apiKey: 'fixture-only', baseUrl: 'https://never-called.invalid/v1', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  new CloudRecords(store).apply(owner, [{ id: 'queue-session', table: 'chatSessions', key: 900001, before: null, after: { id: 900001, videoId: '__library_assistant__', title: 'Queue fixture', createdAt: 1 } }]);
  await context.addInitScript(owner => { window.owner = owner; if (location.pathname === '/__queue-isolation') window.__WANGKE_CONFIG__ = {apiBaseUrl:'https://different-server.invalid'}; }, owner);
  const observe = page => {
    page.on('pageerror', error => evidence.errors.push(error.message));
    page.on('request', request => { if (request.url().includes('/api/clientRuntime/submitTask')) evidence.requests.push(request.postDataJSON()); });
    page.on('dialog', dialog => void dialog.accept());
  };
  const ready = async page => { await page.goto(`${origin}/__queue`); await page.locator('body[data-ready="yes"]').waitFor({timeout:60000}); };
  const page = await context.newPage(); observe(page); await ready(page);
  const count = operationId => store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(owner,operationId).n;
  const pending = await page.evaluate(() => probe.enqueue('before reload'));
  const trailing = await page.evaluate(() => probe.enqueue('second restored FIFO'));
  await page.evaluate(id => probe.edit(id,'edited before reload'), pending.id);
  await page.reload(); await page.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  assert.equal(await page.evaluate(() => probe.state().queued[0].text),'edited before reload');
  assert.equal(await page.evaluate(() => probe.state().queued[0].operationId),pending.operationId);
  assert.deepEqual(await page.evaluate(() => probe.state().queued.map(item => item.operationId)),[pending.operationId,trailing.operationId],'reload preserves FIFO rather than random UUID key order');
  await page.evaluate(id => probe.remove(id),trailing.id);
  assert.equal(count(pending.operationId),0);
  await page.evaluate(id => probe.send(id),pending.id);
  assert.equal(count(pending.operationId),1, JSON.stringify(await page.evaluate(() => ({ error: probe.state().historyError, queued: probe.state().queued, messages: probe.state().messages }))));
  assert.equal(JSON.parse(store.db.prepare('SELECT input FROM cloud_tasks WHERE nonce=?').get(pending.operationId).input).text,'edited before reload');
  evidence.assertions.push('enqueue/edit → real reload → restore → production send, original operation and skills');

  // A response lost AFTER durable admission is recovered read-only.
  const accepted = await page.evaluate(() => probe.enqueue('accepted but response lost'));
  await page.route('**/api/clientRuntime/submitTask',async route => { await route.fetch(); await route.abort('failed'); });
  await page.evaluate(id => probe.send(id).catch(() => {}),accepted.id);
  assert.equal(count(accepted.operationId),1);
  await page.unroute('**/api/clientRuntime/submitTask');
  const beforeReload = evidence.requests.length;
  await page.reload(); await page.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  assert.equal(count(accepted.operationId),1);
  assert.equal(evidence.requests.length,beforeReload);
  assert.equal(await page.evaluate(id => probe.state().queued.some(item => item.id === id),accepted.id),false);
  evidence.assertions.push('accepted response loss → reload → receipt recovery, zero automatic resubmits');

  const uncertain = await page.evaluate(() => probe.enqueue('unknown original command'));
  await page.route('**/api/clientRuntime/submitTask',route => route.abort('failed'));
  await page.evaluate(id => probe.send(id).catch(() => {}),uncertain.id);
  await page.unroute('**/api/clientRuntime/submitTask');
  const beforeMissingReload = evidence.requests.length;
  await page.reload(); await page.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  assert.equal(evidence.requests.length,beforeMissingReload);
  assert.equal(count(uncertain.operationId),0);
  assert.equal(await page.evaluate(id => probe.state().queued.find(item => item.id === id)?.state,uncertain.id),'uncertain');
  await page.evaluate(id => probe.edit(id,'must not change admitted-unknown command'),uncertain.id);
  await page.evaluate(id => probe.send(id),uncertain.id);
  assert.equal(count(uncertain.operationId),1);
  assert.equal(JSON.parse(store.db.prepare('SELECT input FROM cloud_tasks WHERE nonce=?').get(uncertain.operationId).input).text,'unknown original command');
  const acceptedRetryRequests = evidence.requests.length;
  await page.evaluate(id => probe.retry(id),uncertain.operationId);
  assert.equal(evidence.requests.length,acceptedRetryRequests,'global recovery integration port only returns original accepted receipt');
  evidence.assertions.push('missing/unknown admission never auto-replays; explicit retry uses frozen original operation/request');

  const race = await page.evaluate(() => probe.enqueue('two tabs one command'));
  const second = await context.newPage(); observe(second); await ready(second);
  const beforeRace = evidence.requests.length;
  await Promise.all([page.evaluate(id => probe.send(id).catch(() => {}),race.id),second.evaluate(id => probe.send(id).catch(() => {}),race.id)]);
  assert.equal(count(race.operationId),1);
  assert.equal(evidence.requests.length-beforeRace,1,'one dispatch across two real tabs, not merely Host deduplication');
  evidence.assertions.push('two real tabs atomically claim one original command; exactly one submit HTTP');

  const activityButton = (tab, text) => tab.locator('#activity section').filter({ has: tab.getByText(text, { exact: true }) }).getByRole('button', { name: '核对收据并使用原命令重试', exact: true });
  const reloadReady = async tab => { await tab.reload(); await tab.locator('body[data-ready="yes"]').waitFor({timeout:60000}); };
  // Real CloudActivity component/button → retryPendingTaskCommand, competing
  // with the production chat store in another tab (not an adapter-only probe).
  const lostActivity = await page.evaluate(() => probe.enqueue('Activity accepted response loss'));
  await reloadReady(second);
  await page.route('**/api/clientRuntime/submitTask',async route => { await route.fetch(); await route.abort('failed'); });
  await page.evaluate(id => probe.send(id).catch(() => {}),lostActivity.id);
  await page.unroute('**/api/clientRuntime/submitTask');
  await page.evaluate(() => probe.mountActivity());
  await activityButton(page,lostActivity.text).waitFor();
  const lostRequests = evidence.requests.length;
  await Promise.all([activityButton(page,lostActivity.text).click(), second.evaluate(id => probe.send(id).catch(() => {}),lostActivity.id)]);
  await activityButton(page,lostActivity.text).waitFor({state:'detached'});
  assert.equal(count(lostActivity.operationId),1);
  assert.equal(evidence.requests.length,lostRequests,'accepted loss: Activity and queue both query, neither submits');
  assert.notEqual(store.db.prepare('SELECT status FROM cloud_tasks WHERE nonce=?').get(lostActivity.operationId).status,'cancelled','accepted steer receipt recovery must not cancel original task');
  await Promise.all([reloadReady(page),reloadReady(second)]);
  assert.equal(evidence.requests.length,lostRequests);
  evidence.assertions.push('REAL Activity button + other-tab chat queue: accepted response loss, zero retry HTTP, one task, reload remains read-only');

  for (const winner of ['activity','queue']) {
    const item = await page.evaluate(text => probe.enqueue(text),`Activity missing race ${winner}`);
    await page.route('**/api/clientRuntime/submitTask',route => route.abort('failed'));
    await page.evaluate(id => probe.send(id).catch(() => {}),item.id);
    await page.unroute('**/api/clientRuntime/submitTask');
    const beforeRecovery = evidence.requests.length;
    await Promise.all([reloadReady(page),reloadReady(second)]);
    assert.equal(evidence.requests.length,beforeRecovery,'missing admission does not dispatch on reload');
    assert.equal(count(item.operationId),0);
    await page.evaluate(() => probe.mountActivity());
    await activityButton(page,item.text).waitFor();
    let reached, release;
    const intercepted = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const winningTab = winner === 'activity' ? page : second;
    await winningTab.route('**/api/clientRuntime/submitTask',async route => {
      const response = await route.fetch(); reached(); await held; await route.fulfill({response});
    });
    const winningAction = winner === 'activity' ? activityButton(page,item.text).click()
      : second.evaluate(id => probe.send(id).catch(() => {}),item.id);
    await intercepted;
    if (winner === 'activity') await second.evaluate(id => probe.send(id).catch(() => {}),item.id);
    else { await activityButton(page,item.text).click(); await page.locator('#activity').getByText('task_admission_uncertain',{exact:true}).waitFor(); }
    release(); await winningAction;
    await winningTab.unroute('**/api/clientRuntime/submitTask');
    await page.waitForFunction(async id => (await probe.meta()).find(row => row.id === 'task-command:'+id)?.status === 'accepted',item.operationId);
    assert.equal(evidence.requests.length-beforeRecovery,1,'cross-entry race has one HTTP, not merely Host deduplication');
    assert.equal(count(item.operationId),1);
    await Promise.all([reloadReady(page),reloadReady(second)]);
    assert.equal(evidence.requests.length-beforeRecovery,1);
    assert.equal(count(item.operationId),1);
    assert.equal(await page.evaluate(id => probe.state().queued.some(item => item.id === id),item.id),false);
    evidence.assertions.push(`REAL Activity/queue missing cross-entry race (${winner} wins): original operation, one HTTP/one task including reload`);
  }

  const nonchatId = crypto.randomUUID();
  await page.route('**/api/clientRuntime/submitTask',route => route.abort('failed'));
  await page.evaluate(id => probe.nonchat(id).catch(() => {}),nonchatId);
  await page.unroute('**/api/clientRuntime/submitTask');
  await reloadReady(page);
  const nonchatBefore = evidence.requests.length;
  await page.evaluate(() => probe.mountActivity());
  await activityButton(page,'nonchat original').click();
  await page.locator('#activity section').filter({hasText:'nonchat original'}).waitFor({state:'detached'});
  assert.equal(evidence.requests.length-nonchatBefore,1,JSON.stringify({nonchatId, tasks:count(nonchatId), recent:evidence.requests.slice(-3), meta:await page.evaluate(id => probe.meta().then(rows => rows.find(row => row.id === 'task-command:'+id)),nonchatId)}));
  assert.equal(count(nonchatId),1);
  assert.equal(evidence.requests.at(-1).payload.args.request.kind,'modelOnce');
  evidence.assertions.push('non-chat Activity retry still uses original kind/input/operation and normal recovery');
  await page.evaluate(() => probe.unmountActivity());

  for (const invalidate of ['runtime','account']) {
    const item = await page.evaluate(text => probe.enqueue(text),`Activity retired ${invalidate}`);
    await page.route('**/api/clientRuntime/submitTask',route => route.abort('failed'));
    await page.evaluate(id => probe.send(id).catch(() => {}),item.id);
    await page.unroute('**/api/clientRuntime/submitTask');
    await page.evaluate(() => probe.mountActivity());
    await activityButton(page,item.text).waitFor();
    let reached, release;
    const intercepted = new Promise(resolve => { reached = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/clientRuntime/taskAdmission',async route => {
      const response = await route.fetch(); reached(); await held;
      await route.fulfill({response}).catch(() => {}); // old runtime may abort its fetch
    });
    const before = evidence.requests.length;
    await activityButton(page,item.text).click();
    await intercepted;
    if (invalidate === 'runtime') await page.evaluate(() => probe.retireRuntime());
    else await page.evaluate(() => probe.switchAccount());
    release();
    await page.locator('#activity').getByText(/client_account_changed|abort/i).waitFor();
    await page.unroute('**/api/clientRuntime/taskAdmission');
    assert.equal(evidence.requests.length,before,'retired Activity retry cannot submit through generic fallback');
    assert.equal(count(item.operationId),0);
    await reloadReady(page);
    assert.equal(evidence.requests.length,before);
    assert.equal(await page.evaluate(id => probe.state().queued.find(item => item.id === id)?.text,item.id),item.text);
    evidence.assertions.push(`real Activity retry with delayed missing receipt rejects retired ${invalidate}, zero HTTP, original durable draft survives reload`);
  }

  new CloudRecords(store).apply(owner, [
    {id:'continue-session',table:'chatSessions',key:900002,before:null,after:{id:900002,videoId:'__library_assistant__',title:'Continuation fixture',createdAt:2}},
    {id:'continue-answer',table:'chats',key:910001,before:null,after:{id:910001,sessionId:900002,videoId:'__library_assistant__',role:'assistant',content:'partial server answer',interrupted:true,interruptReason:'stopped',createdAt:2}},
  ]);
  await page.goto(`${origin}/__queue?session=900002`); await page.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  await page.route('**/api/clientRuntime/submitTask',route => route.abort('failed'));
  await page.evaluate(() => probe.continue());
  await page.unroute('**/api/clientRuntime/submitTask');
  const continuation = evidence.requests.at(-1).payload.args.request;
  assert.equal(continuation.input.action,'continue');
  assert.equal(continuation.input.rowId,910001);
  const beforeContinueReload = evidence.requests.length;
  await reloadReady(page);
  assert.equal(evidence.requests.length,beforeContinueReload);
  await page.evaluate(() => probe.mountActivity());
  // Continue's canonical input intentionally has no text; Activity renders its
  // standard recovery prompt, not the queue item's presentation label.
  const continueAlert = page.locator('#activity section:not(:has(p:nth-of-type(2)))');
  await continueAlert.getByRole('button',{name:'核对收据并使用原命令重试',exact:true}).click();
  await continueAlert.waitFor({state:'detached'});
  assert.equal(evidence.requests.length-beforeContinueReload,1);
  assert.equal(count(continuation.operationId),1);
  assert.deepEqual(evidence.requests.at(-1).payload.args.request,continuation,'Activity resumes frozen continue command, not a new chat turn');
  await reloadReady(page);
  assert.equal(evidence.requests.length-beforeContinueReload,1);
  evidence.assertions.push('production retryMessage continuation → missing response → reload → real Activity original row/action recovery, one submit/one task');
  await ready(page);

  // Offline drafts retain raw local blobs, but have no local model executor.
  const localRefs = await context.newPage(); observe(localRefs);
  await localRefs.goto(`${origin}/__local-queue`); await localRefs.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  await localRefs.evaluate(() => probe.putFile('shared-queue-file'));
  const file = { id:'shared-queue-file', name:'fixture.txt', mimeType:'text/plain', size:7 };
  const firstRef = await localRefs.evaluate(file => probe.enqueue('first reference',[file]),file);
  await localRefs.evaluate(file => probe.enqueue('second reference',[file]),file);
  await localRefs.evaluate(id => probe.edit(id,''),firstRef.id);
  assert.ok(await localRefs.evaluate(() => probe.file('shared-queue-file')));
  await localRefs.evaluate(() => probe.clear());
  assert.equal(await localRefs.evaluate(() => probe.file('shared-queue-file')),undefined);
  await localRefs.close();
  evidence.assertions.push('shared attachment survives edit; final clear releases blob after persistent reference check');

  const isolated = await page.evaluate(() => probe.enqueue('old account only'));
  const otherServer = await context.newPage(); observe(otherServer);
  await otherServer.goto(`${origin}/__queue-isolation`); await otherServer.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  assert.deepEqual(await otherServer.evaluate(() => window.isolatedQueue),[]);
  evidence.assertions.push('same origin IndexedDB and same account, different configured server sees no old queue');
  await otherServer.close();
  const late = await page.evaluate(() => probe.enqueue('accepted late callback after account switch'));
  let reached, release;
  const intercepted = new Promise(resolve => { reached = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/clientRuntime/submitTask',async route => {
    const response = await route.fetch(); reached(); await held; await route.fulfill({ response });
  });
  const lateSend = page.evaluate(id => probe.send(id).catch(() => {}),late.id);
  await intercepted;
  await page.evaluate(() => probe.switchAccount());
  release(); await lateSend;
  await page.unroute('**/api/clientRuntime/submitTask');
  assert.deepEqual(await page.evaluate(() => probe.state().messages),[],'late acceptance cannot write into new account view');
  assert.equal(count(late.operationId),1,'account switch detaches views, not already accepted server work');
  assert.deepEqual(await page.evaluate(() => probe.list()),[]);
  assert.equal(count(isolated.operationId),0);
  evidence.assertions.push('account switch cannot read/dispatch old queue; delayed accepted callback cannot mutate new account, accepted task is not cancelled');

  // Retired: the old paid-model-free *browser Agent loop* assertion. Its
  // replacement proves durable lazy drafts submit one server command and do not
  // fabricate local user/assistant history while the worker is disabled.
  const draftPage = await context.newPage(); observe(draftPage); await ready(draftPage);
  await draftPage.evaluate(() => probe.newDraft());
  const draftItem = await draftPage.evaluate(() => probe.enqueue('durable lazy draft queue'));
  await draftPage.reload(); await draftPage.locator('body[data-ready="yes"]').waitFor({timeout:60000});
  assert.equal(await draftPage.evaluate(() => probe.state().activeId),null,'pending lazy draft is restored without inventing a session');
  assert.equal(await draftPage.evaluate(() => probe.state().queued[0].operationId),draftItem.operationId);
  await draftPage.evaluate(id => probe.send(id),draftItem.id);
  assert.notEqual(await draftPage.evaluate(() => probe.state().activeId),900001);
  assert.equal(count(draftItem.operationId),1);
  assert.equal(await draftPage.evaluate(async () => (await probe.rows()).filter(row => row.content === 'durable lazy draft queue').length),0,'only the server worker may append history');
  evidence.assertions.push('server lazy draft reload preserves identity; first dispatch creates/rekeys session, submits once, and never writes local chat history');
  assert.deepEqual(evidence.errors,[]);
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
  console.log(`PASS production courseChat + IndexedDB + typed admission + two tabs. Evidence: ${directory}`);
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
