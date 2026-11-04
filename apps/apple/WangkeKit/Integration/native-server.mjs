// Native-owned integration fixture. Real Fastify/Host/DSH + SQLite; no models/IM.
// Run from the repository root: node --import tsx apps/apple/WangkeKit/Integration/native-server.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { TYPERT_REMOTE } from '../../../../packages/remote-artifacts/generated/typert.remote-client.js';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const evidence = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/native-remote-'));
const secret = crypto.randomUUID();
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: evidence,
  FILES_DIR: path.join(evidence, 'files'), BOOTSTRAP_SECRET_FILE: path.join(evidence, 'bootstrap-secret') });
const { buildServer } = await import('../../../../apps/api/src/server.ts');
const { DatabaseStore } = await import('../../../../apps/api/src/storage/database.ts');
const { BotApplicationService } = await import('../../../../apps/api/src/agent/service.ts');
const { BotMessageHistory } = await import('../../../../apps/api/src/agent/message-history.ts');
const dbPath = path.join(evidence, 'db.sqlite');
const app = buildServer({ dbPath });
const store = new DatabaseStore(dbPath);
const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
const history = new BotMessageHistory(store);
const sockets = new Set();
let upgrades = 0, businessRequests = 0, race, hold, release, held = false;
const requests = [];
app.server.on('upgrade', (request, socket) => {
  if (request.url !== '/api/remote.mux') return;
  upgrades++; sockets.add(socket); socket.once('close', () => sockets.delete(socket));
});
app.addHook('onRequest', async request => {
  if (request.url.startsWith('/api/')) { businessRequests++; requests.push({ method: request.method, url: request.url }); }
});
app.addHook('onSend', async (request, _reply, payload) => {
  const match = /^\/api\/v1\/threads\/([^/]+)\/snapshot$/.exec(request.url);
  if (!match) return payload;
  if (race === match[1]) { race = undefined; bot.append(match[1], 'assistant', 'text', 'snapshot-open-race'); }
  if (hold === match[1]) {
    hold = undefined; held = true;
    await new Promise(resolve => { release = resolve; });
    held = false;
  }
  return payload;
});
app.post('/__native/control', async (request, reply) => {
  if (request.headers['x-native-control'] !== secret) return reply.code(403).send({ error: 'fixture_only' });
  const { action, thread, content } = request.body;
  switch (action) {
    case 'stats': return { upgrades, businessRequests, held, sockets: sockets.size };
    case 'append': bot.append(thread, 'assistant', 'text', content); break;
    case 'burst': for (let n = 0; n < 120; n++) bot.append(thread, 'assistant', 'text', `burst-${n}`); break;
    case 'arm-race': race = thread; break;
    case 'hold-snapshot': hold = thread; break;
    case 'release-snapshot': release?.(); release = undefined; break;
    case 'disconnect': for (const socket of sockets) socket.destroy(); break;
    case 'gap': {
      // Disconnect before committing beyond the follower's applied watermark.
      for (const socket of sockets) socket.destroy();
      bot.append(thread, 'assistant', 'text', 'gap-rebuilt');
      const owner = store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get(thread).owner_id;
      store.db.prepare('INSERT INTO client_journal_floors(owner_id,thread_id,cursor) VALUES(?,?,?) ON CONFLICT(owner_id,thread_id) DO UPDATE SET cursor=excluded.cursor').run(owner, thread, history.cursor(thread));
      break;
    }
    case 'expire':
      store.db.prepare("UPDATE api_tokens SET expires_at='2000-01-01T00:00:00.000Z'").run();
      store.db.prepare("UPDATE sessions SET expires_at='2000-01-01T00:00:00.000Z'").run();
      break;
    default: throw new Error(`Unknown fixture action: ${action}`);
  }
  return { ok: true };
});

