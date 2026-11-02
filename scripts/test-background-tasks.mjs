import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isActiveTask } from '../apps/web/src/cloud/activityStore.ts';

const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'background-tasks-api-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let store;
try {
  await app.ready();
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'background-tasks-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'background-tasks-password-123' } });
  assert.equal(login.statusCode, 200);
  const cookie = login.headers['set-cookie'].split(';')[0];
  const owner = login.json().user.id;
  const get = url => app.inject({ method: 'GET', url: `/api/v1/cloud${url}`, headers: { cookie } });
  const policy = (await get('/config')).json().policy;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const other = crypto.randomUUID(), at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other owner', at);
  store.db.prepare("INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES('task-agent',?,'小助手','assistant','',?,?)").run(owner, at, at);
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,agent_id,created_at,updated_at) VALUES('task-thread',?,'bot','task-agent',?,?)").run(owner, at, at);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES('task-run','task-thread','bot','completed',?)").run(at);
  const insert = (id, taskOwner, status, parent, input = {}) => store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, taskOwner, id, 'material', 'course:document', JSON.stringify({ videoId: 'document', format: 'pdf', ...input }), status, at, at, parent);
  insert('app-task', owner, 'queued', null, { source: { kind: 'bot', name: 'Forged' } });
  insert('bot-task', owner, 'waiting_user', 'task-run');
  insert('other-task', other, 'running', null);
  const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
  const records = new CloudRecords(store);
  for (const [user, name] of [[owner, '我的资料.pdf'], [other, '私密资料.pdf']]) {
    records.apply(user, [{ id: crypto.randomUUID(), table: 'videos', key: 'document', before: null, after: { id: 'document', name, kind: 'material', materialFormat: 'pdf' } }]);
  }
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/cloud/tasks' })).statusCode, 401);
  const response = await get('/tasks');
  assert.equal(response.statusCode, 200);
  const { tasks } = response.json();
  assert.deepEqual(tasks.map(task => task.id).sort(), ['app-task', 'bot-task']);
  assert.deepEqual(tasks.find(task => task.id === 'app-task').source, { kind: 'app' }, 'payload cannot forge Bot provenance');
  assert.deepEqual(tasks.find(task => task.id === 'bot-task').source, { kind: 'bot', name: '小助手' });
  assert.ok(tasks.every(task => task.resourceName === '我的资料.pdf'), 'resource names are owner scoped');
  assert.deepEqual((await get('/tasks/bot-task')).json().source, { kind: 'bot' }, 'individual task retains provenance without a display-name join');
  store.db.prepare("UPDATE threads SET agent_id=NULL WHERE id='task-thread'").run();
  assert.deepEqual((await get('/tasks')).json().tasks.find(task => task.id === 'bot-task').source, { kind: 'bot' }, 'missing profile never turns a Bot task into an app task');
  for (const status of ['queued', 'running', 'waiting_user', 'completed', 'failed', 'cancelled', 'interrupted']) {
    assert.equal(isActiveTask({ status }), ['queued', 'running', 'waiting_user'].includes(status), status);
  }
  const cancel = await app.inject({ method: 'POST', url: '/api/v1/cloud/tasks/app-task/cancel', headers: { cookie } });
  assert.equal(cancel.statusCode, 200);
  assert.equal((await get('/tasks/app-task')).json().status, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/cloud/tasks/other-task/cancel', headers: { cookie } })).statusCode, 404);
  assert.deepEqual((await get('/config')).json().policy, policy, 'task management does not change saved permissions');
  console.log('Background tasks API passed: authoritative provenance, profile fallback, owner isolation, resource names, status grouping, cancellation, unchanged permissions.');
} finally {
  await app.close();
  store?.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
