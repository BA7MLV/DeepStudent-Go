import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';

/** Real userscript + browser remux + resource upload/API. Only GM's transport
 * is a fixture; this does not pretend to test a real installed extension. */
export async function verifyBiliBrowser({ api, cookie, bvid, secretCookie, folder, directory, call, setMode, localFetch }) {
  let web, browser, page;
  try {
    web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
      server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: `http://127.0.0.1:${api.server.address().port}`, ws: true, changeOrigin: false } } } });
    await web.listen();
    const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ locale: 'zh-CN' });
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    const bridgeCalls = [];
    await context.exposeBinding('__biliFixture', async (_, details) => {
      let url = details.url;
      bridgeCalls.push(url);
      const headers = new Headers(details.headers);
      if (new URL(url).hostname === 'api.bilibili.com') headers.set('cookie', secretCookie);
      const response = await localFetch(url, { method: details.method, headers, dispatcher: {}, signal: new AbortController().signal });
      // GM follows short links; preserve the final video URL without fetching HTML.
      if (response.status === 302) return { status: 200, finalUrl: response.headers.get('location'), bytes: [], headers: '' };
      return { status: response.status, finalUrl: url, bytes: Array.from(new Uint8Array(await response.arrayBuffer())), headers: [...response.headers].map(([key, value]) => `${key}: ${value}`).join('\r\n') };
    });
    await context.addInitScript(() => {
      window.unsafeWindow = window;
      window.GM_xmlhttpRequest = details => {
        let aborted = false;
        window.__biliFixture({ url: details.url, method: details.method, headers: details.headers }).then(result => {
          if (aborted) return;
          details.onprogress?.({ loaded: result.bytes.length, total: result.bytes.length, lengthComputable: true });
          details.onload({ status: result.status, finalUrl: result.finalUrl, response: new Uint8Array(result.bytes).buffer, responseHeaders: result.headers });
        }).catch(error => { if (!aborted) details.onerror(error); });
        return { abort() { aborted = true; details.onabort?.(); } };
      };
    });
    await context.addInitScript({ path: path.resolve('userscript/wangke-bili-bridge.user.js') });
    page = await context.newPage();
    const errors = [], external = [], legacyRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/\/cloud\/bilibili\/(resolve|subtitles|status)$/.test(request.url())) legacyRequests.push(request.url()); });
    await context.route(/https:\/\/(?:[^/]*\.)?(?:bilibili\.com|bilivideo\.com|biliapi\.net|hdslb\.com|b23\.tv)\//, route => { external.push(route.request().url()); return route.abort(); });
    await page.goto(`${origin}/#/settings/sources`);
    await page.getByTestId('bili-bridge-status').waitFor({ timeout: 60000 });
    assert.equal(await page.getByTestId('bili-bridge-status').getAttribute('data-ready'), 'true');
    assert.equal(await page.getByTestId('bili-cookie').count(), 0, 'no Cookie upload input');
    await page.getByRole('button', { name: '检查本机 B 站登录', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '本机 B 站已登录: Fixture' }).waitFor();
    const scriptResponse = await context.request.get(`${origin}/wangke-bili-bridge.user.js`);
    assert.match(scriptResponse.headers()['content-type'], /charset=utf-8/);
    assert.match(await scriptResponse.text(), /@version\s+3\.0\.0/);
    await page.getByRole('button', { name: '关闭设置', exact: true }).click();
    await page.getByTestId('settings-modal').waitFor({ state: 'hidden' });
    await page.goto(`${origin}/#/library?folder=${folder.id}`);
    await page.getByTestId('resource-list').waitFor();
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入课程 / B 站视频', exact: true }).click();
    await page.getByTestId('btn-bili-import').click();
    await page.getByTestId('bili-url').evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', '【课程-哔哩哔哩】\n（https://b23.tv/fixture）。复制后打开哔哩哔哩');
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
    });
    await page.getByTestId('bili-target').waitFor();
    assert.equal(await page.getByTestId('bili-url').inputValue(), 'https://b23.tv/fixture');
    assert.equal(await page.getByTestId('bili-page').count(), 2);
    await page.getByTestId('bili-pages-none').click();
    assert.equal(await page.getByTestId('bili-confirm').isDisabled(), true);
    await page.getByTestId('bili-pages-all').click();
    // Use a new empty destination; the server test already imported this course.
    const destination = await call('POST', '/resources/folders', { name: '本机上传测试' });
    await page.getByTestId('bili-cancel').click();
    await page.goto(`${origin}/#/library?folder=${destination.id}`);
    await page.getByTestId('resource-list').waitFor();
    await page.getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name: '导入课程 / B 站视频', exact: true }).click();
    await page.getByTestId('btn-bili-import').click();
    await page.getByTestId('bili-url').fill(bvid);
    await page.getByTestId('bili-confirm').click();
    await page.getByTestId('bili-target').waitFor();
    const before = (await call('GET', '/cloud/tasks')).tasks;
    await page.getByTestId('bili-confirm').click();
    await page.getByTestId('bili-dialog').waitFor({ state: 'hidden', timeout: 60000 });
    const uploaded = (await call('GET', `/resources?projectId=${destination.id}`)).entries.filter(entry => entry.courseId);
    assert.equal(uploaded.length, 2, 'both local MP4 files land in the chosen folder');
    const after = (await call('GET', '/cloud/tasks')).tasks;
    assert.ok(!after.some(task => task.kind === 'bilibiliImport' && !before.some(old => old.id === task.id)), 'no server Bilibili download task');
    for (const entry of uploaded) {
      const { execFileSync } = await import('node:child_process');
      const filename = path.join(process.env.FILES_DIR, 'projects', destination.id, entry.path);
      const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', filename])).streams;
      assert.ok(streams.some(stream => stream.codec_type === 'video'));
      assert.ok(streams.some(stream => stream.codec_type === 'audio'));
    }
    assert.ok(bridgeCalls.some(url => url.includes('video.m4s')));
    assert.ok(bridgeCalls.some(url => url.includes('audio.m4s')));
    assert.ok(bridgeCalls.some(url => url.includes('fixture.json')));

    // Existing server jobs remain observable/cancellable after the UI switches.
    const taskRow = id => page.locator(`[data-testid="bili-server-task"][data-task-id="${id}"]`);
    setMode('blocked');
    const cancelled = await call('POST', '/cloud/tasks', { kind: 'bilibiliImport', resource: 'browser-cancel', nonce: 'browser-cancel', input: { bvid, pages: [{ bvid, cid: 100 }], langs: [] } });
    await taskRow(cancelled.id).getByRole('progressbar').waitFor();
    await taskRow(cancelled.id).getByRole('button', { name: '取消导入', exact: true }).click();
    await page.waitForFunction(id => document.querySelector(`[data-task-id="${id}"]`)?.getAttribute('data-status') === 'cancelled', cancelled.id);
    setMode('normal');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'mobile no horizontal overflow');
    const screenshot = path.join(os.tmpdir(), 'opencode', 'bilibili-local-mobile.png');
    fs.mkdirSync(path.dirname(screenshot), { recursive: true });
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(legacyRequests, [], 'UI never uses the server Bilibili resolve/subtitles/status routes');
    assert.deepEqual(external, [], 'all Bilibili traffic goes through the userscript bridge');
    assert.deepEqual(errors, []);
    console.log(`PASS local bridge login/installation, selection, real browser MP4 merge/upload, chosen folder, no server download task, existing-task cancellation and mobile layout (${screenshot}).`);
  } catch (error) {
    if (page) console.error('Bilibili browser failure:', await page.locator('body').innerText());
    throw error;
  } finally { await browser?.close(); await web?.close(); }
}
