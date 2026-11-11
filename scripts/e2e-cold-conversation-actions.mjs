/** Cold business-IDB actions against real API/SQLite; only model HTTP scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cold-conversation-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
let calls = 0;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid'); calls++;
  const content = 'Controlled regenerated answer';
  if (JSON.parse(init.body).stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
} });
const evidence = { checks: [], errors: [], requests: [] }; let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React,{createRef} from 'react';import {createRoot} from 'react-dom/client';
import ChatPanel from '/src/components/ChatPanel.tsx';import {FeedbackHost} from '/src/ui/feedback.tsx';
import {startCloud} from '/src/cloud/sync.ts';import {db} from '/src/store/db.ts';
import {removeConversationMessages,deleteServerSession} from '/src/client/conversations.ts';
import {removeConversationMessage} from '/src/store/conversationProducts.ts';
import {useCourseChat} from '/src/store/courseChat.ts';
import '/src/i18n/index.ts';import '/src/theme.css';
await startCloud(window.owner);
window.probe={counts:async()=>({chats:await db.chats.count(),sessions:await db.chatSessions.count()}),cached:id=>db.chats.get(id).then(Boolean),
 remove:removeConversationMessages,removeOne:removeConversationMessage,deleteSession:deleteServerSession,
 loadChat:async()=>{await useCourseChat.getState().bootstrap();await useCourseChat.getState().loadSession(70);},
 chatReady:()=>useCourseChat.getState().messages.some(row=>row.rowId===702),
 chatDone:()=>!useCourseChat.getState().loading&&useCourseChat.getState().messages.some(row=>row.content.includes('Controlled regenerated answer')),
 retryChat:()=>{const state=useCourseChat.getState();return state.retryMessage(state.messages.find(row=>row.rowId===702).key);}};
createRoot(document.getElementById('root')).render(React.createElement('main',null,React.createElement(FeedbackHost),React.createElement(ChatPanel,{videoId:'course',videoName:'Course',playerRef:createRef(),materialKind:'page',materialFormat:'pdf'})));
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'cold-conversation', resolveId: id => id === '/__cold.js' ? '\0cold-conversation' : undefined, load: id => id === '\0cold-conversation' ? fixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__cold') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__cold.js"></script>'); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true }); const context = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  const password = 'cold-conversation-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const owner = (await (await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), config = new CloudConfiguration(store, directory);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Scripted', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'not-paid', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  put('videos', 'course', { id: 'course', name: 'Course', kind: 'material', materialFormat: 'pdf', createdAt: 1 });
  for (const id of [70, 80]) put('chatSessions', id, { id, videoId: '__library_assistant__', title: 'Cold Chat', createdAt: id });
  put('chatSessions', 90, { id: 90, videoId: 'course', title: 'Cold QA', createdAt: 90 });
  const message = (id, sessionId, role, content, extra = {}) => ({ id, sessionId, videoId: sessionId === 90 ? 'course' : '__library_assistant__', role, content, createdAt: id, ...extra });
  const quiz = { data: { questions: [{ stem: 'Cold quiz question', options: ['First choice', 'Second choice'], answer: 0, explanation: 'Controlled explanation', answerSource: 'verified' }] }, picks: [-1] };
  put('chats', 701, message(701, 70, 'user', 'Cold Chat retry question', { explicitSkillIds: [] }));
  put('chats', 702, message(702, 70, 'assistant', 'Cold Chat retry answer', { reasoning: 'full record baseline', modelTrace: [{ role: 'assistant', content: 'not in display projection' }] }));
  put('chats', 801, message(801, 80, 'user', 'Cold session deletion'));
  put('chats', 901, message(901, 90, 'user', 'Cold QA original question'));
  put('chats', 902, message(902, 90, 'assistant', 'Cold QA original answer', { reasoning: 'complete CAS field', modelTrace: [{ role: 'assistant', content: 'not in display projection' }] }));
  await context.addInitScript(owner => { window.owner = owner; window.unhandled = []; addEventListener('unhandledrejection', event => window.unhandled.push(String(event.reason))); }, owner);
  const page = await context.newPage();page.setDefaultTimeout(45000);page.on('pageerror', error => evidence.errors.push(error.message));
  let failKeys = false, failHistory = false, keyFailureWaiters = [];
  const keyFailure = () => new Promise(resolve => keyFailureWaiters.push(resolve));
  await page.route('**/api/clientRuntime/read', route => {
    const body = route.request().postData() ?? '';
    if (failKeys && body.includes('"kind":"recordKeys"')) {
      keyFailureWaiters.splice(0).forEach(resolve => resolve());
      return route.fulfill({ status: 503, body: 'cold-action-keys-unavailable' });
    }
    if (failHistory && body.includes('"kind":"collectionPage"') && body.includes('"table":"chats"')) return route.fulfill({ status: 503, body: 'cold-action-history-unavailable' });
    return route.continue();
  });
  page.on('request', request => { if (request.url().includes('/api/')) evidence.requests.push({ url: request.url(), body: request.postData() }); });
  await page.goto(origin + '/__cold');await page.locator('body[data-ready="yes"]').waitFor({ timeout: 90000 });
  await page.getByText('Cold QA original answer', { exact: false }).first().waitFor();
  assert.equal((await page.evaluate(() => probe.counts())).chats, 0, 'session projection did not hydrate business chats');
  await page.evaluate(()=>probe.loadChat());await page.waitForFunction(()=>probe.chatReady());
  assert.equal((await page.evaluate(() => probe.counts())).chats, 0);
  // Chat retry's bulk-deletion helper is cold and complete-record CAS based.
  failKeys = true;
  await page.evaluate(() => probe.retryChat());
  await page.getByText(/503|cold-action-keys-unavailable/).first().waitFor();
  assert.ok(records.get(owner, 'chats', 701));assert.ok(records.get(owner, 'chats', 702));assert.equal(calls, 0);
  failKeys = false;await page.evaluate(() => probe.retryChat());
  assert.equal(records.get(owner, 'chats', 701), null);assert.equal(records.get(owner, 'chats', 702), null);
  await page.waitForFunction(()=>probe.chatDone(),null,{timeout:60000});
  await page.evaluate(() => probe.deleteSession(80, [{ id: 801, sessionId: 80 }]));
  assert.equal(records.get(owner, 'chatSessions', 80), null);assert.equal(records.get(owner, 'chats', 801), null);
  evidence.checks.push('cold Chat bulk retry deletion removes both authoritative rows; read outage preserves both and submits no model; session delete reads complete session/message CAS, not passed display DTO');

  // Real QA delete button, with message body present only in session projection.
  await page.getByTestId('chat-delete-message').last().click();await page.getByTestId('message-delete-popconfirm').getByTestId('popconfirm-confirm').click();
  await page.waitForFunction(() => !document.body.textContent.includes('Cold QA original answer'));
  assert.equal(records.get(owner, 'chats', 902), null);
  put('chats', 903, message(903, 90, 'assistant', 'Cold QA retry original'));
  await page.getByText('Cold QA retry original', { exact: false }).first().waitFor();
  failKeys = true;const callsBefore = calls;
  await page.getByTestId('chat-retry-message').last().click();
  await page.waitForFunction(() => document.body.textContent.includes('503') || document.body.textContent.includes('unavailable'));
  assert.ok(records.get(owner, 'chats', 901));assert.ok(records.get(owner, 'chats', 903));assert.equal(calls, callsBefore);
  failKeys = false;await page.getByTestId('chat-retry-message').last().click();
  await page.getByText('Controlled regenerated answer', { exact: false }).first().waitFor({ timeout: 60000 });
  assert.equal(records.get(owner, 'chats', 901), null);assert.equal(records.get(owner, 'chats', 903), null);assert.ok(calls > callsBefore);
  evidence.checks.push('real cold QA delete succeeds; retry outage retains original question/answer without resend, explicit retry deletes original pair then regenerates through controlled server model');

  const active = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL AND json_extract(value,'$.content')='Controlled regenerated answer' AND json_extract(value,'$.videoId')='course'").get(owner);
  const activeSession = JSON.parse(active.value).sessionId;
  const quizTrace = [{ role: 'assistant', content: 'quiz hidden transcript must survive' }];
  put('chats', 904, { ...message(904, activeSession, 'assistant', 'Quiz complete record', { quiz, reasoning: 'quiz full CAS preserved', modelTrace: quizTrace }), createdAt: Date.now() });
  await page.reload();await page.locator('body[data-ready="yes"]').waitFor({ timeout: 90000 });
  await page.getByTestId('quiz-card').waitFor();
  assert.equal(await page.evaluate(()=>probe.cached(904)),false,'quiz is only in display projection before click');
  const first = page.getByTestId('quiz-card').locator('.quiz-option').first();
  await first.click();
  await page.waitForFunction(() => document.querySelector('.quiz-option[aria-pressed="true"]') !== null);
  assert.equal(records.get(owner, 'chats', 904).quiz.picks[0], 0);assert.equal(records.get(owner, 'chats', 904).reasoning, 'quiz full CAS preserved');
  assert.deepEqual(records.get(owner,'chats',904).modelTrace,quizTrace);
  assert.deepEqual(await page.evaluate(() => window.unhandled), []);

  // Full production CourseChat page: its onPress uses `void retryMessage`, so
  // neither full-history nor exact-key failures may escape as a rejection.
  put('chatSessions', 71, { id: 71, videoId: '__library_assistant__', title: 'Page retry failure', createdAt: Date.now() });
  put('chats', 711, message(711, 71, 'user', 'Page retry original question'));
  put('chats', 712, message(712, 71, 'assistant', 'Page retry original answer', { modelTrace: [{ role: 'assistant', content: 'page hidden CAS trace' }] }));
  await page.goto(origin + '/#/chat');
  await page.getByTestId('course-chat-page').waitFor({ timeout: 90000 });
  await page.evaluate(async () => { const { useCourseChat } = await import('/src/store/courseChat.ts'); await useCourseChat.getState().loadSession(71); });
  const originalAnswer = page.locator('[data-chat-message="stored-712"]');
  await originalAnswer.waitFor();
  assert.equal(await page.evaluate(async () => (await import('/src/store/db.ts')).db.chats.get(712).then(Boolean)), false);
  const beforePageRetry = calls;
  failHistory = true;
  await originalAnswer.getByTestId('chat-retry-message').click();
  await page.getByText(/重新生成失败|Unable to regenerate/).filter({ hasText: /503|unavailable/ }).first().waitFor();
  assert.ok(records.get(owner, 'chats', 711)); assert.ok(records.get(owner, 'chats', 712)); assert.equal(calls, beforePageRetry);
  failHistory = false; failKeys = true;
  const exactKeyFailure = keyFailure();
  await originalAnswer.getByTestId('chat-retry-message').click();
  await exactKeyFailure;
  await page.waitForFunction(() => [...document.querySelectorAll('[role="alert"]')]
    .some(node => /503|unavailable/.test(node.textContent ?? '')));
  assert.ok(records.get(owner, 'chats', 711)); assert.ok(records.get(owner, 'chats', 712)); assert.equal(calls, beforePageRetry);
  assert.ok(await originalAnswer.isVisible());
  failKeys = false;
  await originalAnswer.getByTestId('chat-retry-message').click();
  await originalAnswer.waitFor({ state: 'detached' });
  await page.getByText('Controlled regenerated answer', { exact: false }).first().waitFor();
  assert.equal(records.get(owner, 'chats', 711), null); assert.equal(records.get(owner, 'chats', 712), null); assert.ok(calls > beforePageRetry);
  evidence.checks.push('production CourseChat retry button catches history and exact-key 503 with visible errors, keeps original pair, never auto-sends; explicit successful retry removes both full rows and regenerates');
  assert.deepEqual(await page.evaluate(() => window.unhandled), []);assert.deepEqual(evidence.errors, []);
  assert.equal(evidence.requests.some(request => /recordsPage|watchRecords/.test(request.url) || request.body?.includes('"kind":"records"')), false);
  evidence.checks.push('real cold QA quiz click persists pick with complete authoritative CAS and preserves unrelated full-row reasoning; zero global feed/unhandled error');
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ ...evidence, calls, passed: true }, null, 2));console.log(`PASS cold conversation ${process.env.BROWSER ?? 'chromium'}: ${directory}`, evidence.checks);
} catch(error) { console.error('cold failure evidence',directory);fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ ...evidence, error: String(error) }, null, 2));if(browser){for(const context of browser.contexts())for(const page of context.pages())fs.writeFileSync(path.join(directory,'page.html'),await page.content());}throw error; }
finally { await browser?.close();await web?.close();store?.close();await app.close(); }
