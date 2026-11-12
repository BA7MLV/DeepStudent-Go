import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-presentation-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let store, domain;
const subscriptions = [];
try {
  const init = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, payload: { adminPassword: 'presentation-test-password-123' } });
  assert.equal(init.statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'presentation-test-password-123' } });
  const owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  const row = id => ({ id, sessionId: 1, createdAt: id, role: id % 2 ? 'user' : 'assistant', content: `Message ${id}`,
    modelTrace: [{ role: 'user', content: 'internal repeated context'.repeat(2000) }], modelRequests: [{ id: 'internal-usage' }],
    attachments: [{ id: 'image', type: 'image', dataUrl: 'data:image/png;base64,cHJlc2VydmU=' }],
    reasoning: 'Visible reasoning', tools: [{ name: 'search', status: 'done', result: 'Visible result' }],
    widgets: [{ id: 'visual', html: '<p>Retained visual</p>' }], ask: { picked: 'Retained answer' },
    interrupted: true, interruptReason: 'Retained reason' });
  const display = value => { const { modelTrace, modelRequests, ...rest } = value; return rest; };
  put('chatSessions', 1, { id: 1, title: 'Presentation', createdAt: 1 });
  for (let id = 1; id <= 65; id++) put('chats', id, row(id));
  domain = new ClientRuntimeDomain(store, {});
  let projections = 0;
  const project = domain.sessionProjection.bind(domain);
  domain.sessionProjection = (...args) => { projections++; return project(...args); };
  const subscribe = request => {
    const controller = new AbortController(), stream = domain.watchSessionJournal(owner, request, controller.signal)[Symbol.asyncIterator]();
    subscriptions.push({ controller, stream }); return stream;
  };
  const stream = subscribe({ sessionId: 1 });
  const baseline = (await stream.next()).value;
  assert.equal(baseline.type, 'baseline'); assert.equal(baseline.hasOlder, true);
  const rows = (await stream.next()).value.rows;
  assert.equal(rows.length, 40);
  for (const item of rows) assert.deepEqual(item.data, display(row(item.id)), 'all presentation fields survive unchanged');
  assert.equal((await stream.next()).value.type, 'ready');
  assert.equal((await stream.next()).value.type, 'events');
  assert.equal(projections, 1, 'baseline, chunks, ready and immediate catch-up read the window only once');
  const edited = { ...row(65), content: 'Edited after baseline' };
  put('chats', 65, edited);
  domain.pump();
  let changed;
  for (let n = 0; n < 5 && !changed; n++) changed = (await stream.next()).value.events.find(event => event.rowId === 65)?.row;
  assert.deepEqual(changed.data, display(edited), 'live events use the same presentation projection');
  assert.equal(projections, 1, 'live changes do not recapture forty bodies');
  const older = await domain.read(owner, { kind: 'session', sessionId: 1, before: { id: 26, createdAt: 26, role: 'assistant' } });
  assert.equal(older.value.rows.length, 25);
  for (const item of older.value.rows) assert.deepEqual(item.data, display(row(item.id)), 'pagination uses the same projection');
  const full = await domain.read(owner, { kind: 'recordKeys', keys: [{ table: 'chats', key: 65 }] });
  assert.deepEqual(full.value.records[0].value, edited, 'explicit full-record consumers retain model context and usage');
  assert.deepEqual(records.get(owner, 'chats', 65), edited, 'presentation never modifies authoritative records');

  store.db.prepare('UPDATE client_session_cursors SET floor=cursor WHERE owner_id=? AND session_id=1').run(owner);
  const repair = subscribe({ sessionId: 1, after: 0 });
  assert.equal((await repair.next()).value.type, 'resync-required');
  assert.equal((await repair.next()).value.hasOlder, false);
  const repaired = [];
  for (;;) { const frame = (await repair.next()).value; if (frame.type === 'ready') break; repaired.push(...frame.rows); }
  assert.equal(repaired.length, 65, 'gap repair still restores the entire timeline in chunks');
  assert.deepEqual(repaired.at(-1).data, display(edited));

  // Rechecking permission between yields must remain cheap, but cannot disappear.
  for (const framesBeforeDeletion of [1, 2]) {
    const sessionId = framesBeforeDeletion + 1, rowId = 100 + framesBeforeDeletion;
    put('chatSessions', sessionId, { id: sessionId, title: 'Revoked during delivery' });
    put('chats', rowId, { id: rowId, sessionId, createdAt: 100, role: 'user', content: 'private' });
    const revoked = subscribe({ sessionId });
    for (let n = 0; n < framesBeforeDeletion; n++) await revoked.next();
    put('chatSessions', sessionId, null);
    await assert.rejects(revoked.next(), /session_not_found/, 'deletion is checked before rows and before ready');
  }
  const foreign = domain.watchSessionJournal('another-owner', { sessionId: 1 }, new AbortController().signal)[Symbol.asyncIterator]();
  await assert.rejects(foreign.next(), /session_not_found/);
  console.log('PASS presentation baseline/pagination/events/gap repair preserve visible fields, full records remain intact, one baseline read, and per-frame authorization');
} finally {
  for (const { controller, stream } of subscriptions) { controller.abort(); await stream.return?.(); }
  domain?.close(); store?.close(); await app.close();
}
