import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fork } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// One identical runner for independently built clean HEAD and current production
// outputs. No source patches, shared node_modules, model calls or live accounts.
if (process.argv[2] === '--serve') {
  const source = process.argv[3], directory = process.argv[4];
  process.env.BOARD_SEED_DIR = path.resolve('scripts/fixtures/board-plugins'); // board samples are test fixtures
  Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
  const { buildServer } = await import(pathToFileURL(path.join(source, 'apps/api/dist/apps/api/src/server.js')).href);
  const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
  const { DatabaseStore } = await import(pathToFileURL(path.join(source, 'apps/api/dist/apps/api/src/storage/database.js')).href);
  const { CloudRecords } = await import(pathToFileURL(path.join(source, 'apps/api/dist/apps/api/src/cloud/records.js')).href);
  const fixtureStore = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const dist = path.join(source, 'apps/web/dist');
  const web = http.createServer((req, res) => {
    if (req.url.startsWith('/api/')) {
      const proxy = http.request(new URL(req.url, api), { method: req.method, headers: req.headers }, upstream => { res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res); });
      proxy.on('error', error => { if (!res.headersSent) res.writeHead(502); res.end(error.message); }); req.pipe(proxy); return;
    }
    const filename = path.resolve(dist, '.' + decodeURIComponent(req.url.split('?')[0]));
    if (!filename.startsWith(dist + path.sep) && filename !== dist) { res.writeHead(403); res.end(); return; }
    const target = fs.existsSync(filename) && fs.statSync(filename).isFile() ? filename : path.join(dist, 'index.html');
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
    res.writeHead(200, { 'content-type': types[path.extname(target)] ?? 'application/octet-stream', 'content-length': fs.statSync(target).size, 'cache-control': 'no-store' }); fs.createReadStream(target).pipe(res);
  });
  web.on('upgrade', (req, socket, head) => {
    const proxy = http.request(new URL(req.url, api), { headers: req.headers });
    proxy.on('upgrade', (response, upstream, buffered) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(response.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`);
      if (buffered.length) socket.write(buffered); if (head.length) upstream.write(head);
      upstream.on('error', () => socket.destroy()); socket.on('error', () => upstream.destroy()); upstream.pipe(socket); socket.pipe(upstream);
    });
    proxy.on('response', response => { socket.end(`HTTP/1.1 ${response.statusCode} Rejected\r\n\r\n`); response.resume(); });
    proxy.on('error', () => socket.destroy()); proxy.end();
  });
  await new Promise(resolve => web.listen(0, '127.0.0.1', resolve));
  process.send({ origin: `http://127.0.0.1:${web.address().port}`, secret: fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() });
  process.on('message', async message => {
    if (message?.seedOwner) {
      new CloudRecords(fixtureStore).apply(message.seedOwner, [{ id: 'benchmark-disable-study-tracking', table: 'preferences', key: 'studyTrackingEnabled', before: null, after: { id: 'studyTrackingEnabled', value: false } }]);
      process.send({ seeded: true });
    }
    if (message === 'stop') { web.closeAllConnections(); web.close(); await app.close(); fixtureStore.close(); process.exit(0); }
  });
} else {
  const { chromium } = await import('playwright');
  const baseline = path.resolve(process.argv[2] ?? ''), current = path.resolve(process.argv[3] ?? '.');
  assert.ok(baseline !== current && fs.existsSync(path.join(baseline, 'apps/web/dist/index.html')), 'pass isolated clean HEAD source directory');
  const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-head-comparison-');
  // Frozen before measurement: no post-result threshold tuning.
  const thresholds = { firstScreenMs: { ratio: 1.2, allowance: 100 }, inputMs: { ratio: 1.2, allowance: 10 }, projectionMs: { ratio: 1.2, allowance: 25 }, heapBytes: { ratio: 1.2, allowance: 1048576 }, jsBytes: { ratio: 1.15, allowance: 0 }, idleBusinessHttp: { maximum: 0 } };
  fs.writeFileSync(path.join(directory, 'thresholds.json'), JSON.stringify(thresholds, null, 2));
  const results = {}, browser = await chromium.launch({ headless: true });
  const outputIdentity = source => {
    const hash = crypto.createHash('sha256');
    const visit = directory => {
      for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
        const filename = path.join(directory, item.name);
        if (item.isDirectory()) visit(filename);
        else if (item.isFile()) hash.update(path.relative(source, filename)).update('\0').update(fs.readFileSync(filename)).update('\0');
      }
    };
    for (const relative of ['apps/web/dist', 'apps/api/dist', 'packages/remote-artifacts/generated']) {
      const directory = path.join(source, relative);
      if (fs.existsSync(directory)) visit(directory);
      else if (relative === 'packages/remote-artifacts/generated') hash.update(`${relative}\0absent\0`);
      else throw new Error(`benchmark_build_missing:${directory}`);
    }
    return hash.digest('hex');
  };
  const identities = Object.fromEntries([['head', baseline], ['current', current]].map(([label, source]) => [label, outputIdentity(source)]));
  fs.writeFileSync(path.join(directory, 'output-identities.json'), JSON.stringify(identities, null, 2));
  try {
    for (const [label, source] of [['head', baseline], ['current', current]]) {
      const data = path.join(directory, label); fs.mkdirSync(data);
      const log = fs.openSync(path.join(data, 'server.log'), 'w');
      const child = fork(import.meta.filename, ['--serve', source, data], { cwd: source, stdio: ['ignore', log, log, 'ipc'] });
      try {
        const { origin, secret } = await new Promise((resolve, reject) => { child.once('message', resolve); child.once('exit', code => reject(new Error(`${label} server exited ${code}`))); });
        const trials = [];
        for (let trial = 0; trial < 3; trial++) {
          const context = await browser.newContext({ locale: 'zh-CN' });
          // Deny external network for both versions, including telemetry/catalogs.
          await context.route('**/*', route => new URL(route.request().url()).origin === origin || route.request().url().startsWith('data:') ? route.continue() : route.abort());
          if (!trial) assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': secret, origin }, data: { adminPassword: 'isolated-baseline-password-123' } })).status(), 201);
          const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'isolated-baseline-password-123' } });
          assert.equal(login.status(), 200);
          if (!trial) {
            const seeded = new Promise(resolve => child.once('message', resolve));
            child.send({ seedOwner: (await login.json()).user.id }); await seeded;
          }
          const page = await context.newPage(), errors = [], requests = [];
          page.on('pageerror', error => errors.push(error.message));
          page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) requests.push({ at: Date.now(), method: request.method(), path: new URL(request.url()).pathname, body: request.postData(), frame: request.frame().url() }); });
          const start = performance.now();
          await page.goto(`${origin}/#/board`);
          await page.getByTestId('board').waitFor({ timeout: 30000 });
          const todo = page.getByTestId('board-plugin-todo').frameLocator('iframe');
          await todo.getByRole('textbox', { name: '待办内容' }).waitFor({ timeout: 30000 });
          const firstScreenMs = performance.now() - start;
          const input = todo.getByRole('textbox', { name: '待办内容' });
          const inputStart = performance.now(); await input.fill('same-fixture-draft');
          await input.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
          const inputMs = performance.now() - inputStart;
          const statePath = '/system/board/plugins/todo/state.json';
          const response = await context.request.get(`${origin}/api/v1/system/file?path=${encodeURIComponent(statePath)}`);
          const saved = await response.json();
          const title = `same-fixture-projection-${trial}`, projectionStart = performance.now();
          const write = await context.request.post(`${origin}/api/v1/system/file`, { headers: { origin }, data: { path: statePath, expected: saved.content, revision: saved.revision, content: JSON.stringify({ items: [{ id: 'baseline-fixed-item', title, done: false }] }) } });
          assert.equal(write.status(), 200, await write.text());
          await todo.getByText(title, { exact: true }).waitFor({ timeout: 15000 });
          const projectionMs = performance.now() - projectionStart;
          const jsBytes = await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => new URL(entry.name).pathname.endsWith('.js')).reduce((sum, entry) => sum + entry.encodedBodySize, 0));
          const cdp = await context.newCDPSession(page); await cdp.send('HeapProfiler.collectGarbage');
          const { usedSize: heapBytes } = await cdp.send('Runtime.getHeapUsage');
          // Cold boot and its explicit preference migration are not idle work.
          // Both versions get the same fixed settling period; no retries/filter
          // based on observed traffic. Keep executor lease admission separately.
          await page.waitForTimeout(5000);
          const idleStart = Date.now();
          if (!trial) await page.waitForTimeout(60000);
          const idle = requests.filter(request => request.at >= idleStart && !/\/auth\/|\/config$|\/health$/.test(request.path));
          const lease = idle.filter(request => request.path === '/api/v1/cloud/worker/claim');
          const business = idle.filter(request => request.path !== '/api/v1/cloud/worker/claim');
          trials.push({ firstScreenMs, inputMs, projectionMs, heapBytes, jsBytes, idleBusinessHttp: business.length, idleRequests: idle, leaseAdmissions: lease.length, requests, errors });
          await page.screenshot({ path: path.join(data, `trial-${trial}.png`) });
          await context.close();
        }
        results[label] = trials;
        fs.writeFileSync(path.join(data, 'measurements.json'), JSON.stringify(trials, null, 2));
      } finally { child.send('stop'); await new Promise(resolve => child.once('exit', resolve)); fs.closeSync(log); }
    }
    const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
    for (const [label, source] of [['head', baseline], ['current', current]]) assert.equal(outputIdentity(source), identities[label], `${label} output changed during measurement; reject mixed-build evidence`);
    const comparison = Object.fromEntries(Object.entries(thresholds).map(([metric, threshold]) => {
      const head = median(results.head.map(row => row[metric])), currentValue = metric === 'idleBusinessHttp' ? results.current[0][metric] : median(results.current.map(row => row[metric]));
      const limit = 'maximum' in threshold ? threshold.maximum : head * threshold.ratio + threshold.allowance;
      return [metric, { head, current: currentValue, limit, pass: currentValue <= limit }];
    }));
    const evidence = { fixture: 'same production board/todo; 3 cold contexts; input double-RAF; external CAS state write; 60s idle in first trial; forced-GC main-realm heap; no external network', baseline, current, thresholds, results, comparison };
    fs.writeFileSync(path.join(directory, 'comparison.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ directory, comparison }, null, 2));
    if (Object.values(comparison).some(metric => !metric.pass)) process.exitCode = 1;
  } finally { await browser.close(); }
}
