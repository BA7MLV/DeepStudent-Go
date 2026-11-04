import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket from 'ws';
import { createExecutorRuntime, createClientRuntime } from '@wangke/client-core';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/executor-interactions-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
const runtimes = [], sockets = [], followers = [];
let store;
const bounded = promise => Promise.race([promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('interaction timeout')), 12000); timer.unref(); })]);
try {
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'executor-interactions-password' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'executor-interactions-password' } });
  const owner = login.json().user.id, cookie = login.headers['set-cookie'].split(';')[0];
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const records = new CloudRecords(store), sessionId = 991;
  const session = { id: sessionId, videoId: '', title: 'Original snapshot', createdAt: 1 };
  const user = { id: 992, sessionId, videoId: '', role: 'user', content: 'Original question', createdAt: 2, explicitSkillIds: [7], attachments: [{ id: 'original-attachment', name: 'keep.txt', mimeType: 'text/plain', size: 3 }] };
  const answer = { id: 993, sessionId, videoId: '', role: 'assistant', content: 'Original result', createdAt: 3, interrupted: true, taskId: 'original-task', modelTrace: { messages: [{ role: 'assistant', content: 'Original snapshot' }] }, resume: { opaque: ['keep'] } };
  records.apply(owner, [{ table: 'chatSessions', key: sessionId, after: session }, ...[user, answer].map(after => ({ table: 'chats', key: after.id, after }))].map(row => ({ id: crypto.randomUUID(), before: null, ...row })));
  const create = async (action = 'continue', resource = `session:${sessionId}`) => {
    const taskId = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'chat',?,?,'running','browser',?,?,?,?)").run(taskId, owner, taskId, resource, JSON.stringify({ action, sessionId, rowId: answer.id }), workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), at, at);
    let dropReset = false;
    const options = { interactions: 'answer', transport: { streamBaseUrl: base,
      fetch: async (url, init) => {
        const result = await fetch(new URL(url, base), { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } });
        if (dropReset && String(url).endsWith('/resetConversation')) { dropReset = false; await result.arrayBuffer(); throw new Error('reset response lost'); }
        return result;
      },
      createWebSocket: url => { const socket = new WebSocket(url, ['wangke-executor', token], { headers: { cookie } }); sockets.push(socket); return socket; },
    } };
    const runtime = await createExecutorRuntime(taskId, options); runtimes.push(runtime);
    return { taskId, token, runtime, options, drop: () => { dropReset = true; } };
  };
  const continuing = await create();
  const request = { operationId: `reset-${crypto.randomUUID()}`, mode: 'continue' };
  continuing.drop();
  await assert.rejects(continuing.runtime.resetConversation(request), /reset response lost/);
  const reloaded = await createExecutorRuntime(continuing.taskId, continuing.options); runtimes.push(reloaded);
  const receipt = await reloaded.resetConversation(request);
  assert.deepEqual(receipt, { mode: 'continue', sessionId, target: answer, user, removed: [] });
  assert.deepEqual(records.get(owner, 'chats', answer.id), answer);
  await assert.rejects(reloaded.resetConversation({ ...request, operationId: `reset-${crypto.randomUUID()}` }), error => error.code === 'client/conflict');
  await assert.rejects(reloaded.resetConversation({ ...request, mode: 'retry' }), error => error.code === 'client/conflict');
  const wrongResource = await create('retry', 'session:other');
  await assert.rejects(wrongResource.runtime.resetConversation({ operationId: `reset-${crypto.randomUUID()}`, mode: 'retry' }), error => error.code === 'client/forbidden');
  const retry = await create('retry'), retryRequest = { operationId: `reset-${crypto.randomUUID()}`, mode: 'retry', permissionId: crypto.randomUUID() };
  await assert.rejects(retry.runtime.resetConversation(retryRequest), error => error.code === 'client/forbidden');
  store.db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,?,?,?,?)').run(retryRequest.permissionId, owner, retry.taskId, 'write', JSON.stringify({ tool: 'reset_chat_result', sessionId, rowId: answer.id, mode: 'retry' }), 'consumed', new Date().toISOString());
  retry.drop();
  await assert.rejects(retry.runtime.resetConversation(retryRequest), /reset response lost/);
  assert.equal(records.get(owner, 'chats', answer.id), null);
  const reset = await retry.runtime.resetConversation(retryRequest);
  assert.deepEqual(reset.removed, [user, answer]);
  assert.deepEqual(reset.target.modelTrace, answer.modelTrace);
  assert.deepEqual(reset.user.attachments, user.attachments);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(retry.taskId);
  assert.deepEqual(await retry.runtime.resetConversation(retryRequest), reset, 'terminal original receipt is readable, not a second deletion');

  const permissionId = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,?,?,?,?)').run(permissionId, owner, continuing.taskId, 'write', '{}', 'pending', new Date().toISOString());
  const approved = continuing.runtime.waitAuthorization(permissionId);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/cloud/permissions/${permissionId}/resolve`, headers: { cookie }, payload: { approved: true } })).statusCode, 200);
  assert.equal(await bounded(approved), 'approved', 'approval before/after subscription is recovered from SQL baseline');
  await assert.rejects(wrongResource.runtime.waitAuthorization(permissionId), /Permission task scope denied/);
  const waitingId = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,?,?,?,?)').run(waitingId, owner, continuing.taskId, 'write', '{}', 'pending', new Date().toISOString());
  const cancelWait = new AbortController();
  const cancelled = assert.rejects(continuing.runtime.waitAuthorization(waitingId, cancelWait.signal));
  cancelWait.abort(new Error('task cancelled during approval'));
  await bounded(cancelled);
  assert.equal(store.db.prepare('SELECT status FROM cloud_permissions WHERE id=?').get(waitingId).status, 'pending', 'cancelling observation never approves/consumes the permission');
  const account = await createClientRuntime({ server: base, account: owner, scope: 'forbidden-executor' }, continuing.options); runtimes.push(account);
  const tasks = account.tasks();
  let errorReady;
  const denied = bounded(new Promise(resolve => { errorReady = resolve; }));
  const off = tasks.subscribe(() => { if (tasks.getSnapshot().status === 'error') errorReady(tasks.getSnapshot()); });
  const release = tasks.acquire();
  assert.match((await denied).error, /scope|denied|forbidden/i, 'executor mux plus account Cookie cannot watch account tasks');
  release(); off();
  const mux = new URL('/api/remote.mux', base); mux.protocol = 'ws:';
  const refused = new WebSocket(mux, ['wangke-executor', 'unknown-capability'], { headers: { cookie } }); sockets.push(refused);
  const rejection = await bounded(new Promise((resolve, reject) => {
    refused.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    refused.on('open', () => reject(new Error('unknown executor borrowed Cookie principal')));
    refused.on('error', () => {});
  }));
  assert.equal(rejection, 403);

  const frames = [], errors = [];
  let arrival;
  const next = () => bounded(new Promise(resolve => { arrival = resolve; }));
  const follower = continuing.runtime.followInteractions(async frame => { frames.push(frame); arrival?.(frame); }, error => { errors.push(String(error)); arrival?.({ error: String(error) }); });
  followers.push(follower);
  if (!frames.length) await next();
  assert.equal(frames[0].type, 'baseline'); assert.deepEqual(frames[0].commands, []);
  const send = body => app.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${continuing.taskId}/commands`, headers: { cookie }, payload: body });
  const accountCall = async (method, request, headers = { cookie }) => {
    const response = await app.inject({ method: 'POST', url: `/api/clientRuntime/${method}`, headers, payload: { type: 'client-request', rpcId: crypto.randomUUID(), method: `clientRuntime/${method}`, payload: { args: { request } } } });
    return response.statusCode === 200 ? response.json().result : { ok: false, httpStatus: response.statusCode };
  };
  for (const [index, action] of ['answerAsk', 'confirmPlan', 'cancelPlan'].entries()) {
    const target = `row:${1000 + index}`;
    const ask = { question: 'Original question', type: 'single', options: [{ id: 'keep', label: 'Keep' }, { id: 'stop', label: 'Stop' }] };
    records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: 1000 + index, before: null, after: { id: 1000 + index, sessionId, videoId: '', role: 'assistant', content: '', createdAt: 10 + index, ...(action === 'answerAsk' ? { ask } : { folderPlan: { summary: 'Original plan', folders: [{ name: 'Original folder', courseIds: [] }], applied: 0 } }) } }]);
    await continuing.runtime.report({ view: action === 'answerAsk' ? { pendingAsk: { messageKey: target } } : { pendingPlan: { messageKey: target } } });
    const body = { nonce: crypto.randomUUID(), action, value: action === 'answerAsk' ? 'keep' : null };
    if (action === 'answerAsk') assert.equal((await send({ ...body, value: { selectedIds: ['unknown'] } })).statusCode, 400, 'invalid input never occupies this checkpoint');
    const pending = next();
    assert.equal((await send(body)).statusCode, 200);
    const frame = await pending;
    assert.equal(frame.type, 'commands'); assert.equal(frame.commands.length, 1);
    const command = frame.commands[0];
    assert.equal(command.target, target); assert.equal(command.action, action); assert.deepEqual(command.value, body.value);
    assert.equal((await send(body)).statusCode, 200, 'nonce is idempotent');
    assert.equal((await send({ ...body, value: 'changed' })).statusCode, 409);
    assert.equal((await send({ ...body, nonce: crypto.randomUUID() })).statusCode, 409, 'same target cannot be reanswered with another nonce');
    const begin = { sequence: command.sequence, phase: 'begin' };
    assert.equal((await continuing.runtime.deliverInteraction(begin)).phase, 'started');
    assert.equal((await continuing.runtime.deliverInteraction(begin)).phase, 'started', 'lost begin response retries SQL admission only');
    await assert.rejects(() => continuing.runtime.deliverInteraction({ ...begin, phase: 'applied' }), /effect receipt/);
    assert.equal((await continuing.runtime.deliverInteraction({ ...begin, phase: 'executing' })).phase, 'started');
    await assert.rejects(() => continuing.runtime.deliverInteraction({ ...begin, phase: 'executing' }), /already dispatched/);
    const inspectionRequest = { kind: 'interactionRecovery', taskId: continuing.taskId, sequence: command.sequence };
    const observed = await accountCall('read', inspectionRequest);
    const statusBeforeReconcile = store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(continuing.taskId).status;
    assert.equal(observed.ok, true); assert.equal(observed.value.value.disposition, 'uncertain');
    for (const action of ['resume', 'settle']) assert.equal((await accountCall('reconcileInteraction', { taskId: continuing.taskId, sequence: command.sequence, observed: observed.value.value.observed, action })).ok, false, 'executing without committed evidence cannot resume or settle');
    assert.equal((await accountCall('reconcileInteraction', { taskId: continuing.taskId, sequence: command.sequence, observed: 'stale-observation', action: 'hold' })).ok, false, 'observation CAS rejects stale user decision before freezing task');
    assert.equal((await accountCall('read', { ...inspectionRequest, taskId: wrongResource.taskId })).ok, false, 'sequence from another task is not transferable');
    assert.equal((await accountCall('read', inspectionRequest, {})).ok, false, 'anonymous cannot inspect snapshot');
    assert.equal((await accountCall('read', inspectionRequest, { cookie, authorization: `Bearer ${continuing.token}` })).ok, false, 'executor cannot borrow account cookie for reconciliation');
    assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(continuing.taskId).status, statusBeforeReconcile, 'failed reconciliation never mutates live task');
    const original = records.get(owner, 'chats', 1000 + index);
    if (action === 'confirmPlan') {
      const permissionId = crypto.randomUUID(), at = new Date().toISOString();
      store.db.prepare("INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,status,created_at) VALUES(?,?,?,'write',?,'consumed',?)").run(permissionId, owner, continuing.taskId, JSON.stringify({ tool: 'apply_folder_plan', plan: original.folderPlan }), at);
      await continuing.runtime.resourceCommand({ operationId: crypto.randomUUID(), permissionId, operation: { kind: 'organizeCourses', folders: original.folderPlan.folders } });
    }
    const { validateAskAnswer, askAnswerText } = await import('@wangke/study-core/ask-user');
    const answer = action === 'answerAsk' ? validateAskAnswer(ask, body.value) : undefined;
    const value = action === 'answerAsk' ? { ...original, ask: { ...ask, picked: askAnswerText(answer), answer } }
      : { ...original, folderPlan: { ...original.folderPlan, applied: action === 'confirmPlan' ? 1 : 2 } };
    await continuing.runtime.commitArtifacts(crypto.randomUUID(), [{ mutationId: crypto.randomUUID(), kind: 'conversationMessage', expected: original, value }]);
    assert.equal((await continuing.runtime.deliverInteraction({ ...begin, phase: 'applied' })).phase, 'applied');
    assert.equal((await continuing.runtime.deliverInteraction(begin)).phase, 'applied', 'final receipt forbids another callback');
    assert.equal(store.db.prepare('SELECT consumed FROM cloud_task_commands WHERE id=?').get(command.sequence).consumed, 1);
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  await follower.dispose();
  const again = next();
  const afterReconnect = reloaded.followInteractions(async frame => { arrival?.(frame); }, error => { errors.push(String(error)); }); followers.push(afterReconnect);
  assert.deepEqual((await again).commands, [], 'fresh baseline excludes all applied commands');
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${continuing.taskId}/commands/claim`, headers: { authorization: `Bearer ${continuing.token}` } })).statusCode, 404);
  await afterReconnect.dispose();
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, frames, errors, reset, checks: ['real-executor-mux-cookie-no-escalation', 'sequence-target', 'event-wake', 'all-three-actions', 'nonce-conflict', 'same-target-once', 'begin-final-receipts', 'reconnect-baseline', 'no-claim-endpoint', 'reset-lost-response-reload', 'snapshot-and-attachments', 'resource-permit-denied', 'terminal-original-receipt'] }, null, 2));
  console.log(`PASS: task reset and executor-only typed interaction stream (${directory})`);
} finally { for (const follower of followers) await follower.dispose(); for (const runtime of runtimes) await runtime.dispose(); for (const socket of sockets) socket.terminate(); store?.close(); await app.close(); }
