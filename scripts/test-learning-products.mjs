// Every declared producer crosses the real HTTP Host/codec and lease boundary.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/learning-products-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { taskProductMutations } = await import('../apps/api/src/realtime/task-products.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external request forbidden'); } });
let store;
try {
  await app.ready();
  const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'learning-products-test-password' } });
  assert.equal(initialized.statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'learning-products-test-password' } });
  const owner = login.json().user.id, cookie = login.headers['set-cookie'].split(';')[0];
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), courseId = 'producer-course';
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: courseId, before: null, after: { id: courseId, name: 'Producer fixture' } }]);
  const uploaded = await app.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-name': 'product.txt', 'x-file-mime': 'text/plain' }, payload: Buffer.from('product bytes') });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const blob = { $file: uploaded.json().id, type: 'text/plain' };
  const parentThread = crypto.randomUUID(), parentRun = crypto.randomUUID(), parentAt = new Date().toISOString();
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,'bot','Cancelled parent',?,?)").run(parentThread, owner, parentAt, parentAt);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','cancelled',?)").run(parentRun, parentThread, parentAt);
  const samples = [
    ['transcribe', 'transcriptSegment', { id: 1, videoId: courseId, idx: 0, start: 0, end: 1, text: '字幕', status: 1 }],
    ['transcribe', 'subtitleTrack', { id: 2, videoId: courseId, lang: 'zh', lanDoc: 'zh', primary: 1, cues: [{ start: 0, end: 1, text: '字幕' }] }],
    ['material', 'materialBlock', { id: 3, materialId: courseId, idx: 0, unit: 1, unitLabel: '1', text: '正文', kind: 'body' }],
    ['handout', 'slideFrame', { id: 4, videoId: courseId, ts: 0, blob, kind: 'slide' }],
    ['cover', 'courseCover', { videoId: courseId, blob, w: 1, h: 1, ts: 0, source: 'auto', createdAt: 1 }],
    ['handout', 'handoutDocument', { id: 5, videoId: courseId, createdAt: 1, title: '讲义', blob, outlineJson: '[]' }],
    ['handoutEdit', 'handoutDocument', { id: 6, videoId: courseId, createdAt: 1, title: '编辑讲义', blob, outlineJson: '[]' }],
    ['cards', 'candidateCard', { id: 7, videoId: courseId, q: '问题', a: '答案', time: 0, status: 0, createdAt: 1 }],
    ['comments', 'courseComment', { id: 8, videoId: courseId, time: 0, author: 'AI', role: 'note', text: '批注', createdAt: 1 }],
    ['danmaku', 'courseDanmaku', { id: 9, videoId: courseId, time: 0, text: '弹幕' }],
    ['chat', 'conversationSession', { id: 10, videoId: '', title: '聊天', createdAt: 1 }],
    ['chat', 'conversationMessage', { id: 11, sessionId: 10, videoId: '', role: 'assistant', content: '回答', createdAt: 1 }],
    ['qa', 'conversationMessage', { id: 12, sessionId: 10, videoId: '', role: 'assistant', content: '问答', createdAt: 1 }],
    ['transcribe', 'courseDerivation', { status: 'transcribed', transcriptionPaused: false }],
    ['material', 'courseDerivation', { unitCount: 1, scanned: 1 }],
    ['cover', 'courseDerivation', { coverState: 'done', dominantColor: '#123456' }],
  ];
  const checks = [];
  for (const [taskKind, kind, value] of samples) {
    const taskId = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 60000 });
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','browser',?,?,?,?)")
      .run(taskId, owner, taskId, taskKind, courseId, JSON.stringify({ videoId: courseId, sessionId: 10 }), workerTokenHash(token), new Date(Date.now() + 60000).toISOString(), at, at);
    const rpc = async (method, request) => {
      const response = await app.inject({ method: 'POST', url: `/api/executorRuntime/${method}`, headers: { authorization: `Bearer ${token}` }, payload: { type: 'client-request', rpcId: crypto.randomUUID(), method: `executorRuntime/${method}`, payload: { args: { request } } } });
      assert.equal(response.statusCode, 200, response.body);
      return response.json().result;
    };
    const command = { taskId, operationId: crypto.randomUUID(), products: [{ kind, mutationId: crypto.randomUUID(), expected: kind === 'courseDerivation' ? {} : null, value, ...(kind === 'courseDerivation' ? { courseId } : {}) }] };
    const denied = async products => {
      const operationId = crypto.randomUUID();
      const result = await rpc('commitArtifacts', { ...command, operationId, products });
      assert.equal(result.ok, false, `${taskKind}/${kind}: invalid product accepted`);
      assert.equal(store.db.prepare('SELECT 1 FROM client_commands WHERE operation_id=?').get(operationId), undefined);
    };
    // The codec projects declared fields; the domain also rejects unknown fields
    // for internal callers rather than relying solely on that projection.
    assert.throws(() => taskProductMutations(records, owner, { id: taskId, kind: taskKind, input: JSON.stringify({ videoId: courseId, sessionId: 10 }) }, [{ ...command.products[0], value: { ...value, arbitraryField: 'not permitted' } }]), /artifact_(schema|state)_denied/);
    await denied([{ mutationId: crypto.randomUUID(), permissionId: 'consumed-does-not-bypass-schema', expected: null, ...(taskKind === 'cards'
      ? { kind: 'courseDanmaku', value: { id: 888, videoId: courseId, time: 0, text: 'wrong task' } }
      : { kind: 'candidateCard', value: { id: 888, videoId: courseId, q: 'wrong task', a: 'denied', time: 0, status: 0, createdAt: 1 } }) }]);
    await denied([kind === 'courseDerivation' ? { ...command.products[0], courseId: 'other-course' } : { ...command.products[0], value: { ...value, ...(kind === 'materialBlock' ? { materialId: 'other-course' } : kind.startsWith('conversation') ? { sessionId: 999, id: 999 } : { videoId: 'other-course' }) } }]);
    if (value.blob) await denied([{ ...command.products[0], value: { ...value, blob: { $file: 'not-owned-by-this-account' } } }]);
    if (kind === 'conversationMessage') await denied([{ ...command.products[0], value: { ...value, videoId: 'forged-conversation-course' } }]);
    if (!kind.startsWith('conversation')) {
      const original = records.get(owner, 'videos', courseId);
      records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: courseId, before: original, after: { ...original, fileDeleted: true } }]);
      await denied(command.products);
      records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: courseId, before: { ...original, fileDeleted: true }, after: original }]);
    }
    store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=? WHERE id=?').run(new Date(0).toISOString(), taskId);
    await denied(command.products);
    store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=? WHERE id=?').run(new Date(Date.now() + 60000).toISOString(), taskId);
    store.db.prepare('UPDATE cloud_tasks SET parent_run_id=? WHERE id=?').run(parentRun, taskId);
    await denied(command.products);
    store.db.prepare('UPDATE cloud_tasks SET parent_run_id=NULL WHERE id=?').run(taskId);
    const committed = await rpc('commitArtifacts', command);
    assert.equal(committed.ok, true, `${taskKind}/${kind}: ${JSON.stringify(committed)}`);
    assert.deepEqual(await rpc('commitArtifacts', command), committed, 'lost response recovers the original receipt');
    store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(taskId);
    assert.deepEqual(await rpc('commitArtifacts', command), committed, 'terminal tasks may recover existing receipts');
    await denied([{ ...command.products[0], mutationId: crypto.randomUUID() }]);
    checks.push(`${taskKind}/${kind}`);
  }
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, checks, matrix: ['schema', 'task-kind', 'course/session', 'owned-file', 'deleted-course', 'expired-lease', 'cancelled-parent', 'receipt-recovery', 'terminal-no-new-write'] }, null, 2));
  console.log(`PASS: ${checks.length} producer HTTP/codec authorization and receipt matrices (${directory})`);
} finally { store?.close(); await app.close(); }
