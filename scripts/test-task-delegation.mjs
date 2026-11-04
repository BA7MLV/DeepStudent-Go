import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { TaskDelegationService } from '../apps/api/src/cloud/delegation.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';
import { submitOwnerTask } from '../apps/api/src/cloud/task-commands.ts';
import { UsageLedger } from '../apps/api/src/agent/budget.ts';
import { TaskStepBudget } from '../apps/api/src/agent/task-step-budget.ts';
import { freezeTaskModel } from '../apps/api/src/agent/task-model.ts';
import { ModelTargetResolver } from '../apps/api/src/agent/model-target-resolver.ts';
import { createModelGateway } from '../apps/api/src/agent/model-gateway-factory.ts';
import { modelUsageReport } from '../apps/api/src/agent/model-observations.ts';
import { WorkspaceHandoff } from '../apps/api/src/agent/workspace-handoff.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';

const temp = '/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode';
const ref = model => ({ providerId: 'fixture', model });
const selection = model => ({ modelRef: ref(model) });
function fixture() {
  const directory = fs.mkdtempSync(path.join(temp, 'task-delegation-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  for (const owner of ['owner', 'other']) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const configuration = new CloudConfiguration(store, directory);
  const config = configuration.save('owner', { ...configuration.get('owner'), providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'test-only', protocol: 'openai-chat', catalogId: '', serves: ['chat'], deployments: ['A','B','C'].map(model => ({ model, protocol: 'openai-chat' })) }], llmModel: ref('A'), policy: { read: 'allow', write: 'allow', shell: 'deny', remove: 'deny', network: 'deny', maxSteps: 30 } });
  const service = new TaskDelegationService(store, configuration), records = new CloudRecords(store);
  const session = service.command('owner', { action: 'session.create', operationId: 'root-session', title: 'Root', defaultModel: selection('A') }).sessionId;
  return { directory, store, configuration, config, service, records, session, close() { store.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}
const create = (operationId, extras = {}) => ({ action: 'create', operationId, goal: 'Check the supplied evidence', constraints: ['No invented sources'], completionCriteria: ['Explain uncertainty'], context: [{ source: 'draft', version: 'v1', text: 'fixture evidence' }], modelSelection: selection('B'), ...extras });
const until = async fn => { const deadline = Date.now() + 15000; while (Date.now() < deadline) { if (fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('fixture_timeout'); };
const response = (content, calls = []) => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls.length ? { tool_calls: calls.map(([name, args]) => ({ id: crypto.randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })) } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });

function workspaceFixture(f) {
  const stamp = new Date().toISOString();
  f.store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,role,system_prompt,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run('fixture-bot', 'owner', 'Fixture', 'study', '', stamp, stamp);
  const projects = new ProjectRepository(f.store, path.join(f.directory, 'projects'));
  const main = projects.create('owner', 'Main workspace', 'fixture-bot');
  const alternate = projects.create('owner', 'Alternate workspace', 'fixture-bot');
  return { projects, main, alternate };
}

function workspaceThread(f, projectId) {
  const id = crypto.randomUUID(), stamp = new Date().toISOString();
  f.store.db.prepare("INSERT INTO threads(id,owner_id,mode,title,agent_id,project_id,created_at,updated_at) VALUES(?,'owner','bot','Workspace','fixture-bot',?,?,?)").run(id, projectId, stamp, stamp);
  return { id };
}

test('workspace revision covers nested changes, special entries and rename without following links', () => {
  const f = fixture();
  try {
    const { projects, main } = workspaceFixture(f);
    projects.files.mkdir(main.id, 'nested');
    const file = projects.files.write(main.id, 'nested/note.txt', 'before', null);
    const first = projects.files.workspaceRevision(main.id);
    assert.equal(projects.files.workspaceRevision(main.id), first, 'reads do not change the revision');
    projects.files.write(main.id, 'nested/note.txt', 'after!', file.revision);
    const second = projects.files.workspaceRevision(main.id);
    assert.notEqual(first, second);
    const external = path.join(f.directory, 'outside.txt');
    fs.writeFileSync(external, 'not included');
    fs.symlinkSync(external, path.join(projects.files.root, main.id, 'link'));
    const linked = projects.files.workspaceRevision(main.id);
    assert.notEqual(second, linked);
    fs.writeFileSync(external, 'must not follow the link');
    assert.equal(projects.files.workspaceRevision(main.id), linked);
    fs.renameSync(path.join(projects.files.root, main.id, 'nested'), path.join(projects.files.root, main.id, 'renamed'));
    assert.notEqual(projects.files.workspaceRevision(main.id), linked);
    projects.files.mkdir(main.id, 'deep');
    let directory = path.join(projects.files.root, main.id, 'deep');
    for (let i = 0; i < 65; i++) { directory = path.join(directory, 'd'); fs.mkdirSync(directory); }
    assert.throws(() => projects.files.workspaceRevision(main.id), /workspace_revision_too_large/);
  } finally { f.close(); }
});

test('workspace handoff blocks unsettled or uncertain alternate commands and resumes atomically', async () => {
  const f = fixture();
  let bot;
  try {
    const { projects, main, alternate } = workspaceFixture(f);
    bot = new BotRunner(f.store, { configuration: f.configuration, projects });
    const app = new BotApplicationService(f.store, bot, projects);
    const session = workspaceThread(f, main.id);
    const run = app.send('owner', session.id, { clientNonce: 'handoff', content: 'check workspace' }).receipt.runId;
    const thread = projects.thread(session.id), handoff = new WorkspaceHandoff(f.store, projects);
    const stamp = new Date().toISOString();
    f.store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES('in-flight',?,'shell','{}','running',?)").run(run, stamp);
    assert.throws(() => handoff.capture(run, thread, 'wait-step'), /workspace_handoff_unsettled/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM run_workspace_handoffs').get().n, 0);
    f.store.db.prepare("UPDATE run_steps SET status='interrupted' WHERE id='in-flight'").run();
    projects.beginExecution(alternate.id, 'in-flight');
    assert.throws(() => handoff.capture(run, thread, 'wait-step'), /workspace_cleanup_pending/, 'alternate lease is checked even before its scope receipt exists');
    assert.equal(projects.hasExecution(alternate.id), true, 'failure must not release the uncertain sandbox lease');
    projects.endExecution('in-flight');
    handoff.observe(run, alternate.id);
    handoff.capture(run, thread, 'wait-step');
    const saved = f.store.db.prepare('SELECT payload FROM run_workspace_handoffs WHERE run_id=?').get(run).payload;
    projects.files.write(alternate.id, 'changed.txt', 'external edit', null);
    assert.throws(() => f.store.transaction(() => { assert.match(handoff.resume(run, thread), /Workspace changed/); throw new Error('simulated_commit_failure'); }), /simulated_commit_failure/);
    assert.equal(f.store.db.prepare('SELECT payload FROM run_workspace_handoffs WHERE run_id=?').get(run).payload, saved, 'rollback preserves the change notice for restart');
    f.store.db.prepare('UPDATE agent_profiles SET enabled=0 WHERE id=?').run('fixture-bot');
    assert.throws(() => handoff.resume(run, thread), /agent_not_found/, 'resume rechecks current authorization');
    assert.ok(f.store.db.prepare('SELECT 1 FROM run_workspace_handoffs WHERE run_id=?').get(run));
    f.store.db.prepare('UPDATE agent_profiles SET enabled=1 WHERE id=?').run('fixture-bot');
    assert.match(handoff.resume(run, thread), new RegExp(alternate.id));
    assert.equal(handoff.resume(run, thread), undefined, 'notice consumption is idempotent');
    handoff.capture(run, thread, 'wait-step');
    assert.equal(handoff.resume(run, thread), undefined, 'unchanged workspace needs no warning');
    handoff.capture(run, thread, 'wait-step');
    const reopened = new DatabaseStore(path.join(f.directory, 'db.sqlite'));
    try {
      const recoveredProjects = new ProjectRepository(reopened, path.join(f.directory, 'projects'));
      projects.files.write(main.id, 'after-reopen.txt', 'persisted checkpoint', null);
      assert.match(reopened.transaction(() => new WorkspaceHandoff(reopened, recoveredProjects).resume(run, recoveredProjects.thread(session.id))), new RegExp(main.id));
    } finally { reopened.close(); }
  } finally { await bot?.close(); f.close(); }
});

test('Bot wait restart rechecks default and observed alternate workspace before replanning, without tool replay', async () => {
  const f = fixture();
  let bot, cloud;
  try {
    process.env.BOT_CONCURRENCY = '1'; process.env.CLOUD_CONCURRENCY = '1';
    const { projects, main, alternate } = workspaceFixture(f);
    for (const project of [main, alternate]) projects.files.write(project.id, 'note.txt', 'before', null);
    let turn = 0, childId, notices = 0;
    const reads = () => [main, alternate].map(project => ['workspace', { action: 'read', projectId: project.id, path: 'note.txt' }]);
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'B') return response('Child result; no workspace authority.');
      if (++turn === 1) return response(null, reads());
      if (turn === 2) { const { operationId: _ignored, ...args } = create('ignored'); return response(null, [['task_delegate', args]]); }
      if (turn === 3) { childId = JSON.parse(body.messages.at(-1).content).id; return response(null, [['task_delegate', { action: 'wait', taskIds: [childId] }]]); }
      const notice = body.messages.filter(m => m.content?.startsWith('Workspace changed while this task waited.'));
      assert.equal(notice.length, 1);
      assert.match(notice[0].content, new RegExp(main.id));
      assert.match(notice[0].content, new RegExp(alternate.id));
      notices++;
      if (turn === 4) return response(null, reads());
      assert.equal(turn, 5);
      assert.match(body.messages.at(-1).content, /after/);
      return response('Re-read changed workspaces; summary only.');
    };
    const options = { configuration: f.configuration, projects, study: new StudyTools(f.store, f.configuration, path.join(f.directory, 'files')), fetch: fetcher };
    bot = new BotRunner(f.store, options);
    const app = new BotApplicationService(f.store, bot, projects);
    const session = workspaceThread(f, main.id);
    const run = app.send('owner', session.id, { clientNonce: 'parent-wait', content: 'Read both workspaces, delegate analysis, then verify before summarizing.' }).receipt.runId;
    bot.start();
    await until(() => f.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run)?.status === 'waiting_event');
    await bot.close(); bot = undefined;
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM run_workspace_scopes WHERE run_id=?').get(run).n, 2);
    const checkpoint = JSON.parse(f.store.db.prepare('SELECT payload FROM run_workspace_handoffs WHERE run_id=?').get(run).payload);
    assert.equal(checkpoint.length, 2);
    for (const project of [main, alternate]) projects.files.write(project.id, 'note.txt', 'after', projects.files.read(project.id, 'note.txt').revision);
    cloud = new CloudTaskRunner(f.store, { configuration: f.configuration, fetch: fetcher, filesDir: path.join(f.directory, 'files') });
    cloud.start('http://fixture.invalid');
    bot = new BotRunner(f.store, options); bot.start();
    await until(() => f.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run)?.status === 'completed');
    assert.equal(turn, 5);
    assert.equal(notices, 2);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM run_steps WHERE run_id=? AND tool='workspace'").get(run).n, 4, 'only initial reads and explicitly replanned reads run');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM run_workspace_handoffs WHERE run_id=?').get(run).n, 0);
    assert.equal(f.service.command('owner', { action: 'read', taskId: childId }).status, 'completed');
  } finally { await bot?.close(); await cloud?.close(); f.close(); }
});

