import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createClientRuntime } from '@wangke/client-core';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/task-admission-errors-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let runtime, store, domain;
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'task-admission-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'task-admission-password-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const configuration = new CloudConfiguration(store, directory);
  configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://never-called.invalid/v1', protocol: 'openai-chat', apiKey: 'fixture-only', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  new CloudRecords(store).apply(owner, [{ id: 'admission-errors-session', table: 'chatSessions', key: 900001, before: null, after: { id: 900001, title: 'Admission errors', createdAt: 1 } }]);
  runtime = await createClientRuntime({ server: base, account: owner, scope: 'account' }, { interactions: 'answer', transport: { fetch: (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init?.headers, cookie } }), streamBaseUrl: base } });
  const command = { operationId: 'task-admission-rejection-0001', kind: 'chat', resource: 'session:900001', input: { sessionId: 900001, text: '请你把这个变成 word。', modelSelection: { modelRef: { providerId: 'missing-provider', model: 'fixture' } } } };
  await assert.rejects(runtime.submitTask(command), error => {
    assert.equal(error.code, 'client/domain');
    assert.deepEqual(error.detail, { code: 'model_provider_not_found', admissionRejected: true }, 'wire adapter must retain the actual reason and rejection evidence');
    return true;
  });
  assert.deepEqual(await runtime.taskAdmission(command.operationId), { status: 'missing' }, 'rejected admission rolls back its task row');
  const config = configuration.get(owner);
  configuration.save(owner, { ...config, providers: [...config.providers, { ...config.providers[0], id: 'missing-provider' }] });
  const task = await runtime.submitTask(command);
  assert.equal((await runtime.submitTask(command)).id, task.id, 'repair retry returns the same durable task');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM cloud_tasks WHERE nonce=?').get(command.operationId).n, 1);
  await assert.rejects(runtime.submitTask({ ...command, input: { ...command.input, text: 'different' } }), error => error.code === 'client/conflict');
  // An earlier accepted task must never become a known rejection merely because
  // a subsequent admission attempt fails before returning that receipt.
  domain = new ClientRuntimeDomain(store, {}, () => { throw new Error('model_not_configured'); });
  await assert.rejects(domain.submitTask(owner, command), error => {
    assert.equal(error.details.code, 'model_not_configured');
    assert.equal(error.details.admissionRejected, undefined);
    return true;
  });
  console.log('PASS typed admission errors: concrete reason, transactional rejection, original-command repair, one task, accepted-task safety');
} finally { domain?.close(); await runtime?.dispose(); await app.close(); store?.close(); }
