import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { workerTokens, workerTokenHash } from '../apps/api/src/cloud/workerAuth.ts';
import { fixtureDomain } from './fixture-domain.mjs';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/executor-entries-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external model forbidden'); } });
let browser, vite, store, active;
const checks = [], modelRequests = [], requests = [];
const until = async (read, label) => {
  const end = Date.now() + 20000;
  while (Date.now() < end) { const value = await read(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error(`Timed out: ${label}`);
};
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'executor-entries-password' } })).statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'executor-entries-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const records = new CloudRecords(store), configuration = new CloudConfiguration(store, directory);
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'executor-entries-fixture', configureServer(server) {
    server.middlewares.use('/__harness', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>Actual QA and artifact executor</title>'); });
    server.middlewares.use('/__model/v1/chat/completions', async (req, res) => {
      let body = ''; for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body), current = active;
      modelRequests.push({ kind: current.kind, scenario: current.scenario, payload }); current.calls++;
      if (current.block) { current.reached = true; await current.block; }
      const hasTool = payload.messages.some(message => message.role === 'tool');
      const message = current.kind === 'artifactEdit' ? { content: JSON.stringify({ source: '<p>edited artifact</p>' }) }
        : !hasTool ? { tool_calls: [{ id: 'actual-qa-edit', type: 'function', function: { name: 'edit', arguments: JSON.stringify({ path: '/courses/current/material', edits: [{ old_string: 'original', new_string: 'approved' }] }) } }] }
        : { content: 'Actual QA completed after the original tool result.' };
      const finish_reason = message.tool_calls ? 'tool_calls' : 'stop';
      res.setHeader('content-type', payload.stream ? 'text/event-stream' : 'application/json');
      res.end(payload.stream ? `data: ${JSON.stringify({ choices: [{ index: 0, delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n` : JSON.stringify({ choices: [{ message, finish_reason }] }));
    });
  } }] });
  await vite.listen(); const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext();
  const settings = async page => page.evaluate(async () => {
    (await import('/src/store/settings.ts')).useSettings.setState({ providers: [{ id: 'fixture', name: 'Local HTTP model', baseUrl: location.origin + '/__model/v1', apiKey: 'local-only', protocol: 'openai-chat', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture' }, thinkingEnabled: false });
  });
  const enter = async (page, capability) => {
    await page.goto(origin + '/__harness');
    await page.evaluate(async capability => {
      await (await import('/src/cloud/sync.ts')).startCloud(capability.owner, true);
      Object.assign((await import('/src/cloud/state.ts')).cloud, { taskId: capability.taskId, workerToken: capability.token });
      await (await import('/src/cloud/sync.ts')).flushCloud();
      await import('/src/cloud/worker.ts');
    }, capability); await settings(page);
  };
  for (const kind of ['qa', 'artifactEdit']) for (const scenario of ['completion-loss', 'refresh-running', 'cancel-running', 'revoke-running', 'lease-expired', 'wrong-resource', 'cancelled-parent', 'foreign-capability', ...(kind === 'qa' ? ['wrong-permit', 'revoke-write-after-consume', 'product-loss'] : [])]) {
    active = { kind, scenario, calls: 0 };
    const current = active, courseId = crypto.randomUUID(), sessionId = 20000 + checks.length;
    await fixtureDomain(api, cookie, 'resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'saveMarkdown', courseId, expected: '', text: 'original body', createOnly: true, name: 'Actual QA recovery' } });
    records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: sessionId, before: null, after: { id: sessionId, videoId: courseId, title: 'QA executor matrix', createdAt: Date.now() } }]);
    const ui = await context.newPage(); await ui.goto(origin + '/__harness');
    await ui.evaluate(async owner => (await import('/src/cloud/sync.ts')).startCloud(owner), owner); await settings(ui);
    // These are the production public entrypoints, not a product mutation seam.
    await ui.evaluate(async ({ kind, courseId, sessionId }) => {
      window.entryDone = false;
      const signal = new AbortController().signal;
      const pending = kind === 'qa' ? (await import('/src/harness/qaRunner.ts')).runQa({ videoId: courseId, sessionId, text: 'Please edit original body', materialKind: 'para', materialFormat: 'md' }, { signal })
        : (await import('/src/pipelines/artifactEdit.ts')).editArtifact({ kind: 'html', source: '<p>original artifact</p>', instruction: 'edit this one block', context: '', mode: 'rewrite', signal });
      window.entryResult = pending.then(result => { window.entryDone = true; return { result }; }, error => { window.entryDone = true; return { error: error.message }; });
    }, { kind, courseId, sessionId });
    const row = await until(() => store.db.prepare("SELECT * FROM cloud_tasks WHERE owner_id=? AND kind=? AND status='queued' ORDER BY created_at DESC LIMIT 1").get(owner, kind), 'actual entry admission');
    const taskId = row.id, token = crypto.randomUUID();
    const capability = { taskId, token, owner };
    workerTokens.set(token, { id: owner, taskId, expiresAt: Date.now() + 600000 });
    store.db.prepare("UPDATE cloud_tasks SET status='running',executor='browser',worker_id=?,lease_expires_at=? WHERE id=?").run(workerTokenHash(token), new Date(Date.now() + 600000).toISOString(), taskId);
    if (scenario === 'wrong-resource') store.db.prepare('UPDATE cloud_tasks SET resource=? WHERE id=?').run('session:foreign', taskId);
    let worker = await context.newPage(); await enter(worker, capability);
    if (scenario === 'lease-expired') store.db.prepare('UPDATE cloud_tasks SET lease_expires_at=? WHERE id=?').run(new Date(0).toISOString(), taskId);
    if (scenario === 'cancelled-parent') {
      const thread = crypto.randomUUID(), run = crypto.randomUUID(), at = new Date().toISOString();
      store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,'bot','Interrupted parent',?,?)").run(thread, owner, at, at);
      store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','cancelled',?)").run(run, thread, at);
      store.db.prepare('UPDATE cloud_tasks SET parent_run_id=? WHERE id=?').run(run, taskId);
    }
    if (scenario === 'foreign-capability') workerTokens.set(token, { id: crypto.randomUUID(), taskId, expiresAt: Date.now() + 600000 });
    let deniedWrite = false, productLost = false;
    if (scenario === 'wrong-permit' || scenario === 'revoke-write-after-consume') await worker.route('**/api/executorRuntime/resourceCommand', async route => {
      const body = route.request().postDataJSON(), request = body.payload.args.request;
      assert.equal(store.db.prepare('SELECT status FROM cloud_permissions WHERE id=? AND task_id=?').get(request.permissionId, taskId).status, 'consumed');
      if (scenario === 'wrong-permit') request.permissionId = crypto.randomUUID();
      else { const config = configuration.get(owner, true); configuration.save(owner, { ...config, policy: { ...config.policy, write: 'deny' } }); }
      const response = await route.fetch({ postData: JSON.stringify(body) });
      assert.equal((await response.json()).result.ok, false); deniedWrite = true;
      await route.fulfill({ response });
    });
    if (scenario === 'product-loss') await worker.route('**/api/executorRuntime/commitArtifacts', async route => {
      const response = await route.fetch();
      if (!productLost) { assert.equal((await response.json()).result.ok, true); productLost = true; await route.abort('failed'); }
      else await route.fulfill({ response });
    });
    worker.on('request', req => { if (req.url().includes('/api/')) requests.push({ kind, scenario, url: req.url() }); });
    if (scenario === 'wrong-resource' && kind === 'artifactEdit') {
      // An artifact has no writable course/session target: arbitrary resource
      // labels cannot grant either a product or a file permit.
      const denial = await worker.evaluate(async courseId => {
        try { await (await (await import('/src/cloud/executor-runtime.ts')).executorRuntime()).resourceCommand({ operationId: crypto.randomUUID(), permissionId: 'foreign', operation: { kind: 'saveMarkdown', courseId, expected: 'original body', text: 'must not write' } }); return false; } catch { return true; }
      }, courseId); assert.equal(denial, true);
    }
    let release;
    if (['refresh-running', 'cancel-running', 'revoke-running'].includes(scenario)) current.block = new Promise(resolve => { release = resolve; });
    const task = { id: taskId, kind, resource: row.resource, input: JSON.parse(row.input) };
    const approve = setInterval(() => {
      for (const permission of store.db.prepare("SELECT id FROM cloud_permissions WHERE task_id=? AND status='pending'").all(taskId)) void api.inject({ method: 'POST', url: `/api/v1/cloud/permissions/${permission.id}/resolve`, headers: { cookie }, payload: { approved: true } });
    }, 80);
    try {
      await worker.evaluate(task => { window.workerDone = false; window.workerRun = window.__runCloudTask(task).then(result => { window.workerDone = true; return { result }; }, error => { window.workerDone = true; return { error: error.message }; }); }, task);
      if (current.block) {
        await until(() => current.reached, 'model running');
        if (scenario === 'refresh-running') {
          await worker.close(); release();
          worker = await context.newPage(); await enter(worker, capability);
          const result = await worker.evaluate(async task => { try { await window.__runCloudTask(task); return {}; } catch (error) { return { error: error.message }; } }, task);
          assert.match(result.error, /executor_execution_uncertain/); assert.equal(current.calls, 1);
          checks.push({ kind, scenario, taskId, result, calls: current.calls });
          continue;
        }
        if (scenario === 'cancel-running') assert.equal((await api.inject({ method: 'POST', url: `/api/v1/cloud/tasks/${taskId}/cancel`, headers: { cookie } })).statusCode, 200);
        else { const config = configuration.get(owner, true); configuration.save(owner, { ...config, policy: { ...config.policy, read: 'deny' } }); }
        // Heartbeat observes cancellation/revocation before the model responds.
        await new Promise(resolve => setTimeout(resolve, 900)); release();
      }
      const result = await Promise.race([worker.evaluate(() => window.workerRun), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Worker failed to stop')), 20000); timer.unref(); })]);
      if (scenario === 'product-loss') {
        assert.ok(result.error); assert.equal(productLost, true); assert.equal(current.calls, 0);
        await enter(worker, capability);
        const journal = await worker.evaluate(async () => (await import('/src/store/db.ts')).db.table('_cloudMeta').filter(row => row.id.startsWith('executor-products:')).toArray());
        assert.equal(journal.length, 0, 'committed original product resolved before uncertain execution');
        const retry = await worker.evaluate(async task => { try { await window.__runCloudTask(task); return {}; } catch (error) { return { error: error.message }; } }, task);
        assert.match(retry.error, /executor_execution_uncertain/); assert.equal(current.calls, 0);
      } else if (scenario === 'wrong-permit' || scenario === 'revoke-write-after-consume') {
        assert.equal(deniedWrite, true, 'actual QA tool reached closed resource permission check');
      } else if (scenario === 'completion-loss' || scenario === 'wrong-resource' && kind === 'artifactEdit') {
        assert.equal(result.error, undefined, JSON.stringify(result));
        if (kind === 'qa') assert.match(result.result.content, /Actual QA/); else assert.equal(result.result, '<p>edited artifact</p>');
        const calls = current.calls;
        await worker.route('**/api/executorRuntime/complete', async route => { const response = await route.fetch(); assert.equal((await response.json()).result.ok, true); await route.abort('failed'); });
        await assert.rejects(() => worker.evaluate(async result => (await import('/src/cloud/executor-runtime.ts')).completeExecutor({ status: 'completed', result }), result.result));
        assert.equal(store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(taskId).status, 'completed');
        await worker.unroute('**/api/executorRuntime/complete');
        await worker.reload();
        await worker.evaluate(async capability => {
          await (await import('/src/cloud/sync.ts')).startCloud(capability.owner, true);
          Object.assign((await import('/src/cloud/state.ts')).cloud, { taskId: capability.taskId, workerToken: capability.token });
        }, capability);
        await worker.evaluate(async result => (await import('/src/cloud/executor-runtime.ts')).completeExecutor({ status: 'completed', result }), result.result);
        assert.equal(current.calls, calls, 'completion recovery never invokes producer again');
        await until(() => ui.evaluate(() => window.entryDone), 'original entry receives completed result');
        assert.deepEqual((await ui.evaluate(() => window.entryResult)).result, result.result);
      } else { assert.ok(result.error, JSON.stringify(result)); }
      if (scenario !== 'completion-loss') {
        const doc = await fixtureDomain(api, cookie, 'read', { kind: 'courseDocument', courseId });
        assert.equal(doc.ok, true, JSON.stringify(doc));
        assert.equal(doc.value.value.text, 'original body', 'invalid/cancelled task never changes material');
      } else if (kind === 'qa') {
        const doc = await fixtureDomain(api, cookie, 'read', { kind: 'courseDocument', courseId });
        assert.equal(doc.value.value.text, 'approved body', 'real QA edit producer commits approved material');
      }
      checks.push({ kind, scenario, taskId, result, calls: current.calls });
    } finally {
      release?.(); clearInterval(approve);
      const config = configuration.get(owner, true); if (config.policy.read === 'deny' || config.policy.write === 'deny') configuration.save(owner, { ...config, policy: { ...config.policy, read: 'allow', write: 'ask' } });
      await worker.close(); await ui.close();
    }
  }
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, checks, modelRequests, requests }, null, 2));
  console.log(`PASS: actual QA/artifactEdit entry recovery matrix (${directory})`);
} catch (error) { fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error.stack), checks, modelRequests, requests }, null, 2)); throw error; }
finally { active?.release?.(); await browser?.close(); await vite?.close(); store?.close(); await api.close(); }
