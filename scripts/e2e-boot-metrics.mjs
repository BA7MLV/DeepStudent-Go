/**
 * Boot-metrics baseline (X-style lab measurement, see docs in AGENTS.md).
 *
 * Serves the production `apps/web/dist` over a static file server, throttles
 * the network to Lighthouse's Slow 4G profile (150 ms RTT, 1.6 Mbps down) via
 * CDP, and reports what a cold visitor experiences before the app shell is
 * interactive:
 *
 *   - FCP / LCP (browser timing APIs)
 *   - hydration: when React replaces the inline boot-splash (`#root` children)
 *   - startup JS: request count and compressed transfer size
 *
 * No API is running: boot() catches the failed `/api/v1/cloud/status` and
 * renders the error CloudGate, which is exactly the shell we want to measure.
 * Usage: `npm run build:web && npm run test:boot-metrics [-- --json]`
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const dist = path.resolve('apps/web/dist');
if (!fs.existsSync(path.join(dist, 'index.html'))) {
  console.error('dist/ not found — run `npm run build:web` first');
  process.exit(1);
}

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm' };
const server = http.createServer((request, response) => {
  const url = (request.url ?? '/').split('?')[0];
  const file = path.join(dist, url === '/' ? 'index.html' : url);
  const resolved = path.resolve(file);
  if (!resolved.startsWith(dist + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    response.writeHead(url === '/config.js' ? 404 : 200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(url === '/config.js' ? '' : fs.readFileSync(path.join(dist, 'index.html')));
    return;
  }
  const body = fs.readFileSync(resolved);
  response.writeHead(200, { 'Content-Type': types[path.extname(resolved)] ?? 'application/octet-stream', 'Content-Length': body.length });
  response.end(body);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext();

const runs = [];
for (let run = 0; run < 3; run++) {
  const page = await context.newPage();
  // 限速必须挂在真正测量的页面上：CDP emulation 是 per-session 的,
  // 挂在别的 page 上对新开的页面不生效,之前因此整轮都没有限速。
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const started = performance.now();
  const jsRequests = [];
  page.on('response', async (response) => {
    const url = response.url();
    if (!url.endsWith('.js') && !url.endsWith('.css')) return;
    try {
      const body = await response.body();
      const transfer = Number(response.headers()['content-length']) ?? 0;
      jsRequests.push({ url: url.replace(origin, ''), bytes: body.length, gzip: zlib.gzipSync(body).length,
        transfer: Number.isFinite(transfer) && transfer > 0 ? transfer : body.length });
    } catch { /* body already consumed (e.g. 304) */ }
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  const metrics = await page.evaluate(() => new Promise((resolve) => {
    const result = { fcp: null, lcp: null, hydratedAt: null };
    let lcp = null;
    let hydratedAt = null;
    let done = false;
    // LCP 只在后续条目到来时刷新;水合后再静置 2.5s 取最后一条,避免读早了拿到半程值。
    const LCP_SETTLE_MS = 2500;
    const settle = () => {
      if (done) return;
      done = true;
      setTimeout(() => { result.lcp = lcp; resolve(result); }, LCP_SETTLE_MS);
    };
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name === 'first-contentful-paint') result.fcp = entry.startTime;
        else lcp = entry.startTime;
      }
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((list) => {
      const entry = list.getEntries().at(-1);
      if (entry) lcp = entry.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    // `#root` 出厂就带着 <style> 和 #boot-splash 两个子节点,不能拿 childList 数量当水合信号;
    // React 首次 render 会整体替换掉内联骨架,以 #boot-splash 消失为准。
    const root = document.getElementById('root');
    const hydrated = () => {
      if (hydratedAt != null) return;
      hydratedAt = performance.now();
      result.hydratedAt = hydratedAt;
      settle();
    };
    if (!document.getElementById('boot-splash')) { hydrated(); return; }
    const observer = new MutationObserver(() => {
      if (!document.getElementById('boot-splash')) { observer.disconnect(); hydrated(); }
    });
    observer.observe(root ?? document.body, { childList: true, subtree: true });
    setTimeout(() => { observer.disconnect(); hydrated(); }, 30_000);
  }));
  const startup = jsRequests.filter((entry) => !entry.url.includes('/sw') && !entry.url.includes('workbox') && !entry.url.includes('registerSW'));
  runs.push({ ...metrics, wall: Math.round(performance.now() - started),
    jsFiles: startup.filter((entry) => entry.url.endsWith('.js')).length,
    jsGzipBytes: startup.filter((entry) => entry.url.endsWith('.js')).reduce((sum, entry) => sum + entry.gzip, 0) });
  await page.close();
}
await browser.close();
server.close();

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  profile: 'Slow 4G (150ms RTT, 1.6Mbps), 4x CPU',
  fcpMs: Math.round(median(runs.map((run) => run.fcp))),
  lcpMs: Math.round(median(runs.map((run) => run.lcp))),
  hydrateMs: Math.round(median(runs.map((run) => run.hydratedAt))),
  startupJsFiles: median(runs.map((run) => run.jsFiles)),
  startupJsGzip: median(runs.map((run) => run.jsGzipBytes)),
  runs: runs.map((run) => ({ fcp: Math.round(run.fcp), lcp: Math.round(run.lcp), hydratedAt: Math.round(run.hydratedAt), jsFiles: run.jsFiles, jsGzipKB: Math.round(run.jsGzipBytes / 1024) })),
};
if (process.argv.includes('--json')) console.log(JSON.stringify(report, null, 2));
else {
  console.log('Boot metrics (median of 3, Slow 4G + 4x CPU):');
  console.log(`  FCP            ${report.fcpMs} ms`);
  console.log(`  LCP            ${report.lcpMs} ms`);
  console.log(`  shell hydrated ${report.hydrateMs} ms`);
  console.log(`  startup JS     ${report.startupJsFiles} files, ${(report.startupJsGzip / 1024).toFixed(0)} KB gzip`);
}
