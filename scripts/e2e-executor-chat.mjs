import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';
import { fixtureDomain } from './fixture-domain.mjs';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/executor-chat-ui-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external requests forbidden'); } });
let vite, browser, store;
const checks = [];
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'executor-chat-password' } })).statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'executor-chat-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const records = new CloudRecords(store);
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'isolated-executor-chat', configureServer(server) { server.middlewares.use('/__harness', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Real executor chat</title>'); }); } }] });
  await vite.listen();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  let page = await context.newPage();
  const requests = [];
  page.on('request', request => { if (request.url().includes('/api/')) requests.push({ url: request.url(), method: request.method() }); });
  const enter = async capability => {
    await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__harness`);
    await page.evaluate(async capability => {
      const Socket = window.WebSocket;
      window.executorSockets = [];
      window.WebSocket = class extends Socket { constructor(...args) { super(...args); window.executorSockets.push(this); } };
      await (await import('/src/cloud/sync.ts')).startCloud(capability.owner, true);
      Object.assign((await import('/src/cloud/state.ts')).cloud, { taskId: capability.taskId, workerToken: capability.token });
      await (await import('/src/cloud/sync.ts')).flushCloud();
      const { useSettings } = await import('/src/store/settings.ts');
      useSettings.setState({ providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'local-only', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' }, thinkingEnabled: false });
      window.modelCalls = 0;
      const original = window.fetch;
      window.fetch = async (url, init) => {
        if (!String(url).startsWith('https://fixture.invalid')) return original(url, init);
        window.modelCalls++;
        const chunk = { id: 'local-completion', choices: [{ index: 0, delta: { content: ' completed by real Worker' }, finish_reason: null }] };
        return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      };
      await import('/src/cloud/worker.ts');
    }, capability);
  };
  for (const [index, scenario] of ['continue', 'retry', 'failedRetry', 'cancelledRetry'].entries()) {
    const action = scenario.endsWith('Retry') ? 'retry' : scenario;
    const sessionId = 800 + index, rowId = 900 + index * 2, videoId = '__library_assistant__';
    const user = { id: rowId - 1, sessionId, videoId, role: 'user', content: 'Original question', createdAt: 1 };
    const answer = { id: rowId, sessionId, videoId, taskId: 'prior-task', role: 'assistant', content: 'Original partial', createdAt: 2, ...(action === 'continue' ? { interrupted: true } : {}) };
    records.apply(owner, [{ table: 'chatSessions', key: sessionId, after: { id: sessionId, videoId, title: 'Actual Worker entry', createdAt: 1 } }, ...(scenario === 'failedRetry' ? [user] : [user, answer]).map(after => ({ table: 'chats', key: after.id, after }))].map(row => ({ id: crypto.randomUUID(), before: null, ...row })));
    const taskId = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
    const targetId = scenario === 'failedRetry' ? user.id : rowId;
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'chat',?,?,'running','browser',?,?,?,?)").run(taskId, owner, taskId, `session:${sessionId}`, JSON.stringify({ action, sessionId, rowId: targetId }), workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), at, at);
    const task = { id: taskId, kind: 'chat', resource: `session:${sessionId}`, input: { action, sessionId, rowId: targetId } };
    // Approvals below use the real owner resolve endpoint and exact tool args.
    await enter({ owner, taskId, token });
    if (scenario === 'cancelledRetry') {
      await page.evaluate(task => { window.cancelledRun = window.__runCloudTask(task).then(() => ({ unexpected: true, calls: window.modelCalls }), error => ({ error: error.message, calls: window.modelCalls })); }, task);
      let permission;
      for (let attempt = 0; attempt < 100; attempt++) {
        permission = store.db.prepare("SELECT id FROM cloud_permissions WHERE task_id=? AND status='pending'").get(taskId);
        if (permission) break;
        await page.waitForTimeout(100);
      }
      assert.ok(permission, 'retry must wait for its exact write approval');
      assert.equal((await api.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/cancel`, headers: { cookie } })).statusCode, 200);
      const cancelled = await Promise.race([page.evaluate(() => window.cancelledRun), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('cancelled approval kept Worker waiting')), 10000); timer.unref(); })]);
      assert.ok(cancelled.error, JSON.stringify(cancelled)); assert.equal(cancelled.calls, 0);
      assert.deepEqual(records.get(owner, 'chats', rowId), answer, 'cancel before approval preserves original answer');
      assert.deepEqual(records.get(owner, 'chats', user.id), user);
      checks.push({ scenario, cancelled });
      continue;
    }
    let droppedReset = false;
    await page.route('**/api/executorRuntime/resetConversation', async route => {
      const response = await route.fetch();
      if (!droppedReset && (await response.json()).result.ok) { droppedReset = true; await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    const approve = setInterval(() => {
      for (const row of store.db.prepare("SELECT id FROM cloud_permissions WHERE task_id=? AND status='pending'").all(taskId)) void api.inject({ method: 'POST', url: `/api/v1/cloud/permissions/${row.id}/resolve`, headers: { cookie }, payload: { approved: true } });
    }, 100);
    let run;
    try {
      const lost = await page.evaluate(async task => { try { await window.__runCloudTask(task); return { unexpected: true }; } catch (error) { return { error: error.message, calls: window.modelCalls }; } }, task);
      assert.equal(droppedReset, true); assert.equal(lost.calls, 0); assert.ok(lost.error);
      await page.unroute('**/api/executorRuntime/resetConversation');
      await enter({ owner, taskId, token });
      run = await page.evaluate(async task => { try { await window.__runCloudTask(task); return { calls: window.modelCalls, state: (await import('/src/store/courseChat.ts')).useCourseChat.getState().messages }; } catch (error) { return { error: error.message, stack: error.stack, calls: window.modelCalls }; } }, task);
    }
    finally { clearInterval(approve); }
    fs.writeFileSync(path.join(directory, `${scenario}.json`), JSON.stringify(run, null, 2));
    assert.equal(run.error, undefined, JSON.stringify(run));
    const rows = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL AND json_extract(value,'$.sessionId')=? ORDER BY json_extract(value,'$.createdAt')").all(owner, sessionId).map(row => JSON.parse(row.value));
    assert.equal(run.calls, 1, JSON.stringify(run));
    assert.equal(rows.filter(row => row.role === 'user').length, 1);
    assert.equal(rows.filter(row => row.role === 'assistant').length, 1);
    assert.ok(rows.at(-1).content.includes('completed by real Worker'), JSON.stringify(rows));
    if (action === 'continue') { assert.equal(rows.at(-1).id, rowId); assert.ok(rows.at(-1).content.startsWith(answer.content)); assert.equal(rows.at(-1).interrupted, undefined); }
    await enter({ owner, taskId, token });
    const duplicate = await page.evaluate(async task => { try { await window.__runCloudTask(task); return { unexpected: true }; } catch (error) { return { error: error.message, calls: window.modelCalls }; } }, task);
    assert.equal(duplicate.calls, 0, JSON.stringify(duplicate));
    assert.ok(duplicate.error, JSON.stringify(duplicate));
    checks.push({ action, scenario, rows, duplicate });
  }
  const interactionCases = ['answerAsk', 'confirmPlan', 'cancelPlan'].flatMap(action => ['normal', 'before-executing', 'before-effect', 'after-effect'].map(window => ({ action, window })));
  for (const [interactionIndex, interactionCase] of interactionCases.entries()) {
    const commandAction = interactionCase.action, crashWindow = interactionCase.window;
    const sessionId = 810 + interactionIndex, taskId = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    const videoId = '__library_assistant__';
    const courseId = `executor-plan-${commandAction}-${crashWindow}`;
    if (commandAction !== 'answerAsk') {
      const created = await fixtureDomain(api, cookie, 'resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'saveMarkdown', courseId, name: `${courseId}.md`, text: '# Original plan course\n', expected: '', createOnly: true } });
      assert.equal(created.ok, true, JSON.stringify(created));
    }
    records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: sessionId, before: null, after: { id: sessionId, videoId, title: 'Actual ask stream', createdAt: 1 } }]);
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
    const task = { id: taskId, kind: 'chat', resource: `session:${sessionId}`, input: { sessionId, text: 'Ask through task-owned stream' } };
    store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,worker_id,lease_expires_at,created_at,updated_at) VALUES(?,?,?,'chat',?,?,'running','browser',?,?,?,?)").run(taskId, owner, taskId, task.resource, JSON.stringify(task.input), workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), at, at);
    await enter({ owner, taskId, token });
    const lostPhases = new Set();
    await page.route('**/api/executorRuntime/deliverInteraction', async route => {
      const phase = route.request().postDataJSON().payload.args.request.phase;
      const response = await route.fetch();
      if (phase !== 'executing' && !lostPhases.has(phase) && (await response.json()).result.ok) { lostPhases.add(phase); await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    await page.evaluate(({ task, commandAction, courseId }) => {
      const original = window.fetch;
      window.fetch = async (url, init) => {
        if (!String(url).startsWith('https://fixture.invalid')) return original(url, init);
        const first = window.modelCalls++ === 0;
        const tool = commandAction === 'answerAsk' ? { name: 'ask_user', arguments: JSON.stringify({ question: 'Which result?', type: 'single', options: [{ id: 'keep', label: 'Keep' }, { id: 'stop', label: 'Stop' }] }) } : { name: 'propose_folder_plan', arguments: JSON.stringify({ summary: 'Original task-owned plan', folders: [{ name: `Confirmed ${commandAction}`, courseIds: [courseId] }] }) };
        const delta = first ? { tool_calls: [{ index: 0, id: 'actual-ask-tool', type: 'function', function: tool }] } : { content: 'Answer accepted exactly once' };
        return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: first ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      };
      window.taskResult = window.__runCloudTask(task).then(() => ({ calls: window.modelCalls }), error => ({ error: error.message, calls: window.modelCalls }));
    }, { task, commandAction, courseId });
    let pending;
    for (let attempt = 0; attempt < 150; attempt++) {
      const view = JSON.parse(store.db.prepare('SELECT progress FROM cloud_tasks WHERE id=?').get(taskId).progress ?? '{}').view;
      pending = commandAction === 'answerAsk' ? view?.pendingAsk : view?.pendingPlan;
      if (pending) break;
      await page.waitForTimeout(100);
    }
    assert.ok(pending, 'actual persisted ask checkpoint must be reported');
    let crashedRoute, releaseRoute, reached;
    const crashReached = new Promise(resolve => { reached = resolve; });
    if (crashWindow !== 'normal') await page.route('**/api/executorRuntime/**', async route => {
      const request = route.request().postDataJSON()?.payload?.args?.request;
      const checkpoint = request?.products?.some(p => p.kind === 'conversationMessage' && (p.value?.ask?.picked != null || p.value?.folderPlan?.applied > 0));
      const match = crashWindow === 'before-executing' ? request?.phase === 'executing' : checkpoint;
      if (!match) return route.fallback();
      if (crashWindow === 'after-effect') {
        const response = await route.fetch(); assert.equal((await response.json()).result.ok, true);
      }
      crashedRoute = route; reached();
      await new Promise(resolve => { releaseRoute = resolve; });
      await route.abort('failed').catch(() => {});
    });
    const before = await page.evaluate(() => { const count = window.executorSockets.length; for (const socket of window.executorSockets) socket.close(); return count; });
    assert.ok(before > 0, 'task stream uses actual WebSocket');
    const body = { nonce: crypto.randomUUID(), action: commandAction, value: commandAction === 'answerAsk' ? 'keep' : null };
    const command = await api.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/commands`, headers: { cookie }, payload: body });
    assert.equal(command.statusCode, 200, command.body);
    assert.equal((await api.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/commands`, headers: { cookie }, payload: body })).statusCode, 200);
    const approve = setInterval(() => {
      for (const row of store.db.prepare("SELECT id FROM cloud_permissions WHERE task_id=? AND status='pending'").all(taskId)) void api.inject({ method: 'POST', url: `/api/v1/cloud/permissions/${row.id}/resolve`, headers: { cookie }, payload: { approved: true } });
    }, 100);
    if (crashWindow !== 'normal') {
      try {
        await Promise.race([crashReached, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`crash window not reached: ${commandAction}/${crashWindow}`)), 30000); timer.unref(); })]);
        assert.ok(crashedRoute);
        await page.close(); releaseRoute();
        const blocked = await api.inject({ method: 'POST', url: '/api/executorRuntime/read', headers: { authorization: `Bearer ${token}` }, payload: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'executorRuntime/read', payload: { args: { taskId } } } });
        assert.equal(blocked.json().result.ok, false, 'successor must not replay original send before reconciliation');
        assert.match(blocked.json().result.error.message, /reconciliation/);
        page = await context.newPage();
        await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__harness`);
        const commandRow = store.db.prepare('SELECT id FROM cloud_task_commands WHERE task_id=?').get(taskId);
        const id = `executor-interaction:${taskId}:${commandRow.id}`;
        const inspection = await page.evaluate(async ({ owner, id }) => {
          await (await import('/src/cloud/sync.ts')).startCloud(owner);
          const recovery = await import('/src/cloud/executor-recovery.ts');
          window.crashInspection = await recovery.inspectExecutorRecovery(id);
          let cloneDenied = false;
          try { await recovery.reconcileExecutorInteraction(structuredClone(window.crashInspection), 'resume'); } catch { cloneDenied = true; }
          return { observed: window.crashInspection.observed, cloneDenied };
        }, { owner, id });
        assert.equal(inspection.cloneDenied, true);
        const expected = crashWindow === 'before-executing' ? 'resumable' : crashWindow === 'after-effect' ? 'applied' : 'uncertain';
        assert.equal(inspection.observed.disposition, expected, JSON.stringify(inspection));
        const action = expected === 'resumable' ? 'resume' : expected === 'applied' ? 'settle' : 'hold';
        await page.evaluate(async action => (await import('/src/cloud/executor-recovery.ts')).reconcileExecutorInteraction(window.crashInspection, action), action);
        if (action === 'resume') {
          const successorToken = crypto.randomUUID();
          workerTokens.set(successorToken, { id: owner, taskId, expiresAt: Date.now() + 600000 });
          store.db.prepare("UPDATE cloud_tasks SET worker_id=?,lease_expires_at=?,status='running' WHERE id=?").run(workerTokenHash(successorToken), new Date(Date.now() + 600000).toISOString(), taskId);
          await enter({ owner, taskId, token: successorToken });
          const resumedTask = await page.evaluate(async () => (await (await import('/src/cloud/executor-runtime.ts')).executorRuntime()).read());
          const result = await page.evaluate(async task => { try { await window.__runCloudTask(task); return { calls: window.modelCalls }; } catch (error) { return { error: error.message }; } }, resumedTask);
          assert.equal(result.error, undefined, JSON.stringify(result));
          assert.equal(result.calls, 1, 'only checkpoint continuation, not original tool/model replay');
        }
        const state = store.db.prepare('SELECT phase,attempt,effects FROM executor_interaction_recovery WHERE command_id=?').get(commandRow.id);
        const consumed = store.db.prepare('SELECT consumed FROM cloud_task_commands WHERE id=?').get(commandRow.id).consumed;
        assert.equal(consumed, action === 'hold' ? 0 : 1);
        checks.push({ action: commandAction, crashWindow, inspection, resolution: action, state, consumed });
        continue;
      } finally { clearInterval(approve); releaseRoute?.(); }
    }
    let completed;
    try { completed = await Promise.race([page.evaluate(() => window.taskResult), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`actual ${commandAction} reconnect timeout`)), 30000); timer.unref(); })]); }
    finally { clearInterval(approve); }
    fs.writeFileSync(path.join(directory, `${commandAction}.json`), JSON.stringify({ completed, pending }, null, 2));
    assert.equal(completed.error, undefined, JSON.stringify(completed)); assert.equal(completed.calls, 2);
    const commandRow = store.db.prepare('SELECT id,consumed FROM cloud_task_commands WHERE task_id=?').get(taskId);
    assert.equal(commandRow.consumed, 1);
    const delivery = store.db.prepare('SELECT result FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, `executor-interaction-${taskId}-${commandRow.id}`);
    assert.equal(JSON.parse(delivery.result).phase, 'applied');
    assert.deepEqual([...lostPhases], ['begin', 'applied'], 'SQL begin/final lost responses recover without repeating the answer callback');
    if (commandAction !== 'answerAsk') {
      const course = records.get(owner, 'videos', courseId);
      if (commandAction === 'confirmPlan') { assert.ok(course.folderId, JSON.stringify(course)); assert.equal(records.get(owner, 'folders', course.folderId).name, `Confirmed ${commandAction}`); }
      else assert.equal(course.folderId, undefined, 'cancelled plan leaves original placement unchanged');
    }
    await page.unroute('**/api/executorRuntime/deliverInteraction');
    checks.push({ action: `actual-${commandAction}-after-socket-loss`, pending, completed, commandRow });
  }
  assert.equal(requests.some(request => request.url.includes('/commands/claim')), false);
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, checks, requests }, null, 2));
  console.log(`PASS: actual Worker continue/retry, snapshots, refreshed duplicate dispatch denied (${directory})`);
} catch (error) { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error), stack: error.stack, checks }, null, 2)); throw error; }
finally { await browser?.close(); await vite?.close(); store?.close(); await api.close(); }
