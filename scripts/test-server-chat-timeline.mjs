/** Production bundled Chat/QA runtime + durable SQLite; only model HTTP is fake. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto, listOwnerTasks } from '../apps/api/src/cloud/tasks.ts';
import { responseTimeline } from '../packages/study-core/src/utils/responseOrder.ts';

const temporaryRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporaryRoot, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'chat-timeline-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store), configuration = new CloudConfiguration(store, directory);
const owner = crypto.randomUUID(), timestamp = new Date().toISOString();
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, timestamp);
const providers = ['openai-chat', 'openai-responses', 'anthropic-messages'].map((protocol, i) => ({
  id: `p${i}`, name: protocol, protocol, apiKey: 'test-only', baseUrl: `https://p${i}.invalid/v1`, serves: ['chat'], catalogId: '',
}));
configuration.save(owner, { ...configuration.get(owner), providers, llmModel: { providerId: 'p0', model: 'fixture' } });
const put = (table, key, after) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after }]);
const session = (id, videoId = '__library_assistant__') => put('chatSessions', id, { id, videoId, title: '新会话', createdAt: Date.now() });
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
const row = id => records.get(owner, 'chats', get(id).progress.rowId);
const timeline = answer => responseTimeline(answer.content, answer.reasoning ?? '', answer.tools ?? [], answer.responseSegments);
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const value = predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('timeline_fixture_timeout');
};
const enqueue = (sessionId, input = {}, kind = 'chat', status = 'queued') => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, `session:${sessionId}`, JSON.stringify({ sessionId, text: '解释并继续检索', ...input }), status, timestamp, timestamp);
  return id;
};
const complete = async id => {
  await until(() => ['completed', 'failed', 'cancelled'].includes(get(id).status));
  assert.equal(get(id).status, 'completed', JSON.stringify(get(id)));
  assert.equal(script.length, 0);
  const task = get(id), answer = row(id);
  assert.deepEqual(task.result.responseSegments, answer.responseSegments);
  assert.deepEqual(task.progress.responseSegments, answer.responseSegments);
  assert.equal(answer.interrupted, undefined);
  return task;
};
const call = (id, query = '') => ({ id, name: 'models_discover', args: { query } });
let script = [], requests = 0;
const mockFetch = async (url, init) => {
  assert.match(String(url), /^https:\/\/p\d\.invalid/);
  requests++;
  const next = script.shift(); assert.ok(next, 'unexpected extra model request');
  const value = await next(JSON.parse(init.body), init);
  if (value instanceof Response) return value;
  const { text = '', reasoning = '', calls = [], finish = calls.length ? 'tool_calls' : 'stop' } = value;
  if (url.endsWith('/responses')) return Response.json({ output: [
    ...(reasoning ? [{ type: 'reasoning', summary: [{ type: 'summary_text', text: reasoning }] }] : []),
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
    ...calls.map(c => ({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  ] });
  if (url.endsWith('/messages')) return Response.json({ content: [
    ...(reasoning ? [{ type: 'thinking', thinking: reasoning }] : []),
    { type: 'text', text }, ...calls.map(c => ({ type: 'tool_use', id: c.id, name: c.name, input: c.args })),
  ], stop_reason: calls.length ? 'tool_use' : 'end_turn' });
  return Response.json({ choices: [{ message: { role: 'assistant', content: text, reasoning_content: reasoning,
    ...(calls.length ? { tool_calls: calls.map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args) } })) } : {}) }, finish_reason: finish }] });
};
let runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch });
const sse = delta => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`;
const stream = (prefix, signal) => {
  let release;
  const response = new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(prefix));
    release = suffix => { controller.enqueue(new TextEncoder().encode(suffix + 'data: [DONE]\n\n')); controller.close(); };
    signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  } }), { headers: { 'content-type': 'text/event-stream' } });
  return { response, release };
};
try {
  runner.start('http://127.0.0.1:1');
  for (let protocol = 0; protocol < 3; protocol++) {
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${protocol}`, model: 'fixture' } });
    const sid = 100 + protocol; session(sid);
    script = [() => ({ reasoning: '先检索', calls: [call('one')] }), () => ({ text: '已找到线索😀，继续核实。', calls: [call('two', 'other')] }),
      () => ({ reasoning: '核实后总结', text: '最终结论。' })];
    const task = await complete(enqueue(sid));
    assert.equal(task.result.content, '已找到线索😀，继续核实。\n\n最终结论。');
    const parts = timeline(row(task.id));
    assert.equal(parts.length, 2);
    assert.deepEqual(parts.map(p => p.tools.length), [1, 1]);
    assert.match(parts[0].content, /已找到线索/);
    assert.equal(parts[1].content, '\n\n最终结论。');
    assert.equal(new Set(row(task.id).tools.map(tool => tool.id)).size, 2);
    assert.equal(parts[1].reasoning, '核实后总结');
  }
  configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: 'p0', model: 'fixture' } });

  // An in-flight prefix survives durable projection and runner restart without
  // losing its anchors, and a text-only terminal turn does not loop again.
  session(200); let release;
  script = [() => ({ text: '中间说明。', calls: [call('live')] }), (_body, init) => {
    const pending = stream(sse({ reasoning_content: '继续核对' }) + sse({ content: '最终' }), init.signal);
    release = pending.release; return pending.response;
  }];
  const live = enqueue(200);
  await until(() => get(live).progress?.content.endsWith('最终'));
  const projected = listOwnerTasks(store, owner, 'session', 200).find(t => t.id === live);
  assert.deepEqual(projected.progress.responseSegments, get(live).progress.responseSegments);
  assert.equal(timeline(get(live).progress)[0].content, '中间说明。');
  const prefix = get(live).progress.content;
  release(sse({ content: '结论。' })); await complete(live);
  assert.ok(row(live).content.startsWith(prefix));

  session(201); script = [() => ({ text: '直接回答。' })];
  const before = requests; await complete(enqueue(201)); assert.equal(requests, before + 1);

  // Text → reasoning → text inside ONE provider stream is also ordered.
  session(202); script = [() => new Response(sse({ content: '先说明。' }) + sse({ reasoning_content: '进一步考虑' })
    + sse({ content: '再补充。' }) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })];
  const sameRound = await complete(enqueue(202));
  assert.deepEqual(timeline(row(sameRound.id)).map(p => [p.reasoning, p.content]), [['', '先说明。'], ['进一步考虑', '再补充。']]);

  // No fabricated success when both the empty turn and bounded tool-free wrap-up
  // return no answer. Truncation is resumable and never executes partial calls.
  session(203); script = [() => ({ text: '已交付。', calls: [call('empty')] }), () => ({}), body => {
    assert.ok(!body.tools || body.tool_choice === 'none'); return {};
  }];
  const empty = enqueue(203); await until(() => get(empty).status === 'failed');
  assert.match(row(empty).content, /^已交付。/); assert.equal(script.length, 0);
  session(204); script = [() => ({ text: '参数前说明。', calls: [call('cut')], finish: 'length' }), () => ({ text: '修复后结论。' })];
  const cut = await complete(enqueue(204));
  assert.equal(row(cut.id).tools[0].status, 'error');
  assert.match(row(cut.id).content, /参数前说明。[\s\S]*修复后结论/);

  session(205); script = [() => ({ text: '尚未写完', finish: 'length' })];
  const truncated = enqueue(205); await until(() => get(truncated).status === 'failed');
  assert.equal(row(truncated).interrupted, true);
  assert.equal(row(truncated).content, '尚未写完');

  session(206); script = [() => ({ text: '断流前说明。', calls: [call('broken')] }), () => ({ text: '最后半句', finish: 'error' })];
  const failed = enqueue(206); await until(() => get(failed).status === 'failed');
  const partial = row(failed), anchors = partial.responseSegments;
  assert.match(partial.content, /断流前说明。[\s\S]*最后半句/);
  assert.equal(partial.interrupted, true);
  await runner.close(); runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch }); runner.start('http://127.0.0.1:1');
  script = [body => { assert.equal(body.tools, undefined); return { text: '，继续完成。' }; }];
  const continued = await complete(enqueue(206, { action: 'continue', rowId: partial.id }));
  assert.equal(continued.result.rowId, partial.id);
  assert.deepEqual(continued.result.responseSegments, anchors);
  assert.equal(continued.result.content, partial.content + '，继续完成。');

  session(211); script = [() => ({ text: '续写前正文。', finish: 'length' })];
  const continueThinking = enqueue(211); await until(() => get(continueThinking).status === 'failed');
  const beforeThinking = row(continueThinking);
  script = [() => ({ reasoning: '检查剩余内容', text: '补充结论。' })];
  const thought = await complete(enqueue(211, { action: 'continue', rowId: beforeThinking.id }));
  assert.deepEqual(timeline(row(thought.id)).map(p => [p.reasoning, p.content]), [['', '续写前正文。'], ['检查剩余内容', '补充结论。']]);

  session(212); const policy = configuration.get(owner, true).policy;
  configuration.save(owner, { ...configuration.get(owner, true), policy: { ...policy, maxSteps: 1 } });
  script = [() => ({ text: '受限轮次的说明。', calls: [call('bounded')] }), body => {
    assert.ok(!body.tools || body.tool_choice === 'none'); return { text: '受限后的总结。' };
  }];
  const bounded = await complete(enqueue(212));
  assert.match(bounded.result.content, /受限轮次的说明。[\s\S]*受限后的总结/);
  configuration.save(owner, { ...configuration.get(owner, true), policy });

  session(207); script = [() => ({ text: '取消前说明。', calls: [call('cancel')] }), (_body, init) => stream(sse({ content: '正在回答' }), init.signal).response];
  const cancelled = enqueue(207); await until(() => get(cancelled).progress?.content.endsWith('正在回答'));
  const cancelPrefix = get(cancelled).progress.content;
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled); await runner.cancel(cancelled);
  assert.ok(cancelPrefix.startsWith(row(cancelled).content));
  assert.equal(row(cancelled).responseSegments.length, 2);

  // QA uses the same timeline and durable output schema.
  put('videos', 'course', { id: 'course', name: '课程', duration: 60 }); session(208, 'course');
  script = [() => ({ text: '课程中间说明。', calls: [{ id: 'qa-read', name: 'read', args: { path: '/system/AGENTS.md' } }] }), () => ({ text: '课程结论。' })];
  const qa = await complete(enqueue(208, { videoId: 'course' }, 'qa'));
  assert.equal(timeline(row(qa.id)).length, 2);

  // Actual delegation barrier saves both projections and releases the slot.
  // Restart while parked, then wake without replaying the settled tool.
  session(209); const suspended = enqueue(209, {}, 'chat', 'waiting_event');
  const child = enqueue(210, {}, 'chat', 'waiting_event');
  store.db.prepare("INSERT INTO task_delegations(task_id,owner_id,parent_task_id,root_id,dependencies) VALUES(?,?,?,?, '[]')").run(child, owner, suspended, suspended);
  script = [() => ({ text: '挂起前说明。', calls: [{ id: 'settled', name: 'task_delegate', args: { action: 'wait', taskIds: [child] } }] }),
    body => { assert.ok(body.messages.some(m => m.tool_call_id === 'settled' && JSON.parse(m.content).waiting === false)); return { text: '恢复后结论。' }; }];
  store.db.prepare("UPDATE cloud_tasks SET status='queued' WHERE id=?").run(suspended);
  await until(() => get(suspended).status === 'waiting_event');
  const checkpoint = JSON.parse(store.db.prepare('SELECT payload FROM task_agent_checkpoints WHERE task_id=?').get(suspended).payload);
  const checkpointSegments = checkpoint.responseSegments;
  assert.equal(checkpoint.deliveredContent, '挂起前说明。');
  assert.deepEqual(row(suspended).responseSegments, checkpointSegments);
  await runner.close(); runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch }); runner.start('http://127.0.0.1:1');
  store.db.prepare("UPDATE cloud_tasks SET status='completed',result='{}' WHERE id=?").run(child);
  const resumed = await complete(suspended);
  assert.equal(resumed.result.content, '挂起前说明。\n\n恢复后结论。');
  assert.deepEqual(resumed.result.responseSegments.slice(0, 2), checkpointSegments);
  console.log('PASS Chat/QA timeline: three protocols, interleaved tools/text/reasoning, durable live/history, terminal text, empty/truncated/error/cancel, continuation and checkpoint resume');
} finally { await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