test('admission freezes exact model, thinking and candidate order; defaults do not mutate', () => {
  const f = fixture();
  try {
    const task = submitOwnerTask(f.store, f.records, f.configuration, 'owner', { operationId: 'task-b', kind: 'chat', resource: `session:${f.session}`, input: { sessionId: f.session, text: 'test', modelSelection: selection('B'), thinkingLevel: 'high' } });
    assert.equal(task.frozenModel.candidates[0].model, 'B');
    assert.equal(task.frozenModel.thinkingLevel, 'high');
    assert.equal(f.configuration.get('owner').llmModel.model, 'A');
    f.service.command('owner', { action: 'session.default', sessionId: f.session, expected: selection('A'), value: selection('C') });
    assert.equal(JSON.parse(f.store.db.prepare('SELECT model_snapshot FROM cloud_tasks WHERE id=?').get(task.id).model_snapshot).candidates[0].model, 'B');
    assert.equal(submitOwnerTask(f.store, f.records, f.configuration, 'owner', { operationId: 'task-b', kind: 'chat', resource: `session:${f.session}`, input: { sessionId: f.session, text: 'test', modelSelection: selection('B'), thinkingLevel: 'high' } }).id, task.id);
    const resolver = new ModelTargetResolver(() => ({ ...f.config, providers: [] }));
    assert.throws(() => resolver.resolve({ owner: 'owner', purpose: 'chat', frozenModel: task.frozenModel }), /provider_not_found/);
    assert.throws(() => freezeTaskModel(f.store, 'owner', f.config, 'chat', { modelRef: ref('B'), presetId: 'ambiguous' }), /invalid_model_selection/);
  } finally { f.close(); }
});

