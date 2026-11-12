import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { preview } from 'vite';

// Isolated account and mocked upstream: never use real credentials or paid quota.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuanbao-search-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
let requests = 0, upstreamError;
const app = buildServer({ dbPath: path.join(directory, 'app.sqlite'), fetch: async (url, init) => {
  requests++;
  assert.equal(String(url), 'https://api.wsa.cloud.tencent.com/SearchPro');
  assert.equal(init.headers.authorization, 'Bearer test-yuanbao-secret');
  assert.deepEqual(JSON.parse(init.body), { Query: '三星堆的由来' });
  return Response.json({ Response: upstreamError ? { Error: { Code: upstreamError } } : { Pages: [
    JSON.stringify({ title: '三星堆名字的由来', url: 'https://example.org/history', passage: '<b>三星堆</b>的历史。', date: '2026-10-01' }),
    JSON.stringify({ title: '三星堆考古研究', url: 'https://example.com/research', content: '考古研究的动态摘要。' }),
  ] } });
} });
let browser, web, page;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await preview({ root: path.resolve('apps/web'), preview: { host: '127.0.0.1', port: 0,
    proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN', serviceWorkers: 'block', reducedMotion: 'reduce' });
  const password = 'yuanbao-test-password-123';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  assert.equal((await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } })).status(), 200);
  page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/settings/websearch');
  await page.getByRole('button', { name: '添加 元宝搜索', exact: true }).click();
  assert.equal(await page.getByLabel('显示名称', { exact: true }).inputValue(), '元宝搜索');
  assert.equal(await page.getByLabel('SearXNG 服务地址', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('link', { name: '开通服务 / 创建 API KEY', exact: true }).getAttribute('href'), 'https://console.cloud.tencent.com/wsapi/index');
  await page.getByLabel('API Key', { exact: true }).fill('test-yuanbao-secret');
  await page.getByText('启用此供应商', { exact: true }).click();
  await page.getByTestId('web-search-settings').locator('.select__trigger').click();
  await page.getByRole('option', { name: '元宝搜索', exact: true }).click();
  await page.getByText('启用联网搜索', { exact: true }).click();
  await page.getByTestId('web-search-save').click();
  await page.getByText('设置已保存', { exact: true }).waitFor();
  const saved = await context.request.get(`${origin}/api/v1/cloud/web-search/config`);
  assert.ok(!(await saved.text()).includes('test-yuanbao-secret'));
  await page.reload();
  await page.getByLabel('API Key', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '');
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.getByLabel('测试搜索词', { exact: true }).fill('三星堆的由来');
    await page.getByRole('button', { name: '测试搜索', exact: true }).click();
    await page.getByTestId('web-sources').waitFor();
    assert.equal(await page.getByTestId('web-sources').getByRole('link').count(), 2);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByTestId('web-sources').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(directory, `yuanbao-${viewport.width}.png`), fullPage: true });
  }
  assert.equal(requests, 2);
  upstreamError = 'ResourceNotFound';
  await page.getByRole('button', { name: '测试搜索', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '尚未开通元宝搜索' }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Yuanbao E2E passed: key-only desktop/mobile configuration, encrypted credential round trip, SearchPro requests, sources and service errors.');
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(await page.locator('body').innerText().catch(() => 'unavailable'));
    await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
    console.error(`Evidence: ${directory}`);
  }
  throw error;
} finally {
  await browser?.close();
  if (web) {
    await new Promise(resolve => { web.httpServer.close(resolve); web.httpServer.closeAllConnections(); });
  }
  await app.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
