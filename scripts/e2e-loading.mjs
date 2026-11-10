/** Isolated real API + Chromium + IndexedDB. No existing account data is used. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/lazy-loading-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
const { assembleRuntimeDomains } = await import('../apps/api/src/realtime/runtime-domains.ts');
let app, web, browser, store;
const evidence = { fixture: { messages: 1000, files: 8 }, timings: [], checks: [] };
try {
  app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'),
    plugins: [{ name: 'loading-fixture', configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/__loading') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<body>Loading fixture</body>');
    }); } }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const setup = await browser.newContext();
  assert.equal((await setup.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'loading-fixture-password-123' } })).status(), 201);
  const login = await setup.request.post(`${origin}/api/v1/auth/password/login`, { data: { password: 'loading-fixture-password-123' } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id, auth = await setup.storageState();
  const files = [];
  for (let n = 0; n < 8; n++) {
    const upload = await setup.request.post(`${origin}/api/v1/files`, { headers: { 'content-type': 'application/octet-stream', 'x-file-name': `cover-${n}.png`, 'x-file-mime': 'image/png' },
      data: Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64'), Buffer.from(String(n))]) });
    assert.equal(upload.ok(), true); files.push((await upload.json()).id);
  }
  const image = await setup.request.get(`${origin}/api/v1/files/${files[0]}`);
  assert.equal(image.headers()['cache-control'], 'private, no-cache');
  const etag = image.headers().etag;
  assert.ok(etag);
  assert.equal((await setup.request.get(`${origin}/api/v1/files/${files[0]}`, { headers: { 'if-none-match': etag } })).status(), 304);
  const anonymous = await browser.newContext();
  assert.equal((await anonymous.request.get(`${origin}/api/v1/files/${files[0]}`, { headers: { 'if-none-match': etag } })).status(), 401);
  await anonymous.close();
  evidence.checks.push('private browser cache revalidates ownership before 304');
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  new CloudRecords(store).list(owner, 0);
  store.transaction(() => {
    const put = store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)');
    put.run(owner, 'cards', '8888', null);
    put.run(owner, 'chatSessions', '901', JSON.stringify({ id: 901, videoId: '__library_assistant__', title: 'Loading fixture', createdAt: 901 }));
    for (let i = 1; i <= 1000; i++) put.run(owner, 'chats', String(i), JSON.stringify({ id: i, sessionId: 901, role: i % 2 ? 'user' : 'assistant', content: '性能测试内容。'.repeat(30), createdAt: i }));
    for (let i = 0; i < 8; i++) put.run(owner, 'covers', JSON.stringify(`fixture-${i}`), JSON.stringify({ videoId: `fixture-${i}`, blob: { $file: files[i], type: 'image/png' }, createdAt: i }));
  });

  // Reopening both the database and domain is equivalent to a normal process
  // restart for epoch identity, not merely reconnecting a browser model.
  let domain = new ClientRuntimeDomain(store, {});
  const epoch = (await domain.recordsPage(owner, 0)).epoch;
  domain.close(); store.close();
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  domain = new ClientRuntimeDomain(store, {});
  assert.equal((await domain.recordsPage(owner, 0)).epoch, epoch);
  assert.equal((await domain.recordsPage(owner, Number.MAX_SAFE_INTEGER)).reset, true);
  domain.close(); evidence.checks.push('persistent epoch across database/domain restart; future cursor resets');

  // Dependency-specific invalidation retains resource/chat-attachment changes,
  // but learning text/progress cannot rescan every open filesystem directory.
  const domains = assembleRuntimeDomains({ store, plugins: {}, canonical: JSON.stringify });
  const changed = (entity, domain = 'cloud_records') => ({ owner_id: owner, revision: 1, domain, entity });
  for (const entity of ['segments:1', 'cards:1', 'studyDays:"2026-11-09"', 'preferences:"uiLanguage"']) {
    assert.equal(domains.matches({ kind: 'resources' }, changed(entity)), false);
    assert.equal(domains.matches({ kind: 'courseDocument', courseId: 'course' }, changed(entity)), false);
    assert.equal(domains.matches({ kind: 'systemDocument', path: '/system/AGENTS.md' }, changed(entity)), false);
  }
  for (const entity of ['videos:"course"', 'folders:1', 'chats:1', 'chatSessions:1']) assert.equal(domains.matches({ kind: 'resources' }, changed(entity)), true);
  assert.equal(domains.matches({ kind: 'courseDocument', courseId: 'course' }, changed('videos:"course"')), true);
  assert.equal(domains.matches({ kind: 'courseDocument', courseId: 'other' }, changed('videos:"course"')), false);
  assert.equal(domains.matches({ kind: 'systemDocument', path: '/system/AGENTS.md' }, changed('preferences:"agentInstructions"')), true);
  evidence.checks.push('narrow invalidation preserves relevant dependencies');

  async function pageFixture(delayMs = 0) {
    const context = await browser.newContext({ storageState: auth });
    const page = await context.newPage(), requests = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { const url = new URL(request.url()); if (url.pathname.startsWith('/api/')) requests.push(url.pathname); });
    if (delayMs) await page.route('**/api/**', async route => { await new Promise(resolve => setTimeout(resolve, delayMs)); await route.continue(); });
    await page.goto(`${origin}/__loading`);
    // Exclude dev-source compilation from the data-path measurement.
    await page.evaluate(async () => {
      window.sync = await import('/src/cloud/sync.ts'); window.storage = await import('/src/store/db.ts');
      window.blobs = await import('/src/store/cloudBlob.ts'); window.bootstrap = await import('/src/client/bootstrap.ts');
      window.resources = await import('/src/client/resources.ts');
    });
    return { context, page, requests, errors };
  }
  const waitSynced = page => page.waitForFunction(() => sync.useCloudSync.getState().syncedAt > 0, undefined, { timeout: 30000 });
  // Exercise point-read publication without the legacy follower masking failures
  // by independently retiring the command. Real API, IDB and account guards.
  {
    const { context, page } = await pageFixture();
    const version = store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key='1'").get(owner).revision;
    const tombstoneVersion = store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='cards' AND record_key='8888'").get(owner).revision;
    await page.evaluate(async ({ owner, epoch, version, tombstoneVersion }) => {
      const { cloud } = await import('/src/cloud/state.ts');
      storage.useCloudDatabase(owner); cloud.userId = owner; cloud.enabled = true;
      window.receiptCommand = { operationId: 'point-read-fault-fixture', request: { operationId: 'point-read-fault-fixture', edits: [] }, entities: [], state: 'confirmed', createdAt: 1,
        receipt: { versions: [{ table: 'cards', key: 8888, revision: tombstoneVersion }, { table: 'chats', key: 1, revision: version }] } };
      receiptCommand.sequence = await storage.db.table('_learningCommands').add(receiptCommand);
      await storage.db.table('_cloudMeta').bulkPut([{ id: 'cursor', value: 17 }, { id: 'records-epoch', value: epoch }, { id: 'attachment-original', value: new Blob(['private original']) }]);
      const { markCloudApply } = await import('/src/cloud/cache.ts');
      await storage.db.transaction('rw', storage.db.cards, async () => {
        markCloudApply();
        await storage.db.cards.put({ id: 8888, videoId: 'receipt-fixture', q: 'obsolete local card', a: 'must delete only at commit' });
      });
      await bootstrap.serverRuntime(owner);
    }, { owner, epoch, version, tombstoneVersion });
    const confirm = () => page.evaluate(async () => {
      try { return { value: await sync.reconcileLearningProjection(receiptCommand) }; }
      catch (error) { return { error: error.message }; }
    });
    const assertRetained = async () => {
      assert.deepEqual(await page.evaluate(async () => ({ commands: await storage.db.table('_learningCommands').count(), cursor: (await storage.db.table('_cloudMeta').get('cursor')).value,
        original: await (await storage.db.table('_cloudMeta').get('attachment-original')).value.text(), rows: await storage.db.chats.count(), cards: await storage.db.cards.count() })),
      { commands: 1, cursor: 17, original: 'private original', rows: 0, cards: 1 });
    };
    await page.route('**/api/clientRuntime/read', route => route.fulfill({ status: 503, body: 'point read unavailable' }));
    assert.ok((await confirm()).error); await assertRetained();
    await page.unroute('**/api/clientRuntime/read');
    await page.evaluate(() => storage.db.table('_cloudMeta').put({ id: 'records-epoch', value: 'different-generation' }));
    assert.deepEqual(await confirm(), { value: false }); await assertRetained();
    await page.evaluate(epoch => storage.db.table('_cloudMeta').put({ id: 'records-epoch', value: epoch }), epoch);
    await page.evaluate(() => { window.originalPut = IDBObjectStore.prototype.put; IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chats') throw new DOMException('injected quota failure', 'QuotaExceededError');
      return originalPut.apply(this, args);
    }; });
    assert.match((await confirm()).error, /quota/i); await assertRetained();
    await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
    await page.evaluate(() => { receiptCommand.receipt.versions[1].revision += 1000000; });
    assert.match((await confirm()).error, /learning_receipt_projection_unavailable/); await assertRetained();
    await page.evaluate(version => { receiptCommand.receipt.versions[1].revision = version; }, version);
    // Invalidate A's lifetime after capture but before delivery, even though the
    // visible account string returns to A (A->B->A is not the original A).
    let releaseResponse, captured;
    const responseGate = new Promise(resolve => { releaseResponse = resolve; });
    const capturedResponse = new Promise(resolve => { captured = resolve; });
    await page.route('**/api/clientRuntime/read', async route => { const response = await route.fetch(); captured(); await responseGate; await route.fulfill({ response }); });
    const stale = confirm(); await capturedResponse;
    await page.evaluate(async owner => { const { accountLifetime } = await import('/src/client/account-lifecycle.ts'); accountLifetime('other-fixture'); accountLifetime(owner); }, owner);
    releaseResponse(); assert.match((await stale).error, /client_account_changed|client_runtime_disposed|abort|cancel/i); await assertRetained();
    await page.unroute('**/api/clientRuntime/read');
    assert.deepEqual(await confirm(), { value: true });
    assert.deepEqual(await page.evaluate(async () => ({ commands: await storage.db.table('_learningCommands').count(), cursor: (await storage.db.table('_cloudMeta').get('cursor')).value, rows: await storage.db.chats.count(), cards: await storage.db.cards.count() })), { commands: 0, cursor: 17, rows: 1, cards: 0 });
    const hydrate = () => page.evaluate(async () => {
      try { return { rows: (await sync.readRecordKeys('chats', [2])).map(row => row?.id) }; }
      catch (error) { return { error: error.message }; }
    });
    await page.route('**/api/clientRuntime/read', route => route.fulfill({ status: 503, body: 'metadata unavailable' }));
    assert.ok((await hydrate()).error);
    await page.unroute('**/api/clientRuntime/read');
    await page.evaluate(() => storage.db.table('_cloudMeta').put({ id: 'records-epoch', value: 'other-epoch' }));
    assert.match((await hydrate()).error, /records_generation_changed/);
    await page.evaluate(epoch => storage.db.table('_cloudMeta').put({ id: 'records-epoch', value: epoch }), epoch);
    await page.evaluate(() => { IDBObjectStore.prototype.put = function (...args) {
      if (this.name === 'chats') throw new DOMException('injected quota failure', 'QuotaExceededError');
      return originalPut.apply(this, args);
    }; });
    assert.match((await hydrate()).error, /quota/i);
    await page.evaluate(() => { IDBObjectStore.prototype.put = originalPut; });
    assert.equal(await page.evaluate(() => storage.db.chats.count()), 1, 'failed point hydration commits no partial row');
    assert.deepEqual(await hydrate(), { rows: [2] });
    assert.deepEqual(await page.evaluate(async () => ({ cursor: (await storage.db.table('_cloudMeta').get('cursor')).value,
      rows: await storage.db.chats.count(), original: await (await storage.db.table('_cloudMeta').get('attachment-original')).value.text() })),
      { cursor: 17, rows: 2, original: 'private original' });
    await context.close();
    evidence.checks.push('point receipt: 503, epoch mismatch, injected quota, future version and A→B→A preserve journal/original/cursor; tombstone deletion rolls back on failure; retry retires only after atomic publication');
    evidence.checks.push('explicit point hydration: 503, epoch and quota reject without partial rows; retry reads only requested key and never advances global cursor or alters original');
  }
  for (const delayMs of [0, 150]) {
    const { context, page, requests, errors } = await pageFixture(delayMs);
    const start = Date.now();
    const localMs = await page.evaluate(async owner => { const start = performance.now(); await sync.startCloud(owner, { background: true }); return performance.now() - start; }, owner);
    await waitSynced(page);
    const baselineMs = Date.now() - start;
    assert.equal(await page.evaluate(() => storage.db.chats.count()), 1000);
    assert.equal(requests.filter(path => path.startsWith('/api/v1/files/')).length, 0, 'baseline never downloads a Blob');
    assert.equal(requests.filter(path => path === '/api/clientRuntime/recordsPage').length, 6, 'no duplicate first probe page');
    assert.equal(await page.evaluate(async () => (await storage.db.covers.get('fixture-0')).blob.$file), files[0]);
    evidence.timings.push({ delayMs, localMs, baselineMs, pageRequests: 6, baselineFileGETs: 0 });

    const downloads = await page.evaluate(async () => {
      const row = await storage.db.covers.get('fixture-0');
      const results = await Promise.all(Array.from({ length: 10 }, () => blobs.resolveCloudBlob(row.blob)));
      return { size: results[0].size, type: results[0].type, cached: await storage.db.table('_fileCache').count() };
    });
    assert.ok(downloads.size > 0); assert.equal(downloads.type, 'image/png'); assert.equal(downloads.cached, 1);
    assert.equal(requests.filter(path => path.startsWith('/api/v1/files/')).length, 1, 'demand downloads are coalesced');
    requests.length = 0;
    await page.evaluate(async owner => { await sync.startCloud(owner); const row = await storage.db.covers.get('fixture-0'); await blobs.resolveCloudBlob(row.blob); }, owner);
    assert.equal(requests.filter(path => path.startsWith('/api/v1/files/')).length, 0, 'restart reuses persistent file cache');
    assert.equal(requests.filter(path => path === '/api/clientRuntime/recordsPage').length, 1, 'warm restart is incremental');
    await page.evaluate(async () => {
      const row = await storage.db.covers.get('fixture-1');
      const image = document.createElement('img'); image.id = 'lazy-cover'; image.loading = 'lazy';
      image.src = blobs.cloudBlobUrl(row.blob); document.body.append(image);
    });
    await page.waitForFunction(() => { const image = document.querySelector('#lazy-cover'); return image.complete && image.naturalWidth > 0; });

    // A retained directory is emitted synchronously during reacquisition while
    // the replacement stream is still reconnecting, rather than after a request.
    const cachedDirectory = await page.evaluate(async owner => {
      const runtime = await bootstrap.serverRuntime(owner);
      const request = { kind: 'resources', path: '', archived: true };
      const first = await new Promise(resolve => {
        const off = resources.followResources(undefined, '', () => resolve(off), error => { throw error; });
      }); first();
      return new Promise((resolve, reject) => {
        const off = resources.followResources(undefined, '', directory => {
          const status = runtime.resources(request).getSnapshot().status;
          off(); resolve({ status, root: !!directory.rootId });
        }, reject);
      });
    }, owner);
    assert.equal(cachedDirectory.status, 'reconnecting'); assert.equal(cachedDirectory.root, true);
    assert.deepEqual(errors, []);
    await context.close();
  }
  evidence.checks.push('zero baseline file GETs; demand coalescing; persistent disk cache; incremental warm restart; retained directory while revalidating');

  // Fail startup before a follower exists. Timed retry must recover without
  // page reload, user action, or an incidental command flush.
  for (const onlineWake of [false, true]) {
    const { context, page, errors } = await pageFixture();
    let blocked = true, failed = 0;
    await page.route('**/api/clientRuntime/recordsPage', async route => {
      if (blocked) { failed++; await route.fulfill({ status: 503, body: 'temporary fixture outage' }); }
      else await route.continue();
    });
    await page.evaluate(owner => sync.startCloud(owner, { background: true }), owner);
    await page.waitForFunction(() => sync.useCloudSync.getState().degradedSince > 0);
    blocked = false;
    if (onlineWake) await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await waitSynced(page);
    assert.ok(failed > 0);
    assert.equal(await page.evaluate(() => storage.db.chats.count()), 1000);
    assert.equal(await page.evaluate(() => sync.useCloudSync.getState().degradedSince), 0);
    assert.deepEqual(errors, []); await context.close();
  }
  evidence.checks.push('startup recovers by backoff and by online event before follower installation');

  const { context, page, errors } = await pageFixture();
  let fileFailures = 0;
  await page.route('**/api/v1/files/**', async route => { fileFailures++; await route.fulfill({ status: 503, body: 'file unavailable' }); });
  await page.evaluate(owner => sync.startCloud(owner), owner);
  assert.equal(fileFailures, 0);
  const failedFile = await page.evaluate(async () => {
    try { await blobs.resolveCloudBlob((await storage.db.covers.get('fixture-0')).blob); return 'unexpected'; }
    catch (error) { return error.message; }
  });
  assert.match(failedFile, /503/);
  assert.equal(await page.evaluate(() => storage.db.chats.count()), 1000);
  await page.unroute('**/api/v1/files/**');
  assert.ok(await page.evaluate(async () => (await blobs.resolveCloudBlob((await storage.db.covers.get('fixture-0')).blob)).size));
  // A mid-rebuild failure keeps the last complete projection and private drafts.
  await page.evaluate(async () => {
    await storage.db.table('_cloudMeta').put({ id: 'records-epoch', value: 'force-rebuild' });
    await storage.db.table('_cloudMeta').put({ id: 'private-draft', value: new Blob(['retained draft']) });
  });
  let pages = 0;
  await page.route('**/api/clientRuntime/recordsPage', async route => {
    if (++pages === 3) await route.fulfill({ status: 503, body: 'mid-rebuild failure' }); else await route.continue();
  });
  await page.evaluate(() => sync.flushCloud().catch(() => {}));
  assert.equal(await page.evaluate(() => storage.db.chats.count()), 1000);
  assert.ok(await page.evaluate(() => storage.db.table('_projectionStage').count()) > 0);
  await page.unroute('**/api/clientRuntime/recordsPage');
  await page.evaluate(() => sync.flushCloud());
  assert.equal(await page.evaluate(() => storage.db.chats.count()), 1000);
  assert.equal(await page.evaluate(async () => (await storage.db.table('_cloudMeta').get('private-draft')).value.text()), 'retained draft');
  assert.equal(await page.evaluate(() => storage.db.table('_projectionStage').count()), 0);
  assert.deepEqual(errors, []); await context.close();
  evidence.checks.push('file outage does not block records; retry works; atomic failed rebuild preserves previous projection and private drafts');
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`PASS loading regressions (${directory})`);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); await app?.close(); store?.close();
}
