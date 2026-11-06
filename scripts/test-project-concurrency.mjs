import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { ProjectTools } from '../apps/api/src/projects/tools.ts';
import { importBotAttachments } from '../apps/api/src/projects/attachments.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';
import { executeResourceCommand, recoverResourceCommands } from '../apps/api/src/realtime/resources.ts';
import { ProjectFileJournal } from '../apps/api/src/projects/file-journal.ts';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-concurrency-'));
  const filesDir = path.join(directory, 'files');
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(filesDir, 'system-files'));
  const projects = new ProjectRepository(store, path.join(filesDir, 'projects'));
  const resources = new ResourceFiles(projects, filesDir);
  const owner = crypto.randomUUID(), agent = crypto.randomUUID(), at = new Date().toISOString();
  store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, 'Concurrency', at);
  store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(agent, owner, 'Bot', 'assistant', '', at, at);
  const project = projects.create(owner, 'Notes', agent);
  const root = resources.list(owner).rootId;
  const command = operation => ({ operationId: `concurrency-${crypto.randomUUID()}`, operation });
  const execute = operation => executeResourceCommand(resources, owner, command(operation));
  const running = (projectId = project.id) => {
    const thread = crypto.randomUUID(), run = crypto.randomUUID();
    store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,created_at,updated_at) VALUES(?,?,?,?,'bot',?,?)").run(thread, owner, projectId, agent, at, at);
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','running',?)").run(run, thread, at);
    return { thread, run };
  };
  const blob = (id, text) => {
    fs.writeFileSync(path.join(filesDir, `${id}.bin`), text);
    store.db.prepare('INSERT INTO files(id,owner_id,original_name,mime_type,size_bytes,sha256,storage_name,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, owner, `${id}.md`, 'text/markdown', Buffer.byteLength(text), crypto.createHash('sha256').update(text).digest('hex'), `${id}.bin`, at);
  };
  const put = (table, key, after) => {
    const before = resources.records.get(owner, table, key);
    resources.records.apply(owner, [{ id: crypto.randomUUID(), table, key, before, after }]);
  };
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, filesDir, store, projects, resources, owner, agent, project, root, command, execute, running, blob, put };
}

test('a running conversation is not a file lock; only same-file stale writes conflict', t => {
  const f = fixture(t), { projects, resources, project, owner } = f;
  projects.files.write(project.id, 'a.md', 'base A', null);
  projects.files.write(project.id, 'b.md', 'base B', null);
  const a = projects.files.read(project.id, 'a.md'), b = projects.files.read(project.id, 'b.md');
  const { thread } = f.running();
  projects.isActive = id => id === project.id;
  assert.throws(() => projects.assertIdle(project.id), /project_busy/, 'whole-workspace deletion still coordinates with tasks');
  assert.doesNotThrow(() => projects.assertNoExecution(project.id));
  f.execute({ kind: 'saveProjectText', projectId: project.id, path: 'a.md', text: 'user A', expectedRevision: a.revision });
  assert.throws(() => projects.files.write(project.id, 'a.md', 'stale bot A', a.revision), /project_file_conflict/);
  assert.throws(() => projects.files.write(project.id, 'a.md', 'duplicate', null), /project_file_conflict/);
  f.execute({ kind: 'saveProjectText', projectId: project.id, path: 'b.md', text: 'user B', expectedRevision: b.revision });
  f.execute({ kind: 'createDirectory', projectId: project.id, path: 'user-directory' });
  const note = resources.list(owner, project.id).entries.find(entry => entry.path === 'a.md');
  resources.saveText(owner, note.courseId, 'reader A', 'user A');
  const tools = new ProjectTools(projects);
  const context = { ...projects.thread(thread), project_id: null };
  assert.equal(JSON.parse(tools.execute('workspace', { action: 'read', projectId: project.id, path: 'a.md' }, context)).text, 'reader A');
  tools.execute('workspace', { action: 'write', projectId: project.id, path: 'bot.md', text: 'Bot result', expectedRevision: null }, context);
  const current = projects.files.read(project.id, 'b.md');
  resources.move(owner, project.id, 'b.md', project.id, 'renamed-b.md', current.revision);
  const moved = projects.files.read(project.id, 'renamed-b.md');
  resources.remove(owner, project.id, 'renamed-b.md', moved.revision);
  assert.equal(projects.files.read(project.id, 'a.md').text, 'reader A');
  assert.ok(resources.list(owner, project.id).entries.some(entry => entry.name === 'user-directory'));
});

