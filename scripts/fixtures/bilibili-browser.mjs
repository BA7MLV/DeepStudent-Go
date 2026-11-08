import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

/** Real app, API, task subscription and MP4 import; only upstream Bilibili is mocked. */
export async function verifyBiliBrowser({ api, cookie, bvid, secretCookie, folder, directory, call, setMode }) {
  let web, browser, page;
  try {
    web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: `http://127.0.0.1:${api.server.address().port}`, ws: true, changeOrigin: false } } } });
    await web.listen();
    const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'zh-CN' });
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    page = await context.newPage();
    const errors = [], external = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route(/https:\/\/(?:[^/]*\.)?(?:bilibili\.com|bilivideo\.com|biliapi\.net|hdslb\.com|b23\.tv)\//, route => { external.push(route.request().url()); return route.abort(); });
    await page.goto(`${origin}/#/settings/sources`);
    await page.getByTestId('bili-cookie').waitFor({ timeout: 60000 });
    assert.equal(await page.getByTestId('bili-cookie').inputValue(), '', 'saved secret never echoed');
    assert.equal(await page.getByTestId('bili-adv-toggle').count(), 0, 'proxy configuration removed');
    await page.getByTestId('bili-cookie').fill(secretCookie);
    await page.getByTestId('bili-cookie-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="bili-server-status"]')?.textContent.includes('Fixture'));
    await page.getByRole('button', { name: '清除已保存 Cookie', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="bili-server-status"]')?.textContent.includes('未登录'));
    await page.getByTestId('bili-cookie').fill(secretCookie);
    await page.getByTestId('bili-cookie-save').click();
    await page.waitForFunction(() => document.querySelector('[data-testid="bili-server-status"]')?.textContent.includes('Fixture'));
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
    await page.goto(`${origin}/#/library?folder=${folder.id}`);
    await page.getByTestId('resource-list').waitFor();
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入课程 / B 站视频', exact: true }).click();
    await page.getByTestId('btn-bili-import').click();
    await page.getByTestId('bili-url').fill(bvid);
    await page.getByTestId('bili-confirm').click();
    await page.getByTestId('bili-target').waitFor();
    assert.equal(await page.getByTestId('bili-page').count(), 2);
    await page.getByTestId('bili-pages-none').click();
    assert.equal(await page.getByTestId('bili-confirm').isDisabled(), true);
    await page.getByTestId('bili-pages-all').click();
    const before = (await call('GET', '/cloud/tasks')).tasks;
    await page.getByTestId('bili-confirm').click();
    await page.getByTestId('bili-dialog').waitFor({ state: 'hidden' });
    const job = (await call('GET', '/cloud/tasks')).tasks.find(t => t.kind === 'bilibiliImport' && !before.some(old => old.id === t.id));
    assert.ok(job); assert.equal(job.input.folderId, folder.folderId);
    await page.getByTestId('bili-server-tasks').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="bili-server-task"]')].some(node => node.dataset.status === 'completed' && node.textContent.includes('已保存 2/2')));
    const taskRow = id => page.locator(`[data-testid="bili-server-task"][data-task-id="${id}"]`);
    setMode('blocked');
    const cancelled = await call('POST', '/cloud/tasks', { kind: 'bilibiliImport', resource: 'browser-cancel', nonce: 'browser-cancel', input: job.input });
    await taskRow(cancelled.id).getByRole('progressbar').waitFor();
    await taskRow(cancelled.id).getByRole('button', { name: '取消导入', exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-task-id="${id}"]`)?.getAttribute('data-status') === 'cancelled', cancelled.id);
    await taskRow(cancelled.id).getByRole('button', { name: '收起', exact: true }).click();
    await taskRow(cancelled.id).waitFor({ state: 'hidden' });
    setMode('oversize');
    const failed = await call('POST', '/cloud/tasks', { kind: 'bilibiliImport', resource: 'browser-failed', nonce: 'browser-failed', input: job.input });
    await taskRow(failed.id).getByRole('alert').waitFor();
    assert.match(await taskRow(failed.id).innerText(), /大小限制/);
    await taskRow(failed.id).getByRole('button', { name: '收起', exact: true }).click();
    setMode('normal');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile no horizontal overflow');
    fs.mkdirSync(path.join(os.tmpdir(), 'opencode'), { recursive: true });
    const screenshot = path.join(os.tmpdir(), 'opencode', 'bilibili-mobile.png');
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(external, [], 'browser never contacts Bilibili directly');
    assert.deepEqual(errors, []);
    console.log(`PASS browser server Cookie save/clear, no proxy UI, part selection, destination folder, server task completion/progress/cancellation/error/dismissal and mobile layout (${screenshot}).`);
  } catch (error) {
    if (page) console.error('Bilibili browser failure:', await page.locator('body').innerText());
    throw error;
  } finally { await browser?.close(); await web?.close(); }
}
