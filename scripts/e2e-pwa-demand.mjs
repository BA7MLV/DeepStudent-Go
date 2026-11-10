/** Real production service worker; static caching only, not app/offline UI acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { preview } from 'vite';
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/pwa-demand-');
const chunks = JSON.parse(fs.readFileSync('apps/web/dist/.vite/manifest.json', 'utf8'));
const entry = Object.values(chunks).find(chunk => chunk.isEntry).file;
const visited = chunks['src/pages/CourseChat.tsx']?.file ?? Object.values(chunks).find(chunk => /^assets\/CourseChat-.*\.js$/.test(chunk.file))?.file;
const unopened = chunks['src/pages/Player.tsx']?.file ?? Object.values(chunks).find(chunk => /^assets\/Player-.*\.js$/.test(chunk.file))?.file;
assert.ok(visited && unopened, 'production manifest includes CourseChat and Player chunks');
let web, browser;
let disconnectAssets = false;
const evidence = { checks: [], requests: [], engine: process.env.BROWSER ?? 'chromium', entry, visited, unopened };
try {
  web = await preview({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    plugins: [{ name: 'pwa-fixture', configurePreviewServer(server) { server.middlewares.use((req, res, next) => {
      if (disconnectAssets && req.url?.startsWith('/assets/')) { req.socket.destroy(); return; }
      if (req.url !== '/__pwa-test') return next();
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><body>Production service worker fixture<script src="/registerSW.js"></script>');
    }); } }], preview: { host: '127.0.0.1', port: 0 } });
  browser = await (process.env.BROWSER === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('request', request => evidence.requests.push(new URL(request.url()).pathname));
  await page.goto(web.resolvedUrls.local[0] + '__pwa-test');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const cached = () => page.evaluate(async () => {
    const urls = [];
    for (const key of await caches.keys()) for (const request of await (await caches.open(key)).keys()) urls.push(new URL(request.url).pathname);
    return urls;
  });
  evidence.afterInstall = await cached();
  assert.ok(evidence.afterInstall.includes('/' + entry));
  for (const file of [visited, unopened]) assert.ok(!evidence.afterInstall.includes('/' + file), `${file} is not precached`);
  assert.ok(!evidence.requests.includes('/' + unopened), 'installation never requests unopened Player');
  assert.ok(!evidence.requests.some(url => /\/(?:pdf|mermaid|cytoscape|docx-preview)[.-]/.test(url)), 'installation does not prefetch document/diagram renderers');
  assert.equal(await page.evaluate(async file => (await fetch('/' + file)).ok, visited), true);
  // CacheFirst writes via event.waitUntil after returning the network response.
  await page.waitForFunction(async file => !!await caches.match('/' + file), visited);
  evidence.afterDemand = await cached();
  // WebKit's Playwright offline patch fails WebProcess loads before SW dispatch.
  // Drop actual asset connections instead, keeping CacheStorage/SW operational.
  evidence.networkFailure = evidence.engine === 'webkit' ? 'server-drops-asset-connections' : 'browser-context-offline';
  if (evidence.engine === 'webkit') disconnectAssets = true;
  else await context.setOffline(true);
  assert.equal(await page.evaluate(async file => (await fetch('/' + file, { cache: 'reload' })).ok, visited), true);
  assert.equal(await page.evaluate(async file => { try { await fetch('/' + file, { cache: 'reload' }); return 'unexpected'; } catch { return 'offline-unvisited'; } }, unopened), 'offline-unvisited');
  assert.ok(!(await cached()).includes('/' + unopened));
  evidence.checks.push('static entry precached; unopened CourseChat/Player absent at install; no PDF/Mermaid renderer prefetch', 'visited dynamic chunk cached on demand and readable offline; unopened dynamic chunk is not falsely available offline');
  evidence.passed = true;
  console.log(`PASS production SW demand cache (${evidence.engine}): ${directory}`);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close();
}
