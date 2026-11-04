import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { fixtureRemote } from './fixture-remote.mjs';
import { workerTokens } from '../apps/api/src/cloud/workerAuth.ts';
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/runtime-identities-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external requests forbidden'); } });
let remote;
const control = new AbortController();
try {
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'identity-test-password' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/token', payload: { password: 'identity-test-password', deviceName: 'isolated-test' } });
  assert.equal(login.statusCode, 201);
  const { token, user } = login.json();
  const authorization = `Bearer ${token}`;
  remote = await fixtureRemote(origin, { authorization });
  assert.equal((await remote.client.read({ kind: 'catalog' })).ok, true, 'account Bearer is not a Worker');
  assert.equal((await remote.executor.read('not-a-task')).ok, false, 'account cannot acquire task capability');
  const created = await app.inject({ method: 'POST', url: '/api/v1/threads', headers: { authorization }, payload: { mode: 'bot', title: 'Bearer journal' } });
  assert.equal(created.statusCode, 201);
  const stream = remote.client.watchBot(created.json().id, 0, control.signal)[Symbol.asyncIterator]();
  assert.equal((await stream.next()).value.type, 'ready', 'account Bearer admitted on real WS');
  const rpc = async (bearer, namespace = 'clientRuntime') => app.inject({ method: 'POST', url: `/api/${namespace}/read`, headers: { authorization: `Bearer ${bearer}` }, payload: { type: 'client-request', rpcId: crypto.randomUUID(), method: `${namespace}/read`, payload: { args: namespace === 'clientRuntime' ? { request: { kind: 'catalog' } } : { taskId: 'not-a-task' } } } });
  assert.equal((await rpc('invalid')).statusCode, 401);
  const worker = crypto.randomUUID();
  workerTokens.set(worker, { id: user.id, taskId: 'not-a-task', expiresAt: Date.now() + 60000 });
  assert.equal((await rpc(worker)).statusCode, 403, 'Worker cannot call account domain');
  const status = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${origin.replace('http', 'ws')}/api/remote.mux`, { headers: { authorization: `Bearer ${worker}` } });
    socket.once('open', () => { socket.close(); reject(new Error('Worker acquired account WS')); });
    socket.once('error', reject);
    socket.once('unexpected-response', (_req, response) => { response.resume(); socket.removeAllListeners('error'); socket.on('error', () => {}); socket.terminate(); resolve(response.statusCode); });
  });
  assert.equal(status, 403);
  workerTokens.get(worker).expiresAt = 0;
  assert.equal((await rpc(worker, 'executorRuntime')).statusCode, 401, 'expired Worker cannot fall through to account');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization } })).statusCode, 200);
  assert.equal((await rpc(token)).statusCode, 401, 'revoked account token rejected');
  const timer = setTimeout(() => control.abort(), 5000);
  try { await assert.rejects(stream.next(), 'revocation terminates existing account WS'); } finally { clearTimeout(timer); }
  workerTokens.delete(worker);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, checks: ['real account token HTTP+WS', 'invalid token', 'revoked token', 'revoked live WS', 'Worker/account separation', 'Worker WS rejection', 'expired Worker rejection'] }, null, 2));
  console.log(`PASS real token-class identity matrix (${directory})`);
} finally { control.abort(); await remote?.close(); await app.close(); }
