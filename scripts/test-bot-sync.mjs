import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotMessageHistory } from '../apps/api/src/agent/message-history.ts';
import { BotMessageStreams } from '../apps/api/src/agent/message-stream.ts';
import { mergeMessages, mergeById } from '../apps/web/src/pages/botMessageCache.ts';
import { serverClient } from '../apps/web/src/api/serverClient.ts';
import { createMessageGrouper } from '../apps/web/src/pages/botMessages.ts';
import { acquireBotImage, clearBotImageCache, invalidateBotImage } from '../apps/web/src/components/botImageCache.ts';

const temporary = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const at = '2026-11-01T12:00:00.000Z';
function fixture() {
  const root = fs.mkdtempSync(path.join(temporary, 'bot-sync-'));
  const filename = path.join(root, 'db.sqlite');
  const store = new DatabaseStore(filename);
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'Owner', at);
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const thread = bot.create('owner', 'bot', 'History');
  return { root, filename, store, bot, thread, history: new BotMessageHistory(store), close() { store.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('bounded first page at 1 / 100 / 1000 / 10000 messages; hidden progress, keyset and byte budget', () => {
  const f = fixture();
  try {
    const report = [];
    for (const count of [1, 100, 1000, 10000]) {
      const thread = f.bot.create('owner', 'bot', `Scale ${count}`);
      f.store.db.transaction(() => {
        for (let n = 0; n < count; n++) f.bot.append(thread.id, n % 2 ? 'user' : 'assistant', 'text', `message ${n}: **fixture**`);
        for (let n = 0; n < 60; n++) f.bot.append(thread.id, 'assistant', 'progress', `progress ${n}`);
      })();
      const snapshot = f.history.snapshot(thread.id);
      assert.equal(snapshot.messages.length, Math.min(count, 50));
      assert.equal(snapshot.hasOlder, count > 50);
      assert.ok(snapshot.messages.every(message => message.kind !== 'progress'));
      assert.equal(snapshot.messages.at(-1).seq, count);
      assert.equal(snapshot.eventCursor, f.history.cursor(thread.id));
      const all = [...snapshot.messages]; let page = snapshot;
      while (page.hasOlder) {
        page = f.history.page(thread.id, page.nextBeforeSeq);
        assert.ok(page.messages.length && page.messages.at(-1).seq < all[0].seq);
        all.unshift(...page.messages);
      }
      assert.equal(all.length, count);
      assert.equal(new Set(all.map(message => message.id)).size, count);
      const legacy = f.store.db.prepare('SELECT id,thread_id AS threadId,client_nonce AS clientNonce,seq,role,kind,content,reply_to AS replyTo,created_at AS createdAt FROM messages WHERE thread_id=? ORDER BY seq').all(thread.id);
      report.push({ history: count, firstPage: snapshot.messages.length, snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)), legacyMessagesBytes: Buffer.byteLength(JSON.stringify(legacy)) });
    }
    const large = f.bot.create('owner', 'bot', 'Byte budget');
    for (let n = 0; n < 12; n++) f.bot.append(large.id, 'assistant', 'text', '长'.repeat(100_000));
    const page = f.history.snapshot(large.id);
    assert.equal(page.messages.length, 1);
    assert.equal(page.messages[0].content.length, 100_000);
    assert.equal(page.hasOlder, true);
    console.log('Deterministic payload baseline (not latency benchmark):', JSON.stringify(report));
  } finally { f.close(); }
});

