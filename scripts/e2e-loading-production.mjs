/** Production Web + isolated API/SQLite + real browser. Never calls a model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { preview } from 'vite';
import Database from 'better-sqlite3';

// Test-only observation of real server calls, not a production instrumentation
// API. Returned rows are NOT SQLite scanned rows. Timings include binding and
// native JS result materialization; wrapper overhead is present in every round.
let sqlSample;
const prepare = Database.prototype.prepare;
Database.prototype.prepare = function (sql) {
  const statement = prepare.call(this, sql);
  for (const method of ['all', 'get', 'run']) {
    const original = statement[method];
    statement[method] = function (...args) {
      const sample = sqlSample, started = performance.now();
      try {
        const value = original.apply(this, args);
        if (sample) {
          const key = method + ' ' + sql.replace(/\s+/g, ' ').trim();
          const metric = sample[key] ??= { calls: 0, totalMs: 0, maxMs: 0, returnedRows: 0 };
          const elapsed = performance.now() - started;
          metric.calls++; metric.totalMs += elapsed; metric.maxMs = Math.max(metric.maxMs, elapsed);
          metric.returnedRows += method === 'all' ? value.length : method === 'get' && value !== undefined ? 1 : 0;
        }
        return value;
      } catch (error) { throw error; }
    };
  }
  return statement;
};

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/loading-production-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const engine = process.env.BROWSER === 'webkit' ? webkit : chromium;
const sizes = (process.env.LOADING_SIZES ?? '1000,10000,100000').split(',').map(Number);
const rounds = Number(process.env.LOADING_ROUNDS ?? 3);
assert.ok(sizes.every(n => Number.isSafeInteger(n) && n >= 100));
assert.ok(Number.isSafeInteger(rounds) && rounds > 0);
const index = fs.readFileSync('apps/web/dist/index.html');
const evidence = { directory, environment: { node: process.version, platform: process.platform, arch: process.arch,
  cpu: os.cpus()[0].model, memoryBytes: os.totalmem(), browser: engine.name(), artificialLatencyMs: 0,
  artifactSha256: crypto.createHash('sha256').update(index).digest('hex'), serviceWorkers: 'allowed', viewport: { width: 1280, height: 900 } },
   samples: [], summaries: [], errors: [], unmeasured: ['actual SQLite scanned rows', 'iterate/exec SQL timings', 'independent JSON parse time', 'process peak RSS', 'true input-event TTI'], passed: false };
let app, web, browser, store;
try {
  app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async url => { throw new Error(`external execution forbidden: ${url}`); } });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await preview({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await engine.launch({ headless: true });
  evidence.environment.browserVersion = browser.version();
  const setup = await browser.newContext();
  assert.equal((await setup.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'production-loading-fixture-123' } })).status(), 201);
  const owner = (await (await setup.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'production-loading-fixture-123' } })).json()).user.id;
  const auth = await setup.storageState(); await setup.close();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  let seeded = 0;
  const activeCount = 60;
  for (const size of sizes) {
    store.transaction(() => {
      const put = store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)');
      if (!seeded) put.run(owner, 'chatSessions', '901', JSON.stringify({ id: 901, videoId: '__library_assistant__', title: 'Production active fixture', createdAt: 999999 }));
      for (let i = seeded + 1; i <= size; i++) {
        const sessionId = i <= activeCount ? 901 : 1000 + Math.floor((i - activeCount - 1) / 100);
        if (i > activeCount && (i - activeCount - 1) % 100 === 0) put.run(owner, 'chatSessions', String(sessionId), JSON.stringify({ id: sessionId, videoId: '__library_assistant__', title: `Background ${sessionId}`, createdAt: sessionId }));
        put.run(owner, 'chats', String(i), JSON.stringify({ id: i, sessionId, role: i % 2 ? 'user' : 'assistant', content: `Production history ${i} ` + 'bounded fixture text '.repeat(16), createdAt: i }));
      }
    });
    seeded = size;
    for (let round = 0; round < rounds; round++) {
      const context = await browser.newContext({ storageState: auth, viewport: evidence.environment.viewport, locale: 'zh-CN' });
      await context.route('https://**', route => route.abort());
      await context.addInitScript(() => {
        window.__loadingIdb = { transactions: 0, totalTransactionMs: 0, longestTransactionMs: 0 };
        const original = IDBDatabase.prototype.transaction;
        IDBDatabase.prototype.transaction = function (...args) {
          const started = performance.now(), tx = original.apply(this, args);
          window.__loadingIdb.transactions++;
          tx.addEventListener('complete', () => { const ms = performance.now() - started; window.__loadingIdb.totalTransactionMs += ms; window.__loadingIdb.longestTransactionMs = Math.max(window.__loadingIdb.longestTransactionMs, ms); }, { once: true });
          return tx;
        };
      });
      const page = await context.newPage(); page.setDefaultTimeout(120000);
      const goToSession = async id => {
        const target = page.getByTestId(`chat-recent-${id}`);
        const turn = async direction => {
          const before = await page.locator('[role="option"][data-testid^="chat-recent-"]').evaluateAll(rows => rows.map(row => row.dataset.testid).join(','));
          await page.getByTestId(`chat-recent-${direction}`).click();
          await page.waitForFunction(before => [...document.querySelectorAll('[role="option"][data-testid^="chat-recent-"]')].map(row => row.dataset.testid).join(',') !== before, before);
        };
        // Keep fixtures unchanged. Later sidebar pages are reached by actual UI
        // keyset navigation, and that cost belongs to the measured interaction.
        if (!await target.count()) {
          while (await page.getByTestId('chat-recent-previous').count()) await turn('previous');
          for (let n = 0; !await target.count() && n <= Math.ceil(size / 5000); n++) {
            assert.equal(await page.getByTestId('chat-recent-next').count(), 1, `session ${id} must be reachable`);
            await turn('next');
          }
        }
        await target.click();
      };
      page.on('pageerror', error => evidence.errors.push(error.message));
      for (const kind of ['cold', 'warm']) {
        sqlSample = {};
        const requests = [], bodies = [], jobs = new Set();
        const ws = { receivedBytes: 0, sentBytes: 0, receivedFrames: 0 };
        const sockets = new Set();
        const received = ({ payload }) => { ws.receivedBytes += Buffer.byteLength(payload); ws.receivedFrames++; };
        const sent = ({ payload }) => { ws.sentBytes += Buffer.byteLength(payload); };
        const socketOpened = socket => { sockets.add(socket); socket.on('framereceived', received); socket.on('framesent', sent); };
        page.on('websocket', socketOpened);
        let peakHeapBytes = null, peakDomNodes = 0, peakApiInFlight = 0, inFlight = 0;
        const requested = request => { if (new URL(request.url()).pathname.startsWith('/api/')) { requests.push(new URL(request.url()).pathname); peakApiInFlight = Math.max(peakApiInFlight, ++inFlight); } };
        const finished = request => { if (new URL(request.url()).pathname.startsWith('/api/')) inFlight--; };
        const responded = response => {
          if (!new URL(response.url()).pathname.startsWith('/api/')) return;
          const job = response.body().then(body => { bodies.push({ path: new URL(response.url()).pathname, bytes: body.length, timing: response.request().timing(),
            // Count unrelated message payloads, not merely endpoint names.
            unrelatedChatRecords: (() => { try {
              const findRecords = value => {
                if (!value || typeof value !== 'object') return undefined;
                if (Array.isArray(value.records)) return value.records;
                for (const nested of Object.values(value)) { const records = findRecords(nested); if (records) return records; }
              };
              const records = findRecords(JSON.parse(body.toString()));
              return records ? records.filter(row => row.table === 'chats' && row.value?.sessionId !== 901).length : null;
            } catch { return null; } })() }); }).catch(() => {}).finally(() => jobs.delete(job)); jobs.add(job);
        };
        page.on('request', requested); page.on('requestfinished', finished); page.on('requestfailed', finished); page.on('response', responded);
        let cdp;
        if (engine === chromium) { cdp = await context.newCDPSession(page); await cdp.send('Performance.enable'); }
        const timer = cdp && setInterval(() => { void cdp.send('Performance.getMetrics').then(({ metrics }) => {
          const heap = metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
          if (heap !== undefined) peakHeapBytes = Math.max(peakHeapBytes ?? 0, heap);
          const nodes = metrics.find(metric => metric.name === 'Nodes')?.value;
          if (nodes !== undefined) peakDomNodes = Math.max(peakDomNodes, nodes);
        }).catch(() => {}); }, 100);
        try {
          const start = performance.now();
          if (kind === 'cold') await page.goto(origin); else await page.reload();
          await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
          const composerVisibleMs = performance.now() - start;
          // A fresh account may intentionally start in a new conversation. Use
          // the real sidebar rather than importing a dev-only store into dist.
          await goToSession(901);
          await page.locator('[data-chat-message="stored-60"]').waitFor();
          const sessionReadableMs = performance.now() - start;
          await page.waitForTimeout(500); await Promise.allSettled([...jobs]);
          const browserMetrics = await page.evaluate(() => ({ idb: window.__loadingIdb, domNodes: document.querySelectorAll('*').length,
            visibleMessageNodes: document.querySelectorAll('[data-chat-message]').length,
            navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
            resources: performance.getEntriesByType('resource').map(({ name, startTime, duration, transferSize, encodedBodySize, decodedBodySize }) => ({ name: new URL(name).pathname, startTime, duration, transferSize, encodedBodySize, decodedBodySize })) }));
          evidence.samples.push({ messages: size, sessions: 1 + Math.ceil((size - activeCount) / 100), round, kind, composerVisibleMs, sessionReadableMs,
            peakHeapBytes, peakDomNodes, peakApiInFlight, serverSql: structuredClone(sqlSample), requests: [...requests], webSocket: { ...ws }, apiBytes: bodies.reduce((sum, row) => sum + row.bytes, 0), bodies: [...bodies], ...browserMetrics });
          if (size === sizes[0] && round === 0 && kind === 'warm') {
            const before = requests.length;
            const beforeWs = { ...ws };
            await page.waitForTimeout(60000);
            await Promise.allSettled([...jobs]);
            evidence.idle60Seconds = { requests: requests.slice(before),
              webSocket: Object.fromEntries(Object.keys(ws).map(key => [key, ws[key] - beforeWs[key]])),
              note: 'Learning-time writes remain enabled; WS bytes include protocol/keepalive traffic, not only business data.' };
          }
          const interactions = [];
          const interaction = async (name, run) => {
            const started = performance.now(), requestIndex = requests.length, bodyIndex = bodies.length, beforeWs = { ...ws };
            await run(); await Promise.allSettled([...jobs]);
            interactions.push({ name, durationMs: performance.now() - started, requests: requests.slice(requestIndex),
              apiBytes: bodies.slice(bodyIndex).reduce((sum, row) => sum + row.bytes, 0),
              webSocket: Object.fromEntries(Object.keys(ws).map(key => [key, ws[key] - beforeWs[key]])) });
          };
          await interaction('switch-background', async () => {
            await goToSession(1000);
            await page.locator('[data-chat-message="stored-160"]').waitFor();
          });
          await interaction('switch-back-retained', async () => {
            await goToSession(901);
            await page.locator('[data-chat-message="stored-60"]').waitFor();
          });
          await interaction('prepend-history', async () => {
            const viewport = page.getByTestId('course-chat-messages');
            // Prepending correctly preserves the current reading anchor, so the
            // oldest row is not necessarily mounted until we scroll up again.
            await viewport.hover();
            for (let attempt = 0; attempt < 30; attempt++) {
              if (await page.locator('[data-chat-message="stored-1"]').isVisible()) break;
              await page.mouse.wheel(0, -2400);
              await page.waitForTimeout(100);
            }
            await page.locator('[data-chat-message="stored-1"]').waitFor();
          });
          evidence.samples.at(-1).interactions = interactions;
        } catch (error) {
          await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true });
          fs.writeFileSync(path.join(directory, 'failure.txt'), await page.locator('body').innerText());
          console.error('Production measurement failed; evidence:', directory, await page.locator('body').innerText());
          throw error;
        } finally { sqlSample = undefined; if (timer) clearInterval(timer); await cdp?.detach(); page.off('request', requested); page.off('requestfinished', finished); page.off('requestfailed', finished); page.off('response', responded); page.off('websocket', socketOpened); for (const socket of sockets) { socket.off('framereceived', received); socket.off('framesent', sent); } }
      }
      await page.screenshot({ path: path.join(directory, `${size}-${round}.png`), animations: 'disabled' });
      await context.close();
    }
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
  for (const size of sizes) for (const kind of ['cold', 'warm']) {
    const samples = evidence.samples.filter(sample => sample.messages === size && sample.kind === kind);
    const percentile = (key, fraction) => samples.map(sample => sample[key]).sort((a, b) => a - b)[Math.ceil(samples.length * fraction) - 1];
    evidence.summaries.push({ messages: size, kind, samples: samples.length, readableP50Ms: percentile('sessionReadableMs', .5), readableP95Ms: percentile('sessionReadableMs', .95),
      maxHeapBytes: Math.max(...samples.map(sample => sample.peakHeapBytes ?? 0)) || null, maxApiBytes: Math.max(...samples.map(sample => sample.apiBytes)) });
  }
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  console.log(JSON.stringify(evidence.summaries, null, 2));
  console.log(`PASS production measurement (not full demand-loading acceptance): ${directory}`);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); await app?.close(); store?.close();
  Database.prototype.prepare = prepare;
}
