import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { apply as installGateway } from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';
import { applyRuntimePatch } from '@wangke/contracts/runtime-projection';
import { createClientRuntime } from '@wangke/client-core';

const root = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const directory = fs.mkdtempSync(path.join(root, 'client-runtime-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { PluginFiles } = await import('../apps/api/src/plugins/files.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { SystemMaterials } = await import('../apps/api/src/storage/system-materials.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
const ctx = new Context();
let store;
let runtime;
const deadline = async (promise, label) => {
  const control = new AbortController();
  try { return await Promise.race([promise, delay(8000, undefined, { signal: control.signal }).then(() => { throw new Error(`Timeout: ${label}`); })]); }
  finally { control.abort(); }
};
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const init = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize',
    headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'runtime-test-password-123' } });
  assert.equal(init.statusCode, 201, init.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'runtime-test-password-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  let sockets = 0;
  await ctx.plugin(TypertRegistry);
  installConnection(ctx, { interactions: 'answer', transport: {
    fetch: (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init?.headers, cookie } }),
    streamBaseUrl: base,
    createWebSocket: url => { sockets++; return new WebSocket(url, { headers: { cookie, origin: base } }); },
  } });
  await ctx.plugin(installGateway);
  await ctx.remote.$mount(TYPERT_REMOTE);
  const read = await deadline(ctx.remote.clientRuntime.read({ kind: 'catalog' }), 'unary');
  assert.equal(read.ok, true, JSON.stringify(read));
  assert.equal(read.value.type, 'snapshot');
  assert.ok(read.value.value.plugins.length >= 4);
  const unauthorized = await fetch(`${base}/api/clientRuntime/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(`${base}/api/clientRuntime/read`, { method: 'POST', headers: { cookie, origin: 'https://untrusted.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(forbidden.status, 403);
  const malformed = await fetch(`${base}/api/clientRuntime/read`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(malformed.status, 400);
  const rejectedUpgrade = headers => deadline(new Promise((resolve, reject) => {
    const socket = new WebSocket(`${base.replace('http', 'ws')}/api/remote.mux`, { headers });
    socket.once('open', () => { socket.close(); reject(new Error('Unauthenticated upgrade admitted')); });
    socket.once('error', reject);
    socket.once('unexpected-response', (_request, response) => { response.resume(); socket.removeAllListeners('error'); socket.on('error', () => {}); socket.terminate(); resolve(response.statusCode); });
  }), 'rejected WebSocket upgrade');
  assert.equal(await rejectedUpgrade({ origin: base }), 401);
  assert.equal(await rejectedUpgrade({ cookie, origin: 'https://untrusted.example' }), 403);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new PluginFiles(store);
  const typedLayoutDocument = files.layout(owner);
  const layoutCommand = { content: typedLayoutDocument.content, expected: typedLayoutDocument.content, revision: typedLayoutDocument.revision, operationId: 'typed-layout-cas-command-0001' };
  const savedLayout = await ctx.remote.clientRuntime.savePluginLayout(layoutCommand);
  assert.equal(savedLayout.ok, true, JSON.stringify(savedLayout));
  assert.deepEqual(await ctx.remote.clientRuntime.savePluginLayout(layoutCommand), savedLayout, 'layout receipt is idempotent');
  assert.equal((await ctx.remote.clientRuntime.savePluginLayout({ ...layoutCommand, operationId: 'typed-layout-cas-conflict-0001', expected: 'stale' })).ok, false);
  assert.equal((await ctx.remote.clientRuntime.savePluginLayout({ ...layoutCommand, content: '{}' })).ok, false, 'operation id cannot change payload');
  assert.equal((await fetch(`${base}/api/v1/plugins/layout`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(layoutCommand) })).status, 404);
  const resourceControl = new AbortController();
  const resourceStream = ctx.remote.clientRuntime.watch({ kind: 'resources', path: '', archived: true }, resourceControl.signal)[Symbol.asyncIterator]();
  let resourceFrame = (await deadline(resourceStream.next(), 'resource baseline')).value;
  let resourceValue = resourceFrame.value;
  const createResource = { operationId: 'resource-domain-create-folder-0001', operation: { kind: 'createFolder', name: 'Typed domain folder' } };
  const createdResource = await ctx.remote.clientRuntime.resourceCommand(createResource);
  assert.equal(createdResource.ok, true, JSON.stringify(createdResource));
  assert.equal(createdResource.value.name, 'Typed domain folder');
  const uploadBytes = Buffer.from('retained binary resource draft\n');
  const uploadCommand = { operationId: 'resource-upload-admission-0001', operation: { kind: 'upload', projectId: createdResource.value.id,
    path: 'binary.txt', size: uploadBytes.length, sha256: crypto.createHash('sha256').update(uploadBytes).digest('hex'), contentType: 'text/plain' } };
  const uploadUrl = `${base}/api/v1/projects/${createdResource.value.id}/uploads`;
  const uploadHeaders = { cookie, 'content-type': 'application/octet-stream' };
  assert.equal((await fetch(`${uploadUrl}?path=unadmitted.txt`, { method: 'POST', headers: uploadHeaders, body: uploadBytes })).status, 400);
  assert.equal((await ctx.remote.clientRuntime.resourceCommand(uploadCommand)).ok, true);
  assert.equal((await ctx.remote.clientRuntime.receipt(uploadCommand.operationId)).value.status, 'uncertain');
  const uploadResponse = await fetch(`${uploadUrl}?operationId=${uploadCommand.operationId}`, { method: 'POST', headers: uploadHeaders, body: uploadBytes });
  assert.equal(uploadResponse.status, 201, await uploadResponse.clone().text());
  const uploadResult = await uploadResponse.json();
  assert.equal(uploadResult.sha256, uploadCommand.operation.sha256);
  assert.equal((await ctx.remote.clientRuntime.receipt(uploadCommand.operationId)).value.status, 'completed');
  const uploadReplay = await fetch(`${uploadUrl}?operationId=${uploadCommand.operationId}`, { method: 'POST', headers: uploadHeaders, body: 'must not replace' });
  assert.deepEqual(await uploadReplay.json(), uploadResult, 'binary replay returns original receipt without installing bytes');
  const mismatch = { ...uploadCommand, operationId: 'resource-upload-mismatch-0001', operation: { ...uploadCommand.operation, path: 'mismatch.txt' } };
  assert.equal((await ctx.remote.clientRuntime.resourceCommand(mismatch)).ok, true);
  assert.equal((await fetch(`${uploadUrl}?operationId=${mismatch.operationId}`, { method: 'POST', headers: uploadHeaders, body: 'wrong' })).status, 400);
  assert.equal((await fetch(`${uploadUrl}?operationId=${mismatch.operationId}`, { method: 'POST', headers: uploadHeaders, body: uploadBytes })).status, 409, 'uncertain transfers cannot restart');
  const externalControl = new AbortController();
  const externalStream = ctx.remote.clientRuntime.watch({ kind: 'resources', projectId: createdResource.value.id, path: '', archived: true }, externalControl.signal)[Symbol.asyncIterator]();
  let externalFrame = (await deadline(externalStream.next(), 'external filesystem baseline')).value;
  let externalValue = externalFrame.value;
  fs.writeFileSync(path.join(directory, 'files/projects', createdResource.value.id, 'external-unindexed.txt'), 'outside typed command');
  for (let i = 0; !externalValue.entries.some(entry => entry.name === 'external-unindexed.txt') && i < 8; i++) {
    externalFrame = (await deadline(externalStream.next(), 'external filesystem notification')).value;
    externalValue = externalFrame.type === 'snapshot' ? externalFrame.value : applyRuntimePatch(externalValue, externalFrame.changes);
  }
  assert.ok(externalValue.entries.some(entry => entry.name === 'external-unindexed.txt'), 'external files push without browser polling or SQL index writes');
  externalControl.abort(); await externalStream.return?.();
  assert.deepEqual(await ctx.remote.clientRuntime.resourceCommand(createResource), createdResource, 'resource lost response returns original result without creating another folder');
  for (let i = 0; !resourceValue.entries.some(entry => entry.projectId === createdResource.value.id) && i < 8; i++) {
    resourceFrame = (await deadline(resourceStream.next(), 'resource committed push')).value;
    resourceValue = resourceFrame.type === 'snapshot' ? resourceFrame.value : applyRuntimePatch(resourceValue, resourceFrame.changes);
  }
  assert.ok(resourceValue.entries.some(entry => entry.projectId === createdResource.value.id));
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ ...createResource, operation: { kind: 'createFolder', name: 'Wrong replay' } })).ok, false);
  const mkdirResource = { operationId: 'resource-domain-mkdir-0000001', operation: { kind: 'createDirectory', projectId: createdResource.value.id, path: 'contained' } };
  assert.equal((await ctx.remote.clientRuntime.resourceCommand(mkdirResource)).ok, true);
  const resourceListing = await ctx.remote.clientRuntime.read({ kind: 'resources', projectId: createdResource.value.id, path: '', archived: true });
  assert.ok(resourceListing.value.value.entries.some(entry => entry.name === 'contained'));
  const projectTextCommand = { operationId: 'resource-domain-project-text-01', operation: { kind: 'saveProjectText', projectId: createdResource.value.id, path: 'contained/draft.md', text: '# Exact project draft\n', expectedRevision: null } };
  const projectText = await ctx.remote.clientRuntime.resourceCommand(projectTextCommand);
  assert.equal(projectText.ok, true);
  assert.deepEqual(await ctx.remote.clientRuntime.resourceCommand(projectTextCommand), projectText, 'project text replay uses original receipt');
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ ...projectTextCommand, operationId: 'resource-domain-project-conflict', operation: { ...projectTextCommand.operation, text: 'stale competing draft' } })).error.code, 'client/uncertain');
  const savedProjectText = await fetch(new URL(`/api/v1/projects/${createdResource.value.id}/text?path=contained%2Fdraft.md`, base), { headers: { cookie } });
  assert.equal((await savedProjectText.json()).text, '# Exact project draft\n');
  const indexedDraft = (await ctx.remote.clientRuntime.read({ kind: 'resources', projectId: createdResource.value.id, path: 'contained', archived: true })).value.value.entries.find(entry => entry.name === 'draft.md');
  assert.ok(indexedDraft.courseId);
  const callResource = async operation => {
    const result = await ctx.remote.clientRuntime.resourceCommand({ operationId: `resource-test-${crypto.randomUUID()}`, operation });
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  };
  const markdownId = 'domain-markdown-wrongbook-test';
  const markdownCreate = { operationId: 'resource-markdown-create-000001', operation: { kind: 'saveMarkdown', courseId: markdownId, name: 'Wrongbook fixture', text: '# Original\n\nRetained content.', expected: '', createOnly: true } };
  const markdownResult = await ctx.remote.clientRuntime.resourceCommand(markdownCreate);
  assert.equal(markdownResult.ok, true, JSON.stringify(markdownResult));
  assert.ok(markdownResult.value.blockCount > 0);
  assert.deepEqual(await ctx.remote.clientRuntime.resourceCommand(markdownCreate), markdownResult);
  const documentControl = new AbortController();
  const documentStream = ctx.remote.clientRuntime.watch({ kind: 'courseDocument', courseId: markdownId }, documentControl.signal)[Symbol.asyncIterator]();
  let documentFrame = (await deadline(documentStream.next(), 'document baseline')).value, documentValue = documentFrame.value;
  assert.equal(documentValue.text, markdownCreate.operation.text);
  const placement = store.db.prepare('SELECT project_id,path FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, markdownId);
  fs.writeFileSync(path.join(directory, 'files/projects', placement.project_id, placement.path), '# External\n\nChanged outside app.');
  for (let i = 0; !documentValue.text.includes('External') && i < 8; i++) {
    documentFrame = (await deadline(documentStream.next(), 'document external push')).value;
    documentValue = documentFrame.type === 'snapshot' ? documentFrame.value : applyRuntimePatch(documentValue, documentFrame.changes);
  }
  assert.ok(documentValue.text.includes('External'));
  documentControl.abort(); await documentStream.return?.();
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ ...markdownCreate, operationId: 'resource-markdown-stale-cas-0001', operation: { ...markdownCreate.operation, createOnly: false, expected: markdownCreate.operation.text, text: 'must not overwrite' } })).ok, false);
  const systemControl = new AbortController();
  const systemStream = ctx.remote.clientRuntime.watch({ kind: 'systemDocument', path: '/system/AGENTS.md' }, systemControl.signal)[Symbol.asyncIterator]();
  let systemFrame = (await deadline(systemStream.next(), 'system baseline')).value, systemValue = systemFrame.value;
  const systemFile = path.join(directory, 'files/system-files', crypto.createHash('sha256').update(owner).digest('hex'), 'system/AGENTS.md');
  const originalSystem = fs.readFileSync(systemFile, 'utf8');
  fs.writeFileSync(systemFile, `${originalSystem}\nExternal watch fixture\n`);
  for (let i = 0; !systemValue.content.includes('External watch fixture') && i < 8; i++) {
    systemFrame = (await deadline(systemStream.next(), 'system external push')).value;
    systemValue = systemFrame.type === 'snapshot' ? systemFrame.value : applyRuntimePatch(systemValue, systemFrame.changes);
  }
  assert.ok(systemValue.content.includes('External watch fixture'));
  systemControl.abort(); await systemStream.return?.(); fs.writeFileSync(systemFile, originalSystem);
  const organized = await callResource({ kind: 'organizeCourses', folders: [{ name: 'Reuse classification', courseIds: [markdownId, 'invented-id'] }] });
  assert.deepEqual(organized.missing, ['invented-id']); assert.equal(organized.moved, 1);
  const reused = await callResource({ kind: 'organizeCourses', folders: [{ name: 'Reuse classification', courseIds: [markdownId] }] });
  assert.deepEqual(reused.createdFolders, []); assert.equal(reused.moved, 1);
  const markdownRow = new CloudRecords(store).get(owner, 'videos', markdownId);
  assert.ok(markdownRow.folderId);
  const organizedDirectory = await ctx.remote.clientRuntime.read({ kind: 'resources', folderId: markdownRow.folderId, path: '', archived: true });
  assert.ok(organizedDirectory.value.value.entries.some(entry => entry.courseId === markdownId));
  const parentBefore = markdownRow.folderId;
  const badBatch = await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-mixed-invalid-batch-001', operation: { kind: 'moveLibrarySelection', placements: [
    { key: `file:${markdownId}`, parent: parentBefore, target: null }, { key: 'file:invented-id', parent: null, target: null },
  ] } });
  assert.equal(badBatch.ok, false);
  assert.equal(new CloudRecords(store).get(owner, 'videos', markdownId).folderId, parentBefore, 'whole invalid batch preserves original placement');
  await callResource({ kind: 'createDirectory', projectId: placement.project_id, path: 'Batch target' });
  const targetListing = (await ctx.remote.clientRuntime.read({ kind: 'resources', projectId: placement.project_id, path: '', archived: true })).value.value;
  const targetFolderId = targetListing.entries.find(entry => entry.name === 'Batch target').folderId;
  const { ProjectRepository } = await import('../apps/api/src/projects/repository.ts');
  const { ResourceFiles } = await import('../apps/api/src/projects/resources.ts');
  const repository = new ProjectRepository(store, path.join(directory, 'files/projects'));
  const resourceFiles = new ResourceFiles(repository, path.join(directory, 'files'));
  const mixedBatch = [{ key: `folder:${parentBefore}`, parent: new CloudRecords(store).get(owner, 'folders', parentBefore).parentId ?? null, target: targetFolderId },
    { key: `file:${indexedDraft.courseId}`, parent: new CloudRecords(store).get(owner, 'videos', indexedDraft.courseId).folderId ?? null, target: targetFolderId }];
  const originalMove = repository.files.move.bind(repository.files);
  let moveAttempts = 0;
  repository.files.move = (...args) => { if (++moveAttempts === 2) throw new Error('fixture_second_rename_failed'); return originalMove(...args); };
  assert.throws(() => resourceFiles.moveSelection(owner, mixedBatch), /fixture_second_rename_failed/);
  repository.files.move = originalMove;
  assert.equal(new CloudRecords(store).get(owner, 'videos', markdownId).folderId, parentBefore);
  assert.ok(fs.existsSync(path.join(directory, 'files/projects', placement.project_id, 'Reuse classification')), 'failed mixed batch restores the first directory rename');
  const originalResourceMove = resourceFiles.move.bind(resourceFiles);
  resourceFiles.move = (...args) => { originalResourceMove(...args); throw new Error('fixture_after_index_failed'); };
  assert.throws(() => resourceFiles.moveSelection(owner, mixedBatch), /fixture_after_index_failed/);
  resourceFiles.move = originalResourceMove;
  assert.ok(fs.existsSync(path.join(directory, 'files/projects', placement.project_id, 'Reuse classification')), 'failure after file/index work rolls back both layers');
  const movedBatch = resourceFiles.moveSelection(owner, mixedBatch);
  assert.equal(movedBatch.length, 2);
  assert.equal(new CloudRecords(store).get(owner, 'videos', indexedDraft.courseId).folderId, targetFolderId);
  resourceFiles.moveSelection(owner, movedBatch.map(item => ({ ...item, parent: item.target, target: item.parent })));
  assert.equal(new CloudRecords(store).get(owner, 'videos', indexedDraft.courseId).folderId, mixedBatch[1].parent, 'mixed undo restores both original parents');
  assert.equal((await ctx.remote.clientRuntime.commitRecords({ operationId: 'records-generic-denied-000001', mutations: [{ id: 'forged-course', table: 'videos', key: markdownId, before: markdownRow, after: { ...markdownRow, name: 'forged' } }] })).ok, false);
  assert.equal((await fetch(`${base}/api/v1/cloud/records`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ mutations: [] }) })).status, 410);
  fs.writeFileSync(path.join(directory, 'resource-domain-evidence.json'), JSON.stringify({ passed: true, cases: ['markdown-create-receipt', 'markdown-external-watch', 'markdown-stale-cas', 'system-external-watch', 'folder-plan-reuse-missing', 'mixed-preflight-atomicity', 'mixed-second-rename-rollback', 'mixed-post-index-rollback', 'mixed-move-undo', 'generic-records-write-denied'] }, null, 2));
  console.log(`PASS: resource Markdown/watch/organization/mixed atomic rollback and generic write denial (${directory})`);
  const mediaDuration = { operationId: 'resource-media-duration-000001', operation: { kind: 'recordMediaDuration', courseId: indexedDraft.courseId, duration: 123.5 } };
  const durationResult = await ctx.remote.clientRuntime.resourceCommand(mediaDuration);
  assert.equal(durationResult.ok, true);
  assert.equal(durationResult.value.duration, 123.5);
  assert.deepEqual(await ctx.remote.clientRuntime.resourceCommand(mediaDuration), durationResult, 'media metadata has atomic original receipt');
  const playback = await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-playback-domain-000001', operation: { kind: 'recordPlayback', courseId: indexedDraft.courseId, position: 100, finished: true } });
  assert.equal(playback.value.lastPosition, 100); assert.equal(playback.value.finished, 1);
  const readingPosition = { operationId: 'resource-reading-position-00001', operation: { kind: 'recordReadingPosition', courseId: indexedDraft.courseId, unit: 3 } };
  const readingResult = await ctx.remote.clientRuntime.resourceCommand(readingPosition);
  assert.equal(readingResult.ok, true); assert.equal(readingResult.value.lastUnit, 3);
  assert.deepEqual(await ctx.remote.clientRuntime.resourceCommand(readingPosition), readingResult);
  const readingView = await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-reading-view-0000001', operation: { kind: 'setReadingView', courseId: indexedDraft.courseId, view: 'blocks' } });
  assert.equal(readingView.ok, true); assert.equal(readingView.value.htmlView, 'blocks');
  assert.equal(readingView.value.lastUnit, 3, 'view updates preserve reading position');
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-reading-invalid-00001', operation: { kind: 'recordReadingPosition', courseId: indexedDraft.courseId, unit: -1 } })).ok, false);
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-reading-other-0000001', operation: { kind: 'setReadingView', courseId: 'other-owner-course', view: 'raw' } })).ok, false);
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-playback-invalid-00001', operation: { kind: 'recordPlayback', courseId: indexedDraft.courseId, position: -1 } })).ok, false);
  assert.equal((await ctx.remote.clientRuntime.receipt('resource-playback-invalid-00001')).value.status, 'missing');
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-playback-other-000001', operation: { kind: 'recordPlayback', courseId: 'other-owner-course', position: 10 } })).ok, false);
  for (const state of ['archived', 'busy']) {
    if (state === 'archived') store.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(createdResource.value.id);
    else store.db.prepare('INSERT INTO project_executions(project_id,execution_id) VALUES(?,?)').run(createdResource.value.id, 'resource-write-permission-test');
    try {
      for (const kind of ['saveProjectText', 'createDirectory']) {
        const operationId = `resource-${state}-${kind}-preflight`;
        const operation = kind === 'saveProjectText' ? { ...projectTextCommand.operation, path: 'blocked.md' }
          : { kind, projectId: createdResource.value.id, path: 'blocked-directory' };
        assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId, operation })).ok, false, `${state} must reject ${kind}`);
        assert.equal((await ctx.remote.clientRuntime.receipt(operationId)).value.status, 'missing', 'preflight denial does not dispatch or admit filesystem side effects');
      }
    } finally {
      if (state === 'archived') store.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(createdResource.value.id);
      else store.db.prepare('DELETE FROM project_executions WHERE execution_id=?').run('resource-write-permission-test');
    }
  }
  const forbiddenResource = await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-domain-denied-000001', operation: { kind: 'createDirectory', projectId: 'other-owner-project', path: 'escape' } });
  assert.equal(forbiddenResource.ok, false);
  assert.equal((await ctx.remote.clientRuntime.receipt('resource-domain-denied-000001')).value.status, 'missing');
  const traversalResource = { operationId: 'resource-domain-traversal-0001', operation: { kind: 'createDirectory', projectId: createdResource.value.id, path: '../escape' } };
  assert.equal((await ctx.remote.clientRuntime.resourceCommand(traversalResource)).ok, false);
  assert.equal((await ctx.remote.clientRuntime.receipt(traversalResource.operationId)).value.status, 'uncertain');
  assert.equal((await ctx.remote.clientRuntime.resourceCommand(traversalResource)).error.code, 'client/uncertain', 'uncertain filesystem dispatch is never repeated');
  resourceControl.abort(); await resourceStream.return?.();
  const trashControl = new AbortController();
  const trashStream = ctx.remote.clientRuntime.watch({ kind: 'resourceTrash' }, trashControl.signal)[Symbol.asyncIterator]();
  let trashFrame = (await deadline(trashStream.next(), 'resource trash baseline')).value;
  let trashValue = trashFrame.value;
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-domain-trash-000001', operation: { kind: 'trash', projectId: createdResource.value.id } })).ok, true);
  for (let i = 0; !trashValue.projects.some(project => project.id === createdResource.value.id) && i < 8; i++) {
    trashFrame = (await deadline(trashStream.next(), 'resource trash committed push')).value;
    trashValue = trashFrame.type === 'snapshot' ? trashFrame.value : applyRuntimePatch(trashValue, trashFrame.changes);
  }
  assert.ok(trashValue.projects.some(project => project.id === createdResource.value.id));
  assert.equal((await ctx.remote.clientRuntime.resourceCommand({ operationId: 'resource-domain-restore-0001', operation: { kind: 'restore', projectId: createdResource.value.id } })).ok, true);
  for (let i = 0; trashValue.projects.some(project => project.id === createdResource.value.id) && i < 8; i++) {
    trashFrame = (await deadline(trashStream.next(), 'resource restore committed push')).value;
    trashValue = trashFrame.type === 'snapshot' ? trashFrame.value : applyRuntimePatch(trashValue, trashFrame.changes);
  }
  assert.ok(!trashValue.projects.some(project => project.id === createdResource.value.id));
  trashControl.abort(); await trashStream.return?.();
  const preferenceControl = new AbortController();
  const preferenceStream = ctx.remote.clientRuntime.watch({ kind: 'preferences' }, preferenceControl.signal)[Symbol.asyncIterator]();
  const preferenceInitial = (await deadline(preferenceStream.next(), 'preferences baseline')).value;
  const preferenceCommand = { operationId: 'preference-real-io-command-0001', changes: [{ key: 'fontScale', expected: null, value: 'xlarge' }] };
  const preferenceResult = await ctx.remote.clientRuntime.setPreferences(preferenceCommand);
  assert.equal(preferenceResult.ok, true, JSON.stringify(preferenceResult));
  assert.equal(preferenceResult.value.values.fontScale, 'xlarge');
  assert.deepEqual(await ctx.remote.clientRuntime.setPreferences(preferenceCommand), preferenceResult, 'lost preference response returns original durable receipt');
  const preferencePushed = (await deadline(preferenceStream.next(), 'preference command pushed')).value;
  const preferenceValue = preferencePushed.type === 'snapshot' ? preferencePushed.value : applyRuntimePatch(preferenceInitial.value, preferencePushed.changes);
  assert.equal(preferenceValue.values.fontScale, 'xlarge');
  const preferenceConflict = await ctx.remote.clientRuntime.setPreferences({ operationId: 'preference-real-io-command-0002', changes: [{ key: 'fontScale', expected: null, value: 'small' }] });
  assert.equal(preferenceConflict.ok, false);
  assert.equal(preferenceConflict.error.code, 'client/record-conflict');
  assert.equal(new CloudRecords(store).get(owner, 'preferences', 'fontScale').value, 'xlarge');
  const rejectedPreference = await ctx.remote.clientRuntime.setPreferences({ operationId: 'preference-real-io-command-0003', changes: [{ key: 'fontScale', expected: 'xlarge', value: 'compact' }] });
  assert.equal(rejectedPreference.ok, false, 'server validates the actual preference domain');
  assert.equal((await ctx.remote.clientRuntime.receipt('preference-real-io-command-0003')).value.status, 'missing', 'invalid command rolls back receipt');
  assert.equal(new CloudRecords(store).get('other-owner', 'preferences', 'fontScale'), null, 'preferences remain owner scoped');
  preferenceControl.abort(); await preferenceStream.return?.();
  const catalogControl = new AbortController();
  const catalogStream = ctx.remote.clientRuntime.watch({ kind: 'catalog' }, catalogControl.signal)[Symbol.asyncIterator]();
  const catalogInitial = (await deadline(catalogStream.next(), 'catalog before resource indexing')).value;
  const indexedMaterial = { id: 'runtime-newly-indexed-material', name: 'Newly indexed resource', createdAt: Date.now() };
  new CloudRecords(store).apply(owner, [{ id: 'runtime-indexed-material-change', table: 'videos', key: indexedMaterial.id, before: null, after: indexedMaterial }]);
  const catalogChanged = (await deadline(catalogStream.next(), 'catalog scopes pushed after resource indexing')).value;
  const catalogValue = catalogChanged.type === 'snapshot' ? catalogChanged.value : applyRuntimePatch(catalogInitial.value, catalogChanged.changes);
  assert.ok(catalogValue.scopes.materials.some(material => material.id === indexedMaterial.id), 'new resource actions cannot remain hidden behind an old catalog scope snapshot');
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='client_resource_files_insert'").get());
  assert.ok(store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='client_resource_folders_update'").get());
  catalogControl.abort();
  await catalogStream.return?.();
  store.db.prepare('INSERT INTO resource_files(owner_id,course_id,project_id,path,identity,revision) VALUES(?,?,?,?,?,?)').run(owner, 'notification-fixture', 'notification-project', 'fixture.md', 'identity', 'revision');
  const resourceRevision = store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n;
  for (let index = 0; index < 100; index++) store.db.prepare('UPDATE resource_files SET revision=revision WHERE owner_id=? AND course_id=?').run(owner, 'notification-fixture');
  assert.equal(store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n, resourceRevision, 'unchanged resource indexing must not self-invalidate catalog');
  store.db.prepare('UPDATE resource_files SET revision=? WHERE owner_id=? AND course_id=?').run('changed', owner, 'notification-fixture');
  assert.ok(store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n > resourceRevision);
  store.db.prepare('DELETE FROM resource_files WHERE owner_id=? AND course_id=?').run(owner, 'notification-fixture');
  store.db.prepare('INSERT INTO resource_folders(owner_id,folder_id,project_id,path) VALUES(?,?,?,?)').run(owner, 987654321, 'notification-project', 'folder');
  const folderRevision = store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n;
  store.db.prepare('UPDATE resource_folders SET path=path WHERE owner_id=? AND folder_id=?').run(owner, 987654321);
  assert.equal(store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n, folderRevision);
  store.db.prepare('UPDATE resource_folders SET path=? WHERE owner_id=? AND folder_id=?').run('renamed', owner, 987654321);
  assert.ok(store.db.prepare('SELECT MAX(revision) AS n FROM client_changes').get().n > folderRevision);
  store.db.prepare('DELETE FROM resource_folders WHERE owner_id=? AND folder_id=?').run(owner, 987654321);
  const recordsControl = new AbortController();
  const recordStream = ctx.remote.clientRuntime.watchRecords(0, recordsControl.signal)[Symbol.asyncIterator]();
  let recordPage = (await deadline(recordStream.next(), 'records opening cursor')).value;
  while (recordPage.more) recordPage = (await deadline(recordStream.next(), 'records bounded baseline')).value;
  const recordCursor = recordPage.cursor;
  const recordCommand = { operationId: 'records-atomic-operation-0001', edits: [
    { mutationId: 'records-mutation-0001', kind: 'studyTime', date: '2026-11-03', seconds: 60, updatedAt: Date.now() },
  ] };
  const committedRecords = await ctx.remote.clientRuntime.editLearning(recordCommand);
  assert.equal(committedRecords.ok, true, JSON.stringify(committedRecords));
  assert.deepEqual(await ctx.remote.clientRuntime.editLearning(recordCommand), committedRecords, 'lost response reuses durable transaction receipt');
  assert.equal(new CloudRecords(store).get(owner, 'studyDays', '2026-11-03').seconds, 60, 'retry never doubles additive learning time');
  const pushedRecords = (await deadline(recordStream.next(), 'record change pushed without HTTP poll')).value;
  assert.ok(pushedRecords.records.some(row => row.table === 'studyDays' && row.value.seconds === 60));
  assert.ok(pushedRecords.cursor > recordCursor);
  const recordConflict = await ctx.remote.clientRuntime.editLearning({ ...recordCommand, edits: recordCommand.edits.map(m => ({ ...m, seconds: 120 })) });
  assert.equal(recordConflict.ok, false);
  assert.equal(recordConflict.error.code, 'client/conflict');
  const badTransaction = await ctx.remote.clientRuntime.editLearning({ operationId: 'records-atomic-invalid-0001', edits: [
    { mutationId: 'records-rollback-first', kind: 'studyTime', date: '2026-11-04', seconds: 10, updatedAt: Date.now() },
    { mutationId: 'records-rollback-bad', kind: 'studyTime', date: 'bad', seconds: 10, updatedAt: Date.now() },
  ] });
  assert.equal(badTransaction.ok, false);
  assert.equal(new CloudRecords(store).get(owner, 'studyDays', '2026-11-04'), null, 'failed transaction rolls all business rows back');
  assert.equal((await ctx.remote.clientRuntime.receipt('records-atomic-invalid-0001')).value.status, 'missing', 'no committed receipt for rolled back business transaction');
  recordsControl.abort();
  await deadline(recordStream.return(), 'records observation released');
  const firstTurnSessionId = 779011, messageId = 779012;
  const conversation = { operationId: 'learning-dependent-documents-0001', edits: [
    { mutationId: 'learning-new-session', kind: 'conversationSession', expected: null, value: { id: firstTurnSessionId, videoId: markdownId, title: 'Atomic first turn', createdAt: 1 } },
    { mutationId: 'learning-first-message', kind: 'conversationMessage', expected: null, value: { id: messageId, sessionId: firstTurnSessionId, videoId: markdownId, role: 'user', content: 'Retained first turn', createdAt: 2 } },
  ] };
  const conversationResult = await ctx.remote.clientRuntime.editLearning(conversation);
  assert.equal(conversationResult.ok, true, JSON.stringify(conversationResult));
  assert.deepEqual(await ctx.remote.clientRuntime.editLearning(conversation), conversationResult);
  assert.equal(new CloudRecords(store).get(owner, 'chats', messageId).content, 'Retained first turn');
  const deniedLearning = await ctx.remote.clientRuntime.editLearning({ operationId: 'learning-task-authority-denied-001', edits: [
    { mutationId: 'learning-forged-task', kind: 'conversationMessage', expected: null, value: { id: 779013, sessionId: firstTurnSessionId, videoId: markdownId, role: 'assistant', taskId: 'forged-task', content: 'Denied', createdAt: 3 } },
  ] });
  assert.equal(deniedLearning.ok, false);
  assert.equal(new CloudRecords(store).get(owner, 'chats', 779013), null);
  const testSkill = { id: 779014, name: 'Domain Reference Skill', description: 'Retains reference documents', body: 'Original skill body', enabled: 1, builtin: 0, updatedAt: 1 };
  const skillPackage = await ctx.remote.clientRuntime.editLearning({ operationId: 'learning-skill-package-000001', edits: [
    { mutationId: 'learning-skill-definition', kind: 'skillDefinition', expected: null, value: testSkill },
    { mutationId: 'learning-skill-reference', kind: 'skillReference', expected: null, value: { id: 779015, skillId: testSkill.id, path: 'references/guide.md', body: '# Retained guide' } },
  ] });
  assert.equal(skillPackage.ok, true, JSON.stringify(skillPackage));
  const skillPath = store.db.prepare('SELECT slug FROM system_skill_bindings WHERE owner_id=? AND skill_id=?').get(owner, testSkill.id).slug;
  const skillDirectory = new SystemMaterials(store).list(owner, `/system/skills/${skillPath}`);
  assert.ok(skillDirectory.directories.includes(`/system/skills/${skillPath}/references`), JSON.stringify(skillDirectory));
  const skillDocument = new SystemMaterials(store).read(owner, `/system/skills/${skillPath}/SKILL.md`);
  new SystemMaterials(store).save(owner, skillDocument.path, skillDocument.content.replace('Original skill body', 'Edited body'), skillDocument.content, skillDocument.revision);
  assert.equal(new SystemMaterials(store).read(owner, `/system/skills/${skillPath}/references/guide.md`).content, '# Retained guide');
  const request = { kind: 'plugin', pluginId: 'todo', instanceId: 'legacy-todo', revision: files.plugin(owner, 'todo').revision, method: 'state.read', args: {} };
  const control = new AbortController();
  const first = ctx.remote.clientRuntime.watch(request, control.signal)[Symbol.asyncIterator]();
  const second = ctx.remote.clientRuntime.watch({ kind: 'catalog' }, control.signal)[Symbol.asyncIterator]();
  const initial = (await deadline(first.next(), 'state baseline')).value;
  await deadline(second.next(), 'catalog baseline');
  assert.equal(sockets, 1, 'logical streams must share the authenticated socket');
  const previous = initial.value;
  const command = { operationId: 'runtime-test-operation-0001', pluginId: 'todo', instanceId: 'legacy-todo', revision: request.revision,
    method: 'state.write', args: { data: { items: [{ id: 'one', title: 'Shared stream', done: false }] }, expected: previous.content, revision: previous.revision } };
  const result = await ctx.remote.clientRuntime.command(command);
  assert.equal(result.ok, true, JSON.stringify(result));
  const changed = (await deadline(first.next(), 'committed update')).value;
  assert.equal(changed.type, 'delta');
  assert.equal(changed.baseRevision, initial.revision);
  assert.equal(JSON.parse(applyRuntimePatch(initial.value, changed.changes).content).items[0].title, 'Shared stream');
  assert.ok(changed.revision > initial.revision);
  assert.deepEqual(await ctx.remote.clientRuntime.command(command), result, 'retry returns original durable receipt');
  assert.deepEqual(await ctx.remote.clientRuntime.receipt(command.operationId), { ok: true, value: { status: 'completed', value: result.value } }, 'response loss is reconciled without invoking the command');
  assert.deepEqual(await ctx.remote.clientRuntime.receipt('missing-operation-00001'), { ok: true, value: { status: 'missing' } });
  const conflict = await ctx.remote.clientRuntime.command({ ...command, args: { ...command.args, data: {} } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'client/conflict');
  const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
  const { BotMessageHistory } = await import('../apps/api/src/agent/message-history.ts');
  const bot = new BotApplicationService(store, { enqueue() {}, cancel() {} });
  const thread = bot.create(owner, 'bot', 'Shared journal');
  bot.append(thread.id, 'user', 'text', 'Baseline');
  const baseline = new BotMessageHistory(store).snapshot(thread.id);
  bot.append(thread.id, 'assistant', 'text', 'Committed before subscribe');
  const journalControl = new AbortController();
  const journal = ctx.remote.clientRuntime.watchBot(thread.id, baseline.eventCursor, journalControl.signal)[Symbol.asyncIterator]();
  assert.equal((await deadline(journal.next(), 'journal ready')).value.type, 'ready');
  const replayed = (await deadline(journal.next(), 'snapshot-open race replay')).value;
  assert.equal(replayed.type, 'event');
  assert.equal(replayed.event.message.content, 'Committed before subscribe');
  bot.append(thread.id, 'assistant', 'text', 'Live durable event');
  const pushed = (await deadline(journal.next(), 'live journal')).value;
  assert.equal(pushed.event.message.content, 'Live durable event');
  assert.ok(pushed.cursor > replayed.cursor);
  assert.equal(sockets, 1, 'Bot journal and plugin streams share the same socket');
  journalControl.abort(); await deadline(journal.return?.(), 'journal release');
  const resumedControl = new AbortController();
  const resumed = ctx.remote.clientRuntime.watchBot(thread.id, replayed.cursor, resumedControl.signal)[Symbol.asyncIterator]();
  await deadline(resumed.next(), 'resumed ready');
  assert.deepEqual((await deadline(resumed.next(), 'durable resume')).value, pushed);
  resumedControl.abort(); await deadline(resumed.return?.(), 'resumed release');
  store.db.prepare('INSERT INTO client_journal_floors(owner_id,thread_id,cursor) VALUES(?,?,?)').run(owner, thread.id, pushed.cursor);
  const expiredControl = new AbortController();
  const expired = ctx.remote.clientRuntime.watchBot(thread.id, baseline.eventCursor, expiredControl.signal)[Symbol.asyncIterator]();
  assert.equal((await deadline(expired.next(), 'expired journal cursor')).value.event.type, 'resync.required');
  expiredControl.abort(); await deadline(expired.return?.(), 'expired release');
  control.abort();
  await deadline(first.return?.(), 'state cancellation');
  await deadline(second.return?.(), 'catalog cancellation');
  await ctx.fiber.dispose();
  const peers = [];
  runtime = await createClientRuntime({ server: base, account: owner, scope: 'account' }, { interactions: 'answer', transport: {
    fetch: (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init?.headers, cookie } }), streamBaseUrl: base,
    createWebSocket: url => { const socket = new WebSocket(url, { headers: { cookie, origin: base } }); peers.push(socket); return socket; },
  } });
  const model = runtime.plugin(request);
  assert.equal(model, runtime.plugin(request), 'same resource shares the projection');
  const until = async predicate => {
    if (predicate()) return;
    let off;
    try { await deadline(new Promise(resolve => { off = model.subscribe(() => { if (predicate()) resolve(); }); }), 'model update'); }
    finally { off?.(); }
  };
  const releases = [model.acquire(), model.acquire(), model.acquire()];
  await until(() => model.getSnapshot().status === 'ready');
  assert.equal(peers.length, 1);
  assert.equal(model.diagnostics().refs, 3);
  const beforeDisconnect = model.getSnapshot();
  peers[0].terminate();
  await until(() => model.getSnapshot().status === 'reconnecting');
  assert.equal(model.getSnapshot().data, beforeDisconnect.data, 'disconnect retains stale projection');
  await until(() => model.getSnapshot().status === 'ready');
  assert.equal(model.getSnapshot().data, beforeDisconnect.data, 'equivalent reconnect baseline keeps entity references');
  assert.ok(runtime.diagnostics().generation >= 2);
  for (const release of releases) { release(); release(); }
  assert.equal(model.diagnostics().active, false);
  for (let index = 0; index < 100; index++) { const release = model.acquire(); release(); }
  assert.deepEqual(model.diagnostics(), { refs: 0, listeners: 0, active: false, revision: model.getSnapshot().revision });
  const batchRequest = { kind: 'pluginQueries', pluginId: request.pluginId, instanceId: request.instanceId, revision: request.revision,
    queries: [{ key: 'state', method: 'state.read', args: {} }, { key: 'copy', method: 'state.read', args: {} }] };
  const batch = runtime.plugin(batchRequest);
  assert.equal(batch, runtime.plugin(structuredClone(batchRequest)), 'equal composite projections share one model');
  const waitModel = async (target, predicate, label) => {
    let off;
    try { await deadline(new Promise(resolve => {
      if (predicate()) { resolve(); return; }
      off = target.subscribe(() => { if (predicate()) resolve(); });
    }), label); } finally { off?.(); }
  };
  const batchReleases = [batch.acquire(), batch.acquire(), batch.acquire()];
  await waitModel(batch, () => batch.getSnapshot().status === 'ready', 'composite baseline');
  assert.equal(batch.diagnostics().refs, 3);
  assert.deepEqual(batch.getSnapshot().data.state, batch.getSnapshot().data.copy);
  const batchBefore = batch.getSnapshot();
  await runtime.command({ ...command, operationId: 'runtime-composite-operation-0001', args: {
    data: { items: [] }, expected: batchBefore.data.state.content, revision: batchBefore.data.state.revision,
  } });
  await waitModel(batch, () => batch.getSnapshot().revision > batchBefore.revision, 'composite delta');
  assert.equal(JSON.parse(batch.getSnapshot().data.state.content).items.length, 0);
  assert.deepEqual(batch.getSnapshot().data.state, batch.getSnapshot().data.copy);
  assert.ok(batch.getSnapshot().revision > batchBefore.revision);
  for (const release of batchReleases) { release(); release(); }
  assert.equal(batch.diagnostics().active, false);
  assert.equal(batch.diagnostics().refs, 0);
  for (const queries of [[], Array.from({ length: 9 }, (_, i) => ({ key: `q${i}`, method: 'state.read', args: {} })),
    [batchRequest.queries[0], batchRequest.queries[0]], [{ key: 'invalid.key', method: 'state.read', args: {} }]]) {
    await assert.rejects(runtime.read({ ...batchRequest, queries }), error => error.code === 'client/domain');
  }
  assert.equal(Object.keys((await runtime.read({ ...batchRequest, queries: Array.from({ length: 8 }, (_, i) => ({ key: `q${i}`, method: 'state.read', args: {} })) })).value).length, 8);
  await assert.rejects(runtime.read({ ...batchRequest, queries: [{ key: 'write', method: 'state.write', args: { data: {} } }] }), error => error.code === 'client/forbidden');
  assert.equal((await runtime.read(request)).value.content, batch.getSnapshot().data.state.content, 'observing a write must not mutate state');
  const at = new Date().toISOString();
  const sessionRecords = new CloudRecords(store);
  const sessionId = 83000001;
  sessionRecords.apply(owner, [{ id: 'session-projection-fixture', table: 'chatSessions', key: sessionId, before: null, after: { id: sessionId, title: 'Typed session', createdAt: 1 } },
    ...Array.from({ length: 55 }, (_, index) => ({ id: `session-message-${index}`, table: 'chats', key: 84000000 + index, before: null,
      after: { id: 84000000 + index, sessionId, role: index % 2 ? 'assistant' : 'user', content: `history ${index}`, createdAt: index } }))]);
  const sessionModel = runtime.session(sessionId);
  assert.equal(sessionModel, runtime.session(sessionId));
  const sessionRelease = [sessionModel.acquire(), sessionModel.acquire()];
  await waitModel(sessionModel, () => sessionModel.getSnapshot().status === 'ready', 'typed session opening');
  const sessionProjection = sessionModel.projection();
  assert.equal(sessionProjection.rows.length, 40);
  assert.equal(sessionProjection.hasOlder, true);
  assert.equal(sessionProjection.rows[0].content, 'history 15');
  const olderSession = await runtime.read({ kind: 'session', sessionId, before: { id: sessionProjection.rows[0].id, createdAt: sessionProjection.rows[0].createdAt } });
  assert.equal(olderSession.value.rows.length, 15);
  assert.equal(olderSession.value.hasOlder, false);
  const tiedSessionId = 83000002;
  sessionRecords.apply(owner, [{ id: 'session-tied-fixture', table: 'chatSessions', key: tiedSessionId, before: null, after: { id: tiedSessionId, title: 'Tied timestamps', createdAt: 1 } },
    ...Array.from({ length: 42 }, (_, index) => ({ id: `session-tied-${index}`, table: 'chats', key: 86000000 + index, before: null,
      after: { id: 86000000 + index, sessionId: tiedSessionId, role: index % 2 ? 'user' : 'assistant', content: `tied ${index}`, createdAt: 1 } }))]);
  const tiedPage = await runtime.sessionPage(tiedSessionId);
  const tiedFirst = tiedPage.rows[0];
  const tiedOlder = await runtime.sessionPage(tiedSessionId, { id: tiedFirst.id, createdAt: tiedFirst.createdAt, role: tiedFirst.role });
  const tiedRows = [...tiedOlder.rows, ...tiedPage.rows];
  assert.equal(tiedRows.length, 42);
  assert.equal(new Set(tiedRows.map(row => row.id)).size, 42, 'role-aware keyset ties neither duplicate nor omit history');
  assert.deepEqual(tiedRows.map(row => row.role), [...Array(21).fill('user'), ...Array(21).fill('assistant')]);
  const sessionRevision = sessionModel.getSnapshot().revision;
  sessionRecords.apply(owner, [{ id: 'session-message-pushed', table: 'chats', key: 85000000, before: null,
    after: { id: 85000000, sessionId, role: 'assistant', content: 'pushed conversation history', createdAt: 60 } }]);
  await waitModel(sessionModel, () => sessionModel.getSnapshot().revision > sessionRevision, 'session history pushed');
  assert.equal(sessionModel.projection().rows.at(-1).content, 'pushed conversation history');
  const taskCommand = { operationId: 'session-admission-00000001', kind: 'chat', resource: `session:${sessionId}`, input: { sessionId, text: 'typed admission only' } };
  const admitted = await runtime.submitTask(taskCommand);
  assert.deepEqual(await runtime.taskAdmission(taskCommand.operationId), { status: 'accepted', task: admitted });
  assert.deepEqual(await runtime.taskAdmission('never-admitted-command'), { status: 'missing' });
  assert.equal(admitted.input.sessionId, sessionId);
  assert.equal((await runtime.submitTask(taskCommand)).id, admitted.id, 'lost task response returns same task without another submission');
  await assert.rejects(runtime.submitTask({ ...taskCommand, input: { ...taskCommand.input, text: 'changed' } }), error => error.code === 'client/conflict');
  await waitModel(sessionModel, () => sessionModel.projection()?.tasks.some(task => task.id === admitted.id), 'session task admission pushed');
  for (const release of sessionRelease) release();
  assert.equal(sessionModel.diagnostics().active, false);
  console.log('PASS: typed bounded SessionModel history, pagination, pushed rows/tasks, shared lifetime and durable task admission nonce');
  const taskList = runtime.tasks();
  assert.equal(taskList, runtime.tasks(), 'account task list shares one model');
  const releaseList = [taskList.acquire(), taskList.acquire(), taskList.acquire()];
  await waitModel(taskList, () => taskList.getSnapshot().status === 'ready', 'task list baseline');
  assert.equal(taskList.diagnostics().refs, 3);
  const listBefore = taskList.getSnapshot();
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,'transcribe','fixture','{}','queued','browser',?,?)")
    .run('runtime-task', owner, 'runtime-task-nonce', at, at);
  await waitModel(taskList, () => taskList.getSnapshot().revision > listBefore.revision, 'task list insert');
  assert.equal(taskList.tasks().find(task => task.id === 'runtime-task').status, 'queued');
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('other-task-owner', 'Other', at);
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('private-other-task','other-task-owner','private-other-task','qa','fixture','{}','queued','browser',?,?)").run(at, at);
  assert.ok((await runtime.read({ kind: 'tasks' })).value.tasks.every(task => task.id !== 'private-other-task'), 'account task list excludes other owners');
  const taskModel = runtime.task('runtime-task');
  const waiterControl = new AbortController();
  let observed;
  const waitingBaseline = new Promise(resolve => { observed = resolve; });
  const cancelledWait = taskModel.wait(waiterControl.signal, () => observed());
  const rejected = assert.rejects(cancelledWait, /Abort|observation_cancelled/);
  const retainedWait = taskModel.wait();
  await deadline(waitingBaseline, 'task baseline');
  assert.equal(taskModel.diagnostics().refs, 2);
  waiterControl.abort(); await rejected;
  assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get('runtime-task').status, 'queued', 'cancel observation never cancels a durable task');
  assert.equal(taskModel.diagnostics().refs, 1);
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result='42',updated_at=? WHERE id=?").run(new Date().toISOString(), 'runtime-task');
  assert.equal((await deadline(retainedWait, 'task completion')).result, 42);
  await waitModel(taskList, () => taskList.tasks()?.find(task => task.id === 'runtime-task')?.result === 42, 'task list terminal');
  assert.equal(taskModel.diagnostics().refs, 0);
  const records = new CloudRecords(store);
  const notifications = () => store.db.prepare('SELECT COUNT(*) AS n FROM client_changes').get().n;
  const beforeRollback = notifications();
  assert.throws(() => store.transaction(() => {
    store.db.prepare("INSERT INTO plugin_practice_submissions(id,owner_id,row_id,question_index) VALUES('rolled-back-submission',?,991,0)").run(owner);
    throw new Error('rollback-test');
  }), /rollback-test/);
  assert.equal(notifications(), beforeRollback, 'rolled-back learning mutations never publish notifications');
  store.db.prepare("INSERT INTO plugin_practice_submissions(id,owner_id,row_id,question_index) VALUES('pushed-submission',?,991,0)").run(owner);
  store.db.prepare("UPDATE plugin_practice_submissions SET delivered_at=? WHERE id='pushed-submission'").run(at);
  store.db.prepare("DELETE FROM plugin_practice_submissions WHERE id='pushed-submission'").run();
  assert.equal(notifications(), beforeRollback + 3, 'submission insert/delivery/delete each have a durable notification');
  records.apply(owner, ['scope-a', 'scope-b'].map(id => ({ id: `seed-${id}`, table: 'videos', key: id, before: null, after: { id, name: id } })));
  const layoutDocument = files.layout(owner), layout = JSON.parse(layoutDocument.content);
  layout.instances.push({ id: 'material-task-watch', pluginId: 'tasks', scope: { kind: 'material', id: 'scope-a' } });
  files.save(owner, layoutDocument.path, JSON.stringify(layout), layoutDocument.content, layoutDocument.revision);
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES('scope-task',?,'scope-task','transcribe','scope-a',?,'queued','browser',?,?)")
    .run(owner, JSON.stringify({ videoId: 'scope-a' }), at, at);
  const scopedRequest = { kind: 'plugin', pluginId: 'tasks', instanceId: 'material-task-watch', revision: files.plugin(owner, 'tasks').revision, method: 'tasks.get', args: { id: 'scope-task' } };
  assert.equal((await runtime.read(scopedRequest)).value.id, 'scope-task');
  const scopedModel = runtime.plugin(scopedRequest);
  const scopedUntil = async predicate => {
    let off;
    try { await deadline(new Promise(resolve => {
      if (predicate()) { resolve(); return; }
      off = scopedModel.subscribe(() => { if (predicate()) resolve(); });
    }), 'scoped task projection'); }
    finally { off?.(); }
  };
  const releaseScoped = scopedModel.acquire();
  await scopedUntil(() => scopedModel.getSnapshot().status === 'ready');
  const scopedBatchRequest = { kind: 'pluginQueries', pluginId: scopedRequest.pluginId, instanceId: scopedRequest.instanceId, revision: scopedRequest.revision,
    queries: [{ key: 'task', method: 'tasks.get', args: scopedRequest.args }] };
  const scopedBatch = runtime.plugin(scopedBatchRequest), releaseScopedBatch = scopedBatch.acquire();
  await waitModel(scopedBatch, () => scopedBatch.getSnapshot().status === 'ready', 'scoped composite baseline');
  store.db.prepare("UPDATE cloud_tasks SET input=? WHERE id='scope-task'").run(JSON.stringify({ videoId: 'scope-b' }));
  await scopedUntil(() => scopedModel.getSnapshot().status === 'error');
  await waitModel(scopedBatch, () => scopedBatch.getSnapshot().status === 'error', 'scoped composite revocation');
  await assert.rejects(runtime.read(scopedRequest), error => error.code === 'client/domain');
  await assert.rejects(runtime.read(scopedBatchRequest), error => error.code === 'client/domain');
  releaseScopedBatch();
  releaseScoped();
  for (const release of releaseList) { release(); release(); }
  assert.equal(taskList.diagnostics().active, false);
  assert.equal(scopedModel.diagnostics().active, false, 'scope-denied observation is released independently of durable work');
  const { PluginService } = await import('../apps/api/src/plugins/service.ts');
  const { ClientRuntimeDomain } = await import('../apps/api/src/realtime/domain.ts');
  const racePlugins = new PluginService(store), raceDomain = new ClientRuntimeDomain(store, racePlugins);
  try {
    for (const composite of [false, true]) {
      let finish;
      const gate = new Promise(resolve => { finish = resolve; });
      const handler = { id: 'state.delayed', capability: 'state', access: 'read', schema: { type: 'object', additionalProperties: false }, run: () => gate };
      const off = racePlugins.register(handler);
      const delayed = composite ? { ...batchRequest, queries: [{ key: 'delayed', method: handler.id, args: {} }] }
        : { ...request, method: handler.id };
      const pending = raceDomain.read(owner, delayed);
      const rejected = assert.rejects(pending, error => error.details?.code === 'plugin_changed');
      off();
      const replacement = racePlugins.register(handler);
      finish({ secret: 'old-incarnation-result' });
      await rejected;
      replacement();
    }
    {
      let finish;
      const gate = new Promise(resolve => { finish = resolve; });
      const early = { id: 'state.early', capability: 'state', access: 'read', schema: { type: 'object', additionalProperties: false }, run: () => ({ secret: 'early-result' }) };
      const offEarly = racePlugins.register(early);
      const offLate = racePlugins.register({ ...early, id: 'state.late', run: () => gate });
      const pending = raceDomain.read(owner, { ...batchRequest, queries: [{ key: 'early', method: 'state.early', args: {} }, { key: 'late', method: 'state.late', args: {} }] });
      const rejected = assert.rejects(pending, error => error.details?.code === 'plugin_changed');
      await Promise.resolve(); // Early read has returned while the second query is still pending.
      offEarly();
      const replacement = racePlugins.register(early);
      finish({ value: 'late-result' });
      await rejected;
      replacement(); offLate();
    }
    let finish;
    const gate = new Promise(resolve => { finish = resolve; });
    const off = racePlugins.register({ id: 'state.delayed', capability: 'state', access: 'read', schema: { type: 'object', additionalProperties: false }, run: () => gate });
    const abort = new AbortController();
    const stream = raceDomain.watch(owner, { ...request, method: 'state.delayed' }, abort.signal)[Symbol.asyncIterator]();
    const pending = stream.next();
    abort.abort();
    assert.equal((await deadline(pending, 'cancel unresolved async baseline')).done, true, 'cancel during async baseline yields no late frame without waiting for provider');
    assert.equal(raceDomain.diagnostics().subscriptions, 0);
    finish({ secret: 'cancelled-read-result' });
    off();
    let dispatches = 0;
    const stopFault = racePlugins.register({ id: 'state.fault', capability: 'state', access: 'write', schema: { type: 'object', additionalProperties: false }, run: () => {
      dispatches++;
      new CloudRecords(store).apply(owner, [{ id: 'fault-evidence-write', table: 'preferences', key: 'fault-evidence', before: null, after: { id: 'fault-evidence', value: 'committed' } }]);
      throw new Error('response_after_side_effect_failed');
    } });
    const faultCommand = { ...command, operationId: 'runtime-fault-after-dispatch', method: 'state.fault', args: {} };
    await assert.rejects(raceDomain.command(owner, faultCommand), error => error.code === 'client/uncertain');
    assert.equal((await raceDomain.receipt(owner, faultCommand.operationId)).status, 'uncertain');
    await assert.rejects(raceDomain.command(owner, faultCommand), error => error.code === 'client/uncertain');
    assert.equal(dispatches, 1, 'uncertain side effects are never replayed');
    assert.equal(new CloudRecords(store).get(owner, 'preferences', 'fault-evidence').value, 'committed');
    console.log('PASS: post-dispatch side-effect failure returns uncertain receipt and never replays the handler');
    stopFault();
    const stopAtomic = racePlugins.register({ id: 'state.atomic', capability: 'state', access: 'write', atomic: 'sqlite', schema: { type: 'object', additionalProperties: false }, run: () => {
      new CloudRecords(store).apply(owner, [{ id: 'atomic-rollback-write', table: 'preferences', key: 'atomic-rollback', before: null, after: { id: 'atomic-rollback', value: 'must roll back' } }]);
      throw new Error('injected_atomic_failure');
    } });
    const atomicCommand = { ...command, operationId: 'runtime-atomic-rollback', method: 'state.atomic', args: {} };
    await assert.rejects(raceDomain.command(owner, atomicCommand));
    assert.equal(new CloudRecords(store).get(owner, 'preferences', 'atomic-rollback'), null);
    assert.equal((await raceDomain.receipt(owner, atomicCommand.operationId)).status, 'failed');
    stopAtomic();

    let fileDispatches = 0;
    const resource = '/system/memory/atomic-command.md';
    store.systemFiles.write(owner, resource, 'atomic baseline');
    const stopFile = racePlugins.register({ id: 'state.atomic-file', capability: 'state', access: 'write', atomic: 'sqlite', schema: { type: 'object', additionalProperties: false }, run: () => {
      fileDispatches++;
      store.systemFiles.write(owner, resource, 'atomic retained draft', 'atomic baseline');
      return { written: true };
    } });
    const fileCommand = { ...command, operationId: 'runtime-atomic-file-conflict', method: 'state.atomic-file', args: {} };
    const flush = store.systemFiles.flush.bind(store.systemFiles);
    let injectConflict = true;
    try {
      store.systemFiles.flush = operation => {
        if (injectConflict && operation?.id === fileCommand.operationId) {
          injectConflict = false;
          fs.writeFileSync(path.join(directory, 'files/system-files', crypto.createHash('sha256').update(owner).digest('hex'), 'system/memory/atomic-command.md'), 'external edit after SQL commit');
        }
        return flush(operation);
      };
      await assert.rejects(raceDomain.command(owner, fileCommand), error => error.code === 'client/uncertain');
    } finally { store.systemFiles.flush = flush; }
    assert.equal((await raceDomain.receipt(owner, fileCommand.operationId)).code, 'file_intent_conflict');
    await assert.rejects(raceDomain.command(owner, fileCommand), error => error.code === 'client/uncertain');
    assert.equal(fileDispatches, 1, 'SQL-committed file handler is never dispatched twice');
    const intent = store.systemFiles.conflicts(owner).find(intent => intent.path === resource);
    store.systemFiles.resolve(owner, intent.id, 'external edit after SQL commit', 'retry');
    assert.deepEqual(await raceDomain.receipt(owner, fileCommand.operationId), { status: 'completed', value: { written: true } });
    assert.deepEqual(await raceDomain.command(owner, fileCommand), { written: true });
    assert.equal(fileDispatches, 1);
    stopFile();
    const stopCrash = racePlugins.register({ id: 'state.atomic-crash', capability: 'state', access: 'write', atomic: 'sqlite', schema: { type: 'object', additionalProperties: false }, run: () => {
      fileDispatches++;
      store.systemFiles.write(owner, resource, 'rename committed without receipt', 'atomic retained draft');
      return { renamed: true };
    } });
    const crashCommand = { ...command, operationId: 'runtime-atomic-file-fsync', method: 'state.atomic-crash', args: {} };
    const fsync = fs.fsyncSync;
    try {
      fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('injected_command_directory_fsync'); return fsync(fd); };
      await assert.rejects(raceDomain.command(owner, crashCommand), error => error.code === 'client/uncertain');
    } finally { fs.fsyncSync = fsync; }
    assert.equal(store.systemFiles.operationOutcome(owner, crashCommand.operationId), 'pending');
    assert.deepEqual(await raceDomain.receipt(owner, crashCommand.operationId), { status: 'completed', value: { renamed: true } });
    assert.deepEqual(await raceDomain.command(owner, crashCommand), { renamed: true });
    assert.equal(fileDispatches, 2, 'receipt recovery fsyncs a committed rename without rerunning its handler');
    stopCrash();
    const preferences = new CloudRecords(store);
    preferences.agentInstructions(owner);
    const instructionsBefore = preferences.get(owner, 'preferences', 'agentInstructions');
    const recordFileRequest = { operationId: 'runtime-records-file-conflict', changes: [{ key: 'agentInstructions', expected: instructionsBefore?.value ?? null,
      value: 'record intent retained instructions' }] };
    const flushRecords = store.systemFiles.flush.bind(store.systemFiles);
    let injectRecordConflict = true;
    try {
      store.systemFiles.flush = operation => {
        if (injectRecordConflict && operation?.id === recordFileRequest.operationId) {
          injectRecordConflict = false;
          fs.writeFileSync(path.join(directory, 'files/system-files', crypto.createHash('sha256').update(owner).digest('hex'), 'system/AGENTS.md'), 'external instructions after record commit');
        }
        return flushRecords(operation);
      };
      await assert.rejects(raceDomain.setPreferences(owner, recordFileRequest), error => error.code === 'client/uncertain');
    } finally { store.systemFiles.flush = flushRecords; }
    await assert.rejects(raceDomain.setPreferences(owner, recordFileRequest), error => error.code === 'client/uncertain');
    const recordFileIntent = store.systemFiles.conflicts(owner).find(intent => intent.operation_id === recordFileRequest.operationId);
    assert.ok(recordFileIntent, 'record file effects retain an operation-linked original intent');
    store.systemFiles.resolve(owner, recordFileIntent.id, 'external instructions after record commit', 'retry');
    assert.equal((await raceDomain.setPreferences(owner, recordFileRequest)).values.agentInstructions, 'record intent retained instructions');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM cloud_operations WHERE owner_id=? AND id=?').get(owner, recordFileRequest.operationId + ':0').n, 1);
    console.log('PASS: audited SQL command rollback and command/file-intent final receipts reconcile without repeated handlers');
  } finally { raceDomain.close(); await racePlugins.close(); }
  // Gate the production Host read, not a fake transport: a real HTTP command
  // commits while the WS opening snapshot is suspended after capturing data.
  const originalDomainRead = ClientRuntimeDomain.prototype.read;
  let releaseSnapshot, snapshotCaptured;
  const snapshotGate = new Promise(resolve => { releaseSnapshot = resolve; });
  const snapshotEntered = new Promise(resolve => { snapshotCaptured = resolve; });
  let gateFirstPreference = true, produced;
  ClientRuntimeDomain.prototype.read = async function(account, query) {
    const value = await originalDomainRead.call(this, account, query);
    if (query.kind === 'preferences' && account === owner) {
      if (gateFirstPreference) { gateFirstPreference = false; snapshotCaptured(); await snapshotGate; }
      produced?.(); produced = undefined;
    }
    return value;
  };
  const preferencesModel = runtime.preferences();
  let releasePreferences;
  try {
    releasePreferences = preferencesModel.acquire();
    await deadline(snapshotEntered, 'opening snapshot suspended after capture');
    const preferenceBefore = new CloudRecords(store).get(owner, 'preferences', 'theme')?.value ?? null;
    await runtime.setPreferences({ operationId: 'protocol-snapshot-concurrent-write', changes: [{ key: 'theme', expected: preferenceBefore, value: 'dark' }] });
    releaseSnapshot();
    await waitModel(preferencesModel, () => preferencesModel.getSnapshot().data?.values.theme === 'dark', 'write during snapshot follows opening baseline');
    const socket = peers.at(-1), beforeSlow = preferencesModel.getSnapshot();
    socket.pause();
    let expected = 'dark';
    for (let i = 0; i < 8; i++) {
      const serverProduced = new Promise(resolve => { produced = resolve; });
      const value = i % 2 ? 'dark' : 'light';
      await runtime.setPreferences({ operationId: `protocol-slow-consumer-write-${i}`, changes: [{ key: 'theme', expected, value }] });
      expected = value;
      await deadline(serverProduced, 'Host produced while actual WS reader paused');
    }
    assert.equal(preferencesModel.getSnapshot(), beforeSlow, 'paused real socket publishes no phantom consumer progress');
    socket.resume();
    await waitModel(preferencesModel, () => preferencesModel.getSnapshot().revision > beforeSlow.revision && preferencesModel.getSnapshot().data?.values.theme === expected, 'slow socket catches up to final committed projection');
    // Remove a committed invalidation before the pump reads it. Its successor
    // creates a real retained-cursor hole; observers must rebuild, not skip it.
    store.transaction(() => {
      store.db.prepare("INSERT INTO client_changes(owner_id,domain,entity) VALUES(?,'test-gap','retained-away')").run(owner);
      const hole = store.db.prepare('SELECT MAX(revision) n FROM client_changes').get().n;
      store.db.prepare('DELETE FROM client_changes WHERE revision=?').run(hole);
      new CloudRecords(store).apply(owner, [{ id: 'protocol-cursor-gap-write', table: 'preferences', key: 'theme', before: new CloudRecords(store).get(owner, 'preferences', 'theme'), after: { id: 'theme', value: 'auto' } }]);
    });
    await waitModel(preferencesModel, () => preferencesModel.getSnapshot().data?.values.theme === 'auto', 'retained invalidation gap rebuilds projection');
    console.log('PASS: real I/O snapshot/write race, paused WS slow consumer and retained invalidation cursor gap');
  } finally {
    releaseSnapshot(); peers.at(-1)?.resume(); releasePreferences?.(); ClientRuntimeDomain.prototype.read = originalDomainRead;
  }
  const originalDomainWatch = ClientRuntimeDomain.prototype.watch;
  try {
    for (const fault of ['duplicate', 'out-of-order', 'missing-base']) {
      let inject = true, opening;
      ClientRuntimeDomain.prototype.watch = async function* (account, query, signal) {
        for await (const frame of originalDomainWatch.call(this, account, query, signal)) {
          yield frame;
          if (inject && account === owner && query.kind === 'preferences' && frame.type === 'snapshot') {
            inject = false; opening = frame;
            // Production Host -> generated output codec -> real multiplexed WS
            // -> production model. No fake model/source/parser involved.
            yield { type: 'delta', baseRevision: fault === 'missing-base' ? frame.revision + 1 : frame.revision,
              revision: fault === 'duplicate' ? frame.revision : fault === 'out-of-order' ? frame.revision - 1 : frame.revision + 2,
              changes: [] };
          }
        }
      };
      const release = preferencesModel.acquire();
      try {
        await waitModel(preferencesModel, () => preferencesModel.getSnapshot().status === 'error', `${fault} frame surfaces protocol error`);
        assert.equal(preferencesModel.getSnapshot().error, 'protocol_revision_gap');
        assert.equal(preferencesModel.getSnapshot().revision, opening.revision, `${fault} must not advance applied cursor`);
        assert.deepEqual(preferencesModel.getSnapshot().data, opening.value, `${fault} must not corrupt published baseline`);
        preferencesModel.refresh();
        await waitModel(preferencesModel, () => preferencesModel.getSnapshot().status === 'ready', `${fault} explicit recovery opens fresh snapshot consumer`);
        assert.equal(preferencesModel.getSnapshot().data.values.theme, 'auto');
      } finally { release(); }
    }
    console.log('PASS: real codec/WS duplicate, out-of-order and missing-base rejection; explicit fresh-consumer recovery');
  } finally { ClientRuntimeDomain.prototype.watch = originalDomainWatch; }
  const disposalModel = runtime.task('runtime-task-pending');
  let recordsReady;
  const recordsOpened = new Promise(resolve => { recordsReady = resolve; });
  runtime.followRecords({ cursor: async () => 0, apply: async () => { recordsReady(); }, failed: error => { throw error; } });
  await deadline(recordsOpened, 'production records follower opening before account disposal');
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,'transcribe','fixture','{}','queued','browser',?,?)")
    .run('runtime-task-pending', owner, 'runtime-task-pending-nonce', at, at);
  const socketClosed = new Promise(resolve => peers.at(-1).once('close', resolve));
  store.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run(new Date(Date.now() - 1000).toISOString(), owner);
  await deadline(socketClosed, 'automatic account credential expiry closes active peer');
  const expiredHttp = await fetch(new URL('/api/clientRuntime/read', base), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(expiredHttp.status, 401, 'expired credential cannot start a unary request');
  const disposalWait = disposalModel.wait();
  const disposedWait = assert.rejects(disposalWait, /client_model_disposed/);
  await deadline(runtime.dispose(), 'runtime disposal with active records follower');
  await disposedWait;
  assert.throws(() => runtime.task('old-account'), /disposed/);
  console.log('PASS: real Typert HTTP, auth/origin, shared WebSocket, committed update, durable receipt and cancellation');
  console.log('PASS: shared React-free projection, stale reconnect, stable references, 100 retain/release cycles and disposed-account guard');
  console.log('PASS: typed TaskModel shared waiters, observer cancellation without task cancellation, pushed terminal result and account disposal');
  console.log('PASS: typed shared TaskListModel receives inserted tasks and terminal deltas, with idempotent release');
  console.log('PASS: plugin-scoped tasks.get projection rechecks taskAllowed on every invalidation and rejects cross-material task access');
  console.log('PASS: bounded composite queries share a model, apply pushed deltas, reject writes/invalid keys and recheck material scope on updates');
  console.log('PASS: async single/composite reads reject replaced registration incarnations and cancelled baselines publish no frame');
} finally {
  await runtime?.dispose();
  await ctx.fiber.dispose();
  store?.close();
  await app.close();
}