test('persistent invalidations are atomic, survive reopen, cover old active runs and resolved history cards', () => {
  const f = fixture();
  try {
    const questionMessage = f.bot.append(f.thread.id, 'assistant', 'question', 'Question');
    const approvalMessage = f.bot.append(f.thread.id, 'assistant', 'approval', 'Approval');
    f.store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES('old',?,'bot','waiting_event',?)").run(f.thread.id, at);
    for (let n = 0; n < 25; n++) f.store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','completed',?)").run(`recent-${n}`, f.thread.id, '2026-11-02');
    f.store.db.prepare("INSERT INTO run_questions(id,run_id,message_id,status,created_at) VALUES('q','old',?,'pending',?)").run(questionMessage.id, at);
    f.store.db.prepare("INSERT INTO approvals(id,thread_id,message_id,run_id,status,created_at) VALUES('a',?,?,'old','pending',?)").run(f.thread.id, approvalMessage.id, at);
    const start = f.history.cursor(f.thread.id);
    assert.throws(() => f.store.db.transaction(() => {
      f.store.db.prepare("UPDATE runs SET status='completed' WHERE id='old'").run();
      throw new Error('rollback');
    })());
    assert.equal(f.history.cursor(f.thread.id), start);
    assert.equal(f.history.snapshot(f.thread.id).running, true, 'older active run is not hidden by latest 20');
    f.store.db.prepare("UPDATE approvals SET status='approved' WHERE id='a'").run();
    f.store.db.prepare("UPDATE run_questions SET status='answered' WHERE id='q'").run();
    f.store.db.prepare("UPDATE runs SET status='completed' WHERE id='old'").run();
    f.store.db.prepare("UPDATE threads SET archived=1,title='Renamed' WHERE id=?").run(f.thread.id);
    assert.equal(f.history.cursor(f.thread.id), start + 4);
    assert.equal(f.history.state(f.thread.id).running, false);
    assert.equal(f.history.state(f.thread.id).thread.archived, true);
    const page = f.history.page(f.thread.id);
    assert.equal(page.approvals[0].status, 'approved');
    assert.equal(page.questions[0].status, 'answered');
    const second = new DatabaseStore(f.filename);
    assert.equal(new BotMessageHistory(second).cursor(f.thread.id), start + 4);
    second.close();
  } finally { f.close(); }
});

test('nonce identity merge handles POST/SSE either way, duplicates, updates and history overlap', () => {
  const base = { threadId: 't', clientNonce: 'nonce', seq: 1, role: 'user', kind: 'text', content: 'hello', createdAt: at, replyTo: null };
  const pending = { ...base, id: 'pending-nonce', seq: Number.MAX_SAFE_INTEGER };
  const accepted = { ...base, id: 'saved' };
  const settled = mergeMessages([pending], [accepted]);
  assert.deepEqual(settled, [accepted]);
  assert.equal(mergeMessages(settled, [{ ...accepted }]), settled);
  const updated = { ...accepted, content: 'changed' };
  assert.deepEqual(mergeMessages(settled, [updated]), [updated]);
  const older = { ...base, clientNonce: null, seq: 0, id: 'older' };
  const history = mergeMessages(settled, [older, accepted]);
  assert.deepEqual(history.map(message => message.id), ['older', 'saved']);
  assert.equal(history[1], accepted);
  const state = [{ id: 'a', status: 'pending' }];
  assert.equal(mergeById(state, [{ ...state[0] }]), state);
  const resolved = mergeById(state, [{ id: 'a', status: 'approved' }]);
  assert.equal(mergeById(resolved, state), resolved, 'late pending state cannot undo a resolved approval');
  assert.equal(mergeById([{ id: 'q', status: 'answered' }], [{ id: 'q', status: 'pending' }])[0].status, 'answered');
});

test('derived rows reuse unaffected identities; shared image URLs keep active references alive and clear on logout', async () => {
  const group = createMessageGrouper();
  const message = { id: 'one', threadId: 't', clientNonce: null, seq: 1, role: 'assistant', kind: 'text', content: 'hello', createdAt: at, replyTo: null };
  const first = group([message], 'zh-CN');
  const same = group([message], 'zh-CN'); assert.equal(same[0], first[0]);
  const appended = group([message, { ...message, id: 'two', role: 'user', seq: 2 }], 'zh-CN');
  assert.equal(appended[0], first[0], 'unaffected sender group is not rerendered');
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; return new Response(new Blob(['image'], { type: 'image/png' })); };
    const a = acquireBotImage('https://fixture.invalid/image');
    const b = acquireBotImage('https://fixture.invalid/image');
    const source = await a.promise;
    assert.equal(await b.promise, source); assert.equal(calls, 1);
    a.release(); assert.equal((await original(source)).status, 200);
    b.release();
    const reused = acquireBotImage('https://fixture.invalid/image');
    assert.equal(await reused.promise, source); assert.equal(calls, 1, 'remounting does not reload a retained image');
    invalidateBotImage('https://fixture.invalid/image'); reused.release();
    const retried = acquireBotImage('https://fixture.invalid/image');
    assert.notEqual(await retried.promise, source);
    retried.release(); clearBotImageCache();
    await assert.rejects(original(source), /fetch failed/);
  } finally { clearBotImageCache(); globalThis.fetch = original; }
});

