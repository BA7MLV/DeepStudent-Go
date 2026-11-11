/** Independent integration gate. Run: npx tsx scripts/e2e-data-delivery-acceptance.mjs
 * Local isolated API + real product Chromium. Never reads production credentials.
 * Failures are accumulated, not skipped; evidence reports exactly what ran. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/data-delivery-acceptance-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
const { taskDto } = await import('../apps/api/src/cloud/tasks.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('External/model execution forbidden'); } });
const evidence = { environment: 'isolated local source/Vite; NOT production performance', checks: [], rounds: [] };
const check = async (name, run) => {
  try { await run(); evidence.checks.push({ name, status: 'passed' }); console.log(`PASS ${name}`); }
  catch (error) { evidence.checks.push({ name, status: 'failed', error: error.message }); console.error(`FAIL ${name}: ${error.message}`); }
};
const noImageBytes = value => assert.doesNotMatch(JSON.stringify(value), /data:image\/[^"\s]*[;,]base64,|iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB/, 'image bytes must not travel in persisted/wire JSON');
let browser, web, store, domain;
try {
  const backend = await app.listen({ host: '127.0.0.1', port: 0 });
  const password = 'data-delivery-local-fixture-123';
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, payload: { adminPassword: password } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, after, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after }]);
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#f00' } }).png().toBuffer();
  async function upload(name) {
    const response = await fetch(backend + '/api/v1/files', { method: 'POST', headers: { cookie,
      'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-mime': 'image/png' }, body: png });
    const body = await response.text();
    assert.equal(response.status, 201, `upload ${name}: ${body}`); return JSON.parse(body);
  }
  const original = await upload('acceptance-original.png'), preview = await upload('acceptance-preview.png');
  const attachment = { id: 'fixture-image', name: 'acceptance-original.png', mimeType: 'image/png', size: png.length,
    serverId: original.id, previewServerId: preview.id, width: 1, height: 1 };
  put('preferences', 'uiLanguage', { id: 'uiLanguage', value: 'zh-CN' });
  for (const sid of [901, 902, 903]) {
    put('chatSessions', sid, { id: sid, videoId: '__library_assistant__', title: `Delivery ${sid}`, createdAt: 1000 - sid });
    for (let n = 1; n <= 65; n++) put('chats', sid * 100 + n, { id: sid * 100 + n, sessionId: sid,
      role: n % 2 ? 'user' : 'assistant', content: `DELIVERY_BODY_${sid}_${n}`, createdAt: n,
      ...(n === 1 ? { attachments: [attachment] } : {}) });
  }
  domain = new ClientRuntimeDomain(store, {});
  await check('reference session first page is exactly latest 40, no image JSON', async () => {
    const result = await domain.read(owner, { kind: 'session', sessionId: 901 });
    assert.deepEqual(result.value.rows.map(row => row.id), Array.from({ length: 40 }, (_, n) => 90126 + n));
    assert.equal(result.value.hasOlder, true); noImageBytes(result);
    const page = await domain.read(owner, { kind: 'session', sessionId: 901, before: { id: 90126, createdAt: 26, role: 'assistant' } });
    assert.equal(page.value.rows.length, 25); assert.deepEqual(page.value.rows[0].data.attachments, [attachment]); noImageBytes(page);
  });
  await check('exact-key/full-history retain original and preview references', async () => {
    const exact = await domain.read(owner, { kind: 'recordKeys', keys: [{ table: 'chats', key: 90101 }] });
    assert.deepEqual(exact.value.records[0].value.attachments, [attachment]); noImageBytes(exact);
    const ids = [], cursors = new Set(); let cursor;
    do {
      const page = await domain.read(owner, { kind: 'collectionPage', table: 'chats', parent: 901, ...(cursor ? { cursor } : {}) });
      noImageBytes(page); ids.push(...page.value.records.map(row => row.value.id)); cursor = page.value.next;
      if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
    } while (cursor);
    assert.deepEqual(ids.sort((a, b) => a - b), Array.from({ length: 65 }, (_, n) => 90101 + n));
  });
  await check('original download is byte-exact; unauthenticated conditional GET cannot reuse it', async () => {
    const response = await fetch(`${backend}/api/v1/files/${original.id}`, { headers: { cookie } });
    assert.equal(response.status, 200); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    const denied = await fetch(`${backend}/api/v1/files/${original.id}`, { headers: { 'if-none-match': response.headers.get('etag') } });
    assert.equal(denied.status, 401);
  });
  await check('cross-account file and exact-key isolation', async () => {
    const other = crypto.randomUUID();
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'acceptance-other', new Date().toISOString());
    const exact = await domain.read(other, { kind: 'recordKeys', keys: [{ table: 'chats', key: 90101 }] });
    assert.equal(exact.value.records[0].value, null);
    // Move ownership in the isolated DB to exercise real authenticated file lookup.
    store.db.prepare('UPDATE files SET owner_id=? WHERE id IN (?,?)').run(other, original.id, preview.id);
    try {
      for (const file of [original, preview]) assert.equal((await fetch(`${backend}/api/v1/files/${file.id}`, { headers: { cookie, 'if-none-match': `"${file.sha256}"` } })).status, 404);
    } finally { store.db.prepare('UPDATE files SET owner_id=? WHERE id IN (?,?)').run(owner, original.id, preview.id); }
  });
  await check('historical task activity/session cannot reintroduce Base64 through input', async () => {
    const legacy = { id: 'legacy-task', kind: 'chat', resource: 'session:901', status: 'completed',
      input: JSON.stringify({ sessionId: 901, attachments: [{ ...attachment, dataUrl: `data:image/png;base64,${png.toString('base64')}` }] }),
      created_at: new Date().toISOString(), progress: null, result: null };
    for (const detail of ['activity', 'session']) noImageBytes(taskDto(legacy, detail));
  });
  await check('legacy migration preserves originals and model image references; failed rows stay exact', async () => {
    const { migrateChatAttachmentReferences } = await import('../apps/api/src/cloud/attachment-migration.ts');
    put('chatSessions', 904, { id: 904, videoId: '__library_assistant__', title: 'Migration fixture', createdAt: 1 });
    const good = { id: 90401, sessionId: 904, role: 'user', content: 'Legacy image', createdAt: 1,
      attachments: [{ ...attachment, dataUrl: `data:image/png;base64,${png.toString('base64')}` }],
      modelTrace: { source: 'Legacy image', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } }] }] } };
    const bad = { id: 90402, sessionId: 904, role: 'user', content: 'Keep invalid legacy intent', createdAt: 2,
      attachments: [{ ...attachment, dataUrl: 'data:image/png;base64,bm90LWEtcG5n' }] };
    put('chats', good.id, good); put('chats', bad.id, bad);
    const before = store.db.prepare("SELECT value,revision FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key=?").get(owner, String(bad.id));
    const result = await migrateChatAttachmentReferences(store, records, process.env.FILES_DIR, owner);
    assert.equal(result.migrated, 1); assert.equal(result.failed, 1);
    const migrated = records.get(owner, 'chats', good.id); noImageBytes(migrated);
    assert.equal(migrated.attachments[0].serverId, original.id, 'never substitute old lossy thumbnail for original');
    assert.match(migrated.modelTrace.messages[0].content[0].image_url.url, /^attachment-file:/);
    assert.deepEqual(store.db.prepare("SELECT value,revision FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key=?").get(owner, String(bad.id)), before);
    const retry = await migrateChatAttachmentReferences(store, records, process.env.FILES_DIR, owner);
    assert.equal(retry.migrated, 0); assert.equal(retry.failed, 1);
    // Keep this deliberately invalid fixture out of subsequent product startup observations.
    put('chats', bad.id, null); put('chats', good.id, null); put('chatSessions', 904, null);
  });
  await check('completed task nonce replay survives later original-file removal', async () => {
    const { submitOwnerTask } = await import('../apps/api/src/cloud/task-commands.ts');
    const { normalizeChatAttachments } = await import('../apps/api/runtime/chat-attachments.ts');
    const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
    const operationId = crypto.randomUUID(), id = crypto.randomUUID(), now = new Date().toISOString();
    const input = new PluginFiles(store).admitTask(owner, 'chat', { sessionId: 901, text: 'Accepted earlier', attachments: normalizeChatAttachments(store, owner, [attachment]) });
    store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, owner, operationId, 'chat', 'session:901', JSON.stringify(input), 'completed', now, now);
    const command = { operationId, kind: 'chat', resource: 'session:901', input };
    assert.equal(submitOwnerTask(store, records, {}, owner, command).id, id);
    const removed = store.db.prepare('SELECT * FROM files WHERE id=?').get(original.id);
    store.db.prepare('DELETE FROM files WHERE id=?').run(original.id);
    try { assert.equal(submitOwnerTask(store, records, {}, owner, command).id, id, 'existing durable receipt is authoritative for the same nonce'); }
    finally {
      const columns = Object.keys(removed);
      store.db.prepare(`INSERT INTO files(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => removed[key]));
      store.db.prepare('DELETE FROM cloud_tasks WHERE id=?').run(id);
    }
  });
  process.env.WANGKE_API_PROXY = backend;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, hmr: false, watch: null } });
  await web.listen(); const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (let round = 1; round <= 3; round++) await check(`cold product startup + A→B→A round ${round}`, async () => {
    const context = await browser.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const errors = [], calls = [], frames = [], files = [];
    try {
      await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(60000);
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/v1/files/')) files.push(request.url());
        if (request.method() === 'POST' && request.url().includes('/api/clientRuntime/')) {
          const data = request.postDataJSON(); calls.push({ path: new URL(request.url()).pathname, request: data?.payload?.args?.request });
        }
      });
      page.on('websocket', socket => {
        socket.on('framesent', frame => frames.push({ direction: 'sent', body: String(frame.payload) }));
        socket.on('framereceived', frame => frames.push({ direction: 'received', body: String(frame.payload) }));
      });
      await page.goto(origin);
      await page.locator('[data-chat-message="stored-90165"]').waitFor();
      await page.evaluate(async () => {
        const { useCourseChat } = await import('/src/store/courseChat.ts'); window.deliveryStore = useCourseChat;
        await useCourseChat.getState().loadSession(901);
      });
      const first = await page.evaluate(() => deliveryStore.getState().messages.length);
      const startupCalls = calls.slice(), startupFrames = frames.slice();
      evidence.rounds.push({ round, firstPage: first, startupRuntimeCalls: startupCalls.map(call => call.request?.kind ?? call.path),
        unopenedBodyFrames: startupFrames.filter(frame => frame.direction === 'received' && /DELIVERY_BODY_90[23]_/.test(frame.body)).map(frame => ({ bytes: Buffer.byteLength(frame.body), prefix: frame.body.slice(0, 400) })),
        startupWsBytes: startupFrames.reduce((n, frame) => n + Buffer.byteLength(frame.body), 0) });
      // Collect all assertions, including switches, even if the startup gate fails.
      let startupError;
      try {
        assert.equal(first, 40);
        assert.equal(files.length, 0, 'oldest/offscreen attachment must not fetch preview or original');
        assert.ok(!startupCalls.some(call => /recordsPage|followRecords/.test(call.path) || call.request?.kind === 'records'), 'startup must not pull account mirror');
        assert.ok(!startupFrames.some(frame => frame.direction === 'sent' && /followRecords|recordsPage|"kind":"records"/.test(frame.body)), 'startup must not subscribe account mirror');
        assert.ok(!startupFrames.some(frame => frame.direction === 'received' && /DELIVERY_BODY_90[23]_/.test(frame.body)), 'unopened session body leaked over WS');
      } catch (error) { startupError = error; }
      for (const sid of [902, 901, 903, 901]) {
        await page.evaluate(sid => deliveryStore.getState().loadSession(sid), sid);
        await page.locator(`[data-chat-message="stored-${sid}65"]`).waitFor();
        const state = await page.evaluate(() => ({ id: deliveryStore.getState().activeId, contents: deliveryStore.getState().messages.map(row => row.content) }));
        assert.equal(state.id, sid); assert.equal(state.contents.length, 40);
        assert.ok(state.contents.every(content => content.startsWith(`DELIVERY_BODY_${sid}_`)));
      }
      await page.route('**/api/clientRuntime/read', route => {
        const request = route.request().postDataJSON()?.payload?.args?.request;
        return request?.kind === 'session' && request.before
          ? route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }) : route.continue();
      });
      await page.evaluate(() => deliveryStore.getState().loadOlder());
      const failure = await page.evaluate(() => ({ count: deliveryStore.getState().messages.length, error: deliveryStore.getState().historyError }));
      assert.equal(failure.count, 40, 'failed pagination preserves current bodies');
      assert.ok(failure.error, 'failed pagination must not be mistaken for end-of-history');
      await page.unroute('**/api/clientRuntime/read');
      await page.evaluate(() => deliveryStore.getState().loadOlder());
      assert.equal(await page.evaluate(() => deliveryStore.getState().messages.length), 65, 'retry delivers complete old page');
      assert.deepEqual(errors, []); if (startupError) throw startupError;
    } finally { await context.close(); }
  });
  await check('cached attachment must not bypass same-account file revocation', async () => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
      await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(60000); await page.goto(origin);
      await page.locator('[data-chat-message="stored-90165"]').waitFor();
      const first = await page.evaluate(async file => {
        const { readAttachmentBlob } = await import('/src/chat/prepareAttachment.ts');
        const blobs = await Promise.all([readAttachmentBlob(file), readAttachmentBlob(file)]);
        return Promise.all(blobs.map(async blob => Array.from(new Uint8Array(await blob.arrayBuffer()))));
      }, attachment);
      assert.deepEqual(first, [Array.from(png), Array.from(png)]);
      const removed = store.db.prepare('SELECT * FROM files WHERE id=?').get(original.id);
      store.db.prepare('DELETE FROM files WHERE id=?').run(original.id);
      try {
        assert.equal((await fetch(`${backend}/api/v1/files/${original.id}`, { headers: { cookie } })).status, 404);
        const outcome = await page.evaluate(async file => {
          const { readAttachmentBlob } = await import('/src/chat/prepareAttachment.ts');
          try { await readAttachmentBlob(file); return 'returned cached bytes'; } catch { return 'denied'; }
        }, attachment);
        assert.equal(outcome, 'denied', 'server says 404 but cache still returns protected original');
      } finally {
        const columns = Object.keys(removed);
        store.db.prepare(`INSERT INTO files(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(key => removed[key]));
      }
    } finally { await context.close(); }
  });
} catch (error) {
  evidence.checks.push({ name: 'harness setup/runtime', status: 'failed', error: error.stack });
  console.error(error);
} finally {
  await browser?.close(); await web?.close(); domain?.close(); store?.close(); await app.close();
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`Evidence: ${directory}/evidence.json`);
}
if (evidence.checks.some(check => check.status === 'failed')) process.exitCode = 1;
