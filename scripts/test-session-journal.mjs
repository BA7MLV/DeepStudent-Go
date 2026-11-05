import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createClientRuntime } from '@wangke/client-core';
import { SessionJournalModel } from '../packages/client-core/src/session.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/session-journal-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let runtime, store, release;
const sockets = [];
let delayedRead;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const holdNextRead = () => delayedRead = { read: deferred(), resume: deferred() };
async function until(test, label) {
  for (let i = 0; i < 300; i++) { if (test()) return; await delay(20); }
  throw new Error(`Timeout: ${label}`);
}
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const init = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, payload: { adminPassword: 'session-journal-test-123' } });
  assert.equal(init.statusCode, 201, init.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'session-journal-test-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  const row = id => ({ id, sessionId: 1, role: id % 2 ? 'user' : 'assistant', content: `message-${id}`, createdAt: id });
  put('chatSessions', 1, { id: 1, title: 'Journal' });
  for (let id = 1; id <= 50; id++) put('chats', id, row(id));
  runtime = await createClientRuntime({ server: base, account: owner, scope: 'session-journal-test' }, { interactions: 'answer', transport: {
    fetch: async (url, init) => {
      const gate = new URL(url, base).pathname === '/api/clientRuntime/read' ? delayedRead : undefined;
      if (gate) delayedRead = undefined;
      const response = await fetch(new URL(url, base), { ...init, headers: { ...init?.headers, cookie } });
      if (gate) { await response.clone().arrayBuffer(); gate.read.resolve(); await gate.resume.promise; }
      return response;
    }, streamBaseUrl: base,
    createWebSocket: url => { const socket = new WebSocket(url, { headers: { cookie, origin: base } }); sockets.push(socket); return socket; },
  } });
  const model = runtime.session(1);
  release = model.acquire();
  await until(() => { const snapshot = model.getSnapshot(); if (snapshot.status === 'error') throw new Error(JSON.stringify(snapshot)); return snapshot.status === 'ready'; }, 'paged initial baseline');
  assert.equal(model.projection().rows.length, 40);
  assert.equal(model.projection().hasOlder, true);
  const cursorBefore = store.db.prepare('SELECT cursor FROM client_session_cursors WHERE owner_id=? AND session_id=1').get(owner).cursor;
  assert.throws(() => store.transaction(() => { put('chats', 500, row(500)); throw new Error('rollback'); }));
  assert.equal(store.db.prepare('SELECT cursor FROM client_session_cursors WHERE owner_id=? AND session_id=1').get(owner).cursor, cursorBefore);
  // More than a latest window is committed before the consumer observes it.
  for (let id = 51; id <= 130; id++) put('chats', id, row(id));
  await until(() => model.projection()?.rows.length === 120, 'all 80 durable events, not a 40-row replacement');
  put('chats', 50, { ...row(50), content: 'edited' });
  put('chats', 49, null);
  await until(() => model.projection()?.rows.find(row => row.id === 50)?.content === 'edited' && !model.projection()?.rows.some(row => row.id === 49), 'update and tombstone');
  const currentSocket = sockets.at(-1);
  currentSocket.terminate();
  for (let id = 131; id <= 200; id++) put('chats', id, row(id));
  await until(() => model.projection()?.rows.some(row => row.id === 200) && model.getSnapshot().status === 'ready', 'actual WS reconnect');
  assert.equal(model.projection().rows.length, 189);
  // Force a retained-range gap and restart the real subscription. The full
  // repair includes older rows, not just the most recent forty.
  store.transaction(() => {
    put('chats', 201, row(201));
    store.db.prepare('UPDATE client_session_cursors SET floor=cursor WHERE owner_id=? AND session_id=1').run(owner);
    store.db.prepare('DELETE FROM client_session_events WHERE owner_id=? AND session_id=1').run(owner);
  });
  model.refresh();
  await until(() => model.projection()?.rows.some(row => row.id === 1) && model.projection()?.rows.some(row => row.id === 201), 'retained cursor full repair');
  assert.equal(model.projection().rows.length, 200);
  assert.equal(model.projection().hasOlder, false);
  // Actual HTTP is read by SQLite, then held while the real WS journal moves.
  // Row 1001 is outside the loaded window: absence alone cannot protect it.
  put('chatSessions', 2, { id: 2, title: 'Delayed pagination' });
  for (let id = 1001; id <= 1065; id++) put('chats', id, { ...row(id), sessionId: 2 });
  const paged = runtime.session(2);
  let releasePaged = paged.acquire();
  await until(() => paged.getSnapshot().status === 'ready', 'race session baseline');
  const gate = holdNextRead();
  const pendingPage = runtime.sessionPage(2, { id: 1026, createdAt: 1026 });
  await gate.read.promise;
  put('chats', 1001, null);
  put('chats', 1065, { ...row(1065), sessionId: 2, content: 'delete observed' });
  await until(() => paged.projection()?.rows.at(-1)?.content === 'delete observed', 'WS passes unseen delete while HTTP held');
  gate.resume.resolve(); await pendingPage;
  assert.equal(paged.projection().rows.some(row => row.id === 1001), false, 'delayed HTTP must not resurrect deleted unseen row');
  assert.equal(paged.projection().rows.length, 64);

  const gapGate = holdNextRead();
  const oldWindow = runtime.sessionPage(2, { id: 1065, createdAt: 1065 });
  await gapGate.read.promise; // this latest-window page says hasOlder=true
  store.transaction(() => {
    put('chats', 1002, null);
    store.db.prepare('UPDATE client_session_cursors SET floor=cursor WHERE owner_id=? AND session_id=2').run(owner);
    store.db.prepare('DELETE FROM client_session_events WHERE owner_id=? AND session_id=2').run(owner);
  });
  paged.refresh();
  await until(() => paged.getSnapshot().status === 'ready' && paged.projection()?.rows.length === 63 && !paged.projection()?.hasOlder, 'full gap baseline while HTTP held');
  const repaired = paged.projection();
  gapGate.resume.resolve(); await oldWindow;
  assert.equal(paged.projection(), repaired, 'late page cannot replace full repair or regress hasOlder');
  assert.equal(repaired.rows[0].id, 1003, 'full gap repair still includes older-than-window rows');

  const releaseGate = holdNextRead();
  const releasedPage = runtime.sessionPage(2, { id: 1065, createdAt: 1065 });
  await releaseGate.read.promise;
  releasePaged(); releasePaged = paged.acquire();
  await until(() => paged.getSnapshot().status === 'ready', 'release/reacquire resumed stream');
  const reacquired = paged.projection();
  releaseGate.resume.resolve(); await releasedPage;
  assert.equal(paged.projection(), reacquired, 'old observation page cannot publish into reacquired model');

  const disposeGate = holdNextRead();
  const disposedPage = runtime.sessionPage(2, { id: 1065, createdAt: 1065 });
  await disposeGate.read.promise;
  paged.dispose();
  disposeGate.resume.resolve(); await disposedPage;
  assert.equal(paged.getSnapshot().error, 'client_model_disposed');
  assert.equal(paged.getSnapshot().data, undefined, 'disposed model cannot be repopulated by a pending page');
  assert.throws(() => paged.acquire(), /client_model_disposed/);
  releasePaged();
  const reducer = new SessionJournalModel();
  reducer.apply({ type: 'baseline', cursor: 5, session: {}, tasks: [], hasOlder: false });
  reducer.reconnect();
  assert.equal(reducer.cursor, undefined, 'partial baseline is not acknowledged');
  assert.throws(() => reducer.apply({ type: 'ready', cursor: 5 }), /baseline/);
  reducer.apply({ type: 'baseline', cursor: 5, session: {}, tasks: [], hasOlder: false });
  reducer.apply({ type: 'ready', cursor: 5 }); reducer.commit(5);
  for (const frame of [
    { type: 'events', baseCursor: 4, cursor: 5, events: [], session: {}, tasks: [] },
    { type: 'events', baseCursor: 5, cursor: 7, events: [{ cursor: 7, rowId: 1, row: null }], session: {}, tasks: [] },
  ]) assert.throws(() => reducer.apply(frame), /journal_gap/);
  assert.equal(reducer.cursor, 5);
  fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ passed: true, initial: 40, afterBurst: 120, afterReconnect: 189, repaired: 200,
    rollback: true, incompleteBaseline: true, duplicateAndGapRejected: true,
    delayedHttp: { unseenDelete: true, fullGapBaseline: true, releaseReacquire: true, dispose: true } }, null, 2));
  console.log(`PASS session durable journal, rollback, 80-event burst, real WS reconnect, tombstones and full cursor-gap repair: ${directory}`);
} finally { release?.(); await runtime?.dispose(); for (const socket of sockets) socket.terminate(); store?.close(); await app.close(); }