test('one durable stream replays the snapshot gap, follows other-store writes, respects backpressure and cleans up', async () => {
  const f = fixture();
  class Response extends EventEmitter {
    frames = []; writableEnded = false; blocked = false;
    write(frame) { this.frames.push(frame); return !this.blocked; }
    end() { this.writableEnded = true; this.emit('close'); }
  }
  const streams = new BotMessageStreams(f.store);
  let second;
  try {
    f.bot.append(f.thread.id, 'assistant', 'text', 'before');
    const snapshot = f.history.snapshot(f.thread.id);
    const gap = f.bot.append(f.thread.id, 'assistant', 'text', 'between snapshot and subscribe');
    const response = new Response(); let allowed = true;
    streams.add(f.thread.id, snapshot.eventCursor, response, () => allowed);
    assert.ok(response.frames.join('').includes(gap.id));
    assert.equal(response.frames.join('').includes('"content":"before"'), false);
    second = new DatabaseStore(f.filename);
    const other = new BotApplicationService(second, { enqueue() {} });
    response.blocked = true;
    const blocked = other.append(f.thread.id, 'assistant', 'text', 'blocked');
    const waiting = other.append(f.thread.id, 'assistant', 'text', 'waiting for drain');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(response.frames.join('').includes(blocked.id));
    assert.equal(response.frames.join('').includes(waiting.id), false);
    response.blocked = false; response.emit('drain');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.ok(response.frames.join('').includes(waiting.id));
    allowed = false;
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal(response.writableEnded, true);
    streams.close();
  } finally { streams.close(); second?.close(); f.close(); }
});