test('managed file commits check sandbox leases inside the SQLite writer transaction', t => {
  const { projects, store, project } = fixture(t);
  const rival = new Database(store.db.name, { timeout: 0 });
  try {
    const original = projects.assertNoExecution.bind(projects);
    let checks = 0;
    projects.assertNoExecution = id => {
      checks++;
      assert.equal(store.db.inTransaction, true, 'lease check and filesystem CAS share a synchronous transaction');
      assert.throws(() => rival.prepare('INSERT INTO project_executions VALUES(?,?)').run(id, 'racing-sandbox'), error => error.code === 'SQLITE_BUSY');
      original(id);
    };
    projects.files.write(project.id, 'atomic.md', 'atomic', null);
    assert.equal(checks, 1);
    assert.equal(store.db.inTransaction, false, 'no lock survives the commit');
    rival.prepare('INSERT INTO project_executions VALUES(?,?)').run(project.id, 'next-sandbox');
    assert.equal(projects.hasExecution(project.id), true);
  } finally { rival.close(); }
});

test('actual/uncertain sandboxes still exclude all managed writers, including Bot tools', t => {
  const f = fixture(t), { projects, project, owner } = f;
  const other = projects.create(owner, 'Unrelated');
  projects.files.write(project.id, 'note.md', 'keep', null);
  projects.files.mkdir(project.id, 'directory');
  projects.files.write(other.id, 'source.md', 'source', null);
  const current = projects.files.read(project.id, 'note.md');
  const source = projects.files.read(other.id, 'source.md');
  const temporary = path.join(f.filesDir, 'upload'); fs.writeFileSync(temporary, 'upload');
  projects.beginExecution(project.id, 'uncertain-shell');
  for (const write of [
    () => projects.files.write(project.id, 'note.md', 'lost', current.revision),
    () => projects.files.mkdir(project.id, 'new-directory'),
    () => projects.files.copy(project.id, 'copy.md', temporary),
    () => projects.files.installUpload(project.id, 'upload.md', temporary),
    () => projects.files.remove(project.id, 'note.md', current.revision),
    () => projects.files.move(project.id, 'note.md', other.id, 'out.md', current.revision),
    () => projects.files.move(other.id, 'source.md', project.id, 'in.md', source.revision),
  ]) assert.throws(write, /project_busy/);
  const { thread } = f.running();
  assert.throws(() => new ProjectTools(projects).execute('workspace', { action: 'write', path: 'note.md', text: 'lost', expectedRevision: current.revision }, projects.thread(thread)), /project_busy/);
  assert.doesNotThrow(() => projects.files.write(other.id, 'unrelated.md', 'allowed', null));
  assert.equal(projects.files.read(project.id, 'note.md').text, 'keep');
  // Pure project metadata does not modify sandbox paths.
  f.resources.list(owner, other.id);
  assert.doesNotThrow(() => f.resources.setFolderColor(owner, project.id, '', 'purple'));
  projects.endExecution('uncertain-shell');
  projects.files.write(project.id, 'note.md', 'after cleanup', current.revision);
  assert.equal(projects.files.read(project.id, 'note.md').text, 'after cleanup');
});

test('busy legacy file operations defer per item, without redirecting descendants to the root', t => {
  const f = fixture(t), { projects, project, resources, owner, root } = f;
  projects.files.write(project.id, 'delete.md', 'delete later', null);
  const deletion = resources.list(owner, project.id).entries.find(entry => entry.path === 'delete.md');
  const folder = resources.list(owner).entries.find(entry => entry.projectId === project.id);
  f.put('courseFiles', deletion.courseId, null);
  f.put('folders', 999, { id: 999, name: 'deferred-child', parentId: folder.folderId, createdAt: 1 });
  for (const [id, folderId] of [['nested', 999], ['unrelated', undefined]]) {
    f.blob(id, `# ${id}`);
    f.put('videos', id, { id, name: id, folderId, kind: 'material', materialFormat: 'md', createdAt: 1 });
    f.put('courseFiles', id, { id, fileId: id });
  }
  projects.beginExecution(project.id, 'busy-migration');
  assert.doesNotThrow(() => resources.list(owner));
  assert.ok(resources.placement(owner, 'unrelated'), 'an unrelated root file still migrates');
  assert.equal(resources.placement(owner, 'nested'), undefined, 'a deferred parent does not fall back to the resource root');
  assert.equal(fs.existsSync(path.join(projects.files.root, project.id, 'delete.md')), true);
  assert.ok(!projects.files.list(root).some(entry => entry.name === 'nested.md'));
  projects.endExecution('busy-migration');
  resources.migrate(owner);
  assert.equal(resources.placement(owner, 'nested').project_id, project.id);
  assert.equal(resources.placement(owner, 'nested').path, 'deferred-child/nested.md');
  assert.equal(fs.existsSync(path.join(projects.files.root, project.id, 'delete.md')), false);
  assert.equal(projects.files.read(project.id, 'deferred-child/nested.md').text, '# nested');
});