test('native Chat rejects unsupported configured fallback instead of accepting and ignoring it', () => {
  const f = fixture();
  try {
    const config = f.configuration.get('owner');
    f.configuration.save('owner', { ...config, modelPresets: [...config.modelPresets, { id: 'fallback-fixture', name: 'Fallback fixture', purposes: ['chat'], candidates: [{ ref: ref('B') }, { ref: ref('C') }] }] });
    const modelSelection = { presetId: 'fallback-fixture', fallbackPolicy: 'configured' };
    assert.throws(() => f.service.command('owner', { action: 'session.send', operationId: 'unsupported-fallback', sessionId: f.session, text: 'check', modelSelection }), /task_fallback_not_supported/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cloud_tasks WHERE nonce=?').get('unsupported-fallback').n, 0);
    const child = f.service.command('owner', create('canonical-fallback', { modelSelection }));
    assert.deepEqual(child.frozenModel.candidates.map(c => c.model), ['B', 'C'], 'canonical delegated execution retains its supported fallback candidates');
  } finally { f.close(); }
});

test('temporary records, sibling dependencies, ownership, depth, cancellation and promotion are idempotent', () => {
  const f = fixture();
  try {
    const root = f.service.command('owner', { action: 'session.send', operationId: 'root', sessionId: f.session, text: 'Root constraints' });
    const before = f.store.db.prepare("SELECT COUNT(*) n FROM cloud_records WHERE table_name='chatSessions'").get().n;
    const a = f.service.command('owner', create('create-a', { parentTaskId: root.id }));
    assert.equal(f.service.command('owner', create('create-a', { parentTaskId: root.id })).id, a.id);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cloud_records WHERE table_name='chatSessions'").get().n, before);
    assert.throws(() => f.service.command('owner', create('recursive', { parentTaskId: a.id })), /depth_exceeded/);
    assert.throws(() => f.service.command('other', { action: 'read', taskId: a.id }), /task_not_found/);
    const b = f.service.command('owner', create('create-b', { parentTaskId: root.id, dependsOn: [a.id] }));
    assert.throws(() => f.service.command('owner', create('cycle', { parentTaskId: root.id, dependsOn: ['future-id'] })), /invalid_task_dependencies/);
    f.store.db.prepare("UPDATE cloud_tasks SET status='completed',result=? WHERE id=?").run(JSON.stringify({ conclusion: 'Verified fixture output' }), a.id);
    const promoted = f.service.command('owner', { action: 'promote', taskId: a.id });
    assert.deepEqual(f.service.command('owner', { action: 'promote', taskId: a.id }), promoted);
    assert.equal(f.service.command('owner', { action: 'session.read', sessionId: promoted.sessionId }).messages.at(-1).content, 'Verified fixture output');
    f.service.command('owner', { action: 'cancel', taskId: root.id });
    assert.equal(f.service.command('owner', { action: 'read', taskId: b.id }).status, 'cancelled');
    assert.equal(f.service.command('owner', { action: 'read', taskId: a.id }).status, 'completed');
    assert.ok(f.service.command('owner', { action: 'session.read', sessionId: promoted.sessionId }));
  } finally { f.close(); }
});

test('exact history branch strips native state and develops independently; queued override preserves session default', () => {
  const f = fixture();
  try {
    f.records.apply('owner', [1,2,3].map(id => ({ id: `row-${id}`, table: 'chats', key: id, before: null, after: { id, sessionId: f.session, videoId: '__library_assistant__', role: id % 2 ? 'user' : 'assistant', content: `message ${id}`, createdAt: id, modelTrace: { secretContinuation: 'provider-only' } } })));
    const branch = f.service.command('owner', { action: 'session.create', operationId: 'branch', title: 'Branch', sourceSessionId: f.session, sourceMessageId: 2, defaultModel: selection('B') });
    const snapshot = f.service.command('owner', { action: 'session.read', sessionId: branch.sessionId });
    assert.deepEqual(snapshot.messages.map(m => m.content), ['message 1','message 2']);
    assert.doesNotMatch(JSON.stringify(snapshot), /secretContinuation|provider-only|message 3/);
    const task = f.service.command('owner', { action: 'session.send', operationId: 'override-c', sessionId: branch.sessionId, text: 'next', modelSelection: selection('C') });
    assert.equal(task.frozenModel.candidates[0].model, 'C');
    assert.equal(f.service.command('owner', { action: 'session.read', sessionId: branch.sessionId }).session.defaultModel.modelRef.model, 'B');
    assert.throws(() => f.service.command('owner', { action: 'session.create', operationId: 'bad-branch', title: 'Bad', sourceSessionId: f.session, sourceMessageId: 999 }), /source_message_not_found/);
  } finally { f.close(); }
});

test('Bot parent waits durably at concurrency=1, child uses B, main retains A and summarizes once', async () => {
  const f = fixture();
  let bot, cloud;
  try {
    process.env.BOT_CONCURRENCY = '1'; process.env.CLOUD_CONCURRENCY = '1';
    let mainTurns = 0, childCalls = 0, childId;
    const models = [];
    let runId;
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body); models.push(body.model);
      if (body.model === 'B') {
        childCalls++;
        await until(() => f.store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status === 'waiting_event');
        assert.match(JSON.stringify(body.messages), /Root constraints/);
        assert.equal(body.tools?.length ?? 0, 0);
        return response('Child checked fixture evidence; no external validation.');
      }
      assert.equal(body.model, 'A');
      if (++mainTurns === 1) { const { operationId: _ignored, ...args } = create('ignored'); return response(null, [['task_delegate', args]]); }
      if (mainTurns === 2) {
        const output = JSON.parse(body.messages.at(-1).content);
        childId = output.id;
        return response(null, [['task_delegate', { action: 'wait', taskIds: [childId] }]]);
      }
      assert.match(JSON.stringify(body.messages), /Child checked fixture evidence/);
      return response('Main summary: fixture checked, not a real quality evaluation.');
    };
    bot = new BotRunner(f.store, { configuration: f.configuration, study: new StudyTools(f.store, f.configuration, path.join(f.directory, 'files')), fetch: fetcher });
    const app = new BotApplicationService(f.store, bot);
    const thread = app.create('owner', 'bot', 'Main');
    const message = app.send('owner', thread.id, { clientNonce: 'fixture-message', content: 'Root constraints: use only fixture evidence', modelSelection: selection('A') });
    runId = message.receipt.runId;
    assert.equal(app.send('owner', thread.id, { clientNonce: 'fixture-message', content: 'Root constraints: use only fixture evidence', modelSelection: selection('A') }).receipt.runId, runId, 'lost responses return the original run receipt');
    assert.throws(() => app.send('owner', thread.id, { clientNonce: 'fixture-message', content: 'Root constraints: use only fixture evidence', modelSelection: selection('B') }), /message_nonce_conflict/);
    assert.throws(() => app.send('owner', thread.id, { clientNonce: 'silent-reroute', content: 'switch model', modelSelection: selection('B'), target: { kind: 'run', runId } }), /task_model_requires_new_attempt/);
    cloud = new CloudTaskRunner(f.store, { configuration: f.configuration, fetch: fetcher, filesDir: path.join(f.directory, 'files') });
    cloud.start('http://fixture.invalid'); bot.start();
    await until(() => f.store.db.prepare('SELECT status FROM runs WHERE id=?').get(runId)?.status === 'completed');
    assert.equal(childCalls, 1);
    assert.deepEqual(models.filter(m => m === 'B'), ['B']);
    assert.equal(f.service.command('owner', { action: 'read', taskId: childId }).result.actualModels[0].model, 'B');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM messages WHERE thread_id=? AND role='assistant' AND kind='text'").get(thread.id).n, 1);
    assert.equal(f.configuration.get('owner').llmModel.model, 'A');
  } finally { await bot?.close(); await cloud?.close(); f.close(); }
});

