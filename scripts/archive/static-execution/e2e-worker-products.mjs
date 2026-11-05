// Historical fixture for the retired browser worker product protocol. Not runnable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/worker-products-ui-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external requests forbidden'); } });
let browser, vite, store;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'worker-products-password' } })).statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'worker-products-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const records = new CloudRecords(store), courseId = 'real-card-producer';
  records.apply(owner, [
    { id: crypto.randomUUID(), table: 'videos', key: courseId, before: null, after: { id: courseId, name: '真实卡片 producer', kind: 'material', materialFormat: 'md', status: 'new', createdAt: 1, duration: 0, mimeType: 'text/markdown', size: 100 } },
    { id: crypto.randomUUID(), table: 'materialBlocks', key: 1, before: null, after: { id: 1, materialId: courseId, idx: 0, unit: 1, unitLabel: '§1', text: '测试事实：稳定的学习产物通过封闭领域协议提交，丢响应必须沿用原命令身份。', kind: 'body' } },
  ]);
  const taskId = crypto.randomUUID(), token = crypto.randomUUID(), now = new Date().toISOString();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'cards',?,?,'running','browser',?,?,?,?)")
    .run(taskId, owner, crypto.randomUUID(), `course:${courseId}`, JSON.stringify({ videoId: courseId }), workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), now, now);
  workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'worker-products-login', configureServer(server) { server.middlewares.use('/__login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Isolated real browser producer</title><p>Worker producer harness</p>'); }); } }] });
  await vite.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__login`);
  await page.evaluate(async () => { await import('/src/pipelines/cards.ts'); await import('/src/cloud/learning-products.ts'); });
  await page.waitForTimeout(1500);
  const operations = []; let drop = true, dropKind;
  await page.route('**/api/executorRuntime/commitArtifacts', async route => {
    const request = route.request().postDataJSON().payload.args.request; operations.push(request);
    const response = await route.fetch(); assert.equal(response.status(), 200); assert.equal((await response.json()).result.ok, true);
    if (drop && (!dropKind || request.products.some(product => product.kind === dropKind))) { drop = false; await route.abort('failed'); } else await route.fulfill({ response });
  });
  const first = await page.evaluate(async ({ token, taskId, owner, courseId }) => {
    const state = await import('/src/cloud/state.ts');
    const { startCloud } = await import('/src/cloud/sync.ts');
    await startCloud(owner, true);
    Object.assign(state.cloud, { workerToken: token, taskId, acceptedPlugins: ['flashcards'] });
    await (await import('/src/cloud/sync.ts')).flushCloud();
    const { useSettings } = await import('/src/store/settings.ts');
    useSettings.setState({ providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'local-only', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
    const original = window.fetch;
    window.fetch = async (url, init) => String(url).startsWith('https://fixture.invalid') ? Response.json({ choices: [{ message: { content: JSON.stringify([{ q: '学习产物应使用什么协议？', a: '封闭领域产品协议', time: '00:00' }]) }, finish_reason: 'stop' }] }) : original(url, init);
    try { await (await import('/src/pipelines/cards.ts')).runCards(courseId, () => {}); return { unexpected: true }; }
    catch (error) { return { error: error.message }; }
    finally { window.fetch = original; }
  }, { token, taskId, owner, courseId });
  assert.ok(first.error, JSON.stringify(first));
  const persisted = await page.evaluate(async () => (await import('/src/store/db.ts')).db.table('_cloudMeta').filter(row => row.id.startsWith('executor-products:')).toArray());
  assert.equal(persisted.length, 1, 'original closed products journal survives committed response loss');
  await page.evaluate(async () => (await import('/src/cloud/learning-products.ts')).flushLearningProducts());
  assert.equal(operations.length, 2); assert.equal(operations[0].operationId, operations[1].operationId);
  assert.deepEqual(operations[0].products, operations[1].products);
  assert.equal(operations[0].products[0].kind, 'candidateCard');
  const cards = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='cards' AND value IS NOT NULL").all(owner).map(row => JSON.parse(row.value));
  assert.equal(cards.length, 1); assert.equal(cards[0].q, '学习产物应使用什么协议？');
  const guarded = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    try { await db.cards.add({ videoId: 'real-card-producer', q: 'must reject', a: 'no', time: 0, createdAt: 1, status: 0 }); return false; }
    catch (error) { return error.message.includes('executor_product_command_required'); }
  });
  assert.equal(guarded, true, 'no generic write interception remains');
  const source = await api.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-mime': 'text/markdown' }, payload: Buffer.from('# Real cover producer\n\nOriginal source bytes') });
  assert.equal(source.statusCode, 201);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'files', key: courseId, before: null, after: { id: courseId, blob: { $file: source.json().id, type: 'text/markdown' } } }]);
  const startCover = async (kind = 'cover', input = { videoId: courseId }) => {
    const taskId = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,?,?,?,'running','browser',?,?,?,?)")
      .run(taskId, owner, crypto.randomUUID(), kind, ['chat', 'qa'].includes(kind) ? `session:${input.sessionId}` : `course:${input.videoId}`, JSON.stringify(input), workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), at, at);
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
    return { taskId, token, owner };
  };
  const enter = async capability => {
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__login`);
    await page.evaluate(async capability => {
      const { cloud } = await import('/src/cloud/state.ts');
      await (await import('/src/cloud/sync.ts')).startCloud(capability.owner, true);
      Object.assign(cloud, { ...capability, workerToken: capability.token, acceptedPlugins: ['material-tools'] });
      await (await import('/src/cloud/sync.ts')).flushCloud();
    }, capability);
  };
  const cover = await startCover(); await enter(cover);
  let uploads = 0;
  const blobOperations = [];
  await page.route('**/api/v1/files?operationId=*', async route => {
    uploads++; blobOperations.push(new URL(route.request().url()).searchParams.get('operationId'));
    const response = await route.fetch(); assert.equal(response.status(), 201, await response.text());
    await route.abort('failed');
  });
  const coverError = await page.evaluate(async courseId => { try { await (await import('/src/pipelines/cover.ts')).ensureCover(courseId); return null; } catch (error) { return error.message; } }, courseId);
  assert.ok(coverError); assert.equal(uploads, 1, coverError);
  const blobDraft = await page.evaluate(async () => (await import('/src/store/db.ts')).db.table('_cloudMeta').filter(row => row.id.startsWith('executor-product-blob:')).first().then(row => ({ operationId: row.value.operationId, parentOperationId: row.value.parentOperationId, size: row.value.blob.size })));
  assert.equal(blobDraft.operationId, blobOperations[0]); assert.ok(blobDraft.size > 0);
  await enter(cover);
  await page.evaluate(async () => (await import('/src/cloud/learning-products.ts')).flushLearningProducts());
  assert.equal(uploads, 1, 'reload resolves original Blob receipt with zero retransmission');
  const covers = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='covers' AND value IS NOT NULL").all(owner).map(row => JSON.parse(row.value));
  assert.equal(covers.length, 1); assert.equal(covers[0].source, 'material-title');
  const storedBlob = await api.inject({ method: 'GET', url: `/api/v1/files/${covers[0].blob.$file}`, headers: { cookie } });
  assert.equal(storedBlob.statusCode, 200); assert.equal(storedBlob.rawPayload.length, blobDraft.size);
  await page.unroute('**/api/v1/files?operationId=*');
  const producerChecks = [];
  for (const [producer, taskKind] of [['subtitles', 'transcribe'], ['comments', 'comments'], ['danmaku', 'danmaku'], ['reindex', 'material'], ['conversationSession', 'chat'], ['conversationMessage', 'chat'], ['sessionCacheKey', 'chat'], ['historyCheckpoint', 'chat']]) {
    const sessionId = ['sessionCacheKey', 'historyCheckpoint'].includes(producer) ? 701 : 700;
    if (producer === 'conversationSession' || producer === 'sessionCacheKey') records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: sessionId, before: null, after: { id: sessionId, videoId: '', title: 'Producer session', createdAt: 1 } }]);
    if (producer === 'historyCheckpoint') records.apply(owner, [0, 1, 2].map(n => ({ id: crypto.randomUUID(), table: 'chats', key: 10001 + n, before: null, after: { id: 10001 + n, sessionId, videoId: '', role: n === 1 ? 'assistant' : 'user', content: n < 2 ? '原始历史消息。'.repeat(300) : '新问题', createdAt: n + 1 } })));
    const capability = await startCover(taskKind, { videoId: courseId, sessionId });
    await enter(capability);
    const before = operations.length; drop = true;
    const failure = await page.evaluate(async ({ producer, courseId, sessionId }) => {
      const { useSettings } = await import('/src/store/settings.ts');
      useSettings.setState({ providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'local-only', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' } });
      const original = window.fetch;
      window.fetch = async (url, init) => String(url).startsWith('https://fixture.invalid') ? Response.json({ choices: [{ message: { content: JSON.stringify([{ time: '00:00', author: '小林', role: 'ask', text: '原始领域协议如何保证不丢失？', replies: [{ author: '助教', role: 'answer', text: '原始收据和标识保持一致。' }] }]) }, finish_reason: 'stop' }] }) : original(url, init);
      try {
        if (producer === 'subtitles') {
          const cues = [0, 1, 2].map(n => ({ start: n * 10, end: n * 10 + 9, text: '稳定的学习领域协议需要保留原始收据与命令标识。'.repeat(3) }));
          const track = { lang: 'zh', lanDoc: '中文', primary: 1, cues };
          await (await import('/src/store/subtitles.ts')).saveImportedSubtitles(courseId, { primary: track, tracks: [track] });
        } else if (producer === 'comments') await (await import('/src/pipelines/comments.ts')).runComments(courseId, () => {});
        else if (producer === 'danmaku') await (await import('/src/pipelines/danmaku.ts')).runDanmaku(courseId, () => {});
        else if (producer === 'reindex') await (await import('/src/materials/reindex.ts')).reindexMaterial(courseId, 'md', [{ unit: 1, text: '实际材料索引保留完整领域命令。'.repeat(20) }], null);
        else if (producer === 'conversationSession') await (await import('/src/store/conversationProducts.ts')).patchConversationSession(sessionId, { promptCacheKey: 'durable-original-checkpoint' });
        else if (producer === 'sessionCacheKey') await (await import('/src/store/modelHistory.ts')).sessionCacheKey(sessionId);
        else if (producer === 'historyCheckpoint') {
          const rows = await (await import('/src/store/db.ts')).db.chats.where('sessionId').equals(sessionId).toArray();
          await (await import('/src/store/modelHistory.ts')).fitModelHistory(sessionId, rows, 100);
        }
        else await (await import('/src/store/conversationProducts.ts')).appendConversationMessage({ sessionId, videoId: '', role: 'assistant', content: '实际会话生产者', createdAt: 1 });
        return null;
      } catch (error) { return error.message; }
      finally { window.fetch = original; }
    }, { producer, courseId, sessionId });
    assert.ok(failure, `${producer}: expected committed-response loss`);
    assert.equal(operations.length, before + 1, `${producer}: reaches real Host once`);
    const request = operations[before];
    assert.ok(request.products.length);
    await enter(capability); // actual page reload, receipt recovery, original identity
    assert.equal(operations.length, before + 2, `${producer}: only original idempotent SQL command retried`);
    assert.deepEqual(operations[before + 1], request, `${producer}: exact operation/products/mutation identities`);
    await page.evaluate(async () => (await import('/src/cloud/learning-products.ts')).flushLearningProducts());
    assert.equal(operations.length, before + 2, `${producer}: acknowledged command not resubmitted`);
    producerChecks.push({ producer, taskKind, operationId: request.operationId, kinds: request.products.map(product => product.kind), sameIdentityAfterReload: true });
  }
  // Full handout path: real video decode, frame Blob, local model fixture, DOCX
  // bytes, and the ancillary cover under this same closed task capability.
  const videoPath = path.join(directory, 'handout.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', videoPath]);
  const videoUpload = await api.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-mime': 'video/mp4' }, payload: fs.readFileSync(videoPath) });
  assert.equal(videoUpload.statusCode, 201);
  const handoutCourse = 'actual-handout-producer';
  records.apply(owner, [
    { id: crypto.randomUUID(), table: 'videos', key: handoutCourse, before: null, after: { id: handoutCourse, name: '真实讲义视频', size: videoUpload.json().sizeBytes, mimeType: 'video/mp4', duration: 2, createdAt: 1, status: 'transcribed' } },
    { id: crypto.randomUUID(), table: 'files', key: handoutCourse, before: null, after: { id: handoutCourse, blob: { $file: videoUpload.json().id, type: 'video/mp4' } } },
    ...[0, 1, 2].map(n => ({ id: crypto.randomUUID(), table: 'segments', key: 800 + n, before: null, after: { id: 800 + n, videoId: handoutCourse, idx: n, start: n / 2, end: n / 2 + 0.4, text: '实际讲义生产者的稳定领域产物。', status: 1 } })),
  ]);
  for (const kind of ['slideFrame', 'handoutDocument']) {
    const capability = await startCover('handout', { videoId: handoutCourse }); await enter(capability);
    drop = true; dropKind = kind;
    const before = operations.length;
    const failure = await page.evaluate(async courseId => {
      const { useSettings } = await import('/src/store/settings.ts');
      useSettings.setState({ providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'local-only', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' }, visionModel: { providerId: 'fixture', model: 'fixture' } });
      const original = window.fetch;
      window.fetch = async (url, init) => String(url).startsWith('https://fixture.invalid') ? Response.json({ choices: [{ message: { content: JSON.stringify({ title: '真实讲义', summary: '实际生产者摘要', sections: [{ heading: '原始收据', start: '00:00', end: '00:02', points: ['稳定协议'] }], blocks: [{ type: 'para', text: '完整的讲义产物应保留原命令和二进制收据。' }], skills: [] }) }, finish_reason: 'stop' }] }) : original(url, init);
      try { await (await import('/src/pipelines/handout.ts')).runHandout(courseId, () => {}); return null; }
      catch (error) { return error.message; }
      finally { window.fetch = original; }
    }, handoutCourse);
    assert.ok(failure, `${kind}: loss must reach real producer`);
    const request = operations.slice(before).find(request => request.products.some(product => product.kind === kind));
    assert.ok(request, `${kind}: real task reached closed product command: ${failure}`);
    await enter(capability);
    const replayed = operations.filter(row => row.operationId === request.operationId);
    assert.equal(replayed.length, 2); assert.deepEqual(replayed[0], replayed[1]);
    await page.evaluate(async () => (await import('/src/cloud/learning-products.ts')).flushLearningProducts());
    assert.equal(operations.filter(row => row.operationId === request.operationId).length, 2);
    producerChecks.push({ producer: `runHandout/${kind}`, operationId: request.operationId, sameIdentityAfterReload: true });
  }
  dropKind = undefined;
  const handouts = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='handouts' AND value IS NOT NULL").all(owner).map(row => JSON.parse(row.value));
  assert.equal(handouts.length, 1);
  const docx = await api.inject({ method: 'GET', url: `/api/v1/files/${handouts[0].blob.$file}`, headers: { cookie } });
  assert.equal(docx.statusCode, 200); assert.equal(docx.rawPayload.subarray(0, 2).toString(), 'PK', 'real persistent DOCX bytes');
  const editCapability = await startCover('handoutEdit', { videoId: handoutCourse }); await enter(editCapability);
  dropKind = 'handoutDocument'; drop = true;
  const editStart = operations.length;
  const editFailure = await page.evaluate(async handoutId => {
    try { await (await import('/src/pipelines/handoutEdit.ts')).persistHandoutEdit(handoutId, [{ heading: '实际重建', blocks: [{ type: 'para', text: '编辑后完整 DOCX 与 IR 一起保全。' }] }], '新的持久摘要'); return null; }
    catch (error) { return error.message; }
  }, handouts[0].id);
  assert.ok(editFailure);
  const editRequest = operations[editStart]; assert.equal(editRequest.products[0].kind, 'handoutDocument');
  await enter(editCapability);
  const editReplays = operations.filter(request => request.operationId === editRequest.operationId);
  assert.equal(editReplays.length, 2); assert.deepEqual(editReplays[0], editReplays[1]);
  const editedHandout = JSON.parse(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='handouts' AND record_key=?").get(owner, JSON.stringify(handouts[0].id)).value);
  assert.equal(JSON.parse(editedHandout.outlineJson).summary, '新的持久摘要');
  producerChecks.push({ producer: 'persistHandoutEdit', operationId: editRequest.operationId, sameIdentityAfterReload: true });
  dropKind = undefined;
  // Second real producer reaches an admitted but unobserved upload. It must
  // remain recoverable, not use the earlier task's token or resend after reload.
  const changedSource = await api.inject({ method: 'POST', url: '/api/v1/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-file-mime': 'text/markdown' }, payload: Buffer.from('# Distinct unknown cover\n\nA deliberately different source') });
  assert.equal(changedSource.statusCode, 201);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'files', key: courseId, before: records.get(owner, 'files', courseId), after: { id: courseId, blob: { $file: changedSource.json().id, type: 'text/markdown' } } }]);
  const unknown = await startCover(); await enter(unknown);
  await page.route('**/api/v1/files?operationId=*', async route => { uploads++; await route.abort('failed'); });
  const uncertain = await page.evaluate(async courseId => { try { await (await import('/src/pipelines/cover.ts')).ensureCover(courseId, { force: true }); return null; } catch (error) { return error.message; } }, courseId);
  assert.ok(uncertain); assert.equal(uploads, 2);
  await assert.rejects(() => enter(unknown), /executor_product_blob_uncertain/);
  const stillUnknown = await page.evaluate(async () => { try { await (await import('/src/cloud/learning-products.ts')).flushLearningProducts(); return null; } catch (error) { return error.message; } });
  assert.match(stillUnknown, /executor_product_blob_uncertain/); assert.equal(uploads, 2);
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`);
  const recovery = page.getByRole('region', { name: '执行器恢复日志' });
  await recovery.getByRole('button', { name: /核对原任务与收据 executor-product-blob:/ }).click();
  await recovery.getByText(/"status": "uncertain"/).waitFor();
  const recoveryGuards = await page.evaluate(async () => {
    const recovery = await import('/src/cloud/executor-recovery.ts');
    const { cloud } = await import('/src/cloud/state.ts');
    const id = (await recovery.listExecutorRecovery(cloud.userId)).find(row => row.id.startsWith('executor-product-blob:')).id;
    const detail = await recovery.inspectExecutorRecovery(id);
    const denied = async detail => { try { await recovery.archiveExecutorRecovery(detail); return false; } catch (error) { return error.message === 'client_account_changed'; } };
    const cloneDenied = await denied(structuredClone(detail));
    (await import('/src/client/bootstrap.ts')).disposeServerRuntime();
    const staleDenied = await denied(detail);
    return { cloneDenied, staleDenied };
  });
  assert.deepEqual(recoveryGuards, { cloneDenied: true, staleDenied: true });
  await recovery.getByRole('button', { name: '重新查询原收据' }).click();
  await recovery.getByRole('button', { name: '导出完整原稿和附件字节' }).waitFor({ state: 'visible' });
  const downloadEvent = page.waitForEvent('download');
  await recovery.getByRole('button', { name: '导出完整原稿和附件字节' }).click();
  const exported = path.join(directory, 'uncertain-blob-export.json'); await (await downloadEvent).saveAs(exported);
  const detail = JSON.parse(fs.readFileSync(exported, 'utf8'));
  assert.equal(detail.row.value.taskId, unknown.taskId); assert.ok(detail.row.value.blob.bytes.length > 0);
  await recovery.getByRole('button', { name: '确认核对并归档（不重放）' }).click();
  await recovery.getByRole('button', { name: '关闭核对' }).click();
  assert.equal(uploads, 2); assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM cloud_records WHERE owner_id=? AND table_name='covers' AND record_key=? AND value IS NOT NULL").get(owner, JSON.stringify(courseId)).n, 1);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, operations, producerChecks, cards, guarded, blobDraft, covers, uploads, unknown: { taskId: unknown.taskId, receipt: detail.receipt }, checks: ['actual runCards producer', 'real capability/Host/codec', 'closed product journal', 'committed response loss', 'same operation/mutation IDs', 'one authoritative card', 'generic writes rejected', 'actual ensureCover/canvas Blob', 'Blob admission and committed response loss', 'reload original Blob receipt with zero retransmission', 'pending binary never replayed', 'actual inspect/export/archive UI', 'lossless binary export'] }, null, 2));
  workerTokens.delete(token);
  fs.writeFileSync(path.join(directory, 'recovery-guards.json'), JSON.stringify(recoveryGuards, null, 2));
  console.log(`PASS actual browser producer/closed journal/Blob recovery matrices (${directory})`);
} finally { await browser?.close(); await vite?.close(); store?.close(); await api.close(); }
