// Real API + native Node executor + Web client. Only the external model is mocked.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { seedFixtureRecords } from './fixture-domain.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-server-widget-e2e-'));
const shots = process.env.SHOTS_DIR || path.join(os.tmpdir(), 'opencode', 'server-widgets', process.env.BROWSER || 'chrome');
fs.mkdirSync(shots, { recursive: true });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://127.0.0.1:${port}`;
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
  BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret'), PUBLIC_ORIGIN: origin, SERVE_WEB: 'false' });
const source = `<section><h2>服务器生成的交互讲解</h2><button id="counter">0</button></section>
<script>
var saved = window.__wbw.widgetState;
var count = saved && saved.modelContent && Number(saved.modelContent.count) || 0;
var button = document.getElementById('counter'); button.textContent = count;
button.onclick = async function () { count++; button.textContent = count;
  await window.__wbw.setWidgetState({modelContent:{count:count},privateContent:{}});
};
button.dataset.ready = 'true';
</script>`;
const largeSource = source + '<!--' + 'large-work-'.repeat(2500) + '-->';
let release, releaseArgs, modelCalls = 0;
const failedPrefix = '这段服务端已输出的回答发生中断，需要从这里接上。';
const continuedSuffix = '  现在继续解释后半部分。\n';
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
  const body = JSON.parse(init.body); modelCalls++;
  if (body.messages.at(-1)?.content?.includes('从断点处直接续上')) {
    assert.equal(body.tools, undefined);
    return Response.json({ choices: [{ message: { role: 'assistant', content: failedPrefix + continuedSuffix }, finish_reason: 'stop' }] });
  }
  if (body.messages.at(-1)?.content?.includes('测试断线续写')) {
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: failedPrefix }, finish_reason: 'error' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  }
  if (body.messages.at(-1)?.content?.includes('测试空输出异常')) {
    return Response.json({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'error' }] });
  }
  assert.ok(body.tools.some(tool => tool.function?.name === 'show_widget'));
  const large = body.messages.some(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('大型交互式计数器'));
  const receipt = body.messages.filter(message => message.role === 'tool' && message.name === 'show_widget').at(-1);
  if (large && (!receipt || !receipt.content.includes('```wbw-widget'))) {
    const previous = receipt ? JSON.parse(receipt.content) : { length: 0, revision: 0 };
    const offset = previous.length, revision = previous.revision;
    const calls = body.messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []).map(call => JSON.parse(call.function.arguments));
    const args = offset < largeSource.length
      ? { action: 'append', format: 'html', offset, revision, code: largeSource.slice(offset, offset + 2000) }
      : !calls.some(call => call.action === 'read') ? { action: 'read', format: 'html', offset: 0, code: '', limit: 100 }
      : !calls.some(call => call.action === 'patch') ? { action: 'patch', format: 'html', revision, code: '', edits: [{ search: 'var count = saved', replace: 'var count = /* patched */ saved' }] }
      : { action: 'complete', format: 'html', offset, revision, code: '' };
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `chunk-${modelCalls}`, type: 'function', function: { name: 'show_widget', arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] });
  }
  if (!receipt) {
    const json = JSON.stringify({ format: 'html', code: source });
    const split = Math.floor(json.length / 2);
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ start(controller) {
      const send = delta => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
      send({ content: '观察这个可点击的例子。' });
      send({ tool_calls: [{ index: 0, id: `widget-${modelCalls}`, type: 'function', function: { name: 'show_widget', arguments: json.slice(0, split) } }] });
      releaseArgs = () => {
        send({ tool_calls: [{ index: 0, function: { arguments: json.slice(split) } }] });
        controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close();
        releaseArgs = undefined;
      };
    } }), { headers: { 'content-type': 'text/event-stream' } });
  }
  // Keep the follow-up request pending so assertions exercise active task progress,
  // not just the final synced history (the old browser-only test missed this path).
  await new Promise((resolve, reject) => {
    release = resolve;
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
  });
  const reference = /```wbw-widget\n[^\n]+\n```/.exec(receipt.content)?.[0]; assert.ok(reference);
  return Response.json({ choices: [{ message: { role: 'assistant', content: `${reference}\n\n这是服务器工具链的后续讲解。` }, finish_reason: 'stop' }] });
} });
let vite, browser;
const browserWarnings = [];
const password = 'server-widget-test-password';
try {
  const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, payload: { adminPassword: password } });
  assert.equal(initialized.statusCode, 201);
  await app.listen({ host: '127.0.0.1', port: 0 });
  process.env.WANGKE_API_PROXY = `http://127.0.0.1:${app.server.address().port}`;
  const { preview } = await import('vite');
  const root = fileURLToPath(new URL('../apps/web/', import.meta.url));
  vite = await preview({ root, configFile: path.join(root, 'vite.config.ts'),
    preview: { host: '127.0.0.1', port, strictPort: true, proxy: { '/api': { target: process.env.WANGKE_API_PROXY, changeOrigin: false, ws: true } } }, logLevel: 'warn' });
  // Playwright's serviceWorkers:'block' injects a navigator.serviceWorker probe
  // into sandboxed srcdoc frames and itself raises a SecurityError there.
  const contextOptions = { viewport: { width: 1280, height: 900 }, locale: 'zh-CN' };
  // This macOS WebKit build rejects even a standalone IndexedDB Blob put in
  // ephemeral contexts. Use a disposable persistent profile, without mocking
  // storage or swallowing failures in the application's existing data paths.
  const context = process.env.BROWSER === 'webkit'
    ? await webkit.launchPersistentContext(path.join(directory, 'webkit-profile'), contextOptions)
    : await (async () => { browser = await chromium.launch({ channel: 'chrome' }); return browser.newContext(contextOptions); })();
  browser = context.browser();
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } });
  assert.equal(login.status(), 200);
  const fixtureOwner = (await login.json()).user.id;
  const config = await (await context.request.get(`${origin}/api/v1/cloud/config`)).json();
  const configured = await context.request.put(`${origin}/api/v1/cloud/config`, { data: { ...config, providers: [
    { id: 'test', name: 'Test', protocol: 'openai-chat', apiKey: 'test-only', baseUrl: 'https://test.example/v1', serves: ['chat'] },
  ], llmModel: { providerId: 'test', model: 'test-model' } } });
  assert.equal(configured.status(), 200);
  const mutate = async (table, key, after) => {
    await seedFixtureRecords(directory, fixtureOwner, [{ id: crypto.randomUUID(), table, key, before: null, after }]);
  };
  const page = context.pages()[0] ?? await context.newPage();
  page.on('console', message => {
    if (message.type() === 'error' || message.type() === 'warning') browserWarnings.push(message.text());
  });
  await page.addInitScript(() => {
    const fetch = window.fetch.bind(window), pending = new Set();
    let paused = false;
    window.fetch = (...args) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const polling = /^\/api\/v1\/cloud\/(?:records|tasks)(?:\/[\w-]+)?$/.test(url.pathname)
        || /^\/api\/clientRuntime\/(?:recordsPage|tasksPage)$/.test(url.pathname);
      if (!polling) return fetch(...args);
      // Stop only when the test explicitly unloads this document. New polling
      // waits for unload; existing requests (including bodies) finish normally.
      // No response data or network failure is mocked or swallowed.
      if (paused) return new Promise(() => {});
      const request = fetch(...args).then(async response => { await response.clone().arrayBuffer(); return response; });
      pending.add(request);
      request.then(() => pending.delete(request), () => pending.delete(request));
      return request;
    };
    window.__drainWidgetTestPolling = async () => {
      paused = true;
      let timer;
      try {
        await Promise.race([
          Promise.allSettled([...pending]),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Polling did not settle before navigation')), 5000); }),
        ]);
      } finally { clearTimeout(timer); }
    };
  });
  const errors = [];
  const resizeNotices = [];
  // WebKit emits spurious native CORS errors when unloading an active fetch.
  // Drain the old page instead of excluding any access-control errors below.
  const navigate = async action => {
    // The remote client runtime owns its fetches inside a srcdoc frame.
    // Drain it too, not only the top-level legacy polling adapter.
    await Promise.all(page.frames().map(async frame => {
      try { await frame.evaluate(async () => { await window.__drainWidgetTestPolling?.(); }); }
      catch (error) {
        // Static partial previews may unmount while the completed card arrives.
        // Only an already-detached frame needs no drain; real fetch errors fail.
        if (!frame.isDetached()) throw error;
      }
    }));
    await action();
  };
  const failedRequests = [];
  page.on('requestfailed', request => failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
  page.on('pageerror', error => {
    if (error.message === 'ResizeObserver loop completed with undelivered notifications.') { resizeNotices.push(error.message); return; }
    errors.push(error.stack || error.message);
  });
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`${origin}/#/chat`);
  await page.getByTestId('course-chat-page').waitFor();
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('请使用交互式讲解解释一个计数器');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  const works = page.getByTestId('widget-block');
  const openWork = async () => {
    await page.getByTestId('widget-work-source').waitFor({ timeout: 30000 });
    assert.equal(await page.getByTestId('widget-frame').count(), 0, 'published work still requires a user preview click');
    await page.getByTestId('widget-work-source').getByTestId('code-block-more').click();
    await page.getByRole('menuitem', { name: '预览', exact: true }).click();
    await works.waitFor({ timeout: 30000 });
  };
  const partial = page.getByTestId('widget-stream-preview');
  const argsDeadline = Date.now() + 30000;
  while (!releaseArgs && Date.now() < argsDeadline) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(releaseArgs, 'streamed arguments reached the server');
  await page.waitForTimeout(100);
  assert.equal(await partial.count(), 0, 'no tool delta preview before full validation, regardless of field order');
  assert.equal(await page.getByTestId('widget-frame').count(), 0, 'partial arguments cannot execute scripts');
  releaseArgs();
  await openWork();
  await partial.waitFor({ state: 'detached' });
  assert.equal(await page.getByTestId('code-block').count(), 1, 'published works use the existing source-first preview card');
  let task = (await (await context.request.get(`${origin}/api/v1/cloud/tasks`)).json()).tasks.find(task => task.kind === 'chat');
  assert.equal(task.executor, 'node'); assert.equal(task.status, 'running');
  assert.equal(task.progress.widgets.length, 1);
  const ref = task.progress.widgets[0].ref;
  // Reload while the external model is still blocked. The new page has to rebuild
  // its active view from API records/progress, not an in-memory browser tool result.
  await navigate(() => page.reload());
  await openWork();
  assert.equal(await works.count(), 1, 'no duplicate checkpoint + live message');
  const frame = page.getByTestId('widget-frame');
  await frame.contentFrame().getByRole('heading', { name: '服务器生成的交互讲解' }).waitFor();
  const openedChatFrame = await frame.elementHandle();
  assert.equal(await frame.getAttribute('sandbox'), 'allow-scripts');
  // Static first paint can precede the sandbox's script initialization.
  await frame.contentFrame().locator('#counter[data-ready="true"]').waitFor();
  await frame.contentFrame().getByRole('button', { name: '0', exact: true }).click();
  try { await frame.contentFrame().getByRole('button', { name: '1', exact: true }).waitFor(); }
  catch (error) { console.error('FRAME', await frame.contentFrame().locator('body').innerText(), 'DIAGNOSTICS', await page.getByTestId('widget-error').allTextContents()); throw error; }
  assert.equal(await page.getByTestId('widget-error').count(), 0, (await page.getByTestId('widget-error').allTextContents()).join('\n'));
  assert.equal(modelCalls, 2, 'local interactions do not call the model');
  await page.screenshot({ path: path.join(shots, 'chat-active-preview.png') });
  release();
  await page.getByText('这是服务器工具链的后续讲解。', { exact: false }).waitFor({ timeout: 30000 });
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  assert.equal(await openedChatFrame.evaluate(element => element.isConnected), true, 'chat completion must not remount an opened preview');
  await frame.contentFrame().getByRole('button', { name: '1', exact: true }).waitFor();
  assert.equal(await works.count(), 1);
  await navigate(() => page.reload()); await openWork();
  task = await (await context.request.get(`${origin}/api/v1/cloud/tasks/${task.id}`)).json();
  assert.equal(task.status, 'completed'); assert.equal(task.result.widget.ref, ref);
  const row = (await (await context.request.get(`${origin}/api/v1/cloud/record?table=chats&key=${task.result.rowId}`)).json()).value;
  assert.equal(row.widgets[0].html, source);
  await frame.contentFrame().getByRole('button', { name: '1', exact: true }).waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('widget-error').count(), 0, (await page.getByTestId('widget-error').allTextContents()).join('\n'));
  assert.equal(await page.getByTestId('widget-save-material').count(), 0, 'no new library source-save feature');
  await page.screenshot({ path: path.join(shots, 'chat-reloaded-preview.png') });

  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('测试断线续写');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  await page.getByTestId('chat-continue').waitFor({ timeout: 30000 });
  const failedTask = (await (await context.request.get(`${origin}/api/v1/cloud/tasks`)).json()).tasks.find(item => item.input.text === '测试断线续写');
  await page.getByTestId('chat-continue').click();
  await page.getByText('现在继续解释后半部分。', { exact: false }).waitFor({ timeout: 30000 });
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  // The timeline is virtualized: total mounted nodes changes as it remeasures.
  // Check this answer's actual identity and visible copies, not unrelated rows.
  assert.equal(await page.getByText('现在继续解释后半部分。', { exact: false }).count(), 1, 'cloud continuation has one visible answer');
  const continuationTask = (await (await context.request.get(`${origin}/api/v1/cloud/tasks`)).json()).tasks.find(item => item.input.action === 'continue');
  assert.equal(continuationTask.status, 'completed');
  const continuedRow = (await (await context.request.get(`${origin}/api/v1/cloud/record?table=chats&key=${continuationTask.result.rowId}`)).json()).value;
  assert.equal(continuedRow.content, failedPrefix + continuedSuffix);
  assert.equal(continuedRow.interrupted, undefined);
  assert.equal(continuationTask.input.rowId, continuedRow.id);
  assert.equal(continuedRow.id, failedTask.progress.rowId, 'cloud continuation updates the failed answer, not a new message');

  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).fill('测试空输出异常');
  await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).press('Enter');
  await page.getByTestId('chat-error-continue').waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('chat-continue').count(), 0, 'empty failures have no resumable breakpoint');
  await navigate(() => page.reload());
  await page.getByTestId('chat-error-continue').waitFor({ timeout: 30000 });
  assert.equal(await page.getByTestId('chat-continue').count(), 0, 'refresh must not turn an empty error into continuation');

  // QA side panel: real course, real server QA executor and remote runQa sink.
  await mutate('videos', 'widget-course', { id: 'widget-course', name: '作品测试课程', kind: 'material', materialFormat: 'md', status: 'ready', coverState: 'skipped', createdAt: Date.now(), size: 0 });
  await mutate('materialBlocks', 900, { id: 900, materialId: 'widget-course', idx: 0, unit: 1, text: '交互式计数器的学习资料。' });
  // Change the document URL as well as the hash: navigating by hash and then
  // immediately reloading aborts the Player chunk/CSS preload in WebKit.
  await navigate(() => page.goto(`${origin}/?server-widget-qa=1#/player/widget-course`));
  await page.getByRole('button', { name: '打开学习助手', exact: true }).click();
  const input = page.locator('textarea').first(); await input.fill('请画一个大型交互式计数器'); await input.press('Enter');
  await openWork();
  assert.equal(await partial.count(), 0, 'assembly chunks never masquerade as completed previews');
  const qaTask = (await (await context.request.get(`${origin}/api/v1/cloud/tasks`)).json()).tasks.find(task => task.kind === 'qa');
  assert.equal(qaTask.progress.widgets[0].html, largeSource.replace('var count = saved', 'var count = /* patched */ saved'), 'read/patch edits the pending page before the existing QA delivery path');
  assert.equal(await works.count(), 1);
  try { await frame.contentFrame().getByRole('heading', { name: '服务器生成的交互讲解' }).waitFor(); }
  catch (error) { console.error('QA PAGE', await page.locator('body').innerText()); await page.screenshot({ path: path.join(shots, 'qa-failed.png') }); throw error; }
  const openedQaFrame = await frame.elementHandle();
  release();
  await page.getByText('这是服务器工具链的后续讲解。', { exact: false }).waitFor({ timeout: 30000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="chat-msg-ai"][data-streaming="true"]'));
  await frame.contentFrame().getByRole('heading', { name: '服务器生成的交互讲解' }).waitFor();
  assert.equal(await openedQaFrame.evaluate(element => element.isConnected), true, 'completion must not remount an opened preview');
  const callsBeforeEdit = modelCalls;
  await page.getByTestId('widget-work-source').getByTestId('code-block-more').click();
  await page.getByRole('menuitem', { name: '修改 HTML', exact: true }).click();
  const editPanel = page.getByTestId('artifact-edit-panel');
  await editPanel.waitFor();
  await editPanel.getByRole('button', { name: '收起', exact: true }).click();
  await editPanel.waitFor({ state: 'hidden' });
  assert.equal(modelCalls, callsBeforeEdit, 'existing explicit edit entry does not auto-request or patch the shown page');
  assert.equal(await openedQaFrame.evaluate(element => element.isConnected), true);
  assert.equal(await page.getByTestId('widget-error').count(), 0, (await page.getByTestId('widget-error').allTextContents()).join('\n'));
  await page.screenshot({ path: path.join(shots, 'qa-preview.png') });
  if (errors.length) console.error('Failed requests:', failedRequests);
  assert.deepEqual(errors, []);
  assert.ok(resizeNotices.length < 10, 'ResizeObserver notifications must remain bounded');
  console.log(`Real API/Node chat + QA: direct/assembled pages, final-only chat payloads, click sandbox preview, active reload/state, no library-save addition, same-row continuation/dedup and completion passed. Screenshots: ${shots}`);
} catch (error) {
  const context = browser?.contexts()[0];
  const page = context?.pages()[0];
  if (page) {
    console.error('BROWSER WARNINGS', browserWarnings);
    console.error('PAGE', await page.locator('body').innerText());
    console.error('TASKS', await (await context.request.get(`${origin}/api/v1/cloud/tasks`)).text());
    await page.screenshot({ path: path.join(shots, 'failure.png') });
  }
  throw error;
} finally {
  releaseArgs?.(); release?.(); await browser?.close(); await vite?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true });
}
