import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Deliberately run with plain node, not tsx: production cannot execute Host decorators from TS.
const root = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const directory = fs.mkdtempSync(path.join(root, 'runtime-build-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/dist/apps/api/src/server.js');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
try {
  await app.ready();
  const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'runtime-build-password-123' } });
  assert.equal(bootstrap.statusCode, 201, bootstrap.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'runtime-build-password-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const response = await app.inject({ method: 'POST', url: '/api/clientRuntime/read', headers: { cookie }, payload: {
    type: 'client-request', rpcId: 'build-smoke', method: 'clientRuntime/read', payload: { args: { request: { kind: 'catalog' } } },
  } });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().result.ok, true, response.body);
  assert.equal(response.json().result.value.type, 'snapshot');
  console.log('PASS: plain Node compiled API + compiled decorated Host + generated codec dispatch');
} finally { await app.close(); }