test('SSE parser: byte-split UTF-8/CRLF, multiline data, heartbeats, callback failure and malformed payload', async () => {
  const original = globalThis.fetch;
  const message = { id: 'm', threadId: 't', seq: 1, role: 'assistant', kind: 'text', content: '你好', createdAt: at, replyTo: null, clientNonce: null };
  const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\nid: 7\r\nevent: message.accepted\r\ndata: {"message":\r\ndata: ${JSON.stringify(message)}}\r\n\r\n`);
  try {
    globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
    const events = [];
    await serverClient.events('t', 3, (event, cursor) => events.push({ event, cursor }));
    assert.equal(events.length, 1);
    assert.equal(events[0].cursor, 7);
    assert.equal(events[0].event.message.content, '你好');
    await assert.rejects(serverClient.events('t', 3, () => { throw new Error('consumer failed'); }), /consumer failed/);
    globalThis.fetch = async () => new Response('id: 8\nevent: message.accepted\ndata: {bad}\n\n');
    await assert.rejects(serverClient.events('t', 7, () => assert.fail('bad event applied')), /invalid_sync_event/);
    globalThis.fetch = async () => new Response('id: 8\nevent: message.accepted\ndata: {"message":{}}\n\n');
    await assert.rejects(serverClient.events('t', 7, () => assert.fail('invalid message applied')), /invalid_sync_event/);
  } finally { globalThis.fetch = original; }
});

test('HTTP authorization, cursor validation, paged summaries, live stream replay, future cursor and logout', async () => {
  const root = fs.mkdtempSync(path.join(temporary, 'bot-sync-api-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: root, FILES_DIR: path.join(root, 'files'), BOOTSTRAP_SECRET_FILE: path.join(root, 'config/bootstrap-secret') });
  const { buildServer } = await import('../apps/api/src/server.ts');
  const app = buildServer({ dbPath: path.join(root, 'db.sqlite') });
  let store;
  const controllers = [];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'bot-sync-test-password' } });
    assert.equal(initialized.statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'bot-sync-test-password' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    const request = (url, method = 'GET', payload) => app.inject({ method, url: `/api/v1${url}`, headers: { cookie }, payload });
    const owner = login.json().user.id;
    assert.equal((await request('/bootstrap/status')).json().botSyncVersion, 1);
    store = new DatabaseStore(path.join(root, 'db.sqlite'));
    const bot = new BotApplicationService(store, { enqueue() {} });
    const threads = Array.from({ length: 120 }, (_, n) => bot.create(owner, 'bot', `Thread ${n}`));
    const thread = threads[0];
    for (let n = 0; n < 100; n++) bot.append(thread.id, 'assistant', 'text', `message ${n}`);
    const snapshot = (await request(`/threads/${thread.id}/snapshot`)).json();
    assert.equal(snapshot.messages.length, 50);
    assert.equal((await request(`/threads/${thread.id}/messages?beforeSeq=${snapshot.nextBeforeSeq}`)).json().messages.length, 50);
    for (const suffix of ['snapshot', 'messages', 'sync-state', 'stream']) assert.equal((await app.inject(`/api/v1/threads/${thread.id}/${suffix}`)).statusCode, 401);
    for (const query of ['beforeSeq=no', 'beforeSeq=-1', 'beforeSeq=0', 'limit=101', 'limit=0']) assert.equal((await request(`/threads/${thread.id}/messages?${query}`)).statusCode, 400);
    assert.equal((await request(`/threads/${thread.id}/stream?after=no`)).statusCode, 400);
    assert.equal((await request('/threads/page?cursor=no')).statusCode, 400);
    const seen = new Set(); let cursor;
    do {
      const page = (await request(`/threads/page${cursor ? `?cursor=${cursor}` : ''}`)).json();
      assert.ok(page.threads.length <= 50);
      for (const item of page.threads) { assert.equal(seen.has(item.id), false); seen.add(item.id); }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 120);
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('other', 'Other', at);
    const foreign = bot.create('other', 'bot', 'Private');
    for (const suffix of ['summary', 'snapshot', 'messages', 'sync-state', 'stream']) assert.equal((await request(`/threads/${foreign.id}/${suffix}`)).statusCode, 404);
    const gap = bot.append(thread.id, 'assistant', 'text', 'snapshot gap');
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${origin}/api/v1/threads/${thread.id}/stream?after=${snapshot.eventCursor}`, { headers: { cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let text = '';
    const until = async predicate => {
      const timeout = setTimeout(() => controller.abort(), 5000);
      try { while (!predicate()) { const chunk = await reader.read(); if (chunk.done) return; text += decoder.decode(chunk.value, { stream: true }); } }
      finally { clearTimeout(timeout); }
    };
    await until(() => text.includes(gap.id));
    assert.ok(text.includes(gap.id), 'message committed in snapshot/subscribe gap is replayed');
    bot.append(thread.id, 'assistant', 'text', 'live append');
    await until(() => text.includes('live append'));
    assert.ok(text.includes('live append'));
    const future = await fetch(`${origin}/api/v1/threads/${thread.id}/stream?after=${Number.MAX_SAFE_INTEGER}`, { headers: { cookie } });
    assert.match(await future.text(), /resync.required/);
    assert.equal((await request('/auth/logout', 'POST')).statusCode, 200);
    let ended = false;
    const timeout = setTimeout(() => controller.abort(), 5000);
    try { while (!ended) ended = (await reader.read()).done; } finally { clearTimeout(timeout); }
    assert.equal(ended, true, 'revoked session closes its existing stream');
    reader.releaseLock();
  } finally { for (const controller of controllers) controller.abort(); store?.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