test('Bot attachment projection preserves pending sources and resumes after sandbox cleanup', t => {
  const f = fixture(t), { projects, owner, store } = f;
  const bot = projects.botWorkspace(owner), { thread } = f.running(bot);
  const fileId = crypto.randomUUID(); f.blob(fileId, '# attachment');
  store.db.prepare("INSERT INTO messages(id,thread_id,seq,role,kind,content,created_at) VALUES(?,?,1,'user','attachment',?,?)")
    .run(crypto.randomUUID(), thread, JSON.stringify({ fileId }), new Date().toISOString());
  projects.beginExecution(bot, 'attachment-shell');
  assert.doesNotThrow(() => importBotAttachments(projects, f.filesDir, owner));
  assert.equal(store.db.prepare('SELECT 1 FROM resource_attachments WHERE file_id=?').get(fileId), undefined);
  projects.endExecution('attachment-shell');
  importBotAttachments(projects, f.filesDir, owner);
  const receipt = store.db.prepare('SELECT * FROM resource_attachments WHERE file_id=?').get(fileId);
  assert.equal(receipt.status, 'done');
  assert.equal(projects.files.read(bot, receipt.path).text, '# attachment');
});

test('record baselines and incremental pages never execute workspace migration', async t => {
  const f = fixture(t), { resources, projects, store, owner, project } = f;
  projects.files.write(project.id, 'pending.md', 'retained', null);
  const pending = resources.list(owner, project.id).entries.find(entry => entry.path === 'pending.md');
  f.put('courseFiles', pending.courseId, null);
  projects.beginExecution(project.id, 'record-feed-shell');
  // System-document indexing is independent of project migration; settle it
  // before measuring that the workspace feed causes no extra projection.
  resources.records.list(owner, 0);
  resources.migrate = () => { throw new Error('record feed must not migrate'); };
  const domain = new ClientRuntimeDomain(store, undefined, undefined, resources);
  try {
    const before = store.db.prepare('SELECT COUNT(*) n FROM cloud_operations').get().n;
    const page = await domain.recordsPage(owner, 0);
    assert.ok(page.records.length);
    await domain.recordsPage(owner, page.cursor);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM cloud_operations').get().n, before);
    assert.equal(projects.files.read(project.id, 'pending.md').text, 'retained');
  } finally { domain.close(); }
});

test('journal recovery no longer waits for a conversation that is not executing a sandbox', t => {
  const f = fixture(t), { projects, project, owner, resources, store } = f;
  const request = f.command({ kind: 'saveProjectText', projectId: project.id, path: 'recovery.md', text: 'recovered', expectedRevision: null });
  const canonical = JSON.stringify({ kind: 'resource', operation: Object.fromEntries(Object.entries(request.operation).sort(([a], [b]) => a.localeCompare(b))) });
  const digest = crypto.createHash('sha256').update(canonical).digest('hex');
  store.db.prepare("INSERT INTO client_commands(owner_id,operation_id,digest,status) VALUES(?,?,?,'pending')").run(owner, request.operationId, digest);
  store.db.prepare("INSERT INTO resource_workflows(owner_id,operation_id,request,binding,updated_at) VALUES(?,?,?,'',?)").run(owner, request.operationId, JSON.stringify(request), Date.now());
  const journal = new ProjectFileJournal(projects.files, owner, request.operationId);
  projects.files.withJournal(journal, () => projects.files.write(project.id, 'recovery.md', 'interrupted', null));
  f.running(); projects.isActive = id => id === project.id;
  projects.beginExecution(project.id, 'recovery-cleanup-pending');
  recoverResourceCommands(resources);
  assert.equal(store.db.prepare('SELECT status FROM client_commands WHERE operation_id=?').get(request.operationId).status, 'pending');
  assert.equal(store.db.prepare('SELECT last_error FROM resource_workflows WHERE operation_id=?').get(request.operationId).last_error, 'project_busy', 'temporary lease contention is not an external rollback conflict');
  assert.equal(projects.files.read(project.id, 'recovery.md').text, 'interrupted');
  projects.endExecution('recovery-cleanup-pending');
  recoverResourceCommands(resources);
  assert.equal(store.db.prepare('SELECT status FROM client_commands WHERE operation_id=?').get(request.operationId).status, 'completed');
  assert.equal(projects.files.read(project.id, 'recovery.md').text, 'recovered');
});

