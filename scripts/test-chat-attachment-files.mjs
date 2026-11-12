/** Real Fastify routes + isolated files/SQLite; no browser, external API or model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/attachment-files-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('network forbidden'); } });
let store;
try {
  await app.ready();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'attachment-test-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'attachment-test-password-123' } });
  assert.equal(login.statusCode, 200);
  const cookie = [login.headers['set-cookie']].flat().map(value => value.split(';')[0]).join('; ');
  const owner = login.json().user.id;
  const bytes = await sharp({ create: { width: 900, height: 450, channels: 3, background: '#784321' } }).png().toBuffer();
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'original.png', 'x-file-mime': 'image/png' }, payload: bytes });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const file = uploaded.json();
  assert.ok(file.previewServerId); assert.equal(file.width, 900); assert.equal(file.height, 450);
  for (const id of [file.id, file.previewServerId]) {
    assert.equal((await app.inject({ url: `/api/v1/files/${id}` })).statusCode, 401);
    const response = await app.inject({ url: `/api/v1/files/${id}`, headers: { cookie } });
    assert.equal(response.statusCode, 200); assert.equal(response.headers['cache-control'], 'private, no-cache');
    assert.equal((await app.inject({ url: `/api/v1/files/${id}`, headers: { cookie, 'if-none-match': response.headers.etag } })).statusCode, 304);
    assert.equal((await app.inject({ url: `/api/v1/files/${id}`, headers: { 'if-none-match': response.headers.etag } })).statusCode, 401);
  }
  const original = await app.inject({ url: `/api/v1/files/${file.id}`, headers: { cookie } });
  assert.deepEqual(original.rawPayload, bytes);
  assert.ok(original.headers['content-disposition'].includes('attachment;'));
  const range = await app.inject({ url: `/api/v1/files/${file.id}`, headers: { cookie, range: 'bytes=0-9' } });
  assert.equal(range.statusCode, 206); assert.deepEqual(range.rawPayload, bytes.subarray(0, 10));
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const other = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, other, new Date().toISOString());
  store.db.prepare('UPDATE files SET owner_id=? WHERE id=?').run(other, file.id);
  assert.equal((await app.inject({ url: `/api/v1/files/${file.previewServerId}`, headers: { cookie } })).statusCode, 404, 'preview cannot outlive original authority');
  store.db.prepare('UPDATE files SET owner_id=? WHERE id=?').run(owner, file.id);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: 1, before: null, after: { id: 1, role: 'user', content: 'test', attachments: [{ id: 'file', serverId: file.id, ...file }] } }]);
  for (const id of [file.id, file.previewServerId]) {
    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/files/${id}`, headers: { cookie } });
    assert.equal(removed.statusCode, 409); assert.ok(removed.body.includes('file_in_use'));
  }
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: 1, before: records.get(owner, 'chats', 1), after: null }]);
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/files/${file.id}`, headers: { cookie } })).statusCode, 200);
  for (const id of [file.id, file.previewServerId]) assert.equal((await app.inject({ url: `/api/v1/files/${id}`, headers: { cookie } })).statusCode, 404);
  const pending = (await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'pending.png', 'x-file-mime': 'image/png' }, payload: bytes })).json();
  const taskId = crypto.randomUUID(), now = new Date().toISOString();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(taskId, owner, taskId, 'chat', 'session:1', JSON.stringify({ attachments: [{ serverId: pending.id }] }), 'queued', now, now);
  for (const id of [pending.id, pending.previewServerId]) assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/files/${id}`, headers: { cookie } })).statusCode, 409, 'accepted task guards originals before the first message is persisted');
  store.db.prepare('DELETE FROM cloud_tasks WHERE id=?').run(taskId);
  store.db.prepare('DELETE FROM files WHERE id=?').run(pending.id);
  assert.equal((await app.inject({ url: `/api/v1/files/${pending.previewServerId}`, headers: { cookie } })).statusCode, 404, 'original index revocation cascades preview authority');
  console.log('PASS attachment HTTP files: upload metadata, authenticated preview/original, revalidation auth, original bytes/ranges, committed deletion guard, draft cascade deletion');
} finally { store?.close(); await app.close(); fs.rmSync(directory, { recursive: true, force: true }); }
