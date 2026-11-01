import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { GatewayCore } from '../apps/api/src/gateway/core.ts';
import { registerGatewayRoutes } from '../apps/api/src/gateway/routes.ts';
import { IlinkPlugin } from '../apps/api/src/gateway/adapters/ilink.ts';
import { FeishuPlugin } from '../apps/api/src/gateway/adapters/feishu.ts';

const at = () => new Date().toISOString();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const message = (id, text = 'hello', patch = {}) => ({ messageId: id, tenant: 'tenant', peer: 'same-peer', chat: 'same-chat', topic: '', direct: true, human: true, text, context: 'private-context', ...patch });
const input = (botId, extra = {}) => ({ channel: 'ilink', agentId: 'owner-agent', enabled: true, config: { botId, botToken: `secret-${botId}` }, ...extra });
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-management-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const secrets = new CloudConfiguration(store, path.join(directory, 'config'));
  for (const owner of ['owner', 'other']) {
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, at());
    store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(`${owner}-agent`, owner, owner, 'study', 'Study', at(), at());
    secrets.save(owner, { ...secrets.get(owner, true), providers: [], llmModel: { providerId: '', model: '' } });
  }
  const contexts = new Map(), hooks = new Map(), sent = [];
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const factory = channel => account => ({
    manifest: channel === 'ilink' ? new IlinkPlugin(async () => {}).manifest : new FeishuPlugin(async () => {}).manifest,
    validate() {},
    async start(_config, context) { contexts.set(account.id, context); context.health('connected'); },
    async stop() { await hooks.get(account?.id)?.stop?.(); },
    async send(_config, peer, payload, id, signal) { sent.push({ account: account.id, peer, payload, id }); return await hooks.get(account.id)?.send?.(signal) ?? `sent-${id}`; },
    async download(_config, _message, _attachment, signal) { return hooks.get(account.id).download(signal); },
    async login(_config, _action, signal) { return hooks.get(account.id).login(signal); },
  });
  const gateway = new GatewayCore(store, secrets, bot, { ilink: factory('ilink'), feishu: factory('feishu') }, path.join(directory, 'files'));
  t.after(async () => { await gateway.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const bind = async id => {
    gateway.receive(id, [message('pair', gateway.pair('owner', id).command)]); await gateway.tick();
    return store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(id);
  };
  return { store, secrets, bot, gateway, contexts, hooks, sent, bind };
}

test('readiness distinguishes transport, owner binding, model, Bot and actionable failures', async t => {
  const { gateway, store, secrets, bot, bind } = fixture(t);
  const { id } = await gateway.save('owner', input('first'));
  const readiness = () => gateway.list('owner')[0].readiness;
  assert.equal(readiness().state, 'binding_required');
  gateway.receive(id, [message('unlinked')]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(store.db.prepare('SELECT error FROM gateway_inbox').get().error, 'binding_required');
  assert.ok(readiness().lastInboundAt);
  const binding = await bind(id);
  assert.equal(readiness().state, 'model_required');
  secrets.save('owner', { ...secrets.get('owner', true), providers: [{ id: 'model', name: 'Local model', baseUrl: 'http://localhost:1234/v1', apiKey: '', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'model', model: 'test' } });
  assert.equal(readiness().state, 'ready', 'local providers may have no API key; this is configuration readiness, not a network test');
  store.db.prepare('UPDATE agent_profiles SET enabled=0 WHERE id=?').run('owner-agent');
  assert.equal(readiness().state, 'bot_required');
  await gateway.save('owner', { ...input('first'), id, enabled: false });
  assert.equal(readiness().state, 'disabled', 'an account whose Bot is disabled can still be turned off');
  store.db.prepare('UPDATE agent_profiles SET enabled=1 WHERE id=?').run('owner-agent');
  await gateway.save('owner', { ...input('first'), id });
  bot.send('owner', binding.thread_id, { clientNonce: 'failed-run', content: 'question' });
  store.db.prepare("UPDATE runs SET status='failed',error_code='model_not_configured'").run();
  assert.equal(readiness().state, 'attention');
  assert.equal(readiness().latestRun.errorCode, 'model_not_configured');
  store.db.prepare("UPDATE runs SET status='completed',error_code=NULL").run();
  gateway.enqueue(binding.id, 'failed-reply', { text: 'reply' });
  store.db.prepare("UPDATE gateway_outbox SET status='uncertain' WHERE status='pending'").run();
  assert.equal(readiness().deliveryFailures, 1); assert.equal(readiness().state, 'attention');
  const delivery = store.db.prepare("SELECT id FROM gateway_outbox WHERE status='uncertain'").get();
  gateway.discard('owner', delivery.id);
  assert.equal(readiness().state, 'ready');
});

test('two bots on one server isolate cursors, dedupe, owner binding and conversations', async t => {
  const { gateway, store, contexts, bind, sent } = fixture(t);
  const first = (await gateway.save('owner', input('one'))).id;
  const second = (await gateway.save('owner', input('two'))).id;
  const b1 = await bind(first), b2 = await bind(second);
  assert.notEqual(b1.thread_id, b2.thread_id);
  contexts.get(first).receive([message('same-id', 'question for first')], 'cursor-first');
  contexts.get(second).receive([message('same-id', 'question for second')], 'cursor-second');
  await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 2);
  assert.equal(gateway.account('owner', first).cursor, 'cursor-first');
  assert.equal(gateway.account('owner', second).cursor, 'cursor-second');
  assert.match(JSON.stringify(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user'").all(b1.thread_id)), /question for first/);
  assert.match(JSON.stringify(store.db.prepare("SELECT content FROM messages WHERE thread_id=? AND role='user'").all(b2.thread_id)), /question for second/);
  const firstContext = contexts.get(first);
  await gateway.remove('owner', first);
  assert.equal(firstContext.signal.aborted, true);
  assert.equal(contexts.get(second).signal.aborted, false);
  assert.throws(() => firstContext.receive([message('stale')]), /abort/i);
  gateway.receive(second, [message('status-after-remove', '/status')]); await gateway.tick();
  assert.equal(sent.at(-1).account, second);
  assert.equal(gateway.list('owner').length, 1);
  assert.ok(store.db.prepare('SELECT 1 FROM threads WHERE id=?').get(b1.thread_id));
});

test('duplicate platform identities are rejected across owners, simultaneous saves and QR login', async t => {
  const { gateway, hooks } = fixture(t);
  const attempts = await Promise.allSettled([gateway.save('owner', input('same')), gateway.save('owner', input('same'))]);
  assert.equal(attempts.filter(r => r.status === 'fulfilled').length, 1);
  assert.match(attempts.find(r => r.status === 'rejected').reason.message, /duplicate_channel_account/);
  await assert.rejects(gateway.save('other', input('same', { agentId: 'other-agent' })), /duplicate_channel_account/);
  await assert.rejects(gateway.save('owner', input('different', { config: { botId: 'different', botToken: 'secret-same' } })), /duplicate_channel_account/);
  const blank = (await gateway.save('owner', input('', { config: {} }))).id;
  hooks.set(blank, { login: async () => ({ status: 'confirmed', botId: 'same', botToken: 'rotated-secret' }) });
  await assert.rejects(gateway.login('owner', blank, { action: 'poll', qrcode: 'test' }), /duplicate_channel_account/);
  assert.deepEqual(gateway.config(gateway.account('owner', blank)), {});
  const feishu = { channel: 'feishu', agentId: 'owner-agent', enabled: true, config: { appId: 'cli_one', appSecret: 'secret' } };
  await gateway.save('owner', feishu);
  await gateway.save('owner', { ...feishu, config: { appId: 'cli_two', appSecret: 'secret' } });
  await assert.rejects(gateway.save('owner', feishu), /duplicate_channel_account/);
});

test('remove fences active send, attachment and late login; cascades queues while preserving web history', async t => {
  const { gateway, store, bot, bind, hooks, contexts } = fixture(t);
  const { id } = await gateway.save('owner', input('remove'));
  const binding = await bind(id), context = contexts.get(id);
  bot.send('owner', binding.thread_id, { clientNonce: 'active', content: 'preserved question' });
  store.db.prepare('INSERT INTO bot_reminders(id,owner_id,thread_id,text,timezone,next_at,created_at) VALUES(?,?,?,?,?,?,?)').run('reminder', 'owner', binding.thread_id, 'review', 'UTC', Date.now() + 60000, at());
  gateway.pair('owner', id);
  gateway.enqueue(binding.id, 'send-in-flight', { text: 'reply' });
  const sending = deferred(), downloading = deferred(), login = deferred();
  const signals = {};
  hooks.set(id, {
    send: signal => { signals.send = signal; return sending.promise; },
    download: signal => { signals.download = signal; return downloading.promise; },
    login: signal => { signals.login = signal; return login.promise; },
  });
  gateway.receive(id, [message('media', 'read this', { attachments: [{ key: 'file', name: 'study.txt', mime: 'text/plain' }] })]);
  const tick = gateway.tick();
  const pendingLogin = gateway.login('owner', id, { action: 'poll', qrcode: 'late' });
  const loginRejected = assert.rejects(pendingLogin, /abort/i);
  assert.ok(signals.send && signals.download && signals.login);
  // Seed a projection failure as well: all gateway child rows must disappear.
  store.db.prepare('INSERT INTO gateway_projection_failures(binding_id,event_id,error,next_at) VALUES(?,?,?,?)').run(binding.id, 999999, 'projection_failed', Date.now() + 60000);
  await gateway.remove('owner', id);
  assert.ok(Object.values(signals).every(signal => signal.aborted));
  assert.equal(context.signal.aborted, true);
  for (const table of ['gateway_accounts', 'gateway_pairings', 'gateway_bindings', 'gateway_inbox', 'gateway_outbox', 'gateway_projection_failures']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.equal(store.db.prepare('SELECT status FROM bot_reminders').get().status, 'cancelled');
  assert.equal(store.db.prepare('SELECT status FROM runs').get().status, 'cancelled');
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM messages WHERE content='preserved question'").get().n, 1);
  sending.resolve('late-send'); downloading.resolve({ bytes: Buffer.from('late-file'), name: 'study.txt', mime: 'text/plain' });
  login.resolve({ status: 'confirmed', botId: 'remove', botToken: 'late-secret' });
  await tick; await loginRejected; await gateway.tick();
  context.health('connected'); context.updateConfig({ botToken: 'stale' });
  assert.deepEqual(gateway.list('owner'), []);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM files').get().n, 0);
  const replacement = await gateway.save('owner', input('remove'));
  assert.notEqual(replacement.id, id); assert.equal(gateway.list('owner')[0].readiness.bound, false);
});

test('legacy duplicates do not launch competing consumers; removal allows the survivor to reconnect', async t => {
  const { gateway, store, contexts } = fixture(t);
  const { id } = await gateway.save('owner', input('legacy'));
  await gateway.close();
  store.db.prepare('INSERT INTO gateway_accounts SELECT ?,owner_id,channel,agent_id,enabled,preset,config,cursor,health,created_at FROM gateway_accounts WHERE id=?').run('legacy-copy', id);
  contexts.clear(); gateway.start(false);
  assert.equal(contexts.size, 0);
  assert.ok(gateway.list('owner').every(a => a.connection.error.code === 'duplicate_channel_account'));
  await gateway.remove('owner', 'legacy-copy');
  await gateway.save('owner', { ...input('legacy'), id });
  assert.equal(contexts.size, 1); assert.equal(gateway.account('owner', id).health, 'connected');
});

test('DELETE endpoint enforces authentication, origin and ownership', async t => {
  const { gateway } = fixture(t);
  const { id } = await gateway.save('owner', input('http-delete'));
  const app = Fastify();
  registerGatewayRoutes(app, gateway, (r, p) => r.headers['x-owner'] ? { id: r.headers['x-owner'] } : (p.code(401).send(), null),
    (r, p) => r.headers.origin === 'https://test.invalid' || (p.code(403).send(), false));
  t.after(() => app.close());
  const request = headers => app.inject({ method: 'DELETE', url: `/api/v1/gateway/accounts/${id}`, headers });
  assert.equal((await request({ origin: 'https://test.invalid' })).statusCode, 401);
  assert.equal((await request({ origin: 'https://evil.invalid', 'x-owner': 'owner' })).statusCode, 403);
  assert.equal((await request({ origin: 'https://test.invalid', 'x-owner': 'other' })).json().error, 'account_not_found');
  assert.equal(gateway.list('owner').length, 1);
  assert.deepEqual((await request({ origin: 'https://test.invalid', 'x-owner': 'owner' })).json(), { removed: true });
  assert.equal(gateway.list('owner').length, 0);
});

test('WeChat welcomes only after manual pairing, without chat history, model context or runs', async t => {
  const { gateway, hooks, store, sent } = fixture(t);
  store.db.prepare('UPDATE users SET name=? WHERE id=?').run('小明', 'owner');
  const { id } = await gateway.save('owner', input('', { config: {} }));
  const pair = gateway.pair('owner', id);
  assert.match(pair.code, /^[0-9A-HJKMNP-TV-Z]{4}$/);
  hooks.set(id, { login: async () => ({ status: 'confirmed', botId: 'qr-bot', botToken: 'private-token', userId: 'scanner@im.wechat' }) });
  assert.deepEqual(await gateway.login('owner', id, { action: 'poll', qrcode: 'qr' }), { status: 'confirmed' });
  await gateway.tick(); await gateway.tick();
  assert.equal(gateway.list('owner')[0].readiness.state, 'binding_required', 'QR login alone never links or welcomes');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n, 0);
  gateway.receive(id, [message('ordinary-first-message'), message('bad-code', '/pair wrong'), message('group-code', pair.code, { direct: false }), message('robot-code', pair.code, { human: false })]); await gateway.tick();
  assert.equal(sent.length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  const pairing = message('manual-pair', ` ${pair.code.slice(0, 2).toLowerCase()}- ${pair.code.slice(2).toLowerCase()} `);
  gateway.receive(id, [pairing]); await gateway.tick();
  const binding = store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(id);
  assert.equal(binding.peer, pairing.peer); assert.equal(binding.chat, pairing.chat);
  assert.equal(gateway.secrets.open(binding.context), pairing.context);
  assert.equal(gateway.list('owner')[0].readiness.state, 'model_required');
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_pairings').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM message_events').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.text, '嗨，小明！我是 DeepStudent Go！');
  assert.match(sent[1].payload.text, /绑定成功/);
  assert.ok(sent.every(item => item.peer.peer === binding.peer && item.peer.context === 'private-context'));
  await gateway.login('owner', id, { action: 'poll', qrcode: 'again' });
  gateway.receive(id, [pairing, message('consumed-code', pair.command)]); await gateway.tick();
  await gateway.close(); gateway.start(false); await gateway.tick();
  assert.equal(sent.length, 2); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_outbox').get().n, 2, 're-login, replay and restart do not duplicate welcomes');
  gateway.receive(id, [message('first-question', '第一道题')]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n, 1, 'the first real question runs normally');
  assert.deepEqual(store.db.prepare('SELECT role,content FROM messages').all(), [{ role: 'user', content: '第一道题' }], 'pairing and onboarding never enter chat history/model context');
  gateway.revoke('owner', id, binding.id);
  gateway.receive(id, [message('revoked', 'hello')]); await gateway.tick();
  assert.equal(gateway.list('owner')[0].readiness.bound, false, 'a message cannot undo explicit unlinking');
  await gateway.login('owner', id, { action: 'poll', qrcode: 'explicit-relink' });
  assert.equal(gateway.list('owner')[0].readiness.bound, false, 'a new QR login also cannot undo unlinking');
  gateway.receive(id, [message('manual-relink', gateway.pair('owner', id).code)]); await gateway.tick();
  assert.equal(gateway.list('owner')[0].readiness.bound, true);
  assert.equal(store.db.prepare('SELECT thread_id FROM gateway_bindings').get().thread_id, binding.thread_id);
  assert.equal(sent.length, 4, 'an explicit manual rebind acknowledges success again');
});

test('renewed or expired codes never welcome; an already-linked account cannot be taken over', async t => {
  const { gateway, store, sent } = fixture(t);
  const { id } = await gateway.save('owner', input('manual'));
  const old = gateway.pair('owner', id), current = gateway.pair('owner', id);
  gateway.receive(id, [message('old-code', old.code)]); await gateway.tick();
  assert.equal(sent.length, 0);
  store.db.prepare('UPDATE gateway_pairings SET expires_at=?').run('2000-01-01T00:00:00.000Z');
  gateway.receive(id, [message('expired-code', current.code)]); await gateway.tick();
  assert.equal(sent.length, 0); assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings').get().n, 0);
  gateway.receive(id, [message('valid-code', gateway.pair('owner', id).code)]); await gateway.tick();
  const code = gateway.pair('owner', id);
  gateway.receive(id, [message('takeover', code.code, { peer: 'intruder' })]); await gateway.tick();
  assert.equal(sent.length, 2); assert.equal(store.db.prepare('SELECT peer FROM gateway_bindings').get().peer, 'same-peer');
  const feishu = (await gateway.save('owner', { channel: 'feishu', agentId: 'owner-agent', enabled: true, config: { appId: 'cli_manual', appSecret: 'secret' } })).id;
  gateway.receive(feishu, [message('feishu-unlinked')]); await gateway.tick();
  assert.equal(gateway.list('owner').find(a => a.id === feishu).readiness.bound, false);
  const feishuPair = gateway.pair('owner', feishu);
  assert.match(feishuPair.code, /^[0-9A-HJKMNP-TV-Z]{8}$/);
  gateway.receive(feishu, [message('feishu-pair', feishuPair.command)]); await gateway.tick();
  assert.equal(gateway.list('owner').find(a => a.id === feishu).readiness.bound, true, 'Feishu retains explicit pairing and its original acknowledgment');
  assert.match(sent.at(-1).payload.text, /^绑定成功/);
});

test('pairing and both welcome deliveries commit atomically, so failed onboarding never consumes the code', async t => {
  const { gateway, store, sent } = fixture(t);
  const { id } = await gateway.save('owner', input('atomic-welcome'));
  const pair = gateway.pair('owner', id);
  store.db.exec("CREATE TRIGGER fail_welcome BEFORE INSERT ON gateway_outbox WHEN (SELECT COUNT(*) FROM gateway_outbox)=1 BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
  gateway.receive(id, [message('failed-pair', pair.code)]); await gateway.tick();
  for (const table of ['gateway_bindings', 'gateway_outbox', 'threads', 'messages', 'runs']) assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_pairings').get().n, 1);
  assert.equal(sent.length, 0);
  store.db.exec('DROP TRIGGER fail_welcome');
  gateway.receive(id, [message('retry-pair', pair.code)]); await gateway.tick();
  assert.equal(gateway.list('owner')[0].readiness.bound, true); assert.equal(sent.length, 2);
});

test('bare WeChat codes stay account-scoped and revoked queued codes cannot restore a binding', async t => {
  const { gateway, store, sent } = fixture(t);
  const first = (await gateway.save('owner', input('bare-first'))).id;
  const second = (await gateway.save('owner', input('bare-second'))).id;
  const pair = gateway.pair('owner', first);
  const wrong = (pair.code[0] === '0' ? '1' : '0') + pair.code.slice(1);
  gateway.receive(second, [message('wrong-account', pair.code)]);
  gateway.receive(first, [message('wrong-code', wrong), message('extra-prose', `我的绑定码是 ${pair.code}`)]);
  await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings').get().n, 0);
  assert.equal(sent.length, 0);
  gateway.receive(first, [message('bare-valid', pair.code)]); await gateway.tick();
  const binding = store.db.prepare('SELECT * FROM gateway_bindings WHERE account_id=?').get(first);
  assert.equal(sent.length, 2);
  gateway.receive(first, [message('numeric-answer', '1234')]); await gateway.tick();
  assert.equal(store.db.prepare("SELECT content FROM messages WHERE role='user'").get().content, '1234', 'ordinary four-character answers are not swallowed after linking');
  const pending = gateway.pair('owner', first);
  gateway.receive(first, [message('queued-bare', pending.code), message('queued-command', pending.command)]);
  gateway.revoke('owner', first, binding.id);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM gateway_inbox WHERE status='cancelled' AND error='pairing_revoked'").get().n, 2);
  gateway.receive(first, [message('revoked-code', pending.code)]); await gateway.tick();
  assert.equal(gateway.list('owner').find(a => a.id === first).readiness.bound, false);
  assert.equal(sent.length, 2);
});

test('a current bare code is not merged into an earlier WeChat photo or text batch', async t => {
  const { gateway, store, bind, sent } = fixture(t);
  const id = (await gateway.save('owner', input('bare-boundary'))).id;
  await bind(id); // Legacy /pair commands continue to work.
  const pair = gateway.pair('owner', id);
  gateway.receive(id, [message('question-before-code', '先处理这个问题'), message('new-bare-code', pair.code)]);
  await gateway.tick(); await gateway.tick();
  assert.deepEqual(store.db.prepare("SELECT content FROM messages WHERE role='user'").all(), [{ content: '先处理这个问题' }]);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_pairings').get().n, 0);
  assert.equal(sent.length, 4, 'the explicit rebind receives its own acknowledgment');
});

test('four-character WeChat codes limit guesses across senders and restarts, without blocking other accounts', async t => {
  const { gateway, store, sent } = fixture(t);
  const id = (await gateway.save('owner', input('short-code'))).id;
  const pair = gateway.pair('owner', id);
  assert.equal(pair.code.length, 4);
  const wrong = (pair.code[0] === '0' ? '1' : '0') + pair.code.slice(1);
  for (let n = 0; n < 5; n++) {
    gateway.receive(id, [message(`wrong-${n}`, n % 2 ? `/pair ${wrong}` : wrong, { peer: `sender-${n}` })]);
    await gateway.tick();
  }
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_pairings WHERE account_id=?').get(id).n, 0);
  assert.equal(sent.length, 0);
  await gateway.close(); gateway.start(false); await gateway.tick();
  const renewed = gateway.pair('owner', id);
  gateway.receive(id, [message('throttled-correct-code', renewed.code)]); await gateway.tick();
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM gateway_bindings WHERE account_id=?').get(id).n, 0);
  const other = (await gateway.save('owner', input('short-other'))).id;
  gateway.receive(other, [message('other-valid-code', gateway.pair('owner', other).code)]); await gateway.tick();
  assert.equal(sent.length, 2, 'guess limiting is per account');
  store.db.prepare("UPDATE gateway_inbox SET received_at=? WHERE account_id=? AND error='invalid_pairing_code'").run(Date.now() - 11 * 60_000, id);
  gateway.receive(id, [message('after-cooldown', gateway.pair('owner', id).code)]); await gateway.tick();
  assert.equal(sent.length, 4);
  assert.equal(gateway.list('owner').find(a => a.id === id).readiness.bound, true);
});
