import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(root, { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'board-plugins-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/bootstrap-secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { BoardFiles } = await import('../apps/api/src/board/files.ts');
const { BoardScheduler } = await import('../apps/api/src/board/scheduler.ts');
const { BoardTasks } = await import('../apps/api/src/board/tasks.ts');
const { BotApplicationService } = await import('../apps/api/src/agent/service.ts');
const { notebookTools } = await import('../apps/api/src/agent/notebook-tools.ts');
const { executeBoardTool } = await import('../apps/api/runtime/board.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
const { StudyTools } = await import('../apps/api/src/agent/study.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite') });
let store;
try {
  await app.ready();
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'board-test-password-123' } })).statusCode, 201);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'board-test-password-123' } });
  const owner = login.json().user.id, cookie = login.headers['set-cookie'].split(';')[0];
  const api = (url, payload, headers = {}) => app.inject({ method: payload ? 'POST' : 'GET', url: `/api/v1${url}`, headers: { cookie, ...headers }, ...(payload ? { payload } : {}) });
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/board/plugins' })).statusCode, 401);
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const files = new BoardFiles(store), other = crypto.randomUUID(), now = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other', now);
  const catalog = (await api('/board/plugins')).json().plugins;
  assert.deepEqual(catalog.map(p => p.id), ['tasks', 'todo', 'pomodoro', 'schedules']);
  assert.ok(catalog.every(p => !p.error && p.manifest.enabled));
  assert.ok((await api('/system/files?path=/system')).json().directories.includes('/system/board'));
  assert.ok((await api('/system/files?path=/system/board/template')).json().files.some(f => f.name === 'manifest.json'));
  const statePath = '/system/board/plugins/todo/state.json';
  const initial = files.read(owner, statePath);
  const changed = files.save(owner, statePath, '{"items":[{"id":"one","title":"来自 Bot","done":false}]}', initial.content, initial.revision);
  assert.throws(() => files.save(owner, statePath, '{"items":[]}', initial.content, initial.revision), /conflict/);
  assert.equal(JSON.parse(files.read(other, statePath).content).items.length, 0);
  const todo = catalog.find(p => p.id === 'todo');
  const rpc = (plugin, method, args = {}, revision = plugin.revision) => api(`/board/plugins/${plugin.id}/rpc`, { revision, method, args });
  assert.equal((await rpc(todo, 'state.read')).json().content, changed.content);
  assert.equal((await rpc(todo, 'tasks.list')).statusCode, 403);
  assert.equal((await rpc(todo, 'state.read', {}, todo.revision + 1)).statusCode, 409);
  assert.equal((await api('/board/plugins/todo/rpc', { revision: todo.revision, method: 'state.read' }, { origin: 'https://untrusted.example' })).statusCode, 403);
  assert.equal((await api('/system/file', { path: '/system/board/../AGENTS.md', content: 'bad', expected: '', revision: 0 })).statusCode, 400);
  const account = crypto.createHash('sha256').update(owner).digest('hex');
  const physical = path.join(directory, 'files/system-files', account, 'system/board/plugins');
  fs.symlinkSync(path.join(directory, 'files'), path.join(physical, 'linked'));
  assert.ok(files.catalog(owner).find(p => p.id === 'linked').error);
  assert.throws(() => files.save(owner, '/system/board/plugins/linked/escape.json', '{}', '', 0), /unsafe/);

  // Install a new, previously unknown plugin exclusively through system resources.
  const context = { owner, thread: 'none', run: 'none', checkActive() {} };
  const tools = notebookTools(store), edit = tools.find(t => t.name === 'edit'), read = tools.find(t => t.name === 'read');
  for (const [name, content] of Object.entries({ 'manifest.json': JSON.stringify({ ...todo.manifest, id: 'counter', name: 'Counter' }), 'index.html': '<p>External package</p>', 'state.json': '{"count":1}' })) {
    await edit.execute({ path: `/system/board/plugins/counter/${name}`, create: true, content, revision: 0 }, context);
  }
  assert.ok(files.catalog(owner).some(p => p.id === 'counter' && p.manifest.enabled));
  const listing = await read.execute({ path: '/system/board/plugins/counter' }, context);
  assert.equal(listing.files.length, 3);
  const manifestPath = '/system/board/plugins/counter/manifest.json', manifest = files.read(owner, manifestPath);
  await edit.execute({ path: manifestPath, revision: manifest.revision, edits: [{ old_string: '"enabled":true', new_string: '"enabled":false' }] }, context);
  assert.equal((await api('/board/plugins/counter')).statusCode, 400);
  fs.writeFileSync(path.join(physical, 'counter/manifest.json'), '{broken');
  assert.ok(files.catalog(owner).find(p => p.id === 'counter').error);
  assert.ok(files.catalog(owner).find(p => p.id === 'todo').manifest.enabled);

  // Server Chat shares the file and obeys explicit permission denials.
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  const chat = { owner, store, configuration, task: { id: 'chat-test' }, checkActive() {} };
  assert.equal(JSON.parse(executeBoardTool(chat, { action: 'read', path: statePath })).content, changed.content);
  const denied = { ...chat, configuration: { taskPolicy: () => ({ read: 'allow', write: 'deny' }) } };
  assert.throws(() => executeBoardTool(denied, { action: 'write', path: statePath, content: '{}', expected: changed.content, revision: changed.revision }), /policy_denied/);
  assert.throws(() => executeBoardTool({ ...denied, configuration: { taskPolicy: () => ({ read: 'deny' }) } }, { action: 'read', path: statePath }), /policy_denied/);

  // Durable dispatch: no browser, exact owner, one-shot/repeat, restart and replay.
  const bots = new BotApplicationService(store, { enqueue() {} });
  const thread = bots.create(owner, 'bot', 'Scheduled'), foreign = bots.create(other, 'bot', 'Private');
  const conversations = await new StudyTools(store, configuration, path.join(directory, 'files')).plugins.get('board_threads').execute({}, { ...context, thread: thread.id });
  assert.equal(conversations.currentThreadId, thread.id);
  assert.ok(conversations.threads.some(t => t.id === thread.id));
  assert.ok(!conversations.threads.some(t => t.id === foreign.id));
  const schedulePath = '/system/board/plugins/schedules/schedules.json';
  const before = files.read(owner, schedulePath), time = Date.now();
  const jobs = [
    { id: 'once', threadId: thread.id, prompt: 'Run once', nextRunAt: new Date(time - 1000).toISOString(), enabled: true },
    { id: 'repeat', threadId: thread.id, prompt: 'Repeat', nextRunAt: new Date(time - 600000).toISOString(), everySeconds: 60, enabled: true },
  ];
  assert.throws(() => files.save(owner, schedulePath, JSON.stringify({ jobs: [{ ...jobs[0], threadId: foreign.id }] }), before.content, before.revision), /thread_not_found/);
  const due = files.save(owner, schedulePath, JSON.stringify({ jobs }), before.content, before.revision);
  const scheduler = new BoardScheduler(files, bots); scheduler.tick(time);
  let result = JSON.parse(files.read(owner, schedulePath).content);
  assert.equal(result.jobs[0].enabled, false);
  assert.ok(result.jobs.every(j => j.lastMessageId));
  assert.ok(Date.parse(result.jobs[1].nextRunAt) > time);
  const count = () => store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id=?').get(thread.id).n;
  assert.equal(count(), 2);
  new BoardScheduler(new BoardFiles(store), bots).tick(time);
  assert.equal(count(), 2);
  // Replay an old file snapshot: stable message nonce prevents duplicate delivery.
  const current = files.read(owner, schedulePath);
  files.save(owner, schedulePath, due.content, current.content, current.revision);
  scheduler.tick(time); assert.equal(count(), 2);
  // Delivery receipt and durable execution result are separate, even after a one-shot disables itself.
  const taskView = new BoardTasks(store);
  result = JSON.parse(files.read(owner, schedulePath).content);
  const onceTask = taskView.get(owner, result.jobs[0].lastTask.id);
  const repeatTask = taskView.get(owner, result.jobs[1].lastTask.id);
  assert.equal(onceTask.status, 'queued'); assert.equal(onceTask.result, null);
  for (const status of ['running', 'waiting_user', 'waiting_event', 'paused']) {
    store.db.prepare('UPDATE runs SET status=? WHERE id=?').run(status, onceTask.runId);
    scheduler.tick(time);
    assert.equal(JSON.parse(files.read(owner, schedulePath).content).jobs[0].lastTask.status, status);
    assert.equal(taskView.get(owner, onceTask.id).completedAt, null, `${status} is not completion`);
  }
  const reply = bots.append(thread.id, 'assistant', 'text', '复习清单已生成', `bot:${onceTask.runId}:reply:2`);
  bots.append(thread.id, 'assistant', 'text', '另一任务的回复', `bot:${repeatTask.runId}:reply:2`);
  store.db.prepare("UPDATE runs SET status='completed',completed_at=? WHERE id=?").run(now, onceTask.runId);
  store.db.prepare("UPDATE runs SET status='failed',error_code='model_request_failed',completed_at=? WHERE id=?").run(now, repeatTask.runId);
  scheduler.tick(time);
  result = JSON.parse(files.read(owner, schedulePath).content);
  assert.equal(result.jobs[0].lastTask.status, 'completed'); assert.equal(result.jobs[0].lastTask.completedAt, now);
  assert.equal(result.jobs[1].lastTask.status, 'failed'); assert.equal(result.jobs[1].lastTask.error, 'model_request_failed');
  const reopened = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  try { assert.equal(new BoardTasks(reopened).get(owner, onceTask.id).result.messageId, reply.id); } finally { reopened.close(); }
  assert.equal(taskView.get(owner, onceTask.id).result.text, '复习清单已生成', 'result belongs to this run, not latest conversation reply');
  const stable = files.read(owner, schedulePath); scheduler.tick(time);
  assert.equal(files.read(owner, schedulePath).revision, stable.revision, 'unchanged execution state causes no revision churn');
  const scheduleManifest = files.read(owner, '/system/board/plugins/schedules/manifest.json');
  files.save(owner, scheduleManifest.path, JSON.stringify({ ...JSON.parse(scheduleManifest.content), enabled: false }), scheduleManifest.content, scheduleManifest.revision);
  const disabledCount = count();
  store.db.prepare("UPDATE runs SET status='cancelled' WHERE id=?").run(repeatTask.runId);
  scheduler.tick(time + 120000); assert.equal(count(), disabledCount);
  assert.equal(JSON.parse(files.read(owner, schedulePath).content).jobs[1].lastTask.status, 'cancelled', 'disabled plugin still receives existing execution outcome');

  const tasksPlugin = catalog.find(p => p.id === 'tasks');
  const foreignMessage = bots.send(other, foreign.id, { clientNonce: 'private-task', content: 'Private prompt' });
  const privateTask = taskView.forMessage(other, foreign.id, foreignMessage.id);
  store.db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(privateTask.runId);
  const listed = (await rpc(tasksPlugin, 'tasks.list')).json().tasks;
  assert.ok(listed.some(t => t.id === onceTask.id && t.result.text === '复习清单已生成'));
  assert.ok(!listed.some(t => t.id === privateTask.id));
  for (const method of ['tasks.get', 'tasks.cancel', 'tasks.open']) assert.equal((await rpc(tasksPlugin, method, { id: privateTask.id })).statusCode, 404);
  assert.equal((await rpc(todo, 'tasks.get', { id: onceTask.id })).statusCode, 403);
  assert.equal((await rpc(tasksPlugin, 'tasks.open', { id: onceTask.id })).json().threadId, thread.id);
  const startArgs = { threadId: thread.id, prompt: 'SDK task', clientNonce: 'same-click' };
  const started = (await rpc(tasksPlugin, 'tasks.start', startArgs)).json();
  assert.ok(started.id.startsWith('bot:'));
  assert.equal((await rpc(tasksPlugin, 'tasks.start', startArgs)).json().id, started.id, 'retry returns the same run');
  assert.equal((await rpc(tasksPlugin, 'tasks.start', { ...startArgs, prompt: 'Different task' })).statusCode, 409);
  assert.equal((await rpc(tasksPlugin, 'tasks.start', { ...startArgs, threadId: foreign.id })).statusCode, 404);
  assert.equal((await rpc(todo, 'tasks.start', startArgs)).statusCode, 403);
  // Cancel one run and its children, not every run in the conversation.
  store.db.prepare("UPDATE runs SET status='paused' WHERE id=?").run(started.runId);
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,parent_run_id) VALUES('board-child',?,'board-child','material','fixture','{}','queued',?,?,?)").run(owner, now, now, started.runId);
  assert.equal((await rpc(tasksPlugin, 'tasks.cancel', { id: started.id })).json().cancelled, true);
  assert.equal(store.db.prepare("SELECT status FROM cloud_tasks WHERE id='board-child'").get().status, 'cancelled');
  assert.equal(taskView.get(owner, onceTask.id).status, 'completed');

  // User-edited and removed built-ins are never replaced by the compatibility upgrade.
  const customTasksPath = path.join(physical, 'tasks/index.html');
  fs.writeFileSync(customTasksPath, '<p>My customized tasks</p>'); files.ensure(owner);
  assert.equal(fs.readFileSync(customTasksPath, 'utf8'), '<p>My customized tasks</p>');
  fs.rmSync(path.join(physical, 'schedules'), { recursive: true }); files.ensure(owner);
  assert.ok(!fs.existsSync(path.join(physical, 'schedules')), 'upgrade does not recreate uninstalled defaults');
  fs.rmSync(path.join(physical, 'todo'), { recursive: true });
  assert.ok(!files.catalog(owner).some(p => p.id === 'todo'), 'unplugged defaults are not recreated');
  assert.equal((await rpc(todo, 'state.read')).statusCode, 400);
  assert.ok(!files.catalog(owner).some(p => p.id === 'todo'), 'a stale iframe RPC cannot recreate the removed directory');
  console.log('Board plugins passed: discovery, shared files, CAS/isolation, durable dispatch, true run outcomes, paused/waiting semantics, run-specific replies, idempotent task start, scoped cancellation, and safe default upgrades.');
} finally {
  await app.close(); store?.close(); fs.rmSync(directory, { recursive: true, force: true });
}