test('Chat durable wait survives runner restart without duplicate messages or tool replay', async () => {
  const f = fixture();
  let runner;
  try {
    process.env.CLOUD_CONCURRENCY = '1';
    let turns = 0, childCalls = 0, childId;
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'B') { childCalls++; return response('Child restart evidence'); }
      assert.equal(body.model, 'A');
      if (++turns === 1) {
        const { operationId: _ignored, ...args } = create('ignored');
        return response(null, [['task_delegate', args]]);
      }
      if (turns === 2) {
        childId = JSON.parse(body.messages.at(-1).content).id;
        return response(null, [['task_delegate', { action: 'wait', taskIds: [childId] }]]);
      }
      assert.match(JSON.stringify(body.messages), /Child restart evidence/);
      assert.equal(JSON.parse(body.messages.at(-1).content).waiting, false);
      return response('Main restart summary');
    };
    const options = { configuration: f.configuration, filesDir: path.join(f.directory, 'files'), fetch: fetcher };
    const root = f.service.command('owner', { action: 'session.send', operationId: 'chat-restart', sessionId: f.session, text: 'Root constraints', modelSelection: selection('A') });
    runner = new CloudTaskRunner(f.store, options); runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(root.id)?.status === 'waiting_event');
    await runner.close();
    assert.equal(childCalls, 0, 'child remains queued at the safe restart boundary');
    const before = f.service.command('owner', { action: 'session.read', sessionId: f.session }).messages;
    f.service.command('owner', { action: 'session.default', sessionId: f.session, expected: selection('A'), value: selection('C') });
    runner = new CloudTaskRunner(f.store, options); runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(root.id)?.status === 'completed');
    const after = f.service.command('owner', { action: 'session.read', sessionId: f.session }).messages;
    assert.equal(childCalls, 1); assert.equal(turns, 3);
    assert.equal(after.length, 2);
    assert.deepEqual(after.map(m => [m.id, m.createdAt]), before.map(m => [m.id, m.createdAt]));
    assert.equal(after.at(-1).content, 'Main restart summary');
    assert.equal(after.at(-1).interrupted, undefined);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_delegations WHERE parent_task_id=?').get(root.id).n, 1);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_tool_steps WHERE task_id=?').get(root.id).n, 2, 'restart/wake must not recharge or erase settled tools');
  } finally { await runner?.close(); f.close(); }
});

