/** Full authenticated entry and lazy routes, rather than isolated components. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-only-app-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let web, browser, page;
const evidence = { errors: [], failedModules: [], routes: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const password = 'server-only-full-app-123';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } })).status(), 200);
  page = await context.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('response', response => { if (response.status() >= 400 && /\/src\//.test(response.url())) evidence.failedModules.push(response.url()); });
  const historyRequests = [];
  page.on('request', request => { if (/\/src\/cloud\/(HistoryRecovery|LocalHistoryExport|legacy-migration)\./.test(request.url())) historyRequests.push(request.url()); });
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  evidence.routes.push('authenticated main entry / course chat');
  assert.deepEqual(historyRequests, [], 'normal authenticated boot must not load historical recovery');
  await page.evaluate(() => { location.hash = '/library'; });
  await page.getByTestId('resource-list').waitFor({ timeout: 30000 });
  evidence.routes.push('resource library');
  await page.evaluate(() => { location.hash = '/settings/assistant'; });
  await page.getByRole('dialog').waitFor();
  await page.getByTestId('card-agent-instructions').waitFor();
  evidence.routes.push('assistant settings');
  await page.evaluate(() => { location.hash = '/settings/models'; });
  await page.getByTestId('card-context-compression').waitFor();
  evidence.routes.push('model settings / server compression');
  await page.evaluate(() => { location.hash = '/settings/data'; });
  await page.getByTestId('cloud-history-recovery').waitFor();
  assert.deepEqual(historyRequests, [], 'opening data settings must not load recovery');
  await page.getByRole('button', { name: '打开历史恢复', exact: true }).click();
  await page.getByRole('button', { name: '核对历史收据并恢复可验证时长命令', exact: true }).waitFor();
  evidence.routes.push('data settings / explicit history recovery');
  await page.screenshot({ path: path.join(directory, 'authenticated-history.png'), fullPage: true });
  assert.deepEqual(evidence.failedModules, []);
  assert.deepEqual(evidence.errors, []);
  console.log(`PASS authenticated full app, lazy routes/settings and demand-only recovery: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
    fs.writeFileSync(path.join(directory, 'failure.html'), await page.content());
  }
  throw error;
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); await app.close();
}
