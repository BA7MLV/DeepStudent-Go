import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { freezeTaskModel } from '../apps/api/src/agent/task-model.ts';
import { executeNodeTask } from '../apps/api/runtime/node.ts';

// Run the production executor/history builder/native codec/Gateway. Only the
// remote provider transport is scripted; no history helper or executor is mocked.
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/compression-consumption-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = 'consumer', other = 'foreign-consumer', at = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, at);
configuration.save(owner, { ...configuration.get(owner, true), providers: [{ id: 'provider', name: 'Provider', baseUrl: 'https://consume.invalid/v1', apiKey: 'private-consumption-key', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'provider', model: 'native-consumer' } });
let serial = 1000;
const write = (account, table, key, value) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after: value }]);
const fixtures = [];
function fixture({ kind = 'chat', plan = true, rich = true, continuation = false } = {}) {
  const sessionId = serial++, courseId = `course-${sessionId}`;
  if (kind === 'qa') write(owner, 'videos', courseId, { id: courseId, name: 'Consumption course', kind: 'material', materialFormat: 'md', createdAt: 1 });
  const rows = Array.from({ length: 8 }, (_, i) => [
    { id: serial++, sessionId, videoId: kind === 'qa' ? courseId : '__library_assistant__', role: 'user', content: `SESSION-${sessionId}-QUESTION-${i}`, createdAt: i * 2 },
    { id: serial++, sessionId, videoId: kind === 'qa' ? courseId : '__library_assistant__', role: 'assistant', content: `SESSION-${sessionId}-ANSWER-${i}`, createdAt: i * 2 + 1 },
  ]).flat();
  const omissions = rows.map(row => [row.id, row.content]);
  if (rich) {
    rows[2] = { ...rows[2], content: `${rows[2].content}-EDITED-AFTER-PLAN` };
    rows[5].resume = { stopped: true };
    rows[7].interrupted = true;
    rows[9].modelTrace = { version: 1, source: rows[9].content, messages: [
      { role: 'assistant', content: rows[9].content, tool_calls: [{ id: `tool-${sessionId}`, type: 'function', function: { name: 'read', arguments: '{"path":"/skills"}' } }] },
      { role: 'tool', tool_call_id: `tool-${sessionId}`, name: 'read', content: `SESSION-${sessionId}-TOOL-RESULT` },
    ] };
    rows[11].providerState = { items: [] };
  }
  if (continuation) rows.at(-1).interrupted = true;
  for (const row of rows) write(owner, 'chats', row.id, row);
  write(owner, 'chatSessions', sessionId, { id: sessionId, title: 'Keep title', videoId: kind === 'qa' ? courseId : '__library_assistant__', createdAt: 1, ...(plan ? { contextOmissions: omissions } : {}) });
  const out = { sessionId, courseId, rows, omissions, kind, continuation };
  fixtures.push(out);
  return out;
}
async function run(fixture, account = owner) {
  const id = crypto.randomUUID();
  const input = { sessionId: fixture.sessionId, text: '普通通用问题，请直接回答', ...(fixture.kind === 'qa' ? { videoId: fixture.courseId } : {}),
    ...(fixture.continuation ? { action: 'continue', rowId: fixture.rows.at(-1).id } : {}) };
  const frozenModel = freezeTaskModel(store, account, configuration.get(account), 'chat');
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at,model_snapshot) VALUES(?,?,?,?,?,?,'running',?,?,?)").run(id, account, id, fixture.kind, `session:${fixture.sessionId}`, JSON.stringify(input), at, at, JSON.stringify(frozenModel));
  const requests = [], controller = new AbortController();
  const result = await executeNodeTask({ task: { id, kind: fixture.kind, input, frozenModel }, owner: account, store, records, configuration, filesDir: directory, signal: controller.signal,
    checkActive() { controller.signal.throwIfAborted(); }, report() {},
    fetch: async (url, init) => {
      assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-consumption-key');
      assert.ok(String(url).startsWith('https://consume.invalid/'));
      const body = JSON.parse(init.body);
      requests.push(body);
      const message = { role: 'assistant', content: '继续输出的新文本。' };
      return body.stream ? new Response(`data: ${JSON.stringify({ choices: [{ delta: message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
        : Response.json({ choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
    } });
  assert.ok(requests.length > 0, 'production executor actually requests Gateway/provider');
  assert.ok(result);
  return requests[0].messages;
}
const wire = messages => JSON.stringify(messages);
function assertConsumed(fixture, messages) {
  const text = wire(messages);
  for (const row of fixture.rows.slice(0, 2)) assert.ok(!text.includes(row.content), `omitted complete turn not sent: ${row.content}`);
  for (const row of fixture.rows.slice(2)) assert.ok(text.includes(row.content), `protected or stale turn remains on wire: ${row.content}`);
  assert.ok(messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === `tool-${fixture.sessionId}`)));
  assert.ok(messages.some(message => message.role === 'tool' && message.tool_call_id === `tool-${fixture.sessionId}` && message.content === `SESSION-${fixture.sessionId}-TOOL-RESULT`));
  for (const row of fixture.rows) {
    const saved = records.get(owner, 'chats', row.id);
    if (fixture.continuation && row === fixture.rows.at(-1)) assert.ok(saved.content.startsWith(row.content));
    else assert.deepEqual(saved, row, 'selection never deletes or rewrites original messages');
  }
}
const checks = [];
try {
  for (const kind of ['chat', 'qa']) {
    const value = fixture({ kind });
    assertConsumed(value, await run(value));
    checks.push(`${kind}: production Gateway messages omit whole turn, retain changed content/resume/interrupted/tool envelope/providerState/latest two; original rows intact`);
  }
  const continuation = fixture({ continuation: true });
  const countBefore = store.db.prepare("SELECT COUNT(*) n FROM cloud_records WHERE owner_id=? AND table_name='chats'").get(owner).n;
  const continuationMessages = await run(continuation);
  assertConsumed(continuation, continuationMessages);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM cloud_records WHERE owner_id=? AND table_name='chats'").get(owner).n, countBefore);
  assert.ok(wire(continuationMessages).includes(continuation.rows.at(-1).content), 'continuation breakpoint original text is sent despite matching omission receipt');
  checks.push('continue: production request preserves interrupted original breakpoint, uses safe omission plan and updates only original answer');

  for (const kind of ['chat', 'qa']) {
    const value = fixture({ kind, plan: false, rich: false });
    // Same numeric session and row IDs in a different owner must not supply a
    // plan to the executing owner. Owner A has no plan and sends every turn.
    write(other, 'chatSessions', value.sessionId, { id: value.sessionId, title: 'Foreign plan', createdAt: 1, contextOmissions: value.omissions });
    const messages = await run(value);
    for (const row of value.rows) assert.ok(wire(messages).includes(row.content));
    checks.push(`${kind}: absent owner plan keeps original behavior; another owner's matching session/row-ID plan is never read`);
  }
  const partial = fixture({ rich: false });
  write(owner, 'chatSessions', partial.sessionId, { ...records.get(owner, 'chatSessions', partial.sessionId), contextOmissions: partial.omissions.slice(0, 1) });
  const partialMessages = await run(partial);
  for (const row of partial.rows) assert.ok(wire(partialMessages).includes(row.content));
  checks.push('chat: partial-turn receipt does not remove either question or answer in actual production request');
  console.log(JSON.stringify({ ok: true, checks, directory }, null, 2));
} finally { store.close(); }
