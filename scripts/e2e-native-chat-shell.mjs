/** Authenticated browser/API/SQLite/production ordinary Chat runtime. External model
 * and sandbox transports are scripted; approval and task streams are real. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'opencode', 'chat-shell-browser-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const errors = [], executions = [];
const command = 'python3 -c "print(6*7)"';
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), sandbox: async request => {
  executions.push(request); assert.equal(request.command, command); assert.equal(request.network, false);
  assert.equal(request.projectId, undefined); assert.equal(request.systemWrite, undefined);
  return { stdout: '42\n', stderr: '', exitCode: 0 };
}, sandboxCleanup: async () => {}, fetch: async (_, init) => {
  const body = JSON.parse(init.body);
  assert.ok(body.tools.some(tool => tool.function.name === 'shell'));
  const receipt = body.messages.slice(body.messages.findLastIndex(message => message.role === 'user') + 1).find(message => message.role === 'tool' && message.name === 'shell');
  if (!receipt) return Response.json({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: `shell-${Date.now()}`, type: 'function', function: {
    name: 'shell', arguments: JSON.stringify({ command, description: '精确计算6乘7', timeoutSeconds: 120 }),
  } }] }, finish_reason: 'tool_calls' }] });
  return Response.json({ choices: [{ message: { role: 'assistant', content: receipt.content.includes('shell_permission_rejected') ? '命令已拒绝，没有执行。' : '计算完成，结果是42。' }, finish_reason: 'stop' }] });
} });
let web, browser, page;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const password = 'chat-shell-fixture-password';
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } })).status(), 200);
  const config = await (await context.request.get(origin + '/api/v1/cloud/config')).json();
  assert.equal((await context.request.put(origin + '/api/v1/cloud/config', { data: { ...config,
    providers: [{ id: 'fixture', name: '测试模型', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture', serves: ['chat'], catalogId: '' }],
    llmModel: { providerId: 'fixture', model: 'gpt-4.1' }, policy: { ...config.policy, shell: 'ask' } } })).status(), 200);
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://model.invalid/**', () => { throw new Error('browser model execution is forbidden'); });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  const send = async text => {
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
    await input.fill(text); await input.press('Enter');
  };
  const card = page.getByTestId('chat-shell-approval');
  await send('请用Python计算6乘7'); await card.waitFor();
  assert.equal(executions.length, 0);
  assert.match(await card.innerText(), /精确计算6乘7/);
  await card.locator('summary').click(); assert.match(await card.locator('pre').innerText(), /print\(6\*7\)/);
  await page.screenshot({ path: path.join(directory, 'approval-desktop.png') });
  const sessionId = await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
  // Switching chats must not leak another conversation's command card.
  await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().createSession());
  await card.waitFor({ state: 'detached' });
  await page.evaluate(async id => (await import('/src/store/courseChat.ts')).useCourseChat.getState().loadSession(id), sessionId);
  await card.waitFor(); assert.equal(executions.length, 0);
  await page.reload(); await card.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const box = await card.boundingBox(); assert.ok(box && box.x >= 0 && box.x + box.width <= 391 && box.y + box.height <= 845, JSON.stringify(box));
  await page.screenshot({ path: path.join(directory, 'approval-mobile.png') });
  const pending = (await (await context.request.get(origin + '/api/v1/cloud/permissions')).json()).permissions.find(p => p.status === 'pending' && p.capability === 'shell');
  await page.getByTestId('chat-shell-approve').click();
  await page.getByText('计算完成，结果是42。', { exact: false }).first().waitFor();
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  assert.equal(executions.length, 1);
  assert.equal((await context.request.post(origin + `/api/v1/cloud/permissions/${pending.id}/resolve`, { data: { approved: true } })).status(), 409);
  await send('再算一次，但我要拒绝'); await card.waitFor();
  await page.getByTestId('chat-shell-reject').click();
  await page.getByText('命令已拒绝，没有执行。', { exact: false }).first().waitFor();
  await page.getByTestId('chat-stop').waitFor({ state: 'detached' }); assert.equal(executions.length, 1);
  await send('这次等我确认'); await card.waitFor();
  await page.getByTestId('chat-stop').click(); await card.waitFor({ state: 'detached' });
  assert.equal(executions.length, 1); assert.deepEqual(errors, []);
  console.log(`PASS Chat Shell browser: inline approval/reject/stop, exact command, session switch, reload, single-use permit, desktop/mobile. Evidence: ${directory}`);
} catch (error) {
  if (page) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }); console.error(await page.locator('body').innerText(), errors); }
  console.error('Evidence:', directory); throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); }
