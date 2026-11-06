import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { preview } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-pwa-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
const identity = () => Object.fromEntries(['index.html', 'sw.js', 'registerSW.js'].map(file => [file,
  crypto.createHash('sha256').update(fs.readFileSync(path.join('apps/web/dist', file))).digest('hex')]));
const before = identity();
let web, store, browser;
let unavailable = false;
const results = [];
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await preview({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    plugins: [{ name: 'pwa-origin-outage', configurePreviewServer(server) {
      server.middlewares.use((request, response, next) => {
        if (!unavailable) return next();
        // A failed navigation must reach the SW as a network failure, not an
        // HTTP error page (NetworkFirst legitimately returns HTTP responses).
        if (request.headers.accept?.includes('text/html')) { response.destroy(); return; }
        response.statusCode = 503; response.end('fixture origin unavailable');
      });
    } }],
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  for (const [name, type] of Object.entries({ chromium, webkit })) {
    browser = await type.launch({ headless: true });
    const context = await browser.newContext({ serviceWorkers: 'allow' });
    if (!results.length) assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
      'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
    }, data: { adminPassword: 'pwa-test-password-123' } })).status(), 201);
    const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'pwa-test-password-123' } });
    assert.equal(login.status(), 200);
    const owner = (await login.json()).user.id;
    const files = new PluginFiles(store); files.layout(owner);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#/board`);
    await page.waitForFunction(() => document.querySelector('#root')?.textContent?.length > 10);
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      if (registration.active?.state !== 'activated') await new Promise(resolve => registration.active.addEventListener('statechange', function changed() {
        if (this.state === 'activated') { this.removeEventListener('statechange', changed); resolve(); }
      }));
      if (!navigator.serviceWorker.controller) await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    });
    // The installing SW cannot cache the navigation that loaded this page.
    // Warm the runtime navigation cache with an actual controlled navigation.
    await page.reload();
    await page.waitForFunction(async () => {
      const cache = await caches.open('app-shell-html');
      return !!(await cache.match(location.href.split('#')[0]));
    });
    const sw = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      const keys = await caches.keys();
      const entries = await Promise.all(keys.map(async key => [key,
        (await (await caches.open(key)).keys()).map(request => request.url)]));
      const urls = entries.flatMap(([, cached]) => cached);
      return { active: registration.active?.state, script: registration.active?.scriptURL, keys, urls, entries: Object.fromEntries(entries) };
    });
    assert.equal(sw.active, 'activated');
    assert.ok(sw.urls.some(url => /\/assets\/.*\.js/.test(url)));
    assert.equal(sw.urls.some(url => /\/api\/|\/config\.js/.test(url)), false, 'no business authority or runtime config in SW cache');
    // HTML 只允许作为离线导航兑底（app-shell-html）被缓存：在线导航永远走网络拿最新外壳，
    // 断网时才回放这份拷贝，已安装的 PWA 离线也能打开而不是浏览器错误页。
    const htmlCaches = Object.entries(sw.entries).filter(([, cached]) => cached.some(url => new URL(url).pathname === '/')).map(([name]) => name);
    assert.deepEqual(htmlCaches, ['app-shell-html'], 'navigation URL cached only as the offline navigation fallback');
    const assetUrl = new URL(sw.urls.find(url => /\/assets\/.*\.js/.test(url))); assetUrl.searchParams.delete('__WB_REVISION__');
    const asset = assetUrl.href;
    // Actual origin failures (not WebKit's context.setOffline interception,
    // which can reject before its SW sees a request).
    unavailable = true;
    assert.ok(await page.evaluate(async url => (await fetch(url)).ok, asset), 'actual SW serves cached static asset offline');
    assert.equal(await page.evaluate(async () => (await fetch('/api/v1/cloud/config')).status), 503, 'SW does not synthesize offline business facts');
    assert.equal(await page.evaluate(async () => (await fetch('/uncached-outage-probe')).status), 503, 'origin is genuinely unavailable, not just an app flag');
    const offlineNavigation = await page.reload();
    assert.equal(offlineNavigation.status(), 200, 'cached shell opens when the navigation network fails');
    assert.ok((await offlineNavigation.text()).includes('<div id="root">'), 'offline navigation returns the application HTML');
    unavailable = false;
    await page.waitForFunction(async () => { try { return (await fetch('/api/v1/cloud/config')).ok; } catch { return false; } });
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistration()).update());
    assert.equal((await page.evaluate(async () => (await navigator.serviceWorker.ready).active.state)), 'activated');
    assert.deepEqual(errors, []);
    results.push({ browser: name, passed: true, sw, offlineStatic: true, offlineApiRejected: true, onlineRecovered: true, updateChecked: true, errors });
    await browser.close(); browser = undefined;
  }
  const after = identity(); assert.deepEqual(after, before, 'refuse mixed production artifact evidence');
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ before, after, results,
    externalNotCovered: ['physical Safari device', 'OS PWA installation', 'target reverse proxy/deployment'] }, null, 2));
  console.log(`PASS production PWA service worker in Chromium/WebKit, offline static cache, no business/config cache, offline navigation shell, online recovery/update (${directory})`);
} finally { await browser?.close(); await new Promise(resolve => web ? web.httpServer.close(resolve) : resolve()); store?.close(); await app.close(); }
