import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'background-tasks-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const reservation = net.createServer();
await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const origin = `http://localhost:${port}`;
process.env.PUBLIC_ORIGIN = origin;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, store, web;
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), server: { host: 'localhost', port, strictPort: true, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen();
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'background-tasks-ui-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const login = await post('/auth/password/login', { password: 'background-tasks-ui-password-123' });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  const policy = (await (await context.request.get(`${origin}/api/v1/cloud/config`)).json()).policy;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const at = new Date().toISOString();
  store.db.prepare("INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES('tasks-bot',?,'学习助手','assistant','',?,?)").run(owner, at, at);
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,agent_id,created_at,updated_at) VALUES('tasks-thread',?,'bot','tasks-bot',?,?)").run(owner, at, at);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES('tasks-run','tasks-thread','bot','completed',?)").run(at);
  const insert = (id, kind, status, parent = null, error = null) => store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id,error) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, 'course:fixture', '{}', status, at, at, parent, error);
  insert('cover', 'cover', 'running');
  insert('material', 'material', 'queued');
  insert('bot-material', 'material', 'waiting_user', 'tasks-run');
  store.db.prepare("INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,created_at) VALUES('tasks-approval',?,'bot-material','write','{}',?)").run(owner, at);
  insert('completed', 'cards', 'completed');
  insert('failed', 'handout', 'failed', null, '测试失败信息');
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const output = process.env.SCREENSHOT_DIR ?? path.join(directory, 'screenshots');
  fs.mkdirSync(output, { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${origin}/#/settings/bot`);
    await page.getByTestId('bot-policy').waitFor({ timeout: 30000 });
    assert.equal(await page.getByText('专用工作机', { exact: true }).count(), 0);
    assert.equal(await page.getByTestId('bot-tasks').count(), 0);
    await page.getByTestId('bot-approvals').waitFor();
    assert.equal(await page.getByTestId('bot-approvals').getByRole('button', { name: '批准', exact: true }).count(), 1, 'approvals remain in Bot settings');
    await page.evaluate(async () => {
      const { closeSettingsAndClearHash } = await import('/src/components/settingsDialogStore.ts');
      closeSettingsAndClearHash();
      const { applyLocale } = await import('/src/i18n/index.ts');
      applyLocale('zh-CN');
    });
    await page.getByTestId('bot-policy').waitFor({ state: 'hidden' });
    if (width === 390) await page.getByTestId('nav-rail-open').click();
    await page.getByTestId('nav-rail-tasks').click();
    await page.locator('.app-navigation-workspace').evaluate(async element => {
      await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {})));
    });
    const panel = page.getByTestId('background-tasks');
    await panel.getByText('生成封面', { exact: true }).waitFor();
    assert.match(await panel.getByTestId('background-task-cover').innerText(), /由应用发起/);
    assert.match(await panel.getByTestId('background-task-material').innerText(), /排队中/);
    assert.match(await panel.getByTestId('background-task-bot-material').innerText(), /等待确认 · 由 学习助手 Bot 发起/);
    assert.equal(await panel.getByTestId('background-tasks-recent').getByRole('button', { name: /^停止/ }).count(), 0);
    assert.match(await panel.getByTestId('background-task-failed').innerText(), /测试失败信息/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `no overflow at ${width}`);
    assert.ok(await panel.getByRole('button').evaluateAll(buttons => buttons.every(button => {
      const box = button.getBoundingClientRect();
      return box.left >= 0 && box.right <= innerWidth;
    })), `task controls fit ${width}`);
    await page.screenshot({ path: path.join(output, `background-tasks-zh-${width}.png`) });
    await page.evaluate(async () => { const { applyLocale } = await import('/src/i18n/index.ts'); applyLocale('en-US'); });
    await panel.getByText('Generate cover', { exact: true }).waitFor();
    assert.match(await panel.getByTestId('background-task-bot-material').innerText(), /Started by Bot 学习助手/);
    await page.screenshot({ path: path.join(output, `background-tasks-en-${width}.png`) });
  }
  const panel = page.getByTestId('background-tasks');
  await panel.getByTestId('background-task-material').getByRole('button', { name: 'Stop Parse document', exact: true }).click();
  await panel.getByTestId('background-tasks-recent').getByTestId('background-task-material').waitFor();
  assert.equal(store.db.prepare("SELECT status FROM cloud_tasks WHERE id='material'").get().status, 'cancelled');
  // The page consumes CloudActivity's shared snapshot and reports a failed feed,
  // rather than claiming an empty queue when the server cannot be reached.
  await page.route('**/api/v1/cloud/tasks', route => route.fulfill({ status: 403, json: { error: 'fixture_unavailable' } }));
  await panel.getByRole('alert').waitFor();
  assert.equal(await panel.getByTestId('background-task-cover').count(), 1, 'last known rows remain visible');
  await page.unroute('**/api/v1/cloud/tasks');
  await panel.getByRole('alert').waitFor({ state: 'hidden' });
  await page.route('**/api/v1/cloud/tasks', route => route.fulfill({ json: { tasks: [] } }));
  await panel.getByText('No background tasks in progress', { exact: true }).waitFor();
  await panel.getByText('No recent history', { exact: true }).waitFor();
  assert.deepEqual((await (await context.request.get(`${origin}/api/v1/cloud/config`)).json()).policy, policy);
  assert.deepEqual(errors, []);
  console.log(`Background tasks UI passed at 390/1440px: global navigation, Chinese/English names, source labels, status groups, stop, error recovery, empty state, unchanged permissions. Screenshots: ${output}`);
} catch (error) {
  for (const page of browser?.contexts()[0]?.pages() ?? []) console.error((await page.locator('body').innerText()).slice(-10000));
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await app.close();
  store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
