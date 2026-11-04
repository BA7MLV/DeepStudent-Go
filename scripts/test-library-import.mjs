import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/library-import-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external request forbidden'); } });
let store;
try {
  await app.ready();
  const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'library-import-test-password' } });
  assert.equal(initialized.statusCode, 201, initialized.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'library-import-test-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0];
  const upload = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'cache-blob', 'x-file-mime': 'text/markdown' }, payload: Buffer.from('# Original source\nOriginal body') });
  assert.equal(upload.statusCode, 201, upload.body);
  const library = {
    sourceId: crypto.randomUUID(), courses: [{ id: 'legacy-course', name: 'Original', size: 31, mimeType: 'text/markdown', duration: 0, createdAt: 1, status: 'new', kind: 'material', materialFormat: 'md', folderId: 3 }],
    folders: [{ id: 3, name: 'Original folder', createdAt: 1 }],
    files: [{ id: 'legacy-course', blob: { $file: upload.json().id, type: 'text/markdown' } }],
    segments: [], tracks: [], blocks: [], frames: [], covers: [], handouts: [], cards: [], comments: [], danmakus: [],
    sessions: [{ id: 7, videoId: '', title: 'Original conversation', createdAt: 1 }],
    messages: [{ id: 9, sessionId: 7, videoId: '', role: 'user', content: 'Original question', createdAt: 1 }],
    skills: [], references: [], annotations: [], studyDays: [],
  };
  const rpc = async request => {
    const response = await app.inject({ method: 'POST', url: '/api/clientRuntime/resourceCommand', headers: { cookie }, payload: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'clientRuntime/resourceCommand', payload: { args: { request } } } });
    assert.equal(response.statusCode, 200, response.body); return response.json().result;
  };
  const command = { operationId: crypto.randomUUID(), operation: { kind: 'importLibrary', library } };
  const denied = async changed => assert.equal((await rpc({ operationId: crypto.randomUUID(), operation: { kind: 'importLibrary', library: changed } })).ok, false);
  await denied({ ...library, files: [{ id: 'legacy-course', blob: { $file: 'not-owned' } }] });
  await denied({ ...library, messages: [{ ...library.messages[0], sessionId: 99 }] });
  await denied({ ...library, folders: [{ ...library.folders[0], parentId: 3 }] });
  const metadata = upload.json();
  const mapping = { courseId: 'legacy-course', expected: null, sourceReference: { id: 'legacy-course', resourceProjectId: 'old-owner-project', resourcePath: 'inert.md', resourceRevision: 'old' }, blob: library.files[0].blob, sha256: metadata.sha256, size: metadata.sizeBytes, contentType: 'text/markdown' };
  for (const patch of [{ sha256: '0'.repeat(64) }, { size: mapping.size + 1 }, { contentType: 'text/plain' }, { courseId: 'missing-course' }, { blob: { $file: 'foreign-owner-file' } }]) await denied({ ...library, fileMappings: [{ ...mapping, ...patch }] });
  await denied({ ...library, fileMappings: [mapping, mapping] });
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const stored = store.db.prepare('SELECT storage_name FROM files WHERE id=?').get(metadata.id);
  const filename = path.join(directory, 'files', stored.storage_name);
  const originalBytes = fs.readFileSync(filename);
  fs.writeFileSync(filename, Buffer.alloc(originalBytes.length, 120));
  await denied({ ...library, fileMappings: [mapping] });
  fs.renameSync(filename, `${filename}.retained`);
  await denied({ ...library, fileMappings: [mapping] });
  fs.renameSync(`${filename}.retained`, filename); fs.writeFileSync(filename, originalBytes);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM client_commands WHERE json_extract(result,'$.librarySource') IS NOT NULL").get().n, 0, 'invalid bytes/mapping never admit a partial snapshot');
  command.operation.library = { ...library, fileMappings: [mapping] };
  const first = await rpc(command);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(await rpc(command), first, 'lost response uses original receipt');
  await denied({ ...library, sourceId: crypto.randomUUID() });
  const document = await app.inject({ method: 'GET', url: '/api/v1/resources/courses/legacy-course', headers: { cookie } });
  assert.equal(document.statusCode, 200, document.body);
  assert.match(document.body, /Original body/);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, checks: ['owned files', 'session references', 'folder cycle', 'real Markdown authority', 'original IDs', 'receipt replay', 'one initial snapshot only', 'explicit mapping hash/size/mime/identity', 'duplicate mapping denied', 'same-size corrupt bytes denied', 'missing persistent bytes denied', 'invalid snapshot never admitted'] }, null, 2));
  console.log(`PASS library import HTTP/codec (${directory})`);
} finally { store?.close(); await app.close(); }
