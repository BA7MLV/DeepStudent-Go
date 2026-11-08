import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// npx tsx scripts/e2e-chat-scroll-loading.mjs — isolated API/SQLite, no model calls.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/scroll-loading-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('Model calls forbidden'); } });
let web, browser, store;
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const base = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const setup = await browser.newContext();
  const password = 'scroll-loading-test-password';
  assert.equal((await setup.request.post(`${base}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const login = await setup.request.post(`${base}/api/v1/auth/password/login`, { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: null, after: value }]);
  put('chatSessions', 900001, { id: 900001, videoId: '__library_assistant__', title: '加载光环测试', createdAt: 1 });
  put('chats', 900001, { id: 900001, sessionId: 900001, videoId: '__library_assistant__', role: 'user', content: '请输出长回答', createdAt: 1 });
  put('chats', 900002, { id: 900002, sessionId: 900001, videoId: '__library_assistant__', role: 'assistant', content: '正在阅读的历史回答。\n\n'.repeat(100), createdAt: 2 });
  await setup.close();
  for (const width of [1280, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 850 }, hasTouch: width < 600, locale: 'zh-CN' });
    assert.equal((await context.request.post(`${base}/api/v1/auth/password/login`, { data: { password } })).status(), 200);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await page.goto(base);
    await page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true }).waitFor({ timeout: 60000 });
    await page.evaluate(async () => {
      const storeUrl = performance.getEntriesByType('resource').findLast(entry => new URL(entry.name).pathname === '/src/store/courseChat.ts')?.name;
      const { useCourseChat } = await import(storeUrl || '/src/store/courseChat.ts');
      window.__scrollChat = useCourseChat;
      await useCourseChat.getState().loadSession(900001);
    });
    const button = page.getByTestId('chat-scroll-bottom');
    const list = page.getByTestId('course-chat-messages');
    const ring = () => button.evaluate(element => {
      const style = getComputedStyle(element, '::before');
      return { content: style.content, animation: style.animationName, playState: style.animationPlayState, transform: style.transform };
    });
    const generate = loading => page.evaluate(loading => window.__scrollChat.setState(state => ({
      loading,
      messages: state.messages.map(message => message.role === 'ai' ? { ...message, streaming: loading } : message),
    })), loading);
    const scrollUp = async () => {
      await list.evaluate(element => {
        element.dispatchEvent(new WheelEvent('wheel', { deltaY: -300, bubbles: true }));
        element.scrollTop = 0;
      });
      await page.waitForFunction(() => {
        const element = document.querySelector('[data-testid="chat-scroll-bottom"]');
        return element?.dataset.show === 'true' && getComputedStyle(element).opacity === '1';
      });
    };
    await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="course-chat-messages"]');
      return element && element.scrollHeight > element.clientHeight && element.scrollHeight - element.clientHeight - element.scrollTop < 2;
    });
    await scrollUp();
    assert.equal((await ring()).content, 'none', 'idle button has no loading ring');
    const bounds = await button.boundingBox();
    await generate(true);
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.generating === 'true');
    const running = await ring();
    assert.equal(running.animation, 'chat-scroll-bottom-ring');
    assert.equal(running.playState, 'running');
    await page.evaluate(async () => { for (let i = 0; i < 12; i++) await new Promise(requestAnimationFrame); });
    assert.notEqual((await ring()).transform, running.transform, 'the border arc rotates');
    assert.equal(await button.locator('svg').evaluate(element => getComputedStyle(element).transform), 'none', 'arrow remains still');
    const loadingBounds = await button.boundingBox();
    assert.equal(loadingBounds.width, bounds.width, 'loading preserves button width');
    assert.equal(loadingBounds.height, bounds.height, 'loading preserves button height');
    assert.match(await button.getAttribute('aria-label'), /正在生成回答/);
    for (const theme of ['light', 'dark']) {
      await page.evaluate(async theme => (await import('/src/ui/theme.ts')).applyTheme(theme), theme);
      await page.screenshot({ path: path.join(directory, `loading-${theme}-${width}.png`) });
    }

    // Pending user interaction is not active model output, even if the turn remains loading.
    for (const key of ['pendingAsk', 'pendingPlan']) {
      await page.evaluate(key => window.__scrollChat.setState({ [key]: { messageKey: 'waiting', restored: true, resolve() {} } }), key);
      await page.waitForFunction(() => !document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.generating);
      assert.equal((await ring()).content, 'none', `${key} pauses the indicator`);
      await page.evaluate(key => window.__scrollChat.setState({ [key]: null }), key);
      await page.waitForFunction(() => document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.generating === 'true');
    }

    await button.click();
    await page.waitForFunction(() => document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.show === 'false');
    assert.equal((await ring()).playState, 'paused', 'hidden ring does not keep animating');
    await scrollUp();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal((await ring()).animation, 'none', 'reduced motion preserves a static indicator');
    assert.notEqual((await ring()).content, 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });

    await generate(false);
    await page.waitForFunction(() => !document.querySelector('[data-testid="chat-scroll-bottom"]')?.dataset.generating);
    assert.equal((await ring()).content, 'none', 'completion or stop removes the loading ring');
    assert.equal(await button.getAttribute('aria-label'), '回到底部');
    assert.deepEqual(errors, []);
    console.log(`Passed ${width}px: loading ring, stationary arrow, stable geometry, pending interactions, hidden pause, reduced motion and completion.`);
    await context.close();
  }
  console.log(`Screenshots: ${directory}`);
} finally {
  await browser?.close();
  await web?.close();
  store?.close();
  await app.close();
}
