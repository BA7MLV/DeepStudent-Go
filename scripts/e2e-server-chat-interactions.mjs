/** Real authenticated app + API/SQLite. Only the external model transport is scripted. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/chat-interactions-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const html = `<section><h3>学习路线</h3>
<button id="choose">选择深入练习</button><button id="submit">提交路线</button><output></output></section>
<script>
const api=window.__wbw, output=document.querySelector('output');
const answer={status:'answered',mode:'selection',selectedIds:['deep'],selectedLabels:['FORGED'],text:'',note:''};
document.querySelector('#choose').onclick=()=>api.setAnswerDraft(answer).then(()=>output.textContent='已选择深入练习').catch(e=>output.textContent=e.message);
document.querySelector('#submit').onclick=()=>api.submitAnswer(answer).catch(e=>output.textContent=e.message);
function sync(){document.querySelectorAll('button').forEach(button=>button.disabled=api.answerInput.submitted);}
sync();window.addEventListener('wbw:answerchange',sync);
</script>`;
const ask = { question: '选择你的学习路线', type: 'multiple', minSelections: 1, maxSelections: 2,
  options: [{ id: 'short', label: '快速回顾' }, { id: 'deep', label: '深入练习' }], presentation: { html } };
const requests = [], errors = [], commands = [];
let releaseAnswer;
const sse = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid');
  const body = JSON.parse(init.body); requests.push(body);
  const turn = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1);
  const receipt = turn.find(message => message.role === 'tool' && message.name === 'ask_user');
  if (!receipt) return new Response(sse({ reasoning_content: '先确认学习路线。' }) + sse({ tool_calls: [{ index: 0, id: `ask-${requests.length}`, type: 'function', function: { name: 'ask_user', arguments: JSON.stringify(ask) } }] }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
  assert.deepEqual(JSON.parse(receipt.content).selectedIds, ['deep']);
  assert.deepEqual(JSON.parse(receipt.content).selectedLabels, ['深入练习']);
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(encoder.encode(sse({ reasoning_content: '收到路线，整理深入练习步骤。' }) + sse({ content: '已收到路线，开始深入练习。' })));
    releaseAnswer = () => {
      controller.enqueue(encoder.encode(sse({ content: '\n\n这是后续说明，中文流式内容应当连续显示。' }) + 'data: [DONE]\n\n'));
      controller.close(); releaseAnswer = undefined;
    };
  } }), { headers: { 'content-type': 'text/event-stream' } });
} });
let web, browser, page;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const password = 'chat-interactions-fixture-123';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).status(), 200);
  const config = await (await context.request.get(origin + '/api/v1/cloud/config')).json();
  assert.equal((await context.request.put(origin + '/api/v1/cloud/config', { data: { ...config,
    providers: [{ id: 'fixture', name: '测试模型', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'free-only', serves: ['chat'], catalogId: '' }],
    llmModel: { providerId: 'fixture', model: 'gpt-5.2' } } })).status(), 200);
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/\/commands$/.test(request.url())) commands.push(request.postDataJSON()); });
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://model.invalid/**', () => { throw new Error('browser model requests are forbidden'); });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  await page.getByTestId('chat-add').click();
  await page.getByTestId('task-model-selection').getByTestId('model-picker').click();
  const depth = page.getByRole('slider', { name: '思考深度' });
  await depth.waitFor(); await depth.focus(); await depth.press('End');
  assert.equal(await depth.getAttribute('aria-valuetext'), '极高');
  await depth.press('Home'); assert.equal(await depth.getAttribute('aria-valuetext'), '不思考');
  await depth.press('ArrowRight'); assert.equal(await depth.getAttribute('aria-valuetext'), '低');
  assert.equal(await page.getByRole('region', { name: '偏好命令恢复' }).count(), 0, 'ordinary depth changes do not flash recovery controls');
  await page.screenshot({ path: path.join(directory, 'thinking-depth.png'), animations: 'disabled' });
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('menu', { name: '添加到对话' }).waitFor({ state: 'hidden' });
  const send = async text => {
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
    await input.click(); await input.fill(text); await input.press('Enter');
  };
  await send('请让我选择学习路线');
  const card = page.getByTestId('ask-card').filter({ has: page.getByRole('button', { name: '提交选择', exact: true }) });
  const frame = () => card.getByTestId('widget-frame').contentFrame();
  await frame().getByRole('button', { name: '选择深入练习' }).click();
  await frame().locator('output').filter({ hasText: '已选择深入练习' }).waitFor();
  assert.equal(await card.getByRole('checkbox', { name: '深入练习' }).isChecked(), true);
  const mounted = await card.getByTestId('widget-frame').elementHandle();
  // Repeated authoritative task snapshots must not clear/remount the live card.
  await page.evaluate(async () => {
    const { tasks } = await (await fetch('/api/v1/cloud/tasks')).json();
    const { reflectCloudTasks } = await import('/src/store/courseChat.ts');
    for (let n = 0; n < 3; n++) await reflectCloudTasks(tasks);
  });
  assert.equal(await mounted.evaluate(element => element.isConnected), true);
  assert.equal(await card.getByRole('checkbox', { name: '深入练习' }).isChecked(), true);
  assert.equal(requests[0].reasoning_effort, 'low', 'selected depth reaches the real server model request');
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  assert.match(await page.getByTestId('ask-visual-confirm').innerText(), /深入练习/);
  assert.doesNotMatch(await page.getByTestId('ask-visual-confirm').innerText(), /FORGED/);
  await page.getByRole('button', { name: '继续修改', exact: true }).click();
  assert.equal(commands.length, 0);
  await page.reload(); await frame().getByRole('button', { name: '选择深入练习' }).click();
  await frame().locator('output').filter({ hasText: '已选择深入练习' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  await page.screenshot({ path: path.join(directory, 'visual-confirm-mobile.png'), animations: 'disabled' });
  await page.getByRole('button', { name: '确认回答', exact: true }).click();
  await page.getByText('已收到路线，开始深入练习。', { exact: false }).first().waitFor();
  assert.equal(requests.length, 2); assert.equal(commands.length, 1);
  assert.equal(requests[1].reasoning_effort, 'low');
  assert.ok(await page.locator('.t-stream-w').count() > 1, 'Chinese streaming segments animate individually');
  // The answered question card is a chronological anchor: the resumed answer and
  // its thinking chain must follow it, not be pushed above it by the card.
  const order = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="ask-card"][data-answered="true"]');
    const processes = [...document.querySelectorAll('[data-testid="response-process"]')];
    const answer = [...document.querySelectorAll('[data-chat-answer-start]')].at(-1);
    const follows = (before, after) => !!before && !!after && !!(before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { processes: processes.length, preBeforeCard: follows(processes[0], card),
      cardBeforePost: follows(card, processes[1]), cardBeforeAnswer: follows(card, answer) };
  });
  assert.equal(order.processes, 2, 'pre-ask and resumed reasoning stay separate groups');
  assert.ok(order.preBeforeCard, 'ask reasoning precedes the answered card');
  assert.ok(order.cardBeforePost, 'resumed reasoning follows the answered card');
  assert.ok(order.cardBeforeAnswer, 'resumed answer follows the answered card');
  releaseAnswer();
  await page.getByText('这是后续说明，中文流式内容应当连续显示。', { exact: false }).first().waitFor();
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelectorAll('.t-stream-w').length === 0);
  await page.reload(); await page.getByText('这是后续说明，中文流式内容应当连续显示。', { exact: false }).first().waitFor();
  assert.equal(await page.locator('.t-stream-w').count(), 0, 'history does not replay streaming effects');
  assert.equal(await page.getByTestId('widget-frame').contentFrame().getByRole('button', { name: '提交路线' }).isDisabled(), true);
  await page.screenshot({ path: path.join(directory, 'answered-mobile.png'), animations: 'disabled' });
  await send('再问一次，用于检查停止后的题卡');
  await frame().getByRole('button', { name: '提交路线' }).click();
  await page.getByTestId('ask-visual-confirm').waitFor();
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().stop());
  await page.getByTestId('ask-visual-confirm').waitFor({ state: 'detached' });
  await page.getByTestId('ask-card-expired').waitFor();
  assert.equal(requests.length, 3); assert.equal(commands.length, 1);
  assert.deepEqual(errors, []);
  console.log(`PASS thinking depth → server, visual draft/confirm/cancel/reload/stop, Chinese streaming/history. Evidence: ${directory}`);
  if (process.env.KEEP_OPEN) { console.log(`Preview: ${origin} · password: ${password}`); await new Promise(resolve => process.once('SIGTERM', resolve)); }
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(directory, 'failure.html'), await page.content());
    console.error('PAGE', await page.locator('body').innerText());
    console.error('TASKS', await page.evaluate(async () => (await fetch('/api/v1/cloud/tasks')).json()));
    console.error('ERRORS', errors, 'MODEL CALLS', requests.length);
  }
  console.error('Evidence:', directory); throw error;
} finally {
  releaseAnswer?.(); await browser?.close(); await web?.close(); await app.close();
}
