import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { fixturePreference, fixtureDomain } from './fixture-domain.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-feedback-ui-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let vite, browser;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const initialized = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'feedback-test-password' } });
  assert.equal(initialized.statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'feedback-test-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const call = async (method, url, payload) => {
    const result = await api.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
    assert.ok(result.statusCode < 300, result.body); return result.json();
  };
  await fixturePreference(api, cookie, 'uiLanguage', 'zh-CN');
  const session = { id: 92001, videoId: '__library_assistant__', title: '反馈回归对话', createdAt: Date.now() };
  assert.equal((await fixtureDomain(api, cookie, 'editLearning', { operationId: 'feedback-fixture-session-0001', edits: [
    { mutationId: 'session', kind: 'conversationSession', expected: null, value: session },
    { mutationId: 'message', kind: 'conversationMessage', expected: null, value: { id: 92001, sessionId: session.id, videoId: session.videoId, role: 'user', content: '反馈测试', createdAt: session.createdAt } },
  ] })).ok, true);
  const folder = await call('POST', '/resources/folders', { name: '反馈测试资料' });
  await call('PUT', `/projects/${folder.id}/text?path=a.txt`, { text: 'original', expectedRevision: null });
  await call('POST', `/projects/${folder.id}/directories?path=target`);
  const markdown = '# 读取恢复测试\n\n重试后应能正常阅读。';
  await call('PUT', `/projects/${folder.id}/text?path=retry.md`, { text: markdown, expectedRevision: null });
  const material = (await call('GET', `/resources?projectId=${folder.id}&path=`)).entries.find(entry => entry.name === 'retry.md');
  assert.equal((await fixtureDomain(api, cookie, 'resourceCommand', { operationId: 'feedback-markdown-fixture-00001', operation: { kind: 'saveMarkdown', courseId: material.courseId, expected: markdown, text: markdown } })).ok, true);
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: path.resolve('apps/web'), cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*'] }, hmr: false }, plugins: [{
    name: 'feedback-fixture', configureServer(server) {
      server.middlewares.use('/__fixture_login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/library' }); res.end(); });
    },
  }] });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  if (process.env.FEEDBACK_PREVIEW) {
    console.log(`FEEDBACK_PREVIEW ${origin}/__fixture_login`);
    await new Promise(resolve => process.once('SIGTERM', resolve));
  } else {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
    const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block', viewport: { width: 1440, height: 900 } });
    await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(30000);
    await page.goto(`${origin}/__fixture_login`);
    await page.getByTestId('resource-list').waitFor({ timeout: 60000 });
    const toasts = page.locator('[data-slot="toast"]');
    const clear = async () => {
      await page.evaluate(async () => (await import('/src/ui/toast.ts')).toast.clear());
      await toasts.waitFor({ state: 'hidden' });
    };
    await clear();
    await page.evaluate(async () => {
      const { toast } = await import('/src/ui/toast.ts');
      for (const title of ['first', 'second', 'third']) toast.info(title, { timeout: 700 });
    });
    for (const title of ['first', 'second', 'third']) {
      await page.locator('[data-slot="toast-title"]').filter({ hasText: title }).waitFor();
      assert.equal(await toasts.count(), 1, 'waiting toast has no live DOM or timer');
      assert.equal(await toasts.getAttribute('role'), 'group');
      assert.equal(await toasts.locator('[data-slot="toast-content"]').getAttribute('role'), 'status');
      assert.equal(await toasts.locator('[data-slot="toast-content"]').getAttribute('aria-live'), 'polite');
    }
    await toasts.waitFor({ state: 'hidden' });
    await page.evaluate(async () => (await import('/src/ui/toast.ts')).toast.info('pause-on-hover', { timeout: 650 }));
    await toasts.hover(); await page.waitForTimeout(1000);
    assert.equal(await toasts.innerText().then(text => text.includes('pause-on-hover')), true);
    await page.mouse.move(5, 500); await toasts.waitFor({ state: 'hidden' });
    await page.evaluate(async () => (await import('/src/ui/toast.ts')).toast.info('pause-on-focus', { timeout: 650 }));
    await toasts.focus(); await page.waitForTimeout(1000);
    assert.equal(await toasts.isVisible(), true);
    await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
    await page.locator('body').click({ position: { x: 5, y: 500 } });
    await toasts.waitFor({ state: 'hidden' });
    await page.evaluate(async () => (await import('/src/ui/toast.ts')).toast.error('urgent failure'));
    assert.equal(await toasts.getAttribute('role'), 'alertdialog');
    assert.equal(await toasts.locator('[data-slot="toast-content"]').getAttribute('aria-live'), 'assertive');
    await clear();

    // An off-screen completion lights existing unread dots; viewing clears it.
    await page.evaluate(async () => {
      const { useChatNotifications } = await import('/src/store/chatNotifications.ts');
      useChatNotifications.getState().complete(92001);
      useChatNotifications.getState().complete(92001);
    });
    await page.getByTestId('chat-recent-92001-unread').waitFor();
    await page.getByTestId('chat-recent-92001').click();
    await page.getByTestId('chat-recent-92001-unread').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(async () => {
      const { useChatNotifications } = await import('/src/store/chatNotifications.ts');
      useChatNotifications.getState().complete(92001);
      return useChatNotifications.getState().unreadIds.includes(92001);
    }), false, 'currently viewed completions do not produce duplicate feedback');
    await page.evaluate(() => { location.hash = '/library'; });
    await page.getByTestId('resource-list').waitFor();

    // Archive + Undo lives outside route suspense and restores with an expected snapshot.
    await page.getByTestId('chat-recent-92001').hover();
    await page.getByTestId('chat-recent-92001-menu-trigger').click();
    await page.getByTestId('chat-recent-92001-menu-archive').click();
    await toasts.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByTestId('chat-recent-92001').waitFor();
    await clear();

    await page.getByTestId('resource-entry').filter({ hasText: '反馈测试资料' }).locator('.resource-open').click();
    const entry = page.getByTestId('resource-entry').filter({ hasText: 'a.txt' });
    await entry.waitFor();
    const listing = await call('GET', `/resources?projectId=${folder.id}&path=`);
    const source = listing.entries.find(item => item.path === 'a.txt');
    const target = page.getByTestId('resource-entry').filter({ hasText: 'target' });
    await target.evaluate((element, entry) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData('application/x-resource-entry', JSON.stringify({ entries: [entry] }));
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
    }, source);
    await toasts.getByRole('button', { name: '撤销', exact: true }).waitFor();
    const moved = await call('GET', `/projects/${folder.id}/text?path=target/a.txt`);
    await call('PUT', `/projects/${folder.id}/text?path=target/a.txt`, { text: 'later edit must survive', expectedRevision: moved.revision });
    await toasts.getByRole('button', { name: '撤销', exact: true }).click();
    await page.getByTestId('persistent-error').waitFor();
    assert.equal((await call('GET', `/projects/${folder.id}/text?path=target/a.txt`)).text, 'later edit must survive');
    await page.waitForTimeout(8500);
    assert.equal(await page.getByTestId('persistent-error').isVisible(), true, 'operation failure outlives the former 8s toast');
    await page.evaluate(() => { location.hash = '/'; });
    await page.getByTestId('resource-list').waitFor({ state: 'hidden' });
    await page.evaluate(() => { location.hash = '/library'; });
    await page.getByTestId('persistent-error').waitFor();
    assert.equal(await page.getByTestId('persistent-error').isVisible(), true, 'failed Undo survives navigating away and back');
    // The preceding conflict also opens the existing sync recovery overlay.
    // Collapse its presentation, without discarding the command or its draft,
    // before exercising the unrelated reader beneath it.
    await page.getByTestId('cloud-activity').getByRole('button', { name: '收起提醒', exact: true }).click();
    await page.getByTestId('cloud-activity').getByRole('button', { name: '收起提醒', exact: true }).waitFor({ state: 'hidden' });

    // A transient file read failure is not evidence that the source was deleted.
    let failRead = true;
    const failMaterial = async route => {
      if (failRead) await route.fulfill({ status: 503, body: 'fixture unavailable' });
      else await route.continue();
    };
    await page.route(`**/api/v1/resources/courses/${encodeURIComponent(material.courseId)}`, failMaterial);
    await page.evaluate(id => { location.hash = `/player/${encodeURIComponent(id)}`; }, material.courseId);
    await page.getByTestId('reader-file-error').waitFor();
    assert.doesNotMatch(await page.getByTestId('reader-file-error').innerText(), /已删除/);
    failRead = false;
    await page.getByTestId('reader-file-error').getByRole('button', { name: '重试', exact: true }).click();
    await page.getByTestId('material-reader').getByText('重试后应能正常阅读。', { exact: true }).waitFor();
    await page.unroute(`**/api/v1/resources/courses/${encodeURIComponent(material.courseId)}`, failMaterial);

    // Long text, small viewports, both themes and reduced motion keep controls reachable.
    await clear();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await page.evaluate(async () => {
      document.documentElement.classList.add('dark');
      const { toast } = await import('/src/ui/toast.ts');
      toast.info('很长的操作结果与文件名称'.repeat(18), { timeout: 0, actionProps: { children: '撤销', onPress() {} } });
    });
    const action = toasts.getByRole('button', { name: '撤销', exact: true });
    await action.waitFor();
    const box = await action.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 375 && box.y + box.height <= 812);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    console.log('Feedback E2E passed: serial/polite/urgent toasts, hover/focus pause, unread/viewing, archive Undo, safe move conflict, persistent error/navigation, material read recovery, mobile dark/reduced-motion long text.');
  }
} finally { await browser?.close(); await vite?.close(); await api.close(); fs.rmSync(directory, { recursive: true, force: true }); }
