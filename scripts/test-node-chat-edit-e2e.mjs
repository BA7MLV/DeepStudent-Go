import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { register } from 'node:module';

register('./cloud-e2e-source-loader.mjs', import.meta.url);

if (process.argv[2] === '--host') {
  const directory = process.argv[3];
  Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'),
    BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), MODEL_API_KEY: 'isolated-model-key',
    MODEL_BASE_URL: 'https://node-edit.invalid/v1', MODEL_NAME: 'native-model' });
  delete process.env.CLOUD_WORKER_DISABLED;
  delete process.env.PUBLIC_ORIGIN;
  const { buildServer } = await import('../apps/api/src/server.ts');
  const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (_url, init) => {
    const payload = JSON.parse(init.body);
    const marker = payload.messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n').match(/node-edit-case:([a-zA-Z0-9-]+)/)?.[1];
    assert.ok(marker, 'mock receives the original test request');
    const plan = JSON.parse(fs.readFileSync(path.join(directory, `plan-${marker}.json`), 'utf8'));
    const results = payload.messages.filter(message => message.role === 'tool');
    fs.appendFileSync(path.join(directory, 'model.jsonl'), JSON.stringify({ marker, tools: payload.tools?.map(tool => tool.function.name), results }) + '\n');
    let message;
    if (!results.length && plan.readFirst) message = { tool_calls: [{ id: 'read-source', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: plan.args.path, raw: true }) } }] };
    else if (results.length === (plan.readFirst ? 1 : 0)) {
      const args = { ...plan.args };
      if (plan.readFirst && args.path.startsWith('/system/')) args.revision = JSON.parse(results[0].content).revision;
      message = { tool_calls: [{ id: 'edit-source', type: 'function', function: { name: plan.tool ?? 'edit', arguments: JSON.stringify(args) } }] };
    } else message = { content: results.at(-1).content.startsWith('工具执行失败') ? `没有修改：${results.at(-1).content}` : `工具结果：${results.at(-1).content}` };
    const finish_reason = message.tool_calls ? 'tool_calls' : 'stop';
    return payload.stream
      ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json({ choices: [{ message: { role: 'assistant', ...message }, finish_reason }] });
  } });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  process.send({ origin });
  process.on('message', async message => { if (message === 'close') { await app.close(); process.exit(0); } });
} else {
  const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/node-chat-edit-');
  const checks = [], requests = [];
  let child, origin, cookie, cookieB, sessionId = 10000;
  const start = async () => {
    child = fork(new URL(import.meta.url), ['--host', directory], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout.on('data', data => fs.appendFileSync(path.join(directory, 'host.log'), data));
    child.stderr.on('data', data => fs.appendFileSync(path.join(directory, 'host.log'), data));
    const ready = await Promise.race([once(child, 'message'), once(child, 'exit').then(([code]) => { throw new Error(`host exited ${code}; see ${directory}/host.log`); })]);
    origin = ready[0].origin;
  };
  const request = async (url, data, account = cookie, method = data === undefined ? 'GET' : 'POST') => {
    const response = await fetch(origin + url, { method, headers: { ...(account ? { cookie: account } : {}), ...(data === undefined ? {} : { 'content-type': 'application/json' }) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text(); let body; try { body = JSON.parse(text); } catch { body = text; }
    requests.push({ method, url, status: response.status });
    return { status: response.status, body, headers: response.headers };
  };
  const good = async (...args) => { const value = await request(...args); assert.ok(value.status >= 200 && value.status < 300, JSON.stringify(value)); return value.body; };
  const domain = async (method, value, account = cookie) => {
    const result = await good(`/api/clientRuntime/${method}`, { type: 'client-request', rpcId: crypto.randomUUID(), method: `clientRuntime/${method}`, payload: { args: { request: value } } }, account);
    assert.equal(result.result.ok, true, JSON.stringify(result)); return result.result.value;
  };
  const until = async (predicate, label) => {
    const end = Date.now() + 15000;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
    throw new Error(`Timed out: ${label}`);
  };
  const permissions = async () => (await good('/api/v1/cloud/permissions')).permissions;
  const task = async id => good(`/api/v1/cloud/tasks/${id}`);
  const done = async id => until(async () => { const value = await task(id); return ['completed', 'failed', 'cancelled', 'interrupted'].includes(value.status) && value; }, 'task terminal');
  const pending = async id => until(async () => { const permission = (await permissions()).find(permission => permission.taskId === id && permission.status === 'pending'); if (permission) return permission; const value = await task(id); assert.ok(!['completed', 'failed'].includes(value.status), JSON.stringify(value)); }, 'pending approval');
  const resolve = (id, approved, account) => request(`/api/v1/cloud/permissions/${id}/resolve`, { approved }, account);
  const configure = async write => { const config = await good('/api/v1/cloud/config'); return good('/api/v1/cloud/config', { ...config, policy: { ...config.policy, write } }, cookie, 'PUT'); };
  const createCourse = async (account = cookie, folderId) => {
    const id = crypto.randomUUID();
    await domain('resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'saveMarkdown', courseId: id, expected: '', text: 'original body', createOnly: true, name: id, ...(folderId === undefined ? {} : { folderId }) } }, account);
    return id;
  };
  const document = async (id, account = cookie, projectId) => {
    const listing = await good(`/api/v1/resources${projectId ? `?projectId=${projectId}` : ''}`, undefined, account);
    const entry = listing.entries.find(entry => entry.courseId === id); assert.ok(entry);
    return good(`/api/v1/projects/${entry.projectId}/text?path=${encodeURIComponent(entry.path)}`, undefined, account);
  };
  const submit = async (courseId, extras = {}, kind = 'chat') => {
    const marker = crypto.randomUUID();
    fs.writeFileSync(path.join(directory, `plan-${marker}.json`), JSON.stringify({ ...extras, args: { path: `/courses/${courseId}/material`, edits: [{ old_string: 'original', new_string: 'approved' }], ...extras.args } }));
    const id = ++sessionId;
    await domain('editLearning', { operationId: crypto.randomUUID(), edits: [{ mutationId: crypto.randomUUID(), kind: 'conversationSession', expected: null, value: { id, videoId: kind === 'qa' ? courseId : '', title: marker, createdAt: Date.now(), ...(extras.projectFolderId === undefined ? {} : { projectFolderId: extras.projectFolderId }) } }] });
    const result = await good('/api/v1/cloud/tasks', { nonce: crypto.randomUUID(), kind, resource: `session:${id}`, input: { sessionId: id, text: `node-edit-case:${marker}`, ...(kind === 'qa' ? { videoId: courseId, materialKind: 'para', materialFormat: 'md' } : {}) } });
    return result.id;
  };
  const errorTool = async id => { const value = await done(id); assert.equal(value.status, 'completed', JSON.stringify(value)); assert.equal(value.result.tools.at(-1).status, 'error', JSON.stringify(value)); assert.match(value.result.content, /没有修改/); return value; };
  try {
    await start();
    // Bootstrap requires the generated one-time secret, never a test backdoor.
    const response = await fetch(origin + '/api/v1/bootstrap/initialize', { method: 'POST', headers: { 'content-type': 'application/json', 'x-bootstrap-secret': fs.readFileSync(path.join(directory, 'secret'), 'utf8').trim() }, body: JSON.stringify({ adminPassword: 'isolated-node-edit-password' }) }); assert.equal(response.status, 201, await response.text());
    const login = await request('/api/v1/auth/password/login', { password: 'isolated-node-edit-password' }); assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
    const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
    const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
    const ownerB = crypto.randomUUID(), token = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(ownerB, 'Other isolated account', at);
    store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), ownerB, crypto.createHash('sha256').update(token).digest('hex'), at, new Date(Date.now() + 3600000).toISOString()); store.close();
    cookieB = `wangke_session=${token}`;
    const approvedCourse = await createCourse(), approved = await submit(approvedCourse, { readFirst: true }), permit = await pending(approved);
    assert.equal((await document(approvedCourse)).text, 'original body');
    assert.ok([403,409].includes((await resolve(permit.id, true, cookieB)).status));
    assert.equal((await document(approvedCourse)).text, 'original body');
    const forged = await submit(approvedCourse, { args: { permissionId: permit.id } }); await errorTool(forged);
    assert.equal((await document(approvedCourse)).text, 'original body');
    const decisions = await Promise.all([resolve(permit.id, true), resolve(permit.id, true)]);
    assert.ok(decisions.some(decision => decision.status === 200)); assert.ok(decisions.every(decision => [200,409].includes(decision.status)));
    assert.equal((await done(approved)).status, 'completed'); assert.equal((await document(approvedCourse)).text, 'approved body');
    assert.equal((await resolve(permit.id, true)).status, 409);
    const verifyStore = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
    assert.equal(verifyStore.db.prepare("SELECT COUNT(*) AS n FROM client_commands WHERE operation_id=? AND status='completed'").get(`native-edit-${permit.id}`).n, 1); verifyStore.close();
    checks.push('real HTTP: before approval no write; cross-account decision and cross-task permit reuse rejected; approved once; duplicate decision no extra write');

    const rejectedCourse = await createCourse(), rejected = await submit(rejectedCourse), rejectPermit = await pending(rejected);
    assert.equal((await resolve(rejectPermit.id, false)).status, 200); await errorTool(rejected); assert.equal((await document(rejectedCourse)).text, 'original body');
    checks.push('rejection returns actual tool error and does not write');

    const foreign = await createCourse(cookieB), crossAccount = await submit(foreign); await errorTool(crossAccount); assert.equal((await document(foreign, cookieB)).text, 'original body');
    checks.push('foreign course is not readable/editable and has no write');

    const qaCourse = await createCourse(), qa = await submit(qaCourse, { args: { path: '/courses/current/material' } }, 'qa'), qaPermit = await pending(qa);
    await resolve(qaPermit.id, true); assert.equal((await done(qa)).status, 'completed'); assert.equal((await document(qaCourse)).text, 'approved body');
    const outside = await submit(qaCourse, { args: { path: `/courses/${rejectedCourse}/material` } }, 'qa'); await errorTool(outside); assert.equal((await document(rejectedCourse)).text, 'original body');
    checks.push('ordinary Node QA advertises edit and enforces current-course scope');

    const casCourse = await createCourse(), cas = await submit(casCourse), casPermit = await pending(cas);
    await domain('resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'saveMarkdown', courseId: casCourse, expected: 'original body', text: 'concurrent body' } });
    await resolve(casPermit.id, true); await errorTool(cas); assert.equal((await document(casCourse)).text, 'concurrent body');
    checks.push('source CAS still enforced after approval wait');

    const cancelCourse = await createCourse(), cancel = await submit(cancelCourse), cancelPermit = await pending(cancel);
    await good(`/api/v1/cloud/tasks/${cancel}/cancel`, {}); assert.equal((await done(cancel)).status, 'cancelled'); assert.equal((await resolve(cancelPermit.id, true)).status, 409); assert.equal((await document(cancelCourse)).text, 'original body');
    checks.push('cancel invalidates pending approval and cannot revive task/write');

    const revokeCourse = await createCourse(), revoke = await submit(revokeCourse); await pending(revoke); await configure('deny'); await errorTool(revoke); assert.equal((await document(revokeCourse)).text, 'original body'); await configure('ask');
    checks.push('live deny revokes pending edit without write');

    const sys = await submit('', { args: { path: '/system/AGENTS.md', edits: undefined, create: true, content: 'node system instructions' }, readFirst: true });
    const sysResult = await done(sys); assert.equal(sysResult.status, 'completed'); assert.equal(sysResult.result.tools.at(-1).status, 'done', JSON.stringify(sysResult));
    const systemBeforeDeny = await good('/api/v1/system/file?path=%2Fsystem%2FAGENTS.md');
    assert.equal(systemBeforeDeny.content, 'node system instructions');
    assert.notEqual((await good('/api/v1/system/file?path=%2Fsystem%2FAGENTS.md', undefined, cookieB)).content, systemBeforeDeny.content);
    assert.ok(!(await permissions()).some(permission => permission.taskId === sys && permission.status === 'pending'));
    await configure('deny');
    const sysDeny = await submit('', { args: { path: '/system/AGENTS.md', edits: [{ old_string: 'node', new_string: 'forbidden' }] }, readFirst: true }); await errorTool(sysDeny); await configure('ask');
    assert.deepEqual(await good('/api/v1/system/file?path=%2Fsystem%2FAGENTS.md'), systemBeforeDeny);
    const sysConflict = await submit('', { args: { path: '/system/AGENTS.md', revision: systemBeforeDeny.revision + 100, edits: [{ old_string: 'node', new_string: 'forbidden' }] } }); await errorTool(sysConflict);
    assert.deepEqual(await good('/api/v1/system/file?path=%2Fsystem%2FAGENTS.md'), systemBeforeDeny);
    const mcp = await submit('', { args: { path: '/system/mcp.json', revision: 0 } }); await errorTool(mcp);
    const hostPath = await submit('', { args: { path: '/etc/passwd' } }); await errorTool(hostPath);
    const shell = await submit('', { tool: 'shell', args: { path: '/etc/passwd' } }); const shellResult = await errorTool(shell); assert.match(shellResult.result.tools.at(-1).result, /tool_not_available/);
    const note = await submit('', { args: { path: '/system/memory/node-test.md', revision: 0, edits: undefined, create: true, content: 'explicit memory note' } });
    assert.equal((await done(note)).result.tools.at(-1).status, 'done');
    assert.equal((await good('/api/v1/system/file?path=%2Fsystem%2Fmemory%2Fnode-test.md')).content, 'explicit memory note');
    assert.equal((await request('/api/v1/system/file?path=%2Fsystem%2Fmemory%2Fnode-test.md', undefined, cookieB)).status, 404);
    checks.push('system edit is owner-scoped CAS with no routine prompt; explicit deny, MCP mutation and unadvertised shell rejected');

    const project = await domain('resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'createFolder', name: 'Scoped editing' } });
    const projectCourse = await createCourse(cookie, project.folderId);
    const projectEscape = await submit(rejectedCourse, { projectFolderId: project.folderId }); await errorTool(projectEscape); assert.equal((await document(rejectedCourse)).text, 'original body');
    const archiving = await submit(projectCourse, { projectFolderId: project.folderId }), archivePermit = await pending(archiving);
    await good(`/api/v1/projects/${project.id}`, { archived: true }, cookie, 'PATCH');
    await resolve(archivePermit.id, true); await errorTool(archiving);
    assert.equal((await document(projectCourse, cookie, project.id)).text, 'original body');
    checks.push('project session cannot escape its folder; archive while awaiting approval prevents write');

    const restartCourse = await createCourse(), interrupted = await submit(restartCourse), restartPermit = await pending(interrupted);
    assert.equal((await document(restartCourse)).text, 'original body');
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    await start();
    await until(async () => (await task(interrupted)).status === 'interrupted', 'cold restart marks native task interrupted');
    assert.equal((await document(restartCourse)).text, 'original body'); assert.equal((await resolve(restartPermit.id, true)).status, 409);
    assert.equal((await permissions()).find(permission => permission.id === restartPermit.id).status, 'expired');
    checks.push('actual SIGKILL/restart: pending approval expires, native task interrupted, no automatic replay/write');
    const modelCalls = fs.readFileSync(path.join(directory, 'model.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.ok(modelCalls.every(call => call.tools.includes('edit') && call.tools.includes('ask_user') && !call.tools.includes('shell')));
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: true, checks, requests, permissions: await permissions(), modelCalls }, null, 2));
    console.log(`PASS Node chat/QA edit real HTTP + approval/isolation/CAS/cancel/restart (${directory})`);
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ passed: false, checks, requests, failure: String(error.stack ?? error) }, null, 2)); throw error;
  } finally {
    if (child?.connected) { const exited = once(child, 'exit'); child.send('close'); await exited; }
  }
}
