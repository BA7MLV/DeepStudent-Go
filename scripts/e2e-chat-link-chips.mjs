/** Regression: production chat pages must not bypass the shared website renderer. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'chat-link-chips-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const fetched = [];
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url) => {
  fetched.push(String(url));
  assert.ok(['https://www.reuters.com/favicon.ico', 'https://www.news.cn/favicon.ico'].includes(String(url)), 'no model calls or arbitrary page requests');
  return new Response(null, { status: 404 });
} });
const news = `# 今日新闻（回归测试示例）

1. **科技动态**：查看官方发布（[**GitHub 公告**](https://github.com/blog "公告来源")）。
2. **国际动态**：来源：[路透社](https://www.reuters.com/world/) · [新华社](https://www.news.cn/world/)。

继续关注：[再次引用同一公告](https://github.com/blog)。

[路透社报道](https://www.reuters.com/world/article)

https://github.com/openai/codex

[课程引用](#/player/link-course) · [材料原图](#source-image/link-course/page-1)

[定位视频](#seek-12) · [定位材料](#unit-3)

[下载文件](https://www.news.cn/report.pdf)`;
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import ChatPanel from '/src/components/ChatPanel.tsx';
import { startCloud } from '/src/cloud/sync.ts';
import '/src/i18n/index.ts';
import '/src/theme.css';
await startCloud(window.owner);
window.player = {current: {currentTime: 0}};
const readerRef = {current: {scrollToUnit: unit => {window.scrolledUnit = unit;}}};
createRoot(document.getElementById('root')).render(React.createElement(ChatPanel, {videoId:'link-course',videoName:'Link course',playerRef:window.player,readerRef,materialKind:'page',materialFormat:'pdf'}));`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'chat-link-regression',
    resolveId: id => id === '/__chat-links-entry.js' ? '\0chat-links-entry' : undefined,
    load: id => id === '\0chat-links-entry' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/__chat-panel-links') return next();
      res.setHeader('content-type', 'text/html');
      res.end('<div id="root"></div><script type="module" src="/__chat-links-entry.js"></script>');
    }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  // The app's model catalog is unrelated to favicons; keep that startup fetch local.
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'chat-links-fixture-password' } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'chat-links-fixture-password' } });
  assert.ok(login.ok());
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  put('videos', 'link-course', { id: 'link-course', name: 'Link course', kind: 'material', materialFormat: 'pdf', createdAt: 1 });
  for (const [id, videoId] of [[7001, '__library_assistant__'], [7002, 'link-course']]) {
    put('chatSessions', id, { id, videoId, title: 'News link regression', createdAt: id });
    put('chats', id * 10, { id: id * 10, sessionId: id, videoId, role: 'user', content: '请你给我今天的新闻。', createdAt: 1 });
    put('chats', id * 10 + 1, { id: id * 10 + 1, sessionId: id, videoId, role: 'assistant', content: news, createdAt: 2,
      responseSegments: [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }, { contentOffset: news.indexOf('继续关注'), reasoningOffset: 0, toolOffset: 0 }] });
  }
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(), errors = [], external = [];
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(origin) && new URL(request.url()).hostname !== 'models.dev') external.push(request.url());
  });
  const checkNews = async () => {
    const source = page.locator('.md-website-citation a[href="https://github.com/blog"]').first();
    await source.waitFor();
    assert.equal(await source.innerText(), '[1]');
    assert.equal(await source.locator('.md-link-chip__icon').count(), 0, 'body contains only superscripts, not icons or chips');
    assert.match(await source.getAttribute('title'), /公告来源/);
    assert.deepEqual(await page.locator('.md-website-citation a').allTextContents(), ['[1]', '[2]', '[3]', '[1]', '[4]', '[5]']);
    assert.equal(await page.locator('.md-link-chip').count(), 0);
    const footer = page.getByTestId('website-sources');
    assert.equal(await footer.count(), 1, 'one source group per whole answer');
    assert.ok(await page.locator('.x-markdown').count() >= 2, 'exercise actual response timeline segments');
    assert.equal(await footer.locator('.website-sources__label').innerText(), '引用来源');
    assert.equal(await footer.locator('.website-sources__icon').count(), 5, 'repeat URL is deduplicated');
    assert.equal(await footer.locator('[data-brand="github"]').count(), 2);
    assert.deepEqual(await footer.locator('.website-sources__icon').evaluateAll(links => links.map(link => link.getAttribute('data-citation-number'))), ['1', '2', '3', '4', '5']);
    for (const href of ['https://www.reuters.com/world/', 'https://www.news.cn/world/']) {
      const link = footer.locator(`a[href="${href}"]`);
      await link.locator('.md-link-chip__icon img').waitFor({ state: 'detached' });
      assert.equal(await link.locator('.md-link-chip__icon svg').count(), 1, 'missing icons default to a globe');
      assert.equal(await link.getAttribute('target'), '_blank');
      assert.match(await link.getAttribute('rel'), /noopener/);
    }
    const overlap = await footer.locator('.website-sources__icon').evaluateAll(links => {
      const [first, second] = links.map(link => link.getBoundingClientRect());
      return second.left < first.right;
    });
    assert.equal(overlap, true, 'footer icons overlap rather than becoming stacked cards');
    assert.equal(await footer.evaluate(el => [...el.parentElement.querySelectorAll('.x-markdown')].every(body => body.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'source stack follows all answer blocks');
    assert.equal(await page.getByRole('link', { name: '下载文件', exact: true }).locator('.md-link-chip__icon').count(), 0);
    assert.equal(await page.locator('.material-image-link').getByRole('link', { name: '材料原图', exact: true }).count(), 1);
  };
  // The actual app and CourseChat route, not a replacement Markdown fixture.
  await page.goto(origin + '/#/chat');
  await checkNews();
  await page.screenshot({ path: path.join(directory, 'chat-desktop.png') });
  await page.reload();
  await checkNews();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.md-website-citation a').first().scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(directory, 'chat-mobile.png') });
  await page.locator('.x-markdown').getByRole('link', { name: '课程引用', exact: true }).click();
  assert.ok(page.url().endsWith('#/player/link-course'), 'internal course navigation is preserved');

  // Production material/video ChatPanel keeps seek/page/source-image handlers.
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto(origin + '/__chat-panel-links');
  await checkNews();
  await page.getByText('定位视频', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.player.current.currentTime), 12.01);
  await page.getByText('定位材料', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.scrolledUnit), 3);
  await page.screenshot({ path: path.join(directory, 'panel-desktop.png') });
  assert.deepEqual(errors, []);
  assert.deepEqual(external, [], 'browser does not contact source sites');
  assert.ok(fetched.length > 0, 'favicon requests pass through the real authenticated API');
  assert.ok(fetched.every(url => !url.includes('github.com')), 'built-in brands make no remote requests');
  console.log(`Chat citations: production CourseChat + ChatPanel, history reload, stable numeric references, one deduplicated bottom icon stack, globe fallback, source-image/internal/seek/page handlers and mobile layout passed. Evidence: ${directory}`);
} catch (error) {
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    await page.screenshot({ path: path.join(directory, 'failure.png') }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 6000));
  }
  throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
