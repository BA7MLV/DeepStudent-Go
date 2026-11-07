import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner, taskDto } from '../apps/api/src/cloud/tasks.ts';
import { executeServerWidget } from '../apps/api/runtime/widgets.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-server-widgets-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
const records = new CloudRecords(store);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
const owner = crypto.randomUUID(), other = crypto.randomUUID(), timestamp = new Date().toISOString();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, timestamp);
const providers = ['openai-chat', 'openai-responses', 'anthropic-messages'].map((protocol, i) => ({
  id: `p${i}`, name: protocol, protocol, apiKey: 'test-only', baseUrl: `https://p${i}.example/v1`, serves: ['chat'],
}));
configuration.save(owner, { ...configuration.get(owner), providers, llmModel: { providerId: 'p0', model: 'test-model' } });
const put = (table, key, after, account = owner) => records.apply(account, [{ id: crypto.randomUUID(), table, key, before: records.get(account, table, key), after }]);
const rows = sessionId => store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='chats' AND value IS NOT NULL").all(owner)
  .map(row => JSON.parse(row.value)).filter(row => row.sessionId === sessionId);
const answer = sessionId => rows(sessionId).find(row => row.role === 'assistant');
const get = id => taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id));
let script = [], requests = [];
const mockFetch = async (url, init) => {
  const body = JSON.parse(init.body); requests.push(body);
  const next = script.shift(); assert.ok(next, 'unexpected model request');
  const message = await next(body, init);
  if (message instanceof Response) return message;
  const calls = message.calls ?? [];
  if (url.endsWith('/responses')) return Response.json({ output: [
    ...(message.text ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.text }] }] : []),
    ...calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })),
  ] });
  if (url.endsWith('/messages')) return Response.json({ content: [
    ...(message.text ? [{ type: 'text', text: message.text }] : []),
    ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })),
  ], stop_reason: calls.length ? 'tool_use' : 'end_turn' });
  return Response.json({ choices: [{ message: { role: 'assistant', content: message.text ?? null,
    ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) },
  finish_reason: calls.length ? 'tool_calls' : 'stop' }] });
};
let runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch });
const until = async predicate => {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { const result = predicate(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Timed out waiting for server task');
};
const enqueue = (sessionId, kind = 'chat', extra = {}) => {
  const id = crypto.randomUUID();
  store.db.prepare('INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(id, owner, id, kind, `session:${sessionId}`, JSON.stringify({ sessionId, text: '交互式讲解', ...extra }), 'queued', timestamp, timestamp);
  return id;
};
const completed = async id => { await until(() => ['completed', 'failed', 'cancelled'].includes(get(id).status)); const task = get(id); assert.equal(task.status, 'completed', JSON.stringify(task)); assert.equal(task.executor, 'node'); return task; };
const session = id => put('chatSessions', id, { id, videoId: '__library_assistant__', title: '新会话', createdAt: Date.now() });
const widgetCall = (id, code = '<button>交互式讲解</button>', extra = {}) => ({ id, name: 'show_widget', args: { format: 'html', code, ...extra } });
const reference = widget => `\`\`\`wbw-widget\n${widget.ref}\n\`\`\``;
try {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'widget_draft%'").all(), [], 'fresh databases have no draft tables');
  put('preferences', 'savedModels', { id: 'savedModels', value: providers.map(provider => ({ providerId: provider.id, model: 'test-model', maxOutputTokens: 32768, contextWindow: 131072 })) });
  runner.start('http://127.0.0.1:1');
  for (let i = 0; i < providers.length; i++) {
    const sid = 100 + i; session(sid);
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${i}`, model: 'test-model' } });
    const source = '<section><button>点击</button></section><script>throw new Error("must not execute on server")</script>';
    script = [body => {
      assert.equal(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens, 32768, 'server widget rounds respect the saved output limit for every protocol');
      const tools = body.tools.map(tool => tool.function?.name ?? tool.name);
      assert.deepEqual(tools, ['ask_user', 'board', 'edit', 'models_discover', 'plugins', 'read', 'show_widget', 'task_delegate'], 'empty libraries use existing native tools; no independent draft tool');
      return { calls: [widgetCall(`work-${i}`, source)] };
    }, body => {
      assert.equal(body.max_tokens ?? body.max_output_tokens ?? body.max_completion_tokens, 32768, 'follow-up rounds keep the saved output ceiling when context is available');
      const row = answer(sid);
      assert.equal(row.widgets.length, 1, 'committed before the next model request, not just in task progress');
      assert.equal(row.widgets[0].html, source);
      assert.equal(row.widget.id, row.widgets[0].id);
      assert.equal(row.widgets[0].source, 'tool');
      assert.equal(row.interrupted, true);
      assert.ok(JSON.stringify(body).includes(reference(row.widget).split('\n')[1]));
      return { text: `观察交互。\n\n${reference(row.widget)}\n\n继续讲解。` };
    }];
    const task = await completed(enqueue(sid));
    assert.equal(script.length, 0);
    assert.equal(rows(sid).length, 2, 'snapshots and completion update the same pair');
    assert.equal(answer(sid).interrupted, undefined);
    assert.deepEqual(task.result.widgets, answer(sid).widgets);
    assert.deepEqual(task.progress.widgets, task.result.widgets);
    assert.ok(!task.result.content.includes(source));
    assert.equal(records.get(other, 'chats', task.result.rowId), null);
  }
  console.log('Empty-library registration, all 3 model protocols, save-before-receipt, identities, progress/result/record payloads passed');

  configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: 'p0', model: 'test-model' } });
  // More than the former eight rounds: full small operations build a ~36k work.
  for (let protocol = 0; protocol < providers.length; protocol++) {
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${protocol}`, model: 'test-model' } });
    const sid = 120 + protocol; session(sid);
    let offset = 0;
    const chunks = ['<section>', ...Array.from({ length: 12 }, (_, i) => `<p data-part="${i}">${'x'.repeat(2900)}</p>`), '</section>'];
    script = [...chunks.map((text, i) => () => {
      assert.ok(!answer(sid)?.widgets, 'in-memory chunks never reach runtime payloads');
      const call = widgetCall(`chunk-${i}`, text, { action: 'append', offset, revision: i }); offset += text.length;
      return { calls: [call] };
    }), () => ({ calls: [widgetCall('complete', '', { action: 'complete', offset, revision: chunks.length })] }), body => {
      assert.equal(answer(sid).widgets.length, 1);
      assert.equal(answer(sid).widget.html, chunks.join(''));
      assert.ok(JSON.stringify(body).includes(answer(sid).widget.ref));
      return { text: reference(answer(sid).widget) };
    }];
    const result = await completed(enqueue(sid));
    assert.equal(result.result.widget.html, chunks.join('')); assert.equal(script.length, 0);
  }
  assert.deepEqual(store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'widget_draft%'").all(), [], 'fresh databases have no draft tables');
  console.log('Task-local assembly: >8 rounds, all three protocols, final-only chat payloads and no draft tables passed');
  for (let protocol = 0; protocol < providers.length; protocol++) {
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${protocol}`, model: 'test-model' } });
    const sid = 125 + protocol; session(sid);
    const p = (id, revision, search, replace) => widgetCall(id, '', { action: 'patch', revision, edits: [{ search, replace }] });
    const calls = [p('truncated-patch', 1, 'old', 'BAD'), widgetCall('also-not-executed', '!', { action: 'append', revision: 2, offset: 14 })];
    script = [() => ({ calls: [widgetCall('start-patch', '<div>old</div>', { action: 'append', revision: 0, offset: 0 })] }),
      () => ({ calls: [widgetCall('read-base', '', { action: 'read', offset: 0, limit: 100 })] }),
      body => {
        assert.ok(JSON.stringify(body).includes('old'));
        assert.ok(!answer(sid)?.widgets);
        return protocol === 0 ? Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null,
          tool_calls: calls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] })
          : protocol === 1 ? Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) })) })
          : Response.json({ stop_reason: 'max_tokens', content: calls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.args })) });
      }, body => {
        assert.ok(!JSON.stringify(body).includes('truncated-patch'));
        // If either truncated call executed this revision/content would fail.
        return { calls: [p('patch-ok', 1, 'old', 'new'), p('stale-same-round', 1, 'new', 'BAD'), widgetCall('read-after-patch', '', { action: 'read', revision: 2, offset: 0 })] };
      }, body => {
        assert.ok(JSON.stringify(body).includes('revision_conflict'));
        assert.ok(!answer(sid)?.widgets);
        return { calls: [widgetCall('patch-complete', '', { action: 'complete', revision: 2, offset: 14 })] };
      }, () => ({ text: reference(answer(sid).widget) })];
    const result = await completed(enqueue(sid));
    assert.equal(result.result.widget.html, '<div>new</div>');
    assert.equal(result.progress.widgetPreview, undefined);
    assert.equal(script.length, 0);
  }
  console.log('All three protocols: append/read/patch/complete, stale same-round revision and truncated patch batch zero mutation passed');
  // Existing artifactEdit remains a separate entry using its original same-base
  // algorithm and limits; the assembly adapter must not change those semantics.
  for (let protocol = 0; protocol < providers.length; protocol++) {
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${protocol}`, model: 'test-model' } });
    script = [() => ({ text: JSON.stringify({ edits: [{ search: 'alpha', replace: 'beta' }, { search: 'beta', replace: 'gamma' }] }) })];
    assert.equal((await completed(enqueue(140 + protocol, 'artifactEdit', { kind: 'html', source: '<div>alpha beta</div>', instruction: '仅修改此块', mode: 'patch' }))).result, '<div>beta gamma</div>');
  }
  console.log('Existing native artifactEdit patch entry keeps original same-base semantics in all three protocols');
  configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: 'p0', model: 'test-model' } });

  session(130);
  const prefix = '这是足够长的正文断点，后面的内容应该只追加一次。';
  script = [() => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: prefix } }] }), body => {
    assert.equal(body.tools, undefined, 'automatic prose continuation cannot execute tools');
    assert.match(body.messages.at(-1).content, /从断点处直接续上/);
    return { text: prefix + '继续补充。' };
  }];
  assert.equal((await completed(enqueue(130))).result.content, prefix + '继续补充。', 'exact echoed prefix is deduplicated');

  session(131);
  script = Array.from({ length: 3 }, () => () => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: '正文继续写但一直被截断，必须有限停止。' } }] }));
  const boundedContinue = enqueue(131); await until(() => get(boundedContinue).status === 'failed');
  assert.equal(script.length, 0); assert.match(get(boundedContinue).error, /自动续写/);

  session(150);
  script = [() => ({ calls: [{ id: 'board-docs', name: 'board', args: { action: 'read', path: '/system/board/README.md' } }] }), body => {
    const result = JSON.parse(body.messages.find(message => message.tool_call_id === 'board-docs').content);
    assert.match(result.content, /manifest.json/);
    assert.equal(result.nextOffset, null);
    return { calls: [{ id: 'board-create', name: 'board', args: { action: 'write', path: '/system/board/chat-note.json', content: '{"from":"chat"}', expected: '', revision: 0 } }] };
  }, body => {
    assert.equal(JSON.parse(body.messages.find(message => message.tool_call_id === 'board-create').content).saved, true);
    return { text: '看板资源已保存。' };
  }];
  await completed(enqueue(150));
  assert.equal(store.systemFiles.read(owner, '/system/board/chat-note.json'), '{"from":"chat"}', 'bundled native Chat writes the same real system file');
  session(200);
  const invalid = [
    widgetCall('bad-document', '<html><body>not a fragment</body></html>'),
    widgetCall('bad-script', '<script src="https://invalid.test/script.js"></script>'),
    widgetCall('bad-css-image', '<style>.x{background:url(https://invalid.test/bg.png)}</style><div class="x">图片</div>'),
    widgetCall('bad-srcset', '<img srcset="https://invalid.test/a.png 1x">'),
    widgetCall('bad-fetch', '<script>fetch("https://invalid.test/data")</script>'),
    widgetCall('bad-library', '<canvas></canvas>', { libs: ['unknown'] }),
    widgetCall('bad-length', '<div>' + 'x'.repeat(60001) + '</div>'),
  ];
  script = [() => ({ calls: invalid }), () => {
    assert.ok(!answer(200).widgets, 'invalid calls do not deliver a payload');
    assert.ok(answer(200).tools.every(tool => tool.status === 'error'));
    return { calls: [widgetCall('repaired', '<canvas></canvas>', { libs: ['chart.js', 'chart.js'] })] };
  }, () => ({ text: reference(answer(200).widget) })];
  const repaired = await completed(enqueue(200));
  assert.equal(repaired.result.widgets.length, 1);
  assert.deepEqual(repaired.result.widget.libs, ['chart.js']);

  session(201);
  script = [() => ({ calls: [widgetCall('first', '<div>第一幅</div>')] }), () => {
    const row = answer(201);
    put('chats', row.id, { ...row, widgetStates: { [row.widget.id]: { modelContent: { step: 2 }, privateContent: {} } } });
    return { text: `第一幅解释。\n\n${reference(row.widget)}`, calls: [widgetCall('second', '<div>第二幅</div>')] };
  }, () => ({ text: `第二幅解释。\n\n${reference(answer(201).widgets[1])}\n\n后续问题。` })];
  const multiple = await completed(enqueue(201));
  assert.equal(multiple.result.widgets.length, 2);
  assert.notEqual(multiple.result.widgets[0].id, multiple.result.widgets[1].id);
  assert.match(multiple.result.content, /第一幅解释[\s\S]*第二幅解释[\s\S]*后续问题/);
  assert.ok(answer(201).widgetStates[multiple.result.widgets[0].id], 'later snapshots preserve synced interaction state');

  session(202);
  script = [() => ({ calls: [widgetCall('duplicate-a'), widgetCall('duplicate-b')] }), () => ({ text: reference(answer(202).widget) })];
  assert.equal((await completed(enqueue(202))).result.widgets.length, 1);

  session(203);
  let finishArguments;
  const streamedArgs = JSON.stringify({ format: 'html', code: '<button>分段参数</button>' });
  script = [() => new Response(new ReadableStream({ start(controller) {
    const send = delta => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
    send({ tool_calls: [{ index: 0, id: 'stream-widget', type: 'function', function: { name: 'show_widget', arguments: streamedArgs.slice(0, -8) } }] });
    finishArguments = () => {
      send({ tool_calls: [{ index: 0, function: { arguments: streamedArgs.slice(-8) } }] });
      controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
      controller.close();
    };
  } }), { headers: { 'content-type': 'text/event-stream' } }), () => ({ text: reference(answer(203).widget) })];
  const streamed = enqueue(203);
  await until(() => finishArguments);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(get(streamed).progress?.widgetPreview, undefined);
  assert.ok(!answer(203)?.widgets, 'partial parameters cannot create runnable work');
  finishArguments();
  const streamedResult = await completed(streamed);
  assert.equal(streamedResult.progress.widgetPreview, undefined);
  assert.equal(streamedResult.result.widget.html, '<button>分段参数</button>');

  // action may arrive LAST, after code or HTML in search/replace. No raw
  // delta is ever promoted into widgetPreview, including invalid combinations.
  for (const invalid of [false, true]) {
    const sid = invalid ? 281 : 280; session(sid);
    let release;
    const args = JSON.stringify({ format: 'html', code: invalid ? '<button>not a page</button>' : '', edits: [{ search: 'old', replace: '<b>new</b>' }], revision: 1, action: 'patch' });
    const split = args.indexOf(',"revision"');
    script = [() => ({ calls: [widgetCall('stream-base', '<div>old</div>', { action: 'append', revision: 0, offset: 0 })] }),
      () => new Response(new ReadableStream({ start(controller) {
        const send = delta => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`));
        send({ tool_calls: [{ index: 0, id: 'stream-patch', type: 'function', function: { name: 'show_widget', arguments: args.slice(0, split) } }] });
        release = () => { send({ tool_calls: [{ index: 0, function: { arguments: args.slice(split) } }] }); controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); };
      } }), { headers: { 'content-type': 'text/event-stream' } }),
      () => ({ calls: [widgetCall('stream-finish', '', { action: 'complete', revision: invalid ? 1 : 2, offset: invalid ? 14 : 21 })] }),
      () => ({ text: reference(answer(sid).widget) })];
    const id = enqueue(sid);
    await until(() => release);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(get(id).progress?.widgetPreview, undefined);
    assert.ok(!answer(sid)?.widgets);
    release();
    const result = await completed(id);
    assert.equal(result.result.widget.html, invalid ? '<div>old</div>' : '<div><b>new</b></div>');
  }

  session(205);
  script = [() => Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null,
    tool_calls: [{ id: 'truncated-widget', type: 'function', function: { name: 'show_widget', arguments: JSON.stringify(widgetCall('unused').args) } }] } }] }), body => {
    assert.ok(!answer(205).widgets, 'length-limited calls cannot execute even when arguments parse');
    assert.match(body.messages.at(-1).content, /没有执行.*max_tokens/);
    assert.ok(!JSON.stringify(body).includes('truncated-widget'), 'incomplete tool envelopes are discarded, never patched or replayed');
    return { text: '工具参数撞上限，本轮未交付作品。' };
  }];
  assert.equal((await completed(enqueue(205))).result.widgets, undefined);

  for (let protocol = 0; protocol < providers.length; protocol++) {
    configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: `p${protocol}`, model: 'test-model' } });
    const sid = 220 + protocol; session(sid);
    const call = widgetCall('truncated-append', '<div>must-not-append</div>', { action: 'append', offset: 0, revision: 0 });
    script = [() => protocol === 0 ? Response.json({ choices: [{ finish_reason: 'length', message: { role: 'assistant', content: null,
      tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] })
      : protocol === 1 ? Response.json({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [{ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args) }] })
      : Response.json({ stop_reason: 'max_tokens', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.args }] }), body => {
        assert.ok(!JSON.stringify(body).includes(call.id), 'no incomplete provider tool envelope is sent again');
        return { calls: [widgetCall('real-append', '<div>safe</div>', { action: 'append', offset: 0, revision: 0 })] };
      }, () => ({ calls: [widgetCall('finish-after-truncation', '', { action: 'complete', offset: 15, revision: 1 })] }), () => ({ text: '只交付完整页面。' })];
    assert.equal((await completed(enqueue(sid))).result.widget.html, '<div>safe</div>', 'truncated append must not change even in-memory source');
  }
  configuration.save(owner, { ...configuration.get(owner, true), llmModel: { providerId: 'p0', model: 'test-model' } });

  session(225);
  script = [() => ({ calls: [widgetCall('append-before-disconnect', '<div>未完成', { action: 'append', offset: 0, revision: 0 })] }), () => { throw new Error('disconnect during assembly'); }];
  const assemblyFailure = enqueue(225); await until(() => get(assemblyFailure).status === 'failed');
  assert.ok(!answer(225).widgets);
  await runner.close(); runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch }); runner.start('http://127.0.0.1:1');
  script = [() => ({ calls: [widgetCall('cannot-resume-memory', '', { action: 'complete', offset: 8, revision: 1 })] }), body => {
    assert.match(JSON.stringify(body), /length=0/);
    return { calls: [widgetCall('restart-from-zero', '<div>重新组装</div>', { action: 'append', offset: 0, revision: 0 })] };
  }, () => ({ calls: [widgetCall('finish-new-task', '', { action: 'complete', offset: '<div>重新组装</div>'.length, revision: 1 })] }), () => ({ text: '新任务从头组装完成。' })];
  assert.equal((await completed(enqueue(225))).result.widget.html, '<div>重新组装</div>');

  session(206);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '异常前已输出的内容' } }] })];
  const providerError = enqueue(206);
  await until(() => get(providerError).status === 'failed');
  assert.equal(script.length, 0, 'provider failure must not start a wrap-up request');
  assert.equal(answer(206).content, '异常前已输出的内容');
  assert.equal(answer(206).interrupted, true);
  assert.equal(get(providerError).progress.widgetPreview, undefined);

  session(207);
  let streamReads = 0;
  script = [() => new Response(new ReadableStream({ pull(controller) {
    if (streamReads++ === 0) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ choices: [{ delta: { content: '节流窗口中的最后一段' } }] }) + '\n\n'));
    else controller.error(new Error('reader connection reset'));
  } }), { headers: { 'content-type': 'text/event-stream' } })];
  const readerError = enqueue(207);
  await until(() => get(readerError).status === 'failed');
  assert.equal(answer(207).content, '节流窗口中的最后一段', 'failure must force a final durable progress flush');
  assert.equal(answer(207).interrupted, true);
  assert.equal(get(readerError).progress.content, '节流窗口中的最后一段');

  session(208);
  script = [() => Response.json({ choices: [{ finish_reason: 'content_filter', message: { role: 'assistant', content: '',
    tool_calls: [{ id: 'filtered-widget', type: 'function', function: { name: 'show_widget', arguments: JSON.stringify(widgetCall('filtered-widget').args) } }] } }] })];
  const filtered = await completed(enqueue(208));
  assert.equal(script.length, 0, 'content filtering must not trigger a follow-up request');
  assert.equal(filtered.result.widgets, undefined, 'filtered tool calls must not execute');
  assert.equal(answer(208).interrupted, undefined);
  assert.match(answer(208).content, /内容过滤/);

  session(204);
  script = [() => ({ calls: [widgetCall('edited-widget')] }), () => {
    const row = answer(204);
    const revised = { ...row.widget, id: crypto.randomUUID(), revision: 2, html: '<button>新修订</button>' };
    put('chats', row.id, { ...row, widgets: [revised], widget: revised });
    return { text: reference(revised) };
  }];
  const edited = await completed(enqueue(204));
  assert.equal(edited.result.widget.revision, 2, 'results and progress use the latest committed source, not a stale payload');
  assert.deepEqual(edited.result.widgets, answer(204).widgets);
  assert.deepEqual(edited.progress.widgets, answer(204).widgets);

  for (const [id, video] of [['video', { name: '视频', duration: 60 }], ['material', { name: '材料', kind: 'material', materialFormat: 'md' }]]) {
    put('videos', id, { id, ...video });
    const sid = id === 'video' ? 300 : 301; session(sid);
    script = [body => { assert.ok(body.tools.some(tool => tool.function?.name === 'show_widget')); return { calls: [widgetCall('qa-widget')] }; }, () => ({ text: reference(answer(sid).widget) })];
    const task = await completed(enqueue(sid, 'qa', { videoId: id }));
    assert.equal(task.result.widget.html, '<button>交互式讲解</button>');
  }
  console.log('Invalid input/correction, local library whitelist, multiple works/order, deduplication, state preservation and video/material QA passed');

  session(400);
  script = [() => ({ calls: [widgetCall('interrupted-widget')] }), () => { throw new Error('simulated model disconnect'); }];
  const failed = enqueue(400); await until(() => get(failed).status === 'failed');
  const partial = answer(400);
  assert.equal(partial.widgets.length, 1); assert.equal(partial.interrupted, true);
  await runner.close();
  runner = new CloudTaskRunner(store, { records, configuration, filesDir: directory, fetch: mockFetch }); runner.start('http://127.0.0.1:1');
  script = [body => { assert.ok(JSON.stringify(body.messages).includes(partial.widget.ref)); return { text: '继续解释。' }; }];
  await completed(enqueue(400));
  assert.deepEqual(records.get(owner, 'chats', partial.id).widgets, partial.widgets, 'restart retains the already delivered work');

  const beforeContinue = rows(400);
  const suffix = '  接着断点继续解释。\n\n';
  script = [body => {
    assert.equal(body.tools, undefined, 'explicit continuation has no tool execution');
    assert.match(body.messages.at(-1).content, /从断点处直接续上/);
    assert.ok(!JSON.stringify(body.messages).includes('继续解释。'), 'later questions/answers are outside the original breakpoint');
    return { text: partial.content + suffix };
  }];
  const continued = await completed(enqueue(400, 'chat', { action: 'continue', rowId: partial.id }));
  assert.equal(continued.result.rowId, partial.id);
  assert.equal(records.get(owner, 'chats', partial.id).content, partial.content + suffix, 'exact replay is stripped without trimming whitespace');
  assert.equal(records.get(owner, 'chats', partial.id).interrupted, undefined);
  assert.deepEqual(records.get(owner, 'chats', partial.id).widgets, partial.widgets);
  assert.equal(rows(400).length, beforeContinue.length, 'continuation updates the same row, without another user question');

  session(410);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '这是原回答足够长的中断前缀，不能丢失。' } }] })];
  const firstFailure = enqueue(410); await until(() => get(firstFailure).status === 'failed');
  const interrupted = answer(410);
  script = [() => Response.json({ choices: [{ finish_reason: 'error', message: { role: 'assistant', content: '又接上了半句' } }] })];
  const secondFailure = enqueue(410, 'chat', { action: 'continue', rowId: interrupted.id });
  await until(() => get(secondFailure).status === 'failed');
  assert.equal(answer(410).id, interrupted.id);
  assert.equal(answer(410).content, interrupted.content + '又接上了半句');
  assert.equal(answer(410).interrupted, true, 'failure during continuation keeps the new prefix resumable');
  script = [() => ({ text: answer(410).content + '最后写完。' })];
  await completed(enqueue(410, 'chat', { action: 'continue', rowId: interrupted.id }));
  assert.equal(answer(410).content, interrupted.content + '又接上了半句最后写完。');
  assert.equal(answer(410).interrupted, undefined);
  const wrongOwner = enqueue(400, 'chat', { action: 'continue', rowId: interrupted.id });
  await until(() => get(wrongOwner).status === 'failed');
  assert.match(get(wrongOwner).error, /原回答不存在/);

  session(401);
  let waiting = false;
  script = [() => ({ calls: [widgetCall('cancel-widget')] }), (_body, init) => new Promise((_, reject) => {
    waiting = true;
    const abort = () => reject(new DOMException('Aborted', 'AbortError'));
    init.signal.addEventListener('abort', abort, { once: true }); if (init.signal.aborted) abort();
  })];
  const cancelled = enqueue(401); await until(() => waiting);
  store.db.prepare("UPDATE cloud_tasks SET status='cancelled' WHERE id=?").run(cancelled); await runner.cancel(cancelled);
  assert.equal(answer(401).widgets.length, 1); assert.equal(answer(401).interrupted, undefined, 'explicit stop is not an automatic continuation marker');

  session(402);
  script = [() => ({ calls: [widgetCall('deleted-owner')] }), () => { const row = answer(402); put('chats', row.id, null); return { text: 'must not recreate deleted row' }; }];
  const deleted = enqueue(402); await until(() => get(deleted).status === 'failed');
  assert.equal(answer(402), undefined); assert.match(get(deleted).error, /已删除/);

  for (const [format, code] of [
    ['diagram', '{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"x^2"}]}'],
    ['svg', '<svg viewBox="0 0 20 20"><rect width="10" height="10"/></svg>'],
    ['mermaid', 'flowchart TD\n A-->B'],
  ]) assert.match(executeServerWidget({ format, code }, () => assert.fail('not an HTML work')), /```/);
  const graph = {
    type: 'graph',
    nodes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, label: `节点${i}` })),
    edges: Array.from({ length: 20 }, (_, i) => ({ from: `n${i % 12}`, to: `n${(i + 1) % 12}` })),
  };
  const graphCode = JSON.stringify(graph);
  const graphReceipt = executeServerWidget({ format: 'diagram', code: graphCode, title: '完整关系图' }, () => assert.fail('not an HTML work'));
  assert.ok(graphReceipt.includes(graphCode), '12 节点 / 20 条边通过服务端预检，原样保留全部结构');
  assert.match(graphReceipt, /```diagram title="完整关系图"/);
  assert.throws(() => executeServerWidget({ format: 'diagram', code: JSON.stringify({
    ...graph, nodes: Array.from({ length: 101 }, (_, i) => ({ id: `n${i}`, label: `节点${i}` })),
  }) }, () => {}), /渲染安全上限[\s\S]*保留全部节点与关系/);
  assert.throws(() => executeServerWidget({ format: 'diagram', code: '{"type":"plot","x":[-2,2],"y":[0,4],"curves":[{"fn":"fetch(x)"}]}' }, () => {}), /预检没通过/);
  assert.throws(() => executeServerWidget({ format: 'svg', code: '<svg viewBox="0 0 20 20"><script>alert(1)</script></svg>' }, () => {}), /预检没通过/);
  assert.equal(script.length, 0);
  console.log('Model failure/cancellation, restart history, deleted-owner safety and static-format structural checks passed');
  await runner.close();
  // A development checkout may contain abandoned tables. Startup leaves them
  // alone; no DROP/cleanup migration or widget dependency is introduced.
  for (const table of ['widget_drafts', 'widget_draft_operations', 'widget_draft_publications']) {
    store.db.exec(`CREATE TABLE ${table}(sentinel TEXT); INSERT INTO ${table} VALUES('keep-existing-data');`);
  }
  const reopened = new DatabaseStore(path.join(directory, 'db.sqlite'));
  try {
    for (const table of ['widget_drafts', 'widget_draft_operations', 'widget_draft_publications']) {
      assert.equal(reopened.db.prepare(`SELECT sentinel FROM ${table}`).get().sentinel, 'keep-existing-data');
    }
    assert.ok(reopened.db.prepare("SELECT COUNT(*) AS n FROM cloud_records WHERE table_name='chats'").get().n > 0);
  } finally { reopened.close(); }
  console.log('Existing unused tables and chat rows survive reopening without a destructive migration');
} finally {
  await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true });
}