test('root tool budget spans Chat sessions and rejects the next tool before a question or side effect', async () => {
  const f = fixture(); let runner;
  try {
    process.env.CLOUD_CONCURRENCY = '1';
    f.configuration.save('owner', { ...f.config, policy: { ...f.config.policy, maxSteps: 2 } });
    const childSession = f.service.command('owner', { action: 'session.create', operationId: 'child-session', title: 'Child', defaultModel: selection('B') }).sessionId;
    let turns = 0, childId;
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'B') return response(null, [['ask_user', { question: 'This must never be asked after exhaustion' }]]);
      if (++turns === 1) return response(null, [['task_delegate', { action: 'session.send', sessionId: childSession, text: 'Check the evidence', modelSelection: selection('B') }]]);
      if (turns === 2) {
        childId = JSON.parse(body.messages.at(-1).content).id;
        return response(null, [['task_delegate', { action: 'wait', taskIds: [childId] }]]);
      }
      assert.match(JSON.stringify(body.messages), /root_task_step_budget/);
      return response('Child could not run tools: root step budget exhausted.');
    };
    const root = f.service.command('owner', { action: 'session.send', operationId: 'root-step-limit', sessionId: f.session, text: 'Root', modelSelection: selection('A') });
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, fetch: fetcher, filesDir: path.join(f.directory, 'files') });
    runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(root.id)?.status === 'completed');
    const child = f.service.command('owner', { action: 'read', taskId: childId });
    assert.equal(child.status, 'failed'); assert.equal(child.error, 'root_task_step_budget');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_tool_steps WHERE root_id=?').get(root.id).n, 2);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_tool_steps WHERE task_id=?').get(child.id).n, 0);
    assert.equal(child.progress?.view?.pendingAsk ?? null, null, 'exhaustion must not emit a user question');
  } finally { await runner?.close(); f.close(); }
});

test('Bot root tool budget includes native children and continuation runs; receipts and failed admission are atomic', async () => {
  const f = fixture(); let bot;
  try {
    f.configuration.save('owner', { ...f.config, policy: { ...f.config.policy, maxSteps: 3 } });
    bot = new BotRunner(f.store, { configuration: f.configuration });
    const app = new BotApplicationService(f.store, bot);
    const thread = app.create('owner', 'bot', 'Root');
    const runId = app.send('owner', thread.id, { clientNonce: 'root-budget-bot', content: 'Root' }).receipt.runId;
    const steps = new TaskStepBudget(f.store, f.configuration);
    const child = f.service.command('owner', { action: 'session.send', operationId: 'root-budget-child', sessionId: f.session, text: 'Child', parentRunId: runId });
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(child.id);
    f.store.db.prepare('UPDATE runs SET step_count=1 WHERE id=?').run(runId);
    steps.chargeTaskTool('owner', child.id, '0:0');
    steps.chargeTaskTool('owner', child.id, '0:0');
    assert.throws(() => steps.chargeTaskTool('other', child.id, '0:1'), /not_owned/);
    const continuation = crypto.randomUUID(), stamp = new Date().toISOString();
    f.store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at,root_run_id) VALUES(?,?,'bot','running',?,?)").run(continuation, thread.id, stamp, runId);
    const addStep = id => f.store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,'read','{}','queued',?)").run(id, continuation, stamp);
    addStep('allowed'); steps.startRunStep('owner', continuation, 'allowed');
    addStep('blocked');
    assert.throws(() => steps.startRunStep('owner', continuation, 'blocked'), /run_step_budget/);
    assert.equal(f.store.db.prepare('SELECT status FROM run_steps WHERE id=?').get('blocked').status, 'queued');
    assert.equal(f.store.db.prepare('SELECT step_count FROM runs WHERE id=?').get(continuation).step_count, 1);
    assert.throws(() => steps.chargeTaskTool('owner', child.id, '1:0'), /run_step_budget/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_tool_steps WHERE task_id=?').get(child.id).n, 1);
    assert.throws(() => steps.chargeRunRepair('owner', continuation, 2), /run_step_budget/);
    assert.equal(f.store.db.prepare('SELECT step_count FROM runs WHERE id=?').get(continuation).step_count, 1);
    steps.assertRunWithinLimit('owner', continuation);
    assert.throws(() => steps.assertRunAvailable('owner', continuation), /run_step_budget/);
  } finally { await bot?.close(); f.close(); }
});

