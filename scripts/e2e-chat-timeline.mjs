/** Full authenticated Chat, real server stream/store/reload, offline provider. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createServer } from 'vite';

const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'chat-timeline-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const errors = [], requests = [];
let releaseMiddle, releaseFinal;
const sse = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const toolDelta = (id, name, args) => sse({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const pending = (prefix, setRelease, init) => new Response(new ReadableStream({ start(controller) {
  controller.enqueue(new TextEncoder().encode(prefix));
  setRelease(suffix => { controller.enqueue(new TextEncoder().encode(suffix + 'data: [DONE]\n\n')); controller.close(); });
  init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
} }), { headers: { 'content-type': 'text/event-stream' } });
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid', 'never call a real provider');
  requests.push(JSON.parse(init.body));
  if (requests.length === 1) return new Response(sse({ content: '第一段说明。' }) + toolDelta('visual', 'show_widget', {
    format: 'html', code: '<button id="counter">点击 0</button><script>let n=0;document.querySelector("button").onclick=e=>e.target.textContent="点击 "+(++n);</script>',
  }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  if (requests.length === 2) return pending(sse({ content: '第二段说明。' }), release => { releaseMiddle = release; }, init);
  assert.equal(requests.length, 3, 'text-only final output must terminate the loop');
  return pending(sse({ reasoning_content: '根据工具结果进行核实。' }) + sse({ content: '最终结论' }), release => { releaseFinal = release; }, init);
} });
let web, browser, page;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (process.env.CHAT_TIMELINE_BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 850 }, locale: 'zh-CN' });
  const password = 'chat-timeline-test-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).status(), 200);
  const config = await (await context.request.get(origin + '/api/v1/cloud/config')).json();
  assert.equal((await context.request.put(origin + '/api/v1/cloud/config', { data: { ...config,
    providers: [{ id: 'fixture', name: '测试模型', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'test-only', serves: ['chat'], catalogId: '' }],
    llmModel: { providerId: 'fixture', model: 'fixture' } } })).status(), 200);
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://model.invalid/**', () => { throw new Error('browser-side provider execution forbidden'); });
  await page.goto(origin); await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
  await input.fill('请分步解释，并继续使用工具核实'); await input.press('Enter');
  await page.getByText('第二段说明。', { exact: false }).first().waitFor();
  const frame = page.getByTestId('widget-frame');
  await frame.contentFrame().getByRole('button', { name: '点击 0' }).click();
  const mounted = await frame.elementHandle();
  const checkOrder = async final => {
    const positions = await page.evaluate(() => {
      const text = value => [...document.querySelectorAll('p')].find(element => element.textContent.includes(value));
      const first = text('第一段说明。'), middle = text('第二段说明。'), last = text('最终结论');
      const frame = document.querySelector('[data-testid="widget-frame"]');
      const processes = [...document.querySelectorAll('[data-testid="response-process"]')];
      const before = (a, b) => !!a && !!b && !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { firstBeforeFrame: before(first, frame), frameBeforeMiddle: before(frame, middle),
        processAfterMiddle: processes.some(process => before(middle, process)),
        finalAfterProcess: processes.some(process => before(middle, process) && before(process, last)) };
    });
    assert.equal(positions.firstBeforeFrame, true);
    assert.equal(positions.frameBeforeMiddle, true);
    if (final) { assert.equal(positions.processAfterMiddle, true); assert.equal(positions.finalAfterProcess, true); }
  };
  await checkOrder(false);
  releaseMiddle(toolDelta('verify', 'models_discover', {})); releaseMiddle = undefined;
  await page.getByText('最终结论', { exact: false }).first().waitFor();
  assert.equal(await mounted.evaluate(element => element.isConnected), true, 'new tool rounds never remount the existing widget');
  await frame.contentFrame().getByRole('button', { name: '点击 1' }).waitFor();
  await checkOrder(true);
  await page.reload(); await page.getByText('最终结论', { exact: false }).first().waitFor({ timeout: 15000 });
  await checkOrder(true);
  releaseFinal(sse({ content: '，已完成。' })); releaseFinal = undefined;
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  await page.getByText('最终结论，已完成。', { exact: false }).first().waitFor();
  await page.reload(); await page.getByText('最终结论，已完成。', { exact: false }).first().waitFor({ timeout: 60000 });
  await checkOrder(true);
  assert.equal(requests.length, 3);
  const replay = await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    return useCourseChat.getState().messages.filter(message => message.role === 'ai').map(message => ({ content: message.content, segments: message.responseSegments }));
  });
  assert.equal(replay.length, 1, 'one durable answer, not one message per tool round');
  assert.ok(replay[0].segments.length >= 3);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(directory, 'timeline.png'), fullPage: true });
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ requests: requests.length, replay, errors }, null, 2));
  console.log(`PASS Chat timeline UI: visible interleaving, widget identity/state, live reconnect and history replay. Evidence: ${directory}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
    const state = await page.evaluate(async () => {
      const { useCourseChat } = await import('/src/store/courseChat.ts');
      const state = useCourseChat.getState();
      return { activeId: state.activeId, loaded: state.loaded, loading: state.loading, messages: state.messages, tasks: state.tasks, historyError: state.historyError };
    });
    fs.writeFileSync(path.join(directory, 'failure-state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(directory, 'failure.html'), await page.content());
    console.error(await page.locator('body').innerText()); console.error(JSON.stringify(state));
  }
  console.error('Evidence:', directory); throw error;
} finally { releaseMiddle?.(''); releaseFinal?.(''); await browser?.close(); await web?.close(); await app.close(); }
