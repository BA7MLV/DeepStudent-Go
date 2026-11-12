/** Production Chat loop + SQLite/permission journal. Only model and sandbox
 * transports are fixtures: no command is ever run on the API host. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { sessionShell, chatShellWorkspace } from '../apps/api/runtime/chat-shell.ts';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/var/tmp', 'opencode', 'chat-shell-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), timestamp = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, timestamp);
const policy = patch => configuration.save(owner, { ...configuration.get(owner), policy: { ...configuration.get(owner).policy, ...patch } });
const session = (id, account = owner, videoId = '__library_assistant__') => records.apply(account, [{ id: crypto.randomUUID(), table: 'chatSessions', key: id, before: null, after: { id, videoId, title: '新会话', createdAt: Date.now() } }]);
session(10); session(11); session(10, other); session(12, owner, 'course-1');
const requests = [], cleaned = [];
const success = { stdout: '42\n', stderr: '', exitCode: 0 };
const args = { command: 'python3 -c "print(6*7)"', description: '计算乘积' };
const sandbox = async request => { requests.push(request); return success; };
const cleanup = async id => { cleaned.push(id); };
function fixture({ sid = 10, account = owner, kind = 'chat', executor = sandbox, cleaner = cleanup } = {}) {
  const id = crypto.randomUUID(), controller = new AbortController();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, account, id, kind, `session:${sid}`, JSON.stringify({ sessionId: sid }), 'running', timestamp, timestamp);
  const context = { task: taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id)), owner: account, store, records, configuration,
    filesDir: path.join(directory, 'files'), effects: [], signal: controller.signal, fetch, sandbox: executor, sandboxCleanup: cleaner,
    checkActive() {
      controller.signal.throwIfAborted();
      const task = store.db.prepare('SELECT status FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, account);
      if (!['running', 'waiting_user'].includes(task?.status)) throw new DOMException('cancelled', 'AbortError');
    }, report() {} };
  const shell = sessionShell(context);
  return { id, context, controller, shell, call: input => shell.wrap(async name => `other:${name}`)('shell', input),
    finish() { store.db.prepare("UPDATE cloud_tasks SET status='completed' WHERE id=? AND status IN ('running','waiting_user')").run(id); } };
}
const permissions = task => store.db.prepare('SELECT * FROM cloud_permissions WHERE task_id=? ORDER BY rowid').all(task.id);
async function until(read, message = 'condition') {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${message}`);
}
function resolve(permission, status = 'approved') { store.db.prepare('UPDATE cloud_permissions SET status=? WHERE id=? AND status=?').run(status, permission.id, 'pending'); }
let runner;
try {
  policy({ read: 'allow', write: 'ask', shell: 'allow', remove: 'ask', network: 'deny' });
  const first = fixture();
  assert.deepEqual(JSON.parse(await first.call(args)), success);
  assert.equal(await first.shell.wrap(async name => `other:${name}`)('read', {}), 'other:read');
  assert.equal(permissions(first)[0].status, 'finished');
  assert.equal(requests[0].threadId, chatShellWorkspace(owner, 10));
  assert.equal(requests[0].timeoutSeconds, 120); assert.equal(requests[0].network, false);
  assert.equal(requests[0].projectId, undefined); assert.equal(requests[0].systemWrite, undefined);
  assert.notEqual(chatShellWorkspace(owner, 10), chatShellWorkspace(other, 10));
  assert.notEqual(chatShellWorkspace(owner, 10), chatShellWorkspace(owner, 11));
  assert.match(requests[0].executionId, /^[a-f0-9-]{36}$/);
  first.finish();

  const invalid = fixture(), beforeInvalid = requests.length;
  for (const patch of [{ command: '' }, { command: 'x'.repeat(16001) }, { command: 'a\0b' }, { description: '' }, { description: 'x'.repeat(2001) },
    { network: 'true' }, { requiresApproval: 1 }, { timeoutSeconds: 0 }, { timeoutSeconds: 601 }, { timeoutSeconds: 1.5 },
    { timeoutSeconds: '60' }, { projectId: crypto.randomUUID() }, { systemWrite: true }, { background: true }, { workdir: '/' }]) {
    await assert.rejects(invalid.call({ ...args, ...patch }), /invalid_chat_shell_arguments|invalid_shell_timeout/);
  }
  assert.equal(requests.length, beforeInvalid); assert.equal(permissions(invalid).length, 0); invalid.finish();

  for (const [patch, input] of [[{ shell: 'deny' }, args], [{ shell: 'allow', read: 'deny' }, args],
    [{ read: 'allow', network: 'deny' }, { ...args, network: true }], [{ remove: 'deny' }, { ...args, command: 'rm x' }]]) {
    policy(patch); const denied = fixture(); await assert.rejects(denied.call(input), /shell_permission_denied/);
    assert.equal(permissions(denied).length, 0); denied.finish();
  }
  policy({ read: 'allow', shell: 'ask', remove: 'ask', network: 'allow' });
  const approval = fixture(), beforeApproval = requests.length;
  const approvedWork = approval.call({ ...args, network: true, timeoutSeconds: 600 });
  const pending = await until(() => permissions(approval).find(p => p.status === 'pending'));
  assert.equal(requests.length, beforeApproval);
  assert.deepEqual(JSON.parse(pending.arguments), { ...args, network: true, timeoutSeconds: 600, requiresApproval: false });
  resolve(pending); await approvedWork;
  assert.equal(permissions(approval)[0].status, 'finished');
  assert.equal(requests.at(-1).timeoutSeconds, 600); assert.equal(requests.at(-1).network, true);
  const again = approval.call(args), againFailure = assert.rejects(again, /shell_permission_rejected/);
  const next = await until(() => permissions(approval).find(p => p.status === 'pending'));
  assert.notEqual(next.id, pending.id); resolve(next, 'rejected'); await againFailure;
  assert.equal(requests.length, beforeApproval + 1, 'a consumed permit cannot approve another command'); approval.finish();

  // Destruction and externally consequential work still ask with shell=allow.
  policy({ shell: 'allow', remove: 'allow' });
  for (const patch of [{ command: 'rm output.txt' }, { requiresApproval: true }]) {
    const task = fixture(), work = task.call({ ...args, ...patch });
    resolve(await until(() => permissions(task).find(p => p.status === 'pending'))); await work; task.finish();
  }
  policy({ read: 'ask' });
  const readAsk = fixture(), readWork = readAsk.call(args);
  resolve(await until(() => permissions(readAsk).find(p => p.status === 'pending'))); await readWork; readAsk.finish();

  policy({ read: 'allow', shell: 'ask' });
  for (const action of ['revoke', 'reject', 'cancel', 'tamper', 'deleteSession']) {
    const task = fixture({ sid: action === 'deleteSession' ? 11 : 10 }), count = requests.length;
    const work = task.call(args), failure = assert.rejects(work, /shell_permission_revoked|shell_permission_rejected|chat_shell_scope_denied|AbortError/);
    const permission = await until(() => permissions(task).find(p => p.status === 'pending'));
    if (action === 'revoke') policy({ shell: 'deny' });
    else if (action === 'reject') resolve(permission, 'rejected');
    else if (action === 'cancel') task.controller.abort();
    else if (action === 'tamper') store.db.prepare('UPDATE cloud_permissions SET arguments=? WHERE id=?').run('{}', permission.id);
    else records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: 11, before: records.get(owner, 'chatSessions', 11), after: null }]);
    await failure; assert.equal(requests.length, count); assert.ok(['expired', 'rejected'].includes(permissions(task)[0].status));
    task.finish(); policy({ shell: 'ask' });
  }

  policy({ shell: 'allow' });
  const running = fixture({ executor: async (request, signal) => {
    requests.push(request); await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } });
  const runningWork = running.call(args), runningFailure = assert.rejects(runningWork, /AbortError/);
  await until(() => requests.at(-1)?.executionId === permissions(running)[0]?.id);
  running.controller.abort(); await runningFailure;
  assert.equal(cleaned.at(-1), permissions(running)[0].id); running.finish();
  const uncertain = fixture({ executor: async () => { throw new Error('disconnected'); }, cleaner: async () => { throw new Error('offline'); } });
  await assert.rejects(uncertain.call(args), /sandbox_cleanup_pending/); uncertain.finish();
  const truncated = fixture({ executor: async () => ({ ...success, stdout: '[Output preview truncated; read the saved artifact for full output.]', exitCode: 137, terminationReason: 'output_limit_exceeded', output: { complete: false, stdoutTruncated: true } }) });
  const result = JSON.parse(await truncated.call(args));
  assert.equal(result.exitCode, 137); assert.equal(result.output.complete, false); assert.doesNotMatch(result.stdout, /saved artifact/); truncated.finish();

  for (const options of [{ kind: 'qa' }, { sid: 12 }, { sid: 999 }]) {
    const task = fixture(options); await assert.rejects(task.call(args), /chat_shell_scope_denied/); task.finish();
  }
  const thread = crypto.randomUUID(), run = crypto.randomUUID();
  store.db.prepare('INSERT INTO threads(id,mode,owner_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(thread, 'bot', owner, timestamp, timestamp);
  store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run, thread, 'bot', 'running', timestamp);
  const child = fixture(); store.db.prepare('UPDATE cloud_tasks SET parent_run_id=? WHERE id=?').run(run, child.id);
  assert.equal(sessionShell(child.context).tools.length, 0); await assert.rejects(child.call(args), /chat_shell_scope_denied/); child.finish();
  const delegated = fixture();
  store.db.prepare('INSERT INTO task_delegations(task_id,owner_id,parent_task_id,root_id,dependencies) VALUES(?,?,?,?,?)').run(delegated.id, owner, child.id, child.id, '[]');
  assert.equal(sessionShell(delegated.context).tools.length, 0); await assert.rejects(delegated.call(args), /chat_shell_scope_denied/); delegated.finish();
  const foreign = fixture(); foreign.context.owner = other;
  await assert.rejects(foreign.call(args), /chat_shell_scope_denied/); foreign.finish();

  const missing = fixture(); delete missing.context.sandbox;
  const savedEnv = [process.env.SANDBOX_URL, process.env.SANDBOX_TOKEN]; delete process.env.SANDBOX_URL; delete process.env.SANDBOX_TOKEN;
  try { await assert.rejects(missing.call(args), /sandbox_not_configured/); assert.equal(permissions(missing).length, 0); }
  finally { for (const [index, key] of ['SANDBOX_URL', 'SANDBOX_TOKEN'].entries()) { if (savedEnv[index] === undefined) delete process.env[key]; else process.env[key] = savedEnv[index]; } missing.finish(); }

  // The real compiled runtime must register shell, replay its result to the
  // model, save its tool trace, and keep the same workspace on the next turn.
  configuration.save(owner, { ...configuration.get(owner),
    providers: [{ id: 'offline', name: 'Offline', protocol: 'openai-chat', catalogId: '', baseUrl: 'https://offline.invalid/v1', apiKey: 'fixture', serves: ['chat'] }],
    llmModel: { providerId: 'offline', model: 'gpt-4.1' } });
  let script = [], modelCalls = 0;
  runner = new CloudTaskRunner(store, { records, configuration, sandbox, sandboxCleanup: cleanup, filesDir: path.join(directory, 'files'), fetch: async (_, init) => {
    modelCalls++; assert.ok(script.length, 'unexpected model call');
    return Response.json({ choices: [{ message: script.shift()(JSON.parse(init.body)), finish_reason: 'stop' }] });
  } });
  runner.start('http://127.0.0.1:1');
  async function turn(text, check) {
    const id = crypto.randomUUID(), count = requests.length;
    script = [body => {
      assert.ok(body.tools.some(t => t.function.name === 'shell'));
      return { role: 'assistant', content: '', tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'shell', arguments: JSON.stringify(args) } }] };
    }, body => {
      const receipt = body.messages.findLast(message => message.role === 'tool' && message.name === 'shell');
      assert.deepEqual(JSON.parse(receipt.content), success); check?.(body);
      return { role: 'assistant', content: '计算结果是42。' };
    }];
    store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, owner, id, 'chat', 'session:10', JSON.stringify({ sessionId: 10, text }), 'queued', timestamp, timestamp);
    const task = await until(() => { const row = taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id)); return ['completed', 'failed'].includes(row.status) && row; }, 'production Chat turn');
    assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(script.length, 0); assert.equal(requests.length, count + 1);
    assert.equal(task.result.content, '计算结果是42。');
    const answer = records.get(owner, 'chats', task.result.rowId);
    assert.equal(answer.tools.find(tool => tool.name === 'shell').status, 'done');
    assert.deepEqual(JSON.parse(answer.modelTrace.messages.find(message => message.role === 'tool' && message.name === 'shell').content), success);
    return task;
  }
  const firstTurn = await turn('请算6乘7');
  await turn('再核对一遍', body => assert.ok(JSON.stringify(body.messages).includes('请算6乘7')));
  assert.equal(requests.at(-1).threadId, requests.at(-2).threadId);
  const answer = records.get(owner, 'chats', firstTurn.result.rowId);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'chats', key: answer.id, before: answer, after: { ...answer, interrupted: true } }]);
  script = [body => { assert.ok(!body.tools?.length); return { role: 'assistant', content: '这是续写。' }; }];
  const continuation = crypto.randomUUID(), count = requests.length;
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(continuation, owner, continuation, 'chat', 'session:10', JSON.stringify({ sessionId: 10, action: 'continue', rowId: answer.id }), 'queued', timestamp, timestamp);
  const continued = await until(() => { const row = taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(continuation)); return ['completed', 'failed'].includes(row.status) && row; });
  assert.equal(continued.status, 'completed', JSON.stringify(continued)); assert.equal(requests.length, count); assert.equal(modelCalls, 5);
  console.log('PASS Chat Shell: production tool loop/history/continuation, workspace isolation, exact one-shot approvals, revoke/reject/stop, read/network/destructive policies, invalid scopes/arguments, deadlines/output metadata, cleanup and unavailable sandbox.');
} finally {
  await runner?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
