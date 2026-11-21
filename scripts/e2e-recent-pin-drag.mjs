import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// 使用独立 API 和浏览器上下文，测试真实会话索引与持久化。
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recent-drag-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let browser, web, store;
try {
  process.env.WANGKE_API_PROXY = await api.listen({ host: '127.0.0.1', port: 0 });
  const password = 'recent-drag-fixture-123';
  const init = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize',
    headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: password } });
  assert.equal(init.statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after }]);
  const sessions = [
    { id: 901, title: '置顶一', createdAt: 10, pinned: true, pinnedOrder: 0 },
    { id: 902, title: '置顶二', createdAt: 20, pinned: true, pinnedOrder: 1 },
    { id: 903, title: '最近会话', createdAt: 30 },
    { id: 904, title: '旧会话', createdAt: 5 },
  ];
  for (const row of sessions) {
    const videoId = '__library_assistant__';
    put('chatSessions', row.id, { ...row, videoId });
    put('chats', row.id, { id: row.id, sessionId: row.id, videoId, role: 'user', content: row.title, createdAt: row.createdAt });
  }
  web = await createServer({ root: path.resolve('apps/web'), cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await web.listen();
  const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
  await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  const learningRequests = [];
  page.on('response', async response => {
    const body = response.request().postData();
    if (body?.includes('conversationSession')) learningRequests.push({ status: response.status(), response: await response.json().catch(() => null) });
  });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('chat-recent-901').waitFor({ timeout: 60000 });

  const rows = page.locator('[data-testid^="chat-recent-"][role="option"]');
  const ids = () => rows.evaluateAll((els) => els.map((el) => el.dataset.testid));
  const rowOf = (id) => page.getByTestId(`chat-recent-${id}`);
  const zone = page.getByTestId('recent-drop-zone');
  const line = page.getByTestId('recent-drop-line');
  const preview = page.getByTestId('recent-drag-preview');
  const sessionRow = (id) => {
    const row = records.get(owner, 'chatSessions', id);
    return { pinned: !!row.pinned, pinnedOrder: row.pinnedOrder };
  };
  const persisted = async (id, value) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const row = sessionRow(id);
      if (row.pinned === value.pinned && row.pinnedOrder === value.pinnedOrder) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.deepEqual(sessionRow(id), value, `Persistence failed: ${JSON.stringify({ ids: await ids(), errors, learningRequests, actionError: await page.getByTestId('recent-action-error').allTextContents() })}`);
    await page.locator('[data-recent-saving]').waitFor({ state: 'detached' });
  };
  // 长按 350ms 后拖到目标点松手。
  const dragTo = async (id, x, y) => {
    await rowOf(id).hover();
    await page.mouse.down();
    await page.waitForTimeout(450);
    await zone.waitFor();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  };
  const pointBelow = async (id) => {
    const box = await rowOf(id).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height - 1 };
  };

  // 置顶会话有专门的小节，未置顶会话仍归在「最近」下。
  assert.equal(await page.getByTestId('recent-pinned-section').textContent(), '置顶');
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-902', 'chat-recent-903', 'chat-recent-904']);

  // 置顶列表内拖动换顺序：把「置顶一」拖到「置顶二」下方。
  const below902 = await pointBelow(902);
  await dragTo(901, below902.x, below902.y);
  assert.deepEqual(await ids(), ['chat-recent-902', 'chat-recent-901', 'chat-recent-903', 'chat-recent-904']);
  await persisted(902, { pinned: true, pinnedOrder: 0 });
  await persisted(901, { pinned: true, pinnedOrder: 1 });

  // 取消置顶的投放区在置顶小节最下方：拖「置顶二」进去即取消置顶。
  assert.equal(await zone.count(), 0);
  await rowOf(902).hover();
  await page.mouse.down();
  await page.waitForTimeout(450);
  await zone.waitFor();
  assert.equal(await zone.textContent(), '取消置顶');
  const zoneBox = await zone.boundingBox();
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  await persisted(902, { pinned: false, pinnedOrder: undefined });
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-903', 'chat-recent-902', 'chat-recent-904']);
  // 拖放不该顺手把用户切去那个会话。
  assert.notEqual(await rowOf(902).getAttribute('aria-selected'), 'true');

  // 最近会话拖到「置顶一」下方，刷新后仍在置顶区。
  const below901 = await pointBelow(901);
  await dragTo(903, below901.x, below901.y);
  await persisted(903, { pinned: true, pinnedOrder: 1 });
  await page.reload();
  await page.getByTestId('recent-pinned-area').getByTestId('chat-recent-903').waitFor({ timeout: 60000 });

  // 原位没有线；越过相邻行时有线，Escape 和列表外松手不更改顺序。
  await page.waitForFunction(() => !document.querySelector('.recent-drag-preview') &&
    ![...document.querySelectorAll('.recent-item')].some(row => row.getAnimations().some(animation => animation.playState === 'running')));
  const gapBelow903 = await pointBelow(903);
  await rowOf(901).hover();
  await page.mouse.down();
  await preview.waitFor();
  assert.equal(await line.getAttribute('data-visible'), 'false');
  assert.equal(await rowOf(901).evaluate(row => getComputedStyle(row).cursor), 'grabbing');
  const visibleLine = line.and(page.locator('[data-visible="true"]'));
  await page.mouse.move(gapBelow903.x, gapBelow903.y);
  await visibleLine.waitFor({ state: 'attached' });
  assert.notEqual(await rowOf(903).evaluate(row => row.style.translate), '');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await preview.waitFor({ state: 'detached' });
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-903', 'chat-recent-902', 'chat-recent-904']);
  await dragTo(903, 900, 400);
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-903', 'chat-recent-902', 'chat-recent-904']);

  // 减少动态效果时没有悬浮行或位移，仍可用键盘预览和提交顺序。
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await rowOf(903).focus();
  await page.keyboard.press('Shift+Space');
  await page.keyboard.press('ArrowUp');
  await visibleLine.waitFor({ state: 'attached' });
  assert.equal(await preview.isVisible(), false);
  assert.equal(await rowOf(901).evaluate(row => getComputedStyle(row).translate), 'none');
  await page.keyboard.press('Enter');
  await persisted(903, { pinned: true, pinnedOrder: 0 });
  await page.reload();
  await rowOf(903).waitFor({ timeout: 60000 });
  assert.deepEqual(await ids(), ['chat-recent-903', 'chat-recent-901', 'chat-recent-902', 'chat-recent-904']);

  // 短按（不足长按时长）不进入拖拽，也不该弹投放区。
  await rowOf(904).hover();
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  assert.equal(await zone.count(), 0);
  await rowOf(904).and(page.locator('[aria-selected="true"]')).waitFor();

  assert.deepEqual(errors, []);
  console.log('e2e-recent-pin-drag passed');
} catch (error) {
  console.error(error);
  throw error;
} finally {
  await browser?.close();
  await web?.close();
  await api.close();
  store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