test('a bundled native child budget exception pauses its exact Bot parent across the executor boundary', async () => {
  const f = fixture(); let bot, runner;
  try {
    f.configuration.save('owner', { ...f.config, policy: { ...f.config.policy, maxSteps: 1 } });
    bot = new BotRunner(f.store, { configuration: f.configuration });
    await bot.quiesce(0);
    const app = new BotApplicationService(f.store, bot), thread = app.create('owner', 'bot', 'Budget parent');
    const runId = app.send('owner', thread.id, { clientNonce: 'native-budget-parent', content: 'Root' }).receipt.runId;
    const child = f.service.command('owner', { action: 'session.send', operationId: 'native-budget-child', sessionId: f.session, text: 'Child', parentRunId: runId });
    f.store.db.prepare("UPDATE runs SET status='waiting_event',step_count=1 WHERE id=?").run(runId);
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, filesDir: path.join(f.directory, 'files'), fetch: async () => response(null, [['ask_user', { question: 'Must not ask' }]]) });
    runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(child.id)?.status === 'failed');
    const parent = f.store.db.prepare('SELECT status,error_code FROM runs WHERE id=?').get(runId);
    assert.equal(parent.status, 'paused'); assert.equal(parent.error_code, 'run_step_budget');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_tool_steps WHERE task_id=?').get(child.id).n, 0);
  } finally { await runner?.close(); await bot?.close(); f.close(); }
});

for (const failDraft of [false, true]) test(`dependent draft/check execution ${failDraft ? 'blocks check after draft failure' : 'passes actual draft evidence to check and main'}`, async () => {
  const f = fixture(); let runner;
  try {
    process.env.CLOUD_CONCURRENCY = '2';
    let turns = 0, draftId, checkId, draftCalls = 0, checkCalls = 0;
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.model === 'B') {
        draftCalls++;
        if (failDraft) return response('');
        return response('Draft evidence: exact source v1, claim remains unverified.');
      }
      if (body.model === 'C') {
        checkCalls++;
        const payload = JSON.parse(body.messages.at(-1).content);
        assert.equal(payload.dependencies[0].id, draftId);
        assert.equal(payload.dependencies[0].status, 'completed');
        assert.match(payload.dependencies[0].result.conclusion, /Draft evidence/);
        assert.equal(payload.dependencies[0].result.actualModels[0].model, 'B');
        return response('Check evidence: draft reviewed; source is fixture-only.');
      }
      if (++turns === 1) { const { operationId, ...args } = create('unused'); return response(null, [['task_delegate', args]]); }
      if (turns === 2) {
        draftId = JSON.parse(body.messages.at(-1).content).id;
        const { operationId, ...args } = create('unused', { goal: 'Check the draft', modelSelection: selection('C'), dependsOn: [draftId] });
        return response(null, [['task_delegate', args]]);
      }
      if (turns === 3) {
        checkId = JSON.parse(body.messages.at(-1).content).id;
        return response(null, [['task_delegate', { action: 'wait', taskIds: [draftId, checkId] }]]);
      }
      const wait = JSON.parse(body.messages.at(-1).content);
      assert.equal(wait.waiting, false);
      assert.deepEqual(wait.tasks.map(t => t.status), failDraft ? ['failed', 'failed'] : ['completed', 'completed']);
      assert.match(JSON.stringify(wait), failDraft ? /dependency_not_completed/ : /Check evidence/);
      return response(failDraft ? 'Draft failed; checking was not executed.' : 'Draft and check complete; this is not a real model quality evaluation.');
    };
    const root = f.service.command('owner', { action: 'session.send', operationId: 'dependency-root', sessionId: f.session, text: 'Draft, check, then summarize', modelSelection: selection('A') });
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, fetch: fetcher, filesDir: path.join(f.directory, 'files') });
    runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(root.id)?.status === 'completed');
    assert.equal(draftCalls, 1); assert.equal(checkCalls, failDraft ? 0 : 1);
    assert.equal(turns, 4);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM task_delegations WHERE parent_task_id=?').get(root.id).n, 2);
  } finally { await runner?.close(); f.close(); }
});

test('late model response after parent cancellation cannot commit or resurrect a child', async () => {
  const f = fixture(); let runner, release;
  try {
    const root = f.service.command('owner', { action: 'session.send', operationId: 'cancel-root', sessionId: f.session, text: 'root' });
    f.store.db.prepare("UPDATE cloud_tasks SET status='waiting_event' WHERE id=?").run(root.id);
    const child = f.service.command('owner', create('cancel-child', { parentTaskId: root.id }));
    const fetcher = () => new Promise(resolve => { release = () => resolve(response('Too late to commit')); });
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, fetch: fetcher, filesDir: path.join(f.directory, 'files') });
    runner.start('http://fixture.invalid');
    await until(() => release);
    f.service.command('owner', { action: 'cancel', taskId: root.id });
    release();
    await runner.quiesce(2000);
    const ended = f.service.command('owner', { action: 'read', taskId: child.id });
    assert.equal(ended.status, 'cancelled'); assert.equal(ended.result, null);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cloud_task_events WHERE task_id=? AND event='delegation_delivered'").get(child.id).n, 0);
  } finally { release?.(); await runner?.close(); f.close(); }
});

