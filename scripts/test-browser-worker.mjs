import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildServer } from '../apps/api/src/server.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { workerTokens, workerIdentity } from '../apps/api/src/cloud/workerAuth.js';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { createExecutorRuntime } from '@wangke/client-core';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-browser-worker-'));
const dbPath = path.join(dir, 'db.sqlite');
const filesDir = path.join(dir, 'files');
fs.mkdirSync(filesDir);
const app = buildServer({ dbPath, filesDir });
const store = new DatabaseStore(dbPath);
const runner = new CloudTaskRunner(store);
const owner = crypto.randomUUID(), other = crypto.randomUUID(), now = new Date().toISOString();
const token = crypto.randomBytes(32).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
try {
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, now);
  store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
    .run(crypto.randomUUID(), owner, hash(token), now, new Date(Date.now() + 60_000).toISOString());
  const taskId = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(taskId, owner, taskId, 'transcribe', 'course:one', JSON.stringify({ videoId: 'one' }), 'queued', 'browser', now, now);
   const origin = await app.listen({host:'127.0.0.1',port:0});
  runner.start('http://127.0.0.1:1');
  const auth = { cookie: `wangke_session=${encodeURIComponent(token)}` };
  const claim = await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth });
  assert.equal(claim.statusCode, 200);
  const claimed = claim.json();
  assert.equal(claimed.task.id, taskId);
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId).status, 'running');
  assert.ok(workerTokens.has(claimed.token));
  assert.ok(workerIdentity({ headers: { authorization: `Bearer ${claimed.token}` } }));
  assert.equal(workerIdentity({ headers: { authorization: 'Bearer wrong' } }), undefined);
  const unrelatedWrite = await app.inject({ method: 'POST', url: '/api/v1/cloud/records',
    headers: { authorization: `Bearer ${claimed.token}` }, payload: { mutations: [{ id: crypto.randomUUID(),
      table: 'studyDays', key: '2026-11-03', before: null, after: { date: '2026-11-03', seconds: 60, updatedAt: Date.now() } }] } });
  assert.equal(unrelatedWrite.statusCode, 403, 'isolating browser queues must not widen executor authority');
  assert.equal(unrelatedWrite.json().error, 'worker_mutation_denied:studyDays:missing_permit');
  const executorAuth = { authorization: `Bearer ${claimed.token}` };
  const scopedPayload = { mutations: [{ id: crypto.randomUUID(), table: 'studyDays', key: '2026-11-03', before: null, after: { date: '2026-11-03', seconds: 60 } }] };
  const scopedUnrelatedWrite = await app.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/records`, headers: executorAuth, payload: scopedPayload });
  assert.equal(scopedUnrelatedWrite.statusCode, 403);
  assert.equal(scopedUnrelatedWrite.json().error, 'worker_mutation_denied:studyDays:missing_permit');
  const wrongTaskWrite = await app.inject({ method: 'POST', url: '/api/v1/cloud/tasks/another-task/records', headers: executorAuth, payload: scopedPayload });
  assert.equal(wrongTaskWrite.statusCode, 403);
  assert.equal(wrongTaskWrite.json().error, 'worker_scope_denied');
  const permittedRow = { id: 'segment-one', videoId: 'one', text: 'task scoped output' };
  const taskWrite = await app.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/records`, headers: executorAuth,
    payload: { mutations: [{ id: crypto.randomUUID(), table: 'segments', key: permittedRow.id, before: null, after: permittedRow }] } });
  assert.equal(taskWrite.statusCode, 200);
  const enqueue = (id, account, resource) => store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run(id, account, id, 'cover', resource, JSON.stringify({ videoId: resource.slice(7) }), 'queued', 'browser', now, now);
  enqueue('same-course', owner, 'course:one');
  enqueue('other-course', owner, 'course:two');
  enqueue('other-account', other, 'course:three');
  const second = await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth });
  assert.equal(second.statusCode, 200);
  assert.equal(second.json().task.id, 'other-course', 'same-course work cannot overlap');
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth })).statusCode, 204, 'global compute limit is shared with browsers');
  store.db.prepare("UPDATE cloud_tasks SET status='completed' WHERE id='other-course'").run();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth })).statusCode, 204, 'only another account or a locked course remains');

  store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), taskId);
  for (let i = 0; i < 30; i++) {
    if (store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId).status === 'queued') break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId).status, 'queued', 'expired lease is recovered without a server restart');
   const stale = await createExecutorRuntime(taskId,{interactions:'answer',transport:{fetch:(url,init)=>fetch(new URL(url,origin),{...init,headers:{...init?.headers,authorization:`Bearer ${claimed.token}`}})}});
   try { await assert.rejects(stale.report({}),error=>error.detail?.code==='worker_lease_expired','old host cannot renew a recovered lease'); }
   finally { await stale.dispose(); }
  const reclaimed = await app.inject({ method: 'POST', url: '/api/v1/cloud/worker/claim', headers: auth });
  assert.equal(reclaimed.statusCode, 200);
  assert.equal(reclaimed.json().task.id, taskId);
  assert.notEqual(reclaimed.json().token, claimed.token);
  console.log('Browser claim ownership, course serialization, global concurrency and expired-lease recovery checks passed');
} finally {
  await runner.close(); await app.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true });
}
