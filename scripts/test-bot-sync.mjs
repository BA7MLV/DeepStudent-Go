import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { BotMessageHistory } from '../apps/api/src/agent/message-history.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';
import { fixtureRemote } from './fixture-remote.mjs';
import { publishBotEvent } from '../apps/api/src/agent/events.ts';
import { UsageLedger } from '../apps/api/src/agent/budget.ts';
import { mergeMessages, mergeById } from '../apps/web/src/pages/botMessageCache.ts';
import { serverClient } from '../apps/web/src/api/serverClient.ts';
import { isBotActivity } from '@wangke/contracts';
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

test('activity uses durable model/tool facts, handles parallel calls, approvals and terminal states without leaking arguments', () => {
  const f = fixture();
  try {
    const db = f.store.db;
    db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES('activity',?,'bot','queued',?)").run(f.thread.id, at);
    assert.equal(f.history.snapshot(f.thread.id).activity.phase, 'queued');
    db.prepare("UPDATE runs SET status='running' WHERE id='activity'").run();
    const ledger = new UsageLedger(f.store);
    const request = ledger.reserve({ owner: 'owner', run: 'activity', purpose: 'bot', provider: 'fixture', model: 'fixture' }, 1, 100);
    assert.equal(f.history.snapshot(f.thread.id).activity.phase, 'model');
    ledger.settle(request, 'completed');
    assert.equal(f.history.snapshot(f.thread.id).activity.phase, 'running');
    for (let n = 0; n < 6; n++) db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,'activity',?,?,'running',?)").run(`step-${n}`, `tool-${n}`, '{"secret":"do-not-expose"}', at);
    publishBotEvent(f.store, { owner: 'owner', run: 'activity', step: 'step-0', type: 'tool.started' });
    const snapshot = f.history.snapshot(f.thread.id);
    assert.equal(snapshot.activity.phase, 'tools');
    assert.equal(snapshot.activity.activeTools, 6);
    assert.equal(snapshot.activity.tools.length, 4, 'bounded names with exact active count');
    assert.equal(JSON.stringify(snapshot.activity).includes('do-not-expose'), false);
    db.prepare("UPDATE run_steps SET status='completed',result='private output' WHERE id='step-0'").run();
    publishBotEvent(f.store, { owner: 'owner', run: 'activity', step: 'step-0', type: 'tool.finished' });
    assert.equal(f.history.state(f.thread.id).activity.activeTools, 5);
    assert.equal(f.history.state(f.thread.id).activity.completedTools, 1);
    f.bot.append(f.thread.id, 'assistant', 'progress', 'I claim everything is done');
    assert.equal(f.history.state(f.thread.id).activity.activeTools, 5, 'narration cannot override execution facts');
    db.prepare("UPDATE runs SET status='waiting_user' WHERE id='activity'").run();
    assert.equal(f.history.state(f.thread.id).activity.phase, 'waiting_user');
    assert.equal(f.history.state(f.thread.id).activity.activeTools, 0, 'suspended calls are not displayed as executing');
    db.prepare("UPDATE runs SET status='waiting_event' WHERE id='activity'").run();
    assert.equal(f.history.state(f.thread.id).activity.phase, 'waiting_event');
    for (const status of ['completed', 'cancelled', 'failed', 'paused']) {
      db.prepare('UPDATE runs SET status=? WHERE id=\'activity\'').run(status);
      publishBotEvent(f.store, { owner: 'owner', run: 'activity', type: 'run.finished', status });
      assert.equal(f.history.state(f.thread.id).activity, null);
    }
    const events = db.prepare("SELECT payload FROM message_events WHERE thread_id=? AND type='thread.activity' ORDER BY event_id").all(f.thread.id);
    assert.ok(events.length >= 8);
    assert.equal(JSON.parse(events.at(-1).payload).activity, null);
    assert.ok(events.every(event => !/do-not-expose|private output/.test(event.payload)));
    const cursor = f.history.cursor(f.thread.id);
    publishBotEvent(f.store, { owner: 'someone-else', run: 'activity', type: 'tool.started' });
    assert.equal(f.history.cursor(f.thread.id), cursor, 'owner mismatch cannot publish to a thread');
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
  const domain = new ClientRuntimeDomain(f.store, undefined);
  const control = new AbortController();
  let second;
  try {
    f.bot.append(f.thread.id, 'assistant', 'text', 'before');
    const snapshot = f.history.snapshot(f.thread.id);
    const gap = f.bot.append(f.thread.id, 'assistant', 'text', 'between snapshot and subscribe');
    const stream = domain.watchBot('owner', f.thread.id, snapshot.eventCursor, control.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value.type, 'ready');
    const replayed = (await stream.next()).value;
    assert.equal(replayed.event.message.id, gap.id);
    assert.notEqual(replayed.event.message.content, 'before');
    second = new DatabaseStore(f.filename);
    const other = new BotApplicationService(second, { enqueue() {} });
    const blocked = other.append(f.thread.id, 'assistant', 'text', 'blocked');
    const waiting = other.append(f.thread.id, 'assistant', 'text', 'waiting for drain');
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await stream.next()).value.event.message.id, blocked.id);
    // No request for the next item: the bounded generator is backpressured.
    assert.equal(domain.diagnostics().subscriptions, 1);
    await new Promise(resolve => setTimeout(resolve, 350));
    assert.equal((await stream.next()).value.event.message.id, waiting.id);
    control.abort();
    assert.equal((await stream.next()).done, true);
    assert.equal(domain.diagnostics().subscriptions, 0);
  } finally { control.abort(); domain.close(); second?.close(); f.close(); }
});