test('background delivery is a new durable turn, survives replay, and preserves the completed parent', async () => {
  const f = fixture(); let runner;
  try {
    const root = f.service.command('owner', { action: 'session.send', operationId: 'background-root', sessionId: f.session, text: 'root' });
    const child = f.service.command('owner', create('background-child', { parentTaskId: root.id, background: true }));
    f.store.db.prepare("UPDATE cloud_tasks SET status='completed',result=? WHERE id=?").run(JSON.stringify({ content: 'Original finished answer' }), root.id);
    f.store.db.prepare("UPDATE cloud_tasks SET status='completed',result=? WHERE id=?").run(JSON.stringify({ conclusion: 'Background evidence' }), child.id);
    const options = { configuration: f.configuration, filesDir: path.join(f.directory, 'files'), fetch: async () => response('Background summary') };
    for (let restart = 0; restart < 2; restart++) {
      runner = new CloudTaskRunner(f.store, options); runner.start('http://fixture.invalid');
      await until(() => f.store.db.prepare("SELECT status FROM cloud_tasks WHERE nonce=?").get(`delivery:${child.id}`)?.status === 'completed');
      await runner.close();
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM cloud_tasks WHERE nonce=?').get(`delivery:${child.id}`).n, 1);
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM cloud_task_events WHERE task_id=? AND event='delegation_delivered'").get(child.id).n, 1);
    assert.equal(f.store.db.prepare('SELECT root_task_id FROM cloud_tasks WHERE nonce=?').get(`delivery:${child.id}`).root_task_id, root.id);
    assert.equal(f.service.command('owner', { action: 'read', taskId: root.id }).result.content, 'Original finished answer');
    assert.equal(f.service.command('owner', { action: 'session.read', sessionId: f.session }).messages.at(-1).content, 'Background summary');
  } finally { await runner?.close(); f.close(); }
});

test('busy existing Session serializes turns; cancelling a dispatch preserves unrelated queued work', async () => {
  const f = fixture(); let runner, release;
  try {
    process.env.CLOUD_CONCURRENCY = '4';
    const parent = f.service.command('owner', { action: 'session.send', operationId: 'dispatch-parent', sessionId: f.session, text: 'root' });
    f.store.db.prepare("UPDATE cloud_tasks SET status='waiting_event' WHERE id=?").run(parent.id);
    const target = f.service.command('owner', { action: 'session.create', operationId: 'busy-session', title: 'Existing', defaultModel: selection('B') }).sessionId;
    const first = f.service.command('owner', { action: 'session.send', operationId: 'existing-first', sessionId: target, text: 'first turn', modelSelection: selection('A') });
    const calls = [];
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body); calls.push(body.model);
      if (body.model === 'A') { await new Promise(resolve => { release = resolve; }); return response('First settled answer'); }
      assert.equal(body.model, 'B');
      assert.match(JSON.stringify(body.messages), /First settled answer/);
      return response('Independent next answer');
    };
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, filesDir: path.join(f.directory, 'files'), fetch: fetcher });
    runner.start('http://fixture.invalid'); await until(() => release);
    const dispatch = f.service.command('owner', { action: 'session.send', operationId: 'cancel-only-dispatch', sessionId: target, text: 'delegated work', modelSelection: selection('C'), parentTaskId: parent.id });
    const next = f.service.command('owner', { action: 'session.send', operationId: 'independent-next', sessionId: target, text: 'independent work' });
    f.service.command('owner', { action: 'cancel', taskId: parent.id });
    assert.equal(f.service.command('owner', { action: 'read', taskId: dispatch.id }).status, 'cancelled');
    assert.equal(f.service.command('owner', { action: 'read', taskId: first.id }).status, 'running');
    assert.equal(f.service.command('owner', { action: 'read', taskId: next.id }).status, 'queued');
    release();
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(next.id)?.status === 'completed');
    assert.deepEqual(calls, ['A', 'B']);
    assert.equal(f.service.command('owner', { action: 'session.read', sessionId: target }).messages.length, 4);
  } finally { release?.(); await runner?.close(); f.close(); process.env.CLOUD_CONCURRENCY = '1'; }
});

test('real delegated Gateway admission enforces the root reservation before network', async () => {
  const f = fixture(); let runner;
  try {
    f.configuration.save('owner', { ...f.configuration.get('owner'), botBudget: { contextTokens: 20000, runTokens: 10000, prices: [] } });
    const root = f.service.command('owner', { action: 'session.send', operationId: 'reserved-root', sessionId: f.session, text: 'root' });
    const child = f.service.command('owner', create('reserved-child', { parentTaskId: root.id }));
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(root.id);
    new UsageLedger(f.store, f.configuration).reserve({ owner: 'owner', task: root.id, purpose: 'chat', provider: 'fixture', model: 'A' }, 1, 9900);
    f.store.db.prepare("UPDATE cloud_tasks SET status='waiting_event' WHERE id=?").run(root.id);
    let calls = 0;
    runner = new CloudTaskRunner(f.store, { configuration: f.configuration, filesDir: path.join(f.directory, 'files'), fetch: async () => { calls++; return response('Must not reach network'); } });
    runner.start('http://fixture.invalid');
    await until(() => f.store.db.prepare('SELECT status FROM cloud_tasks WHERE id=?').get(child.id)?.status === 'failed');
    assert.equal(calls, 0);
    assert.match(f.service.command('owner', { action: 'read', taskId: child.id }).error, /root_task_token_budget/);
  } finally { await runner?.close(); f.close(); }
});

