/** Production Panel/TaskModelPicker/compression, real API + SQLite + Chromium.
 * Only the server's model HTTP is scripted; browser model fetches are forbidden. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-chat-ui-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
let modelCalls = 0;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid', 'no paid or real provider calls');
  modelCalls++;
  const body = JSON.parse(init.body);
  const selector = body.messages[0]?.content.includes('conservative extractive context selector');
  const content = selector ? JSON.stringify({ answers: Object.fromEntries(JSON.parse(body.messages.at(-1).content).older_turns.map(turn => [turn.id, { noul: 0.99 }])) }) : 'Server course answer.';
  if (body.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
} });
let web, browser, store;
const evidence = { assertions: [], requests: [], errors: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React, { createRef } from 'react';
import { createRoot } from 'react-dom/client';
import ChatPanel from '/src/components/ChatPanel.tsx';
import TaskModelPicker from '/src/components/TaskModelPicker.tsx';
import { startCloud } from '/src/cloud/sync.ts';
import { db } from '/src/store/db.ts';
import { useTaskModel, taskModelKey } from '/src/store/taskModel.ts';
import { useSelectionAsk } from '/src/store/selectionAsk.ts';
import { prepareSessionHistory, useContextCompressionStore } from '/src/store/contextCompression.ts';
import { readChatHistory } from '/src/store/chatHistory.ts';
import { readChatPage } from '/src/store/chatHistory.ts';
import { decisionConfigOf, getSettings } from '/src/store/settings.ts';
import { FeedbackHost } from '/src/ui/feedback.tsx';
import { queueLearning, learningEdit } from '/src/client/learning.ts';
import { invalidateAccountLifetime } from '/src/client/account-lifecycle.ts';
import '/src/i18n/index.ts';
await startCloud(window.owner);
window.probe = {
 select: () => useTaskModel.getState().set(taskModelKey(900001),{modelRef:{providerId:'fixture',model:'fixture-special'}}),
 cite: () => useSelectionAsk.getState().ask({text:'selected course evidence',source:'pdf',unit:1,unitLabel:'第 1 页',image:{dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',thumb:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII='}},'compose'),
 compress: async () => { const rows=await readChatHistory(900002); return prepareSessionHistory(900002,rows,50000,'current request',decisionConfigOf(getSettings()),{force:true}); },
 compression: () => useContextCompressionStore.getState().sessions[900002],
 history: id => readChatHistory(id),
 page: (id,before) => readChatPage(id,before),
 lazyPage: async () => {await queueLearning([learningEdit({kind:'conversationSession',expected:null,value:{id:900004,videoId:'__library_assistant__',title:'Lazy confirmed',createdAt:4}})],['session:900004']);return readChatPage(900004);},
 invalidate: invalidateAccountLifetime,
};
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(FeedbackHost),React.createElement('section',{'data-testid':'default-picker'},React.createElement(TaskModelPicker,{sessionId:900001})),React.createElement(ChatPanel,{videoId:'course',videoName:'Course fixture',playerRef:createRef(),materialKind:'page',materialFormat:'pdf'})));
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'server-chat-ui-fixture', resolveId: id => id === '/__chat-ui-entry.js' ? '\0chat-ui' : undefined,
    load: id => id === '\0chat-ui' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__chat-ui') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__chat-ui-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'server-chat-ui-password-123' } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'server-chat-ui-password-123' } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), config = new CloudConfiguration(store, directory);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Scripted server', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'free-only', serves: ['chat', 'vision'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' }, visionModel: { providerId: 'fixture', model: 'fixture' } });
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  put('videos', 'course', { id: 'course', name: 'Course fixture', kind: 'material', materialFormat: 'pdf', createdAt: 1 });
  put('chatSessions', 900001, { id: 900001, videoId: 'course', title: 'Course session', createdAt: 1 });
  put('chats', 80, { id: 80, sessionId: 900001, videoId: 'course', role: 'user', content: 'idle QA question', createdAt: 1 });
  put('chats', 81, { id: 81, sessionId: 900001, videoId: 'course', role: 'assistant', content: 'idle QA original', createdAt: 2 });
  put('chatSessions', 900002, { id: 900002, videoId: '__library_assistant__', title: 'Compression session', createdAt: 2 });
  put('chatSessions', 900006, { id: 900006, videoId: 'another-material', title: 'Unrelated material', createdAt: 0 });
  put('chats', 5000, { id: 5000, sessionId: 900006, videoId: 'another-material', role: 'user', content: 'unrelated initial', createdAt: 0 });
  for (let n = 0; n < 8; n++) put('chats', 100 + n, { id: 100 + n, videoId: '__library_assistant__', sessionId: 900002, role: n % 2 ? 'assistant' : 'user', content: n % 2 ? `old answer ${n}` : `old request ${n}`, createdAt: 100 + n });
  put('chatSessions', 900003, {id:900003,videoId:'__library_assistant__',title:'Server pagination',createdAt:3});
  const pageRows = [];
  for (let n=0;n<220;n++) { const row={id:20000+n,sessionId:900003,videoId:'__library_assistant__',role:n%2?'assistant':'user',content:`page ${n}`,createdAt:n<130?Math.floor(n/2):100}; pageRows.push(row); put('chats',row.id,row); }
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  await context.route('**/chat/completions', route => { throw new Error('browser model execution forbidden: ' + route.request().url()); });
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  let failReadiness = true, readinessRequests = 0;
  await page.route('**/api/clientRuntime/read', async route => {
    if (route.request().postData()?.includes('courseReadiness')) {
      readinessRequests++;
      if (failReadiness) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'readiness_fixture_unavailable' }) });
    }
    return route.continue();
  });
  page.on('request', request => { if (request.url().includes('/api/clientRuntime/submitTask')) evidence.requests.push(request.postDataJSON()); });
  await page.goto(origin + '/__chat-ui'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  try { await page.getByTestId('chat-index-retry').waitFor({ timeout: 60000 }); }
  catch (error) {
    fs.writeFileSync(path.join(directory, 'readiness-failure.json'), JSON.stringify({ readinessRequests, errors: evidence.errors, body: await page.locator('body').innerText() }, null, 2));
    await page.screenshot({ path: path.join(directory, 'readiness-failure.png') });
    console.error('Readiness evidence:', directory); throw error;
  }
  assert.ok(readinessRequests > 0, 'QA startup reads the server content-availability projection');
  failReadiness = false;
  await page.getByTestId('chat-index-retry').click();
  const composer = page.getByRole('textbox');
  await composer.waitFor({ timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-composer"] textarea')?.disabled);
  evidence.assertions.push('QA content availability uses a boolean server projection; 503 is visible with explicit retry and successful recovery');
  await page.getByText('idle QA original', { exact: false }).first().waitFor();
  put('chats', 81, { ...records.get(owner, 'chats', 81), content: 'idle QA remotely updated' });
  await page.getByText('idle QA remotely updated', { exact: false }).first().waitFor();
  put('chats', 81, null);
  await page.getByText('idle QA remotely updated', { exact: false }).first().waitFor({ state: 'detached' });
  put('chatSessions', 900005, { id: 900005, videoId: 'course', title: 'Remote empty session', createdAt: 5 });
  await page.getByTestId('chat-session').locator('option[value="900005"]').waitFor({ state: 'attached' });
  await page.getByTestId('chat-session').locator('[data-slot="select-trigger"]').click();
  try { await page.getByRole('option', { name: 'Remote empty session', exact: true }).waitFor(); }
  catch (error) {
    console.error('QA SESSION DEBUG', await page.locator('body').innerText());
    await page.screenshot({ path: path.join(directory, 'session-list-failure.png') });
    console.error('Evidence:', directory); throw error;
  }
  await page.keyboard.press('Escape');
  // Count scoped history reads after caches and subscriptions have settled.
  let scopedReads = 0;
  const countReads = request => { if (request.url().endsWith('/api/clientRuntime/read') && request.postData()?.includes('900001')) scopedReads++; };
  page.on('request', countReads);
  await page.evaluate(() => probe.page(900001));
  assert.ok(scopedReads > 0, 'counter observes an actual scoped history read');
  await page.waitForTimeout(300); scopedReads = 0;
  put('studyDays', '2026-11-05', { date: '2026-11-05', seconds: 17, updatedAt: Date.now() });
  put('chats', 5000, { ...records.get(owner, 'chats', 5000), content: 'unrelated-session-change' });
  await page.waitForTimeout(500);
  assert.equal(scopedReads, 0, 'studyTime and other-session row changes do not refetch QA history');
  evidence.qaRecordChanges = { idleEdit: true, idleDelete: true, emptySessionAppears: true, unrelatedHistoryReads: scopedReads };
  page.off('request', countReads);
  evidence.assertions.push('idle QA same-row remote content edit/delete and new empty material session update without any task; unrelated studyTime/other-session changes cause zero scoped history reads');
  put('chats', 80, null);
  await page.getByText('idle QA question', { exact: false }).first().waitFor({ state: 'detached' });
  const paginated = await page.evaluate(async () => {let before,all=[]; for(let n=0;n<20;n++){const page=await probe.page(900003,before);all=[...page.rows,...all];if(!page.hasOlder)return all;before=page.rows[0];}throw new Error('pagination_never_ends');});
  const {compareChatRows}=await import('../packages/study-core/src/utils/chatOrder.ts');
  assert.deepEqual(paginated.map(row=>row.id),pageRows.sort(compareChatRows).map(row=>row.id));
  evidence.assertions.push('real server pagination preserves all 220 rows across legacy pair ties and a 90-row timestamp bucket, with no local fallback');
  assert.deepEqual(await page.evaluate(() => probe.lazyPage()),{rows:[],hasOlder:false,tasks:[]});
  assert.equal(records.get(owner,'chatSessions',900004).title,'Lazy confirmed');
  evidence.assertions.push('lazy session creation drains the learning journal before requesting its first server page');
  await page.evaluate(() => probe.select());
  await page.getByTestId('default-picker').getByRole('button', { name: '设为本会话默认' }).click();
  const until = async predicate => { const deadline = Date.now() + 30000; while (Date.now() < deadline) { store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE owner_id=? AND status='pending'").run(owner); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('ui_fixture_timeout'); };
  await until(() => records.get(owner, 'chatSessions', 900001)?.defaultModel?.modelRef?.model === 'fixture-special');
  await page.getByTestId('default-picker').getByRole('button',{name:'设为本会话默认'}).waitFor({state:'hidden'});
  evidence.assertions.push('TaskModelPicker saves session default with real server expected/CAS delegation');
  await page.evaluate(() => { probe.select(); probe.cite(); });
  await composer.fill('Explain attached evidence'); await composer.press('Enter');
  await until(() => store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND kind='qa'").get(owner));
  const qa = store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND kind='qa' ORDER BY created_at DESC LIMIT 1").get(owner), input = JSON.parse(qa.input);
  assert.equal(input.modelSelection.modelRef.model, 'fixture-special'); assert.equal(input.shotCount, 1); assert.equal(input.refsCount, 1);
  assert.ok(input.text.includes('selected course evidence')); assert.ok(input.images.some(part => part.type === 'image_url'));
  await until(() => ['completed', 'failed'].includes(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(qa.id).status));
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(qa.id).status, 'completed');
  await page.getByText('Server course answer.', { exact: false }).first().waitFor({ timeout: 30000 });
  evidence.assertions.push('ChatPanel sends task-specific model, selected text and raw image evidence through real QA admission, then renders server answer');
  await page.getByTestId('chat-fork-message').last().click();
  let fork;
  await until(() => (fork = records.list(owner, 0, 1000).find(row => row.table === 'chatSessions' && row.value?.title === 'Course session · 分支')?.value));
   await page.locator(`[data-chat-session-id="${fork.id}"]`).waitFor().catch(async error => {
     console.error('FORK UI', await page.locator('body').innerText(), evidence.errors);
     await page.screenshot({ path: path.join(directory, 'fork-failure.png') });
     console.error('Evidence:', directory); throw error;
   });
  await page.getByTestId('chat-delete-message').last().click();
  try { await page.getByTestId('message-delete-popconfirm').getByTestId('popconfirm-confirm').click(); }
  catch (error) { await page.screenshot({path:path.join(directory,'delete-failure.png')}); fs.writeFileSync(path.join(directory,'delete-failure.html'),await page.content()); console.log(directory); throw error; }
  await until(() => records.list(owner, 0, 1000).filter(row => row.table === 'chats' && row.value?.sessionId === fork.id).length === 1);
  evidence.assertions.push('fork mounted-history session sync point then confirmed server answer deletion preserves original');
  const baseline = records.list(owner, 0, 1000).filter(row => row.table === 'chats' && row.value?.sessionId === 900002).map(row => row.value);
  const compress = page.evaluate(() => probe.compress());
  await until(() => store.db.prepare("SELECT 1 FROM cloud_tasks WHERE owner_id=? AND json_extract(input,'$.action')='compressContext' AND status IN ('completed','failed')").get(owner));
  await compress;
  assert.equal((await page.evaluate(() => probe.compression())).phase, 'success');
  const compressed = records.get(owner, 'chatSessions', 900002);
  assert.equal(compressed.contextOmissions.length, 4);
  assert.ok(compressed.contextOmissions.every(([id]) => id < 104), 'latest two turns protected');
  const after = records.list(owner, 0, 1000).filter(row => row.table === 'chats' && row.value?.sessionId === 900002).map(row => row.value);
  assert.deepEqual(after, baseline, 'compression never rewrites/deletes/appends raw history');
  const compression = store.db.prepare("SELECT input FROM cloud_tasks WHERE owner_id=? AND json_extract(input,'$.action')='compressContext'").get(owner);
  assert.deepEqual(JSON.parse(compression.input).expected, baseline.map(row => ({ id: row.id, content: row.content })));
  evidence.assertions.push('production compression admits original complete expected baseline, runs server selector, commits omission CAS, protects latest two turns and leaves all messages unchanged');
  store.transaction(() => {
    for (let id = 1; id <= 61; id++) put('chatSessions', 910000 + id, { id: 910000 + id, videoId: 'course', title: `QA history ${id}`, createdAt: -id });
  });
  const sessionSelect = page.getByTestId('chat-session');
  await sessionSelect.locator('option[value="910001"]').waitFor({ state: 'attached' });
  assert.ok(await sessionSelect.locator('option').count() <= 52, '50 metadata options, active option and native empty sentinel at most');
  await sessionSelect.locator('[data-slot="select-trigger"]').click();
  await page.getByTestId('qa-sessions-next').click();
  await page.getByRole('option', { name: 'QA history 61', exact: true }).waitFor();
  await page.getByTestId('qa-sessions-previous').click();
  await page.getByRole('option', { name: 'QA history 1', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  evidence.assertions.push('QA selector uses bounded 50-row metadata pages, preserves active selection and traverses forward/backward to all older sessions');
  assert.ok(modelCalls >= 2); assert.deepEqual(evidence.errors, []);
  await page.screenshot({ path: path.join(directory, 'course-panel.png'), fullPage: true });
  await page.route('**/api/clientRuntime/read', route => route.abort());
  assert.equal(await page.evaluate(async () => {try {await probe.page(900003);return false;}catch{return true;}}),true,'page failure never falls back to populated confirmed cache');
  await page.unroute('**/api/clientRuntime/read');
  let arrived,release;const observed=new Promise(resolve=>{arrived=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/clientRuntime/read',async route=>{const response=await route.fetch();arrived();await gate;await route.fulfill({response});});
  const late=page.evaluate(async()=>{try{await probe.page(900003);return false;}catch{return true;}});
  await observed;await page.evaluate(()=>probe.invalidate());release();assert.equal(await late,true,'invalidated lifetime rejects delayed same-account page');
  evidence.assertions.push('failed server page has no confirmed-cache fallback; account invalidation rejects a delayed server page');
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS production course panel + task-model UI + server compression. Evidence: ${directory}`);
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
