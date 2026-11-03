import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/plugin-bot-template-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
let browser, web, store;
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => Response.json({ choices: [{ message: { role: 'assistant', content: '模板 Bot 任务已真实完成。' }, finish_reason: 'stop' }] }) });
try {
  await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite'), server: { watch: null, hmr: false, host: 'localhost', port: 0, proxy: { '/api/v1': { target: `http://127.0.0.1:${app.server.address().port}`, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, ''); process.env.PUBLIC_ORIGIN = origin;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const post = (url, data, headers = {}) => context.request.post(`${origin}/api/v1${url}`, { headers: { origin, ...headers }, data });
  assert.equal((await post('/bootstrap/initialize', { adminPassword: 'plugins-ui-password-123' }, { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() })).status(), 201);
  const owner = (await (await post('/auth/password/login', { password: 'plugins-ui-password-123' })).json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store);
  for (const relative of ['views/main.html', 'defaults.json', 'manifest.json']) files.save(owner, `/system/plugins/bot-task/${relative}`, fs.readFileSync(path.resolve('docs/plugins/templates/bot-task', relative), 'utf8'), '', 0);
  const before = files.layout(owner), layout = JSON.parse(before.content);
  layout.instances.push({ id: 'template-bot', pluginId: 'bot-task', scope: { kind: 'account' } });
  files.save(owner, before.path, JSON.stringify(layout), before.content, before.revision);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, read: 'allow', write: 'allow' }, providers: [{ id: 'fixture', name: 'Fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture-model' } });
  const threadResponse = await post('/threads', { title: '模板刷新恢复专项', mode: 'bot' }); assert.equal(threadResponse.status(), 201);
  const thread = await threadResponse.json(), page = await context.newPage(), diagnostics = [];
  page.on('pageerror', error => diagnostics.push(error.message));
  page.on('response', response => { if (response.url().includes('/plugins/bot-task/instances/')) void response.text().then(text => diagnostics.push({ request: response.request().postData(), status: response.status(), response: text })).catch(() => {}); });
  const frame = page.frameLocator('iframe[title="持久 Bot 任务模板"]');
  try {
    await page.goto(`${origin}/#/plugins/template-bot`);
    await frame.getByLabel('Bot 会话').selectOption(thread.id);
    await frame.getByLabel('任务', { exact: true }).fill('返回模板任务完成证据。');
    await frame.getByRole('button', { name: '启动任务', exact: true }).click();
    await frame.getByText('模板 Bot 任务已真实完成。', { exact: true }).waitFor();
    for (let i = 0; i < 5; i++) {
      await page.reload();
      await frame.getByText('模板 Bot 任务已真实完成。', { exact: true }).waitFor();
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE thread_id=?').get(thread.id).n, 1, 'reload must recover the same run');
    }
    for (const locale of ['en-US', 'zh-CN', 'en-US', 'zh-CN']) {
      await page.evaluate(async locale => { (await import('/src/i18n/index.ts')).applyLocale(locale); }, locale);
      await frame.locator(`html[lang="${locale}"]`).waitFor({ state: 'attached' });
      await frame.getByText('模板 Bot 任务已真实完成。', { exact: true }).waitFor();
      assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM runs WHERE thread_id=?').get(thread.id).n, 1, 'iframe recreation must not dispatch a second run');
    }
  } catch (error) {
    await page.screenshot({ path: path.join(directory, 'failure.png') });
    throw new Error(`${error.message}\nBody: ${await page.locator('body').innerText()}\nFrame: ${await frame.locator('body').innerText().catch(() => 'missing')}\nRPC: ${JSON.stringify(diagnostics)}\nEvidence: ${directory}`);
  }
  console.log('Bot template browser passed: actual completion, five refreshes and four locale recreations recover one durable run.');
} finally {
  await browser?.close(); await web?.close(); await app.close(); store?.close();
}
