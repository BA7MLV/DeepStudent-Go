import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { register } from 'node:module';
import { chromium } from 'playwright';
import { fixtureBrowserDomain } from './fixture-domain.mjs';

register('./cloud-e2e-source-loader.mjs', import.meta.url);

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/cloud-e2e-');
const evidence = { command: 'node --import tsx scripts/test-cloud-e2e.mjs', mode: 'source Vite dev + isolated source API/SQLite + source Node task runtime (test-only loader) + mock model; existing compiled shared packages', nodeVersion: process.version, startedAt: new Date().toISOString(), steps: [], errors: [] };
console.log(`Cloud E2E evidence: ${directory}`);
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), FILES_DIR: path.join(directory, 'files') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
Object.assign(process.env, { PUBLIC_ORIGIN: `http://localhost:${port}`, WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_RP_NAME: 'Cloud Test' });
let courseId;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  if (String(_url).endsWith('/models')) return Response.json({ data: [{ id: 'test-model' }] });
  const payload = JSON.parse(init.body);
  await new Promise(r => setTimeout(r, 1500));
  if (payload.stream && payload.messages.some(m => m.role === 'user' && String(m.content).includes('追问测试')) && !payload.messages.some(m => m.role === 'tool')) {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'ask-test', type: 'function', function: { name: 'ask_user', arguments: JSON.stringify({ question: '请选择接下来的学习主题', type: 'text' }) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (payload.stream && payload.messages.some(m => m.role === 'user' && String(m.content).includes('审批修改')) && !payload.messages.some(m => m.role === 'tool')) {
    const revoked = payload.messages.some(m => String(m.content).includes('撤销测试'));
    const argumentsJSON = JSON.stringify({ path: `/courses/${courseId}/material`, edits: [{ old_string: revoked ? '经过审批后修改的课程。' : '跨设备学习记录与字幕讲义。', new_string: revoked ? '禁止写入这段内容。' : '经过审批后修改的课程。' }] });
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'edit-test', type: 'function', function: { name: 'edit', arguments: argumentsJSON } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  const answer = payload.messages.some(m => JSON.stringify(m.content).includes('跨设备课程问答')) ? '另一台设备提交的课程问答已完成。' : '云端执行完成，网页关闭后继续运行。';
  if (payload.stream) return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '云端回复' }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
} });
let browser, vite;
try {
  const backend = await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.WANGKE_API_PROXY = backend;
   const { createServer } = await import('vite');
   vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port, strictPort: true, watch: null, hmr: false, proxy: { '/api': { target: backend, changeOrigin: false, ws: true } } }, logLevel: 'warn' });
   await vite.listen();
   const origin = process.env.PUBLIC_ORIGIN;
   evidence.origin = origin;
   evidence.backend = backend;
  browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const a = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
   const b = await browser.newContext({ serviceWorkers: 'block', locale: 'zh-CN' });
   for (const context of [a,b]) {
     await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
     context.on('page', tab => tab.on('pageerror', error => evidence.errors.push(error.message)));
   }
  let page = await a.newPage();
  const authenticator = async page => {
    const client = await page.context().newCDPSession(page);
    await client.send('WebAuthn.enable');
    const { authenticatorId } = await client.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    return { client, authenticatorId };
  };
  const passkeyA = await authenticator(page);
  page.on('pageerror', error => console.error('PAGE:', error.message));
  await page.goto(`${origin}/#/setup`);
   const legacySettings = await page.evaluate(async () => {
     const { useSettings } = await import('/src/store/settings.ts');
     useSettings.setState({contextWindow:32768});
     return localStorage.getItem('wangke-settings');
   });
   assert.ok(legacySettings);
   await page.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('wangke');
      request.onupgradeneeded = () => {
        for (const table of ['videos', 'files', 'chats', 'chatSessions']) request.result.createObjectStore(table, { keyPath: 'id' });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction(['videos', 'files', 'chats', 'chatSessions'], 'readwrite');
        tx.objectStore('videos').put({ id: 'legacy-md', name: '旧版课程.md', kind: 'material', materialFormat: 'md', status: 'transcribed', coverState: 'skipped', createdAt: 1, size: 18, mimeType: 'text/markdown', duration: 0 });
        tx.objectStore('files').put({ id: 'legacy-md', blob: new Blob(['旧版课程正文'], { type: 'text/markdown' }) });
        tx.objectStore('files').put({ id: 'legacy-attachment', blob: new Blob(['旧聊天附件'], { type: 'text/plain' }) });
        tx.objectStore('chatSessions').put({ id: 42, videoId: '', title: '旧聊天', createdAt: 1 });
        tx.objectStore('chats').put({ id: 43, sessionId: 42, videoId: '', role: 'user', content: '旧问题', createdAt: 1, attachments: [{ id: 'legacy-attachment', storage: 'local', name: 'notes.txt' }] });
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
      };
    });
   });
  try { await page.getByRole('button', { name: '开始', exact: true }).click(); }
  catch (error) { console.error('setup view', await page.locator('body').innerText()); throw error; }
  await page.getByLabel('一次性初始化密钥', { exact: true }).fill(fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim());
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await page.getByRole('button', { name: '创建管理员', exact: true }).click();
  await page.getByLabel('你的称呼', { exact: true }).fill('小测');
  await page.getByRole('button', { name: '继续', exact: true }).click();
  await page.getByRole('heading', { name: '选择模型' }).waitFor({ timeout: 30000 });
  await page.getByTestId('card-models').getByText('主模型', { exact: true }).waitFor();
  await page.getByRole('button', { name: '稍后再说', exact: true }).click();
  // 详细的服务器配置在设置里（选模型页可以跳过）。
  await page.goto(`${origin}/#/settings/models`);
   await page.getByTestId('card-api').waitFor({ timeout: 30000 });
   await page.getByTestId('provider-add-card').click();
   await page.getByTestId('provider-name-draft').fill('隔离测试模型');
   await page.getByTestId('base-url-draft').fill('https://model.example/v1');
   await page.getByTestId('api-key-draft').fill('test-secret');
   await page.getByTestId('provider-draft-save').click();
   await page.getByTestId('provider-back').waitFor();
   await page.getByTestId('discovered-model-select').click();
   await page.getByRole('button', { name: '添加 test-model', exact: true }).click();
   await page.getByRole('button', {name:'编辑 test-model',exact:true}).click();
   await page.getByRole('spinbutton', {name:'上下文窗口',exact:true}).fill('65536');
   await page.getByRole('spinbutton', {name:'最大输出令牌数',exact:true}).fill('4096');
   const customTools = page.getByRole('checkbox', {name:'自定义工具调用',exact:true});
   if (!await customTools.isChecked()) { await customTools.focus(); await customTools.press('Space'); }
   assert.equal(await customTools.isChecked(), true);
   await page.getByRole('button', {name:'保存修改',exact:true}).click();
   await page.getByTestId('provider-back').click();
   // RAC dismisses a nonmodal popover when its scroll container moves. Finish
   // scrolling the settings panel before opening it, rather than racing click's
   // implicit smooth scroll against the popover lifecycle.
   await page.getByTestId('model-button-llmModel').evaluate(element => element.scrollIntoView({behavior:'instant',block:'center'}));
   await page.getByTestId('model-button-llmModel').click();
   await page.waitForFunction(() => {
     const picker = document.querySelector('[data-model-picker="llmModel"]');
     return picker && getComputedStyle(picker).opacity === '1' && !picker.hasAttribute('data-entering');
   });
   await page.getByTestId('model-option-test-model').click();
   await page.getByTestId('cloud-models-save').click();
   await page.getByText('模型设置已保存到服务器', { exact: true }).waitFor();
   evidence.steps.push('Gate UI setup and current model connection/library/default UI');
  assert.ok(!(await (await a.request.get(`${origin}/api/v1/cloud/config`)).text()).includes('test-secret'));
  assert.equal(await page.evaluate(() => localStorage.getItem('wangke-settings')), legacySettings, 'cloud login preserves legacy settings');
  await page.goto(`${origin}/#/settings/data`);
  await page.getByTestId('cloud-sync-card').getByRole('button', { name: '导入', exact: true }).click();
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByText('导入完成', { exact: true }).waitFor({ timeout: 30000 });
  const attachment = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=files&key=%22legacy-attachment%22`)).json()).value;
  assert.equal(await (await a.request.get(`${origin}/api/v1/files/${attachment.blob.$file}`)).text(), '旧聊天附件');
   await page.getByTestId('cloud-passkeys').getByRole('button', { name: '添加', exact: true }).click();
  await page.getByText('Passkey 已添加', { exact: true }).waitFor();
  const credentials = (await passkeyA.client.send('WebAuthn.getCredentials', { authenticatorId: passkeyA.authenticatorId })).credentials;
  assert.equal(credentials.length, 1);
   assert.equal((await (await a.request.get(`${origin}/api/v1/cloud/record?table=preferences&key=%22userName%22`)).json()).value?.value, '小测', 'nickname saved as an account preference');
   evidence.steps.push('config secret redaction, byte-identical local settings preservation, legacy import/attachment bytes, account nickname, Passkey registration');
   await page.getByRole('button', {name:'关闭设置',exact:true}).click();
   await page.goto(`${origin}/#/library`);
   await page.getByRole('button', {name:'更多操作',exact:true}).click();
   await page.getByRole('menuitem', {name:'导入课程 / B 站视频',exact:true}).click();
  await page.getByTestId('import-input').setInputFiles({ name: '云端课程.md', mimeType: 'text/markdown', buffer: Buffer.from('# 云端课程\n\n跨设备学习记录与字幕讲义。') });
  const until = async (fn, description) => {
    for (let i = 0; i < 160; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 500)); }
    console.error(await (await a.request.get(`${origin}/api/v1/cloud/tasks`)).text());
    throw new Error(`Timed out: ${description}`);
  };
  await until(async () => {
    const response = await a.request.get(`${origin}/api/v1/cloud/tasks`);
    const tasks = (await response.json()).tasks;
    const failed = tasks.find(t => t.kind === 'material' && t.status === 'failed');
    if (failed) throw new Error(failed.error);
    return tasks.some(t => t.kind === 'material' && t.status === 'completed' && t.executor === 'node');
  }, 'server material parser');
  courseId = (await (await a.request.get(`${origin}/api/v1/cloud/records`)).json()).records.find(r => r.table === 'videos' && r.value?.name === '云端课程').key;
  const second = await b.newPage();
  const passkeyB = await authenticator(second);
  await passkeyB.client.send('WebAuthn.addCredential', { authenticatorId: passkeyB.authenticatorId, credential: credentials[0] });
  await second.goto(`${origin}/#/library`);
  await second.getByLabel('密码', { exact: true }).fill('test-password-12345');
  await second.getByRole('button', { name: '登录', exact: true }).click();
   await second.getByText('云端课程.md', { exact: true }).first().waitFor({ timeout: 30000 });
   evidence.steps.push('normal Markdown import, completed Node material parser, second-device password login and course visibility');
  await page.goto(`${origin}/#/chat`);
  const textarea = page.locator('textarea').first();
  await textarea.fill('请验证后台任务');
  await textarea.press('Enter');
  let chat;
  await until(async () => { const data = await (await a.request.get(`${origin}/api/v1/cloud/tasks`)).json(); chat = data.tasks.find(t => t.kind === 'chat'); return !!chat; }, 'chat submitted');
  await page.close();
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${chat.id}`)).json();
    if (task.status === 'failed') { console.error(task); throw new Error(task.error); }
    return task.status === 'completed';
  }, 'chat finishes after originating tab closes');
  await second.goto(`${origin}/#/chat`);
  await second.getByText('请验证后台任务', { exact: true }).first().click();
  try { await second.getByText('云端执行完成，网页关闭后继续运行。', { exact: false }).first().waitFor({ timeout: 30000 }); }
  catch (e) { console.error('TASK', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${chat.id}`)).text()); console.error('PAGE', await second.locator('body').innerText()); throw e; }
   const sessionId = chat.input.sessionId;
   evidence.steps.push('chat completes after originating tab closes; persisted session and answer visible on second device');
  // A fresh session keeps the mock's tool envelope independent of the first turn.
  const editSessionId = sessionId + 1;
  await fixtureBrowserDomain(a.request, origin, 'editLearning', { operationId: crypto.randomUUID(), edits: [{ mutationId: crypto.randomUUID(), kind: 'conversationSession', expected: null, value: { id: editSessionId, videoId: '', title: '审批测试', createdAt: Date.now() } }] });
  const editTask = await (await a.request.post(`${origin}/api/v1/cloud/tasks`, { data: { nonce: crypto.randomUUID(), kind: 'chat', resource: `session:${editSessionId}`, input: { sessionId: editSessionId, text: '审批修改课程', attachments: [] } } })).json();
  let approval;
   await until(async () => {
     approval = (await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).json()).permissions.find(p => p.taskId === editTask.id && p.status === 'pending');
     if (approval) return true;
     const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).json();
     if (['completed','failed','cancelled'].includes(task.status)) throw new Error(`Edit terminated before approval: ${JSON.stringify(task)}`);
     return false;
   }, 'edit awaiting approval');
  assert.equal(approval.capability, 'write');
  assert.ok(approval.arguments.includes('经过审批后修改的课程'));
  const resolved = await a.request.post(`${origin}/api/v1/cloud/permissions/${approval.id}/resolve`, { data: { approved: true } });
  assert.equal(resolved.status(), 200);
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).json();
    if (task.status === 'failed') { console.error(JSON.stringify(task)); console.error(await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).text()); throw new Error(task.error); }
    return task.status === 'completed';
  }, 'approved edit completed');
   const readCourseDocument = async () => {
     const listing = await (await a.request.get(`${origin}/api/v1/resources`)).json();
     const entry = listing.entries.find(entry => entry.courseId === courseId);
     assert.ok(entry, 'course has a canonical resource file');
     const response = await a.request.get(`${origin}/api/v1/projects/${encodeURIComponent(entry.projectId)}/text?path=${encodeURIComponent(entry.path)}`);
     assert.equal(response.status(), 200);
     return response.json();
   };
   const fileRecord = await readCourseDocument();
   const editedText = fileRecord.text;
  if (!editedText.includes('经过审批后修改的课程')) console.error('EDIT', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${editTask.id}`)).text());
  assert.ok(editedText.includes('经过审批后修改的课程'));
   assert.equal((await a.request.post(`${origin}/api/v1/cloud/permissions/${approval.id}/resolve`, { data: { approved: true } })).status(), 409);
   evidence.steps.push('one-shot approval edits canonical Markdown bytes; duplicate approval rejected with 409');
  const makeSession = async (id, videoId = '') => {
    await fixtureBrowserDomain(a.request, origin, 'editLearning', { operationId: crypto.randomUUID(), edits: [{ mutationId: crypto.randomUUID(), kind: 'conversationSession', expected: null, value: { id, videoId, title: '云端交互测试', createdAt: Date.now() } }] });
  };
  const submit = async (kind, input) => (await a.request.post(`${origin}/api/v1/cloud/tasks`, { data: { nonce: crypto.randomUUID(), kind, resource: `session:${input.sessionId}`, input } })).json();
  await makeSession(editSessionId + 1, courseId);
  await second.goto(`${origin}/#/player/${courseId}`);
  await second.reload();
  await second.getByRole('button', { name: '打开学习助手', exact: true }).click();
  await second.locator('textarea').first().waitFor();
  const qa = await submit('qa', { sessionId: editSessionId + 1, videoId: courseId, text: '跨设备课程问答', materialKind: 'para', materialFormat: 'md' });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${qa.id}`)).json()).status === 'completed', 'QA completes');
  try { await second.getByText('另一台设备提交的课程问答已完成。', { exact: false }).first().waitFor({ timeout: 30000 }); }
   catch (error) { console.error('QA', await (await a.request.get(`${origin}/api/v1/cloud/tasks/${qa.id}`)).text(), await second.locator('body').innerText()); throw error; }
   evidence.steps.push('cross-device QA completes and appears live in the open learning assistant');
  await makeSession(editSessionId + 2);
  const asking = await submit('chat', { sessionId: editSessionId + 2, text: '追问测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${asking.id}`)).json()).progress?.view?.pendingAsk, 'waiting for question answer');
  assert.equal((await b.request.post(`${origin}/api/v1/cloud/tasks/${asking.id}/commands`, { data: { nonce: crypto.randomUUID(), action: 'answerAsk', value: '继续学习数学' } })).status(), 200);
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${asking.id}`)).json()).status === 'completed', 'question resumes from another device');
  await makeSession(editSessionId + 3);
  const cancelled = await submit('chat', { sessionId: editSessionId + 3, text: '追问测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cancelled.id}`)).json()).status === 'waiting_user', 'task awaits before cancellation');
  await b.request.post(`${origin}/api/v1/cloud/tasks/${cancelled.id}/cancel`);
   assert.equal((await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cancelled.id}`)).json()).status, 'cancelled');
   evidence.steps.push('ask answered from second device resumes; another waiting task cancelled from second device');
  await makeSession(editSessionId + 4);
  const revoked = await submit('chat', { sessionId: editSessionId + 4, text: '审批修改课程，撤销测试', attachments: [] });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/permissions`)).json()).permissions.some(p => p.taskId === revoked.id && p.status === 'pending'), 'pending permission before policy revocation');
  const policyConfig = await (await a.request.get(`${origin}/api/v1/cloud/config`)).json();
  await a.request.put(`${origin}/api/v1/cloud/config`, { data: { ...policyConfig, policy: { ...policyConfig.policy, write: 'deny' } } });
  await until(async () => (await (await a.request.get(`${origin}/api/v1/cloud/tasks/${revoked.id}`)).json()).status === 'completed', 'policy revocation terminates approval wait');
   const unchanged = await readCourseDocument();
   assert.equal(unchanged.text, fileRecord.text);
   assert.equal(unchanged.revision, fileRecord.revision);
   evidence.steps.push('write policy revocation terminates approval wait with canonical text and revision unchanged');
  await a.request.put(`${origin}/api/v1/cloud/config`, { data: policyConfig });
   await second.goto(`${origin}/#/settings/data`);
   await second.getByTestId('cloud-logout').click();
   await second.getByRole('heading', { name: 'DeepStudent Go', exact:true }).waitFor();
  assert.equal(await second.getByText('云端课程.md', { exact: true }).count(), 0);
  await second.getByRole('button', { name: '使用 Passkey 登录', exact: true }).click();
   await second.getByTestId('cloud-logout').waitFor({ timeout: 30000 });
  await second.setViewportSize({ width: 390, height: 844 });
   assert.equal(await second.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile settings fit viewport');
   evidence.steps.push('logout removes account course visibility; Passkey relogin succeeds; mobile settings fit 390px viewport');
  // Exercise browser-side cover decoding as well as Node document parsing.
  const video = await second.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#174d70'; ctx.fillRect(0, 0, 320, 180);
    ctx.fillStyle = '#ffffff'; ctx.font = '32px sans-serif'; ctx.fillText('Cloud video', 40, 100);
    const stream = canvas.captureStream(10), recorder = new MediaRecorder(stream, { mimeType: 'video/webm' }), chunks = [];
    const done = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = resolve; });
    recorder.start(); await new Promise(resolve => setTimeout(resolve, 1200)); recorder.stop(); await done;
    stream.getTracks().forEach(track => track.stop());
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
   await second.goto(`${origin}/#/library`);
   await second.getByRole('button', {name:'关闭设置',exact:true}).click();
   await second.locator('.resource-window input[type=file]').setInputFiles({name:'Video decoder test.webm',mimeType:'video/webm',buffer:Buffer.from(video)});
   let videoId, cover;
   await until(async () => {
     const listing = await (await b.request.get(`${origin}/api/v1/resources`)).json();
     videoId = listing.entries.find(entry => entry.name === 'Video decoder test.webm')?.courseId;
     if (!videoId) return false;
     cover = (await (await b.request.get(`${origin}/api/v1/cloud/tasks`)).json()).tasks.find(task => task.kind === 'cover' && task.input.videoId === videoId);
     return !!cover;
   }, 'normal video upload creates a course and cover task');
  await until(async () => {
    const task = await (await a.request.get(`${origin}/api/v1/cloud/tasks/${cover.id}`)).json();
    if (task.status === 'failed') throw new Error(task.error);
    if (task.status === 'completed') assert.equal(task.executor, 'browser');
    return task.status === 'completed';
  }, 'browser video cover generation');
  const coverRecord = (await (await a.request.get(`${origin}/api/v1/cloud/record?table=covers&key=${encodeURIComponent(JSON.stringify(videoId))}`)).json()).value;
   assert.ok(coverRecord?.blob.$file, 'browser video decoding produced a persisted cover');
   evidence.cover = {taskId:cover.id, videoId, record:coverRecord};
   evidence.steps.push('full original flow including two-device QA, background chat, approval/revocation, ask/cancel, Passkey/logout/mobile, normal video upload and browser cover');
   evidence.passed = true;
  console.log('Cloud e2e: setup, legacy data/attachments, Passkey, encrypted config, server document/video processing, two-device QA, background chat, one-shot editing/revocation, question resume, cancellation, mobile settings and logout isolation passed');
 } catch (error) {
   evidence.failure = String(error.stack ?? error);
   for (const [index, context] of (browser?.contexts() ?? []).entries()) for (const [n, tab] of context.pages().entries()) {
     if (tab.isClosed()) continue;
     fs.writeFileSync(path.join(directory, `failure-${index}-${n}.txt`), await tab.locator('body').innerText().catch(() => 'unavailable'));
     await tab.screenshot({path:path.join(directory, `failure-${index}-${n}.png`)}).catch(() => {});
   }
   throw error;
  } finally {
   for (const [index, context] of (browser?.contexts() ?? []).entries()) {
     const diagnostics = {};
     for (const resource of ['tasks','permissions']) {
       const response = await context.request.get(`${process.env.PUBLIC_ORIGIN}/api/v1/cloud/${resource}`).catch(() => null);
       if (response) diagnostics[resource] = {status:response.status(),body:await response.json().catch(() => null)};
     }
     fs.writeFileSync(path.join(directory, `server-${index}.json`), JSON.stringify(diagnostics,null,2));
   }
   evidence.finishedAt = new Date().toISOString();
   fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
  await browser?.close(); await vite?.close(); await app.close();
}