test('Web SSE parser is retired; shared activity validation still rejects malformed facts', () => {
  assert.equal(Object.hasOwn(serverClient, 'events'), false);
  // Carrier framing/replay/malformed codec tests now belong to the real typed
  // HTTP/WS suite (test-client-runtime), not an unused browser SSE implementation.
  const activity = { phase: 'tools', tools: [{ id: 's', name: 'read' }], activeTools: 1, completedTools: 2 };
  assert.equal(isBotActivity(activity), true);
  for (const invalid of [undefined, {}, { ...activity, activeTools: -1 }, { ...activity, completedTools: 1.5 }, { ...activity, tools: [{ id: 's', name: 7 }] }]) assert.equal(isBotActivity(invalid), false);
});

test('HTTP authorization, cursor validation, paged summaries, live stream replay, future cursor and logout', async () => {
  const root = fs.mkdtempSync(path.join(temporary, 'bot-sync-api-'));
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: root, FILES_DIR: path.join(root, 'files'), BOOTSTRAP_SECRET_FILE: path.join(root, 'config/bootstrap-secret') });
  const { buildServer } = await import('../apps/api/src/server.ts');
  const app = buildServer({ dbPath: path.join(root, 'db.sqlite') });
  let store, remote;
  const controllers = [];
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    const origin = `http://127.0.0.1:${app.server.address().port}`;
    const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'bot-sync-test-password' } });
    assert.equal(initialized.statusCode, 201);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'bot-sync-test-password' } });
    const cookie = login.headers['set-cookie'].split(';')[0];
    remote = await fixtureRemote(origin, { cookie });
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
    for (const suffix of ['snapshot', 'messages', 'sync-state']) assert.equal((await app.inject(`/api/v1/threads/${thread.id}/${suffix}`)).statusCode, 401);
    for (const query of ['beforeSeq=no', 'beforeSeq=-1', 'beforeSeq=0', 'limit=101', 'limit=0']) assert.equal((await request(`/threads/${thread.id}/messages?${query}`)).statusCode, 400);
    const invalid = remote.client.watchBot(thread.id, -1, new AbortController().signal)[Symbol.asyncIterator]();
    await assert.rejects(invalid.next());
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
    for (const suffix of ['summary', 'snapshot', 'messages', 'sync-state']) assert.equal((await request(`/threads/${foreign.id}/${suffix}`)).statusCode, 404);
    await assert.rejects(remote.client.watchBot(foreign.id, 0, new AbortController().signal)[Symbol.asyncIterator]().next());
    const gap = bot.append(thread.id, 'assistant', 'text', 'snapshot gap');
    const controller = new AbortController(); controllers.push(controller);
    const stream = remote.client.watchBot(thread.id, snapshot.eventCursor, controller.signal)[Symbol.asyncIterator]();
    assert.equal((await stream.next()).value.type, 'ready');
    assert.equal((await stream.next()).value.event.message.id, gap.id, 'message committed in snapshot/subscribe gap is replayed');
    bot.append(thread.id, 'assistant', 'text', 'live append');
    assert.equal((await stream.next()).value.event.message.content, 'live append');
    const future = remote.client.watchBot(thread.id, Number.MAX_SAFE_INTEGER, controller.signal)[Symbol.asyncIterator]();
    assert.equal((await future.next()).value.event.type, 'resync.required');
    await future.return?.();
    assert.equal((await request('/auth/logout', 'POST')).statusCode, 200);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try { await assert.rejects(stream.next(), 'revoked session closes its existing stream'); } finally { clearTimeout(timeout); }
  } finally { for (const controller of controllers) controller.abort(); await remote?.close(); store?.close(); await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