test('root token budgets aggregate child tasks instead of resetting with each session', () => {
  const f = fixture();
  try {
    f.configuration.save('owner', { ...f.configuration.get('owner'), botBudget: { contextTokens: 10000, runTokens: 100, prices: [] } });
    const root = f.service.command('owner', { action: 'session.send', operationId: 'budget-root', sessionId: f.session, text: 'root' });
    const child = f.service.command('owner', create('budget-child', { parentTaskId: root.id }));
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id IN (?,?)").run(root.id, child.id);
    const ledger = new UsageLedger(f.store, f.configuration);
    ledger.reserve({ owner: 'owner', task: root.id, purpose: 'chat', provider: 'fixture', model: 'A' }, 1, 70);
    assert.throws(() => ledger.reserve({ owner: 'owner', task: child.id, purpose: 'chat', provider: 'fixture', model: 'B' }, 1, 40), /root_task_token_budget/);
    const continuation = f.service.command('owner', { action: 'session.send', operationId: 'budget-continuation', sessionId: f.session, text: 'background summary' });
    f.store.db.prepare("UPDATE cloud_tasks SET status='running',root_task_id=? WHERE id=?").run(root.id, continuation.id);
    assert.throws(() => ledger.reserve({ owner: 'owner', task: continuation.id, purpose: 'chat', provider: 'fixture', model: 'A' }, 1, 40), /root_task_token_budget/);
    f.service.command('owner', { action: 'cancel', taskId: root.id });
    assert.equal(f.service.command('owner', { action: 'read', taskId: continuation.id }).status, 'cancelled');
    const at = new Date().toISOString();
    f.store.db.prepare("INSERT INTO threads(id,owner_id,mode,created_at,updated_at) VALUES('budget-thread','owner','bot',?,?)").run(at, at);
    for (const [id, parent] of [['budget-run', null], ['budget-run-continuation', 'budget-run']]) f.store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at,root_run_id) VALUES(?,'budget-thread','bot','running',?,?)").run(id, at, parent);
    ledger.reserve({ owner: 'owner', run: 'budget-run', purpose: 'bot', provider: 'fixture', model: 'A' }, 1, 70);
    assert.throws(() => ledger.reserve({ owner: 'owner', run: 'budget-run-continuation', purpose: 'bot', provider: 'fixture', model: 'A' }, 1, 40), /run_token_budget/);
  } finally { f.close(); }
});

test('pre-delegation parent observation is attributed once and included in later root token/cost/day admission', async () => {
  const f = fixture();
  try {
    const price = model => ({ provider: 'fixture', model, inputPerMillion: 1, outputPerMillion: 1, source: 'fixture' });
    f.configuration.save('owner', { ...f.config, botBudget: { ...f.config.botBudget, prices: [price('A'), price('B')] } });
    const root = f.service.command('owner', { action: 'session.send', operationId: 'observation-root', sessionId: f.session, text: 'Root' });
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(root.id);
    await createModelGateway(f.store, f.configuration, async () => response('Parent planning evidence')).request({ owner: 'owner', task: root.id, purpose: 'chat', frozenModel: root.frozenModel, signal: new AbortController().signal, messages: [{ role: 'user', content: 'Plan the work' }], outputTokens: 32 });
    const observed = f.store.db.prepare('SELECT * FROM model_observations WHERE task_id=?').get(root.id);
    assert.equal(observed.input_tokens + observed.output_tokens, 20);
    assert.ok(observed.reserved_tokens > 0); assert.equal(JSON.parse(observed.price_json).source, 'fixture');
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM bot_requests WHERE task_id=?').get(root.id).n, 0);
    const child = f.service.command('owner', create('observation-child', { parentTaskId: root.id }));
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(child.id);
    const ledger = new UsageLedger(f.store, f.configuration), base = f.configuration.get('owner');
    const attribution = { owner: 'owner', task: child.id, purpose: 'study:delegation', provider: 'fixture', model: 'B' };
    for (const [quota, error] of [[{ runTokens: 100 }, /root_task_token_budget/], [{ dayTokens: 100 }, /owner_daily_token_budget/], [{ runCost: 0.00019 }, /run_cost_budget/]]) {
      f.configuration.save('owner', { ...base, botBudget: { ...base.botBudget, ...quota } });
      assert.throws(() => ledger.reserve(attribution, 1, 90), error);
    }
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM bot_requests WHERE task_id=?').get(child.id).n, 0, 'denial leaves no reservation');
    const report = modelUsageReport(f.store, 'owner', '2000-01-01');
    assert.equal(report.total.requests, 1); assert.equal(report.total.totalTokens, 20);
    assert.equal(report.bySource[0].source, 'chat', 'root budget inclusion must not reclassify or duplicate ordinary usage');
    const initialCount = f.store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n;
    assert.throws(() => ledger.observation({ ...attribution, owner: 'other' }, 90), /not_active_or_owned/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n, initialCount);
  } finally { f.close(); }
});

test('unknown pre-delegation parent usage keeps its reservation instead of becoming a zero-token root', async () => {
  const f = fixture();
  try {
    const root = f.service.command('owner', { action: 'session.send', operationId: 'unknown-observation-root', sessionId: f.session, text: 'Root' });
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(root.id);
    await assert.rejects(createModelGateway(f.store, f.configuration, async () => { throw new Error('fixture transport failure'); }).request({ owner: 'owner', task: root.id, purpose: 'chat', frozenModel: root.frozenModel, signal: new AbortController().signal, messages: [{ role: 'user', content: 'Plan the work' }], outputTokens: 32 }, { maxAttemptsPerCandidate: 1 }));
    const observed = f.store.db.prepare('SELECT * FROM model_observations WHERE task_id=?').get(root.id);
    assert.equal(observed.input_tokens, null); assert.equal(observed.output_tokens, null); assert.ok(observed.reserved_tokens > 0);
    const child = f.service.command('owner', create('unknown-observation-child', { parentTaskId: root.id }));
    f.store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(child.id);
    const limit = Math.max(100, observed.reserved_tokens + 50);
    f.configuration.save('owner', { ...f.config, botBudget: { contextTokens: 131072, prices: [], ...f.config.botBudget, runTokens: limit } });
    assert.throws(() => new UsageLedger(f.store, f.configuration).reserve({ owner: 'owner', task: child.id, purpose: 'study:delegation', provider: 'fixture', model: 'B' }, 1, limit - observed.reserved_tokens + 1), /root_task_token_budget/);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM bot_requests WHERE task_id=?').get(child.id).n, 0);
  } finally { f.close(); }
});