let child;
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const init = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize',
    headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'native-fixture-password-123' } });
  assert.equal(init.statusCode, 201, init.body);
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('native-other-account', 'Other', new Date().toISOString());
  const other = bot.create('native-other-account', 'bot', 'Private');
  store.db.prepare('UPDATE threads SET id=? WHERE id=?').run('native-other-account-thread', other.id);

  const message = { id: 'm1', threadId: 'fixture', clientNonce: null, seq: 1, role: 'assistant', kind: 'text', content: 'updated', createdAt: new Date().toISOString(), replyTo: null };
  const codec = TYPERT_REMOTE.methods['clientRuntime/watchBot'].result.create();
  const frames = [ { type: 'ready', cursor: 7 },
    { type: 'event', cursor: 8, event: { type: 'message.accepted', message } },
    { type: 'event', cursor: 8, event: { type: 'message.updated', message: { ...message, content: 'duplicate-must-not-overwrite' } } },
    { type: 'event', cursor: 12, event: { type: 'thread.state_invalidated' } } ].map(frame => codec.parse(frame));
  const invalid = [{ type: 'ready', cursor: -1 }, { type: 'event', cursor: 8 }, { type: 'event', cursor: 8, event: { type: 'unknown' } },
    { type: 'event', cursor: 8, event: { type: 'message.accepted', message: { ...message, kind: 'not-a-kind' } } }].map(value => JSON.stringify(value));
  // DSH's codec allows any numeric cursor; native additionally enforces safe,
  // nonnegative applied positions as the actual Host requires on subscribe.
  for (const value of invalid.slice(1)) assert.equal(codec.safeParse(JSON.parse(value)).success, false);
  const fixturePath = path.join(evidence, 'generated-fixtures.json');
  const thread = { id: 'fixture', mode: 'bot', title: null, createdAt: message.createdAt, updatedAt: message.createdAt };
  const activity = { phase: 'tools', tools: [], activeTools: 0, completedTools: 3 };
  const states = [ { thread, approvals: [], running: true, activity, eventCursor: 20 },
    { thread, approvals: [], running: false, activity: null, eventCursor: 10 } ];
  fs.writeFileSync(fixturePath, JSON.stringify({ snapshot: { schemaVersion: 1, ...thread,
    messages: [], approvals: [], eventCursor: 7, hasOlder: false, activity: null }, frames, invalid, states }));
  // Validate the exact parameter wire names used by Swift against formal descriptors.
  assert.deepEqual(TYPERT_REMOTE.methods['clientRuntime/watchBot'].parameters.map(p => p.wire), ['threadId', 'after']);
  assert.deepEqual(TYPERT_REMOTE.methods['clientRuntime/receipt'].parameters.map(p => p.wire), ['operationId']);
  const log = fs.createWriteStream(path.join(evidence, 'swift-harness.log'));
  child = spawn('swift', ['run', '--package-path', path.join(root, 'apps/apple/WangkeKit'), 'NativeProtocolHarness', fixturePath],
    { cwd: root, env: { ...process.env, NSUnbufferedIO: 'YES', WANGKE_NATIVE_URL: base, WANGKE_NATIVE_CONTROL: secret }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', data => { process.stdout.write(data); log.write(data); });
  child.stderr.on('data', data => { process.stderr.write(data); log.write(data); });
  const timer = setTimeout(() => { child.kill('SIGTERM'); }, 120_000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer); log.end();
  fs.writeFileSync(path.join(evidence, 'requests.json'), JSON.stringify(requests, null, 2));
  assert.equal(requests.some(request => /\/(events|stream)(?:\?|$)/.test(request.url)), false, 'No old SSE endpoints');
  assert.equal(code, 0, `Swift harness failed; evidence: ${evidence}`);
  console.log(`PASS native integration; evidence: ${evidence}`);
} finally {
  release?.();
  if (child && child.exitCode === null) child.kill('SIGTERM');
  for (const socket of sockets) socket.destroy();
  await app.close(); store.close();
}
