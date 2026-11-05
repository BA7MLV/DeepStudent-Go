import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { freezeTaskModel } from '../apps/api/src/agent/task-model.ts';
import { submitOwnerTask } from '../apps/api/src/cloud/task-commands.ts';
import { admitContextCompression, executeContextCompression, effectiveCompressionRows } from '../apps/api/runtime/context-compression.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-compression-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = 'compression-owner', other = 'compression-other', at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'selector', name: 'Selector', baseUrl: 'https://compression.invalid/v1', apiKey: 'server-secret', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'selector', model: 'native-selector' } });
let serial = 100, calls = 0;
const write = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
const create = (options = {}) => {
  const sessionId = serial++;
  write('chatSessions', sessionId, { id: sessionId, title: 'Original', createdAt: 1, contextOmissions: options.omissions ?? [] });
  const rows = Array.from({ length: options.turns ?? 5 }, (_, i) => [
    { id: serial++, sessionId, role: 'user', content: `question-${i} ${'旧资料'.repeat(20)}`, createdAt: i * 2 },
    { id: serial++, sessionId, role: 'assistant', content: `answer-${i} ${'历史答案'.repeat(20)}`, createdAt: i * 2 + 1, ...(options.rowPatch?.(i) ?? {}) },
  ]).flat();
  for (const row of rows) write('chats', row.id, row);
  return { sessionId, rows, input: { action: 'compressContext', sessionId, budget: 1000, query: 'new unrelated request', force: true, expected: rows.map(({ id, content }) => ({ id, content })) } };
};
const session = fixture => records.get(owner, 'chatSessions', fixture.sessionId);
const context = (fixture, behavior = {}) => {
  const id = crypto.randomUUID();
  const input = admitContextCompression(records, owner, fixture.input);
  const controller = new AbortController();
  const frozenModel = freezeTaskModel(store, owner, configuration.get(owner), 'chat', fixture.input.modelSelection);
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,model_snapshot) VALUES(?,?,?,'chat',?,?,'running',?,?,?)").run(id, owner, id, `session:${fixture.sessionId}`, JSON.stringify(input), at, at, JSON.stringify(frozenModel));
  return { task: { id, kind: 'chat', input: { ...input, _pluginProviders: [] }, frozenModel }, owner, store, records, configuration, filesDir: directory, signal: controller.signal,
    checkActive() { controller.signal.throwIfAborted(); }, report() {}, controller,
    fetch: async (url, init) => {
      calls++;
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer server-secret');
      assert.ok(String(url).startsWith('https://compression.invalid/'));
      const payload = JSON.parse(init.body);
      assert.equal(payload.model, 'native-selector');
      const state = JSON.parse(payload.messages.at(-1).content);
      await behavior.beforeResponse?.(state);
      if (behavior.fail) return new Response('provider secret details', { status: 400 });
      if (behavior.cancel) controller.abort(new Error('test_cancelled'));
      const answers = Object.fromEntries(state.older_turns.map(turn => [turn.id, { noul: behavior.probability ?? 0.99 }]));
      return Response.json({ choices: [{ message: { role: 'assistant', content: behavior.invalid ? '{bad json' : JSON.stringify({ answers }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } };
};
const preserved = async (fixture, ctx, pattern) => {
  const before = session(fixture).contextOmissions;
  await assert.rejects(executeContextCompression(ctx), pattern);
  assert.deepEqual(session(fixture).contextOmissions, before);
};
const checks = [];
try {
  const helperFixture = create();
  const helperRows = helperFixture.rows;
  const fullPlan = helperRows.map(row => [row.id, row.content]);
  const retained = effectiveCompressionRows(helperRows, fullPlan);
  assert.deepEqual(retained, helperRows.slice(-4));
  retained.forEach((row, index) => assert.equal(row, helperRows[helperRows.length - 4 + index]));
  assert.deepEqual(effectiveCompressionRows(helperRows, fullPlan.slice(0, 1)), helperRows, 'half-turn receipt cannot omit either row');
  const changed = helperRows.map((row, index) => index === 0 ? { ...row, content: 'changed content' } : row);
  assert.deepEqual(effectiveCompressionRows(changed, fullPlan), [...changed.slice(0, 2), ...changed.slice(-4)]);
  for (const patch of [{ resume: {} }, { interrupted: true }, { tool_calls: [] }, { tool_call_id: 'call' }, { providerState: { items: [] } },
    { modelTrace: { version: 1, source: helperRows[1].content, messages: [{ role: 'tool', content: 'result', tool_call_id: 'call' }] } },
    { modelTrace: { version: 1, source: helperRows[1].content, messages: [{ role: 'assistant', content: '', providerState: { items: [] } }] } }]) {
    const protectedRows = helperRows.map((row, index) => index === 1 ? { ...row, ...patch } : row);
    const result = effectiveCompressionRows(protectedRows, fullPlan);
    assert.deepEqual(result, [...protectedRows.slice(0, 2), ...protectedRows.slice(-4)]);
    assert.equal(result[0], protectedRows[0]);
    assert.equal(result[1], protectedRows[1]);
  }
  assert.equal(effectiveCompressionRows(helperRows, { malformed: true }), helperRows);
  assert.equal(effectiveCompressionRows(helperRows, [[helperRows[0].id, helperRows[0].content], [helperRows[0].id, 'conflict']]), helperRows);
  checks.push('effectiveCompressionRows: exact whole turns only; changed/partial/tool/providerState/resume/interrupted/latest-two protected; original order and references');

  const fixture = create(), originalRows = structuredClone(fixture.rows), ctx = context(fixture);
  const result = await executeContextCompression(ctx);
  assert.equal(result.phase, 'success');
  assert.equal(result.omitted.length, 6);
  assert.equal(result.removedTokens, fixture.rows.slice(0, 6).reduce((n, row) => n + Math.ceil(row.content.length * 0.7), 0));
  const persisted = JSON.parse(store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chatSessions' AND record_key=?").get(owner, JSON.stringify(fixture.sessionId)).value);
  assert.deepEqual(persisted.contextOmissions, result.omitted);
  for (const row of originalRows) assert.deepEqual(records.get(owner, 'chats', row.id), row);
  assert.ok(result.omitted.every(([id]) => !fixture.rows.slice(-4).some(row => row.id === id)));
  assert.ok(store.db.prepare("SELECT COUNT(*) n FROM cloud_audit WHERE owner_id=? AND action LIKE 'model.%'").get(owner).n > 0);
  checks.push('real gateway + SQL CAS persistence + token calculation + no original message writes + latest two turns');

  assert.throws(() => admitContextCompression(records, other, fixture.input), /session_not_found/);
  assert.throws(() => admitContextCompression(records, owner, { ...fixture.input, sessionId: 999999 }), /session_not_found/);
  for (const patch of [{ apiKey: 'forged' }, { owner: other }, { baseUrl: 'https://evil.invalid' }, { budget: -1 }, { force: 'yes' }, { expected: [{ id: 1, content: 'x', role: 'user' }] }, { modelSelection: { modelRef: { providerId: 'selector', model: 'native-selector', apiKey: 'bad' } } }]) assert.throws(() => admitContextCompression(records, owner, { ...fixture.input, ...patch }));
  checks.push('cross-owner/missing-session and malformed/credential-bearing inputs rejected');

  const stale = create(), staleCtx = context(stale);
  write('chats', stale.rows[0].id, { ...stale.rows[0], content: 'edited' });
  await preserved(stale, staleCtx, /context_compression_conflict/);
  assert.throws(() => admitContextCompression(records, owner, stale.input), /context_compression_conflict/);
  checks.push('expected mismatch rejected at admission and execution');

  for (const kind of ['new', 'content', 'trace', 'omissions']) {
    const fixture = create();
    const ctx = context(fixture, { beforeResponse: () => {
      if (kind === 'new') { const id = serial++; write('chats', id, { id, sessionId: fixture.sessionId, role: 'user', content: 'new message', createdAt: 100 }); }
      if (kind === 'content') write('chats', fixture.rows[0].id, { ...fixture.rows[0], content: 'edited during model' });
      if (kind === 'trace') write('chats', fixture.rows[0].id, { ...fixture.rows[0], modelTrace: { version: 1, source: fixture.rows[0].content, messages: [] } });
      if (kind === 'omissions') write('chatSessions', fixture.sessionId, { ...session(fixture), contextOmissions: [[fixture.rows[0].id, fixture.rows[0].content]] });
    } });
    await assert.rejects(executeContextCompression(ctx), /context_compression_conflict/);
    assert.deepEqual(session(fixture).contextOmissions, kind === 'omissions' ? [[fixture.rows[0].id, fixture.rows[0].content]] : []);
  }
  checks.push('model-await races: appended message, edited content, changed trace and competing omission plan all reject');

  const protectedFixture = create({ turns: 7, rowPatch: i => i === 0 ? { resume: { waiting: true } } : i === 1 ? { interrupted: true } : i === 2 ? { modelTrace: { version: 1, source: `answer-${i} ${'历史答案'.repeat(20)}`, messages: [{ role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'a', content: 'result' }] } } : {} });
  const protectedResult = await executeContextCompression(context(protectedFixture));
  assert.deepEqual(protectedResult.omitted.map(([id]) => id), protectedFixture.rows.slice(6, 10).map(row => row.id));
  checks.push('resume/interrupted/tool transcript turns protected as whole units');

  const small = create(); small.input.force = false; small.input.budget = 100000;
  const beforeCalls = calls;
  assert.equal((await executeContextCompression(context(small))).phase, 'unchanged');
  assert.equal(calls, beforeCalls);
  small.input.force = true;
  assert.equal((await executeContextCompression(context(small))).phase, 'success');
  const uncertain = create();
  assert.equal((await executeContextCompression(context(uncertain, { probability: 0.949 }))).phase, 'unchanged');
  assert.deepEqual(session(uncertain).contextOmissions, []);
  const short = create({ turns: 2 });
  assert.equal((await executeContextCompression(context(short))).phase, 'unchanged');
  checks.push('force bypasses under-budget skip; uncertainty and short history unchanged');

  for (const behavior of [{ fail: true }, { invalid: true }, { cancel: true }]) {
    const fixture = create();
    write('chatSessions', fixture.sessionId, { ...session(fixture), contextOmissions: fixture.rows.slice(0, 2).map(row => [row.id, row.content]) });
    await preserved(fixture, context(fixture, behavior), /context_compression_model_failed|context_compression_invalid_decision|test_cancelled/);
  }
  const cancelled = create(), cancelledCtx = context(cancelled); cancelledCtx.controller.abort(new Error('test_cancelled'));
  await preserved(cancelled, cancelledCtx, /test_cancelled/);
  const queueRace = create(), queueCtx = context(queueRace);
  write('chats', queueRace.rows[0].id, { ...queueRace.rows[0], interrupted: true });
  await preserved(queueRace, queueCtx, /context_compression_conflict/);
  checks.push('provider failure/malformed output/cancellation/queue baseline race preserve original plan');

  const receipt = create(), operationId = crypto.randomUUID();
  const command = { operationId, kind: 'chat', resource: `session:${receipt.sessionId}`, input: receipt.input };
  const admittedTask = submitOwnerTask(store, records, configuration, owner, command);
  assert.match(admittedTask.input.compressionBaseline, /^[a-f0-9]{64}$/);
  assert.ok(admittedTask.frozenModel);
  store.db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=?").run(admittedTask.id);
  const receiptResult = await executeContextCompression({ ...context(create()), task: admittedTask });
  assert.equal(receiptResult.phase, 'success');
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result=? WHERE id=?").run(JSON.stringify(receiptResult), admittedTask.id);
  const id = serial++;
  write('chats', id, { id, sessionId: receipt.sessionId, role: 'user', content: 'history advanced after completed receipt', createdAt: 100 });
  const replayedTask = submitOwnerTask(store, records, configuration, owner, command);
  assert.equal(replayedTask.id, admittedTask.id);
  assert.deepEqual(replayedTask.result, receiptResult);
  assert.throws(() => submitOwnerTask(store, records, configuration, owner, { ...command, input: { ...command.input, query: 'different query' } }), /task_nonce_conflict/);
  checks.push('integrated submitOwnerTask freezes model/baseline; completed nonce receipt replays after history advances; changed nonce payload conflicts');
  console.log(JSON.stringify({ ok: true, checks, calls, directory }, null, 2));
} finally { store.close(); }