test('HTTP login, record feeds and unrelated files remain available while a workspace is busy', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'project-concurrency-http-'));
  const environment = { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
    FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'bootstrap-secret') };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  let app, store;
  try {
    const { buildServer } = await import('../apps/api/src/server.ts');
    app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), sandboxCleanup: async () => { throw new Error('broker offline'); } });
    const init = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: {
      'x-bootstrap-secret': fs.readFileSync(environment.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
    }, payload: { adminPassword: 'concurrency-password' } });
    assert.equal(init.statusCode, 201, init.body);
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'concurrency-password' } });
    assert.equal(login.statusCode, 200, login.body);
    const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
    store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(environment.FILES_DIR, 'system-files'));
    const projects = new ProjectRepository(store, path.join(environment.FILES_DIR, 'projects'));
    const resources = new ResourceFiles(projects, environment.FILES_DIR);
    const project = projects.create(owner, 'Busy workspace', projects.defaultAgent(owner));
    const other = projects.create(owner, 'Independent workspace');
    projects.files.write(project.id, 'note.md', 'original', null);
    projects.files.write(project.id, 'pending.md', 'delete later', null);
    const pending = resources.list(owner, project.id).entries.find(entry => entry.path === 'pending.md');
    const reference = resources.records.get(owner, 'courseFiles', pending.courseId);
    resources.records.apply(owner, [{ id: crypto.randomUUID(), table: 'courseFiles', key: pending.courseId, before: reference, after: null }]);
    const thread = crypto.randomUUID(), at = new Date().toISOString();
    store.db.prepare("INSERT INTO threads(id,owner_id,project_id,agent_id,mode,created_at,updated_at) VALUES(?,?,?,?,'bot',?,?)").run(thread, owner, project.id, projects.defaultAgent(owner), at, at);
    store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','running',?)").run(crypto.randomUUID(), thread, at);
    const call = async (method, url, payload, expected = 200) => {
      const response = await app.inject({ method, url, headers: { cookie }, ...(payload === undefined ? {} : { payload }) });
      assert.equal(response.statusCode, expected, `${method} ${url}: ${response.body}`);
      return response.json();
    };
    const fileUrl = `/api/v1/projects/${project.id}/text?path=note.md`;
    const current = await call('GET', fileUrl);
    await call('PUT', fileUrl, { text: 'edited during model generation', expectedRevision: current.revision });
    await call('PUT', fileUrl, { text: 'stale', expectedRevision: current.revision }, 409);
    projects.beginExecution(project.id, crypto.randomUUID());
    await call('POST', '/api/v1/auth/password/login', { password: 'concurrency-password' });
    assert.equal((await call('GET', '/api/v1/auth/session')).authenticated, true);
    await call('GET', '/api/v1/cloud/records?after=0');
    const page = await call('POST', '/api/clientRuntime/recordsPage', {
      type: 'client-request', rpcId: crypto.randomUUID(), method: 'clientRuntime/recordsPage', payload: { args: { after: 0 } },
    });
    assert.equal(page.result.ok, true, JSON.stringify(page));
    assert.ok(page.result.value.records.length);
    assert.equal(projects.files.read(project.id, 'pending.md').text, 'delete later', 'record feeds did not consume the pending deletion');
    await call('PUT', fileUrl, { text: 'unsafe', expectedRevision: current.revision }, 409);
    await call('PUT', `/api/v1/projects/${other.id}/text?path=unrelated.md`, { text: 'available', expectedRevision: null });
    await call('GET', '/api/v1/resources');
  } finally {
    await app?.close(); store?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
