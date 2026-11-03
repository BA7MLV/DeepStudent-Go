/** Bot/Chat wire parity and real Bot tool-loop persistence. Offline only. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestBody, decodeResponse, chatOnce, chatStream, textOf } from '@wangke/study-core/model/client';
import { ModelAdapter } from '../apps/api/src/agent/model-adapter.ts';
import { createModelGateway } from '../apps/api/src/agent/model-gateway-factory.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';

const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('offline test attempted unmocked fetch'); };
after(() => { globalThis.fetch = originalFetch; });

const tool = { type: 'function', function: { name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } } };
const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'question' }];
const connection = (protocol, baseUrl, catalogId = '') => ({ id: 'fixture', name: 'Fixture', protocol, baseUrl, catalogId, apiKey: 'not-a-real-key', serves: ['chat'] });
const targetOf = (provider, model, adapter, capabilities) => ({ providerId: provider.id, protocol: provider.protocol, baseUrl: provider.baseUrl,
  catalogId: provider.catalogId, model, apiKey: '', stateScope: adapter.target.stateScope, capabilities, gatewayManaged: true });
const configs = [
  ['openai-chat', 'https://api.openai.com/v1', 'gpt-5.2'],
  ['openai-responses', 'https://api.openai.com/v1', 'gpt-5.2'],
  ['anthropic-messages', 'https://api.anthropic.com/v1', 'claude-sonnet-4-6'],
  ['anthropic-messages', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5'],
  ['openai-chat', 'https://api.deepseek.com', 'deepseek-v4-pro'],
  ['openai-responses', 'https://api.deepseek.com', 'deepseek-v4-pro'],
  ['openai-chat', 'https://api.moonshot.ai/v1', 'kimi-k2.5'],
  ['openai-chat', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3'],
  ['openai-chat', 'https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen3.6-plus'],
  ['openai-chat', 'https://api.siliconflow.cn/v1', 'deepseek-ai/DeepSeek-V4-Flash'],
  ['openai-chat', 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-flash-preview'],
  ['openai-chat', 'https://openrouter.ai/api/v1', 'anthropic/claude-sonnet-4.6'],
  ['openai-chat', 'https://api.minimax.io/v1', 'MiniMax-M3.1-Flash'],
  ['openai-responses', 'https://api.x.ai/v1', 'grok-4.7'],
  ['openai-chat', 'https://unknown.invalid/v1', 'unknown'],
];
for (const [protocol, baseUrl, model] of configs) {
  test(`same Bot/Chat request codec: ${model} / ${protocol}`, () => {
    const provider = connection(protocol, baseUrl);
    const adapter = new ModelAdapter(provider, model);
    const target = targetOf(provider, model, adapter);
    for (const thinkingLevel of [undefined, 'none', 'low', 'high', 'xhigh', 'max']) {
      const input = { messages, tools: [tool], thinkingLevel, temperature: .3, outputTokens: 8192, cacheKey: 'same-key' };
      const chat = requestBody(target, { messages, tools: [tool], thinkingLevel, temperature: .3, max_tokens: 8192, cacheKey: 'same-key' }, messages, false);
      assert.deepEqual(adapter.encode(input).body, chat);
    }
    assert.deepEqual(adapter.encode({ messages, tools: [tool] }).body, requestBody(target, { messages, tools: [tool] }, messages, false), 'defaults belong to the shared codec');
    const image = { mime: 'image/png', data: 'AAAA' };
    const chatMessages = [...messages.slice(0, -1), { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }, { type: 'text', text: 'question' }] }];
    assert.deepEqual(adapter.encode({ messages, image }).body, requestBody(target, { messages: chatMessages }, chatMessages, false));
  });
}

function fixture(protocol, name = 'read', args = '{}') {
  const call = { id: 'upstream-call', type: 'function', function: { name, arguments: args } };
  if (protocol === 'anthropic-messages') return { stop_reason: 'tool_use', content: [
    { type: 'thinking', thinking: 'Plan', signature: 'opaque-signature' }, { type: 'redacted_thinking', data: 'opaque-redacted' },
    { type: 'text', text: 'ready' }, { type: 'tool_use', id: call.id, name, input: JSON.parse(args) },
  ] };
  if (protocol === 'openai-responses') return { status: 'completed', output: [
    { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'Plan' }], encrypted_content: 'opaque-encrypted' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] },
    { type: 'function_call', call_id: call.id, name, arguments: args },
  ] };
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: 'ready', reasoning_content: 'Plan',
    reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque-encrypted' }],
    extra_content: { google: { thought_signature: 'opaque-signature' } },
    tool_calls: [{ ...call, extra_content: { google: { thought_signature: 'opaque-tool-signature' } } }],
  } }] };
}
for (const [protocol, baseUrl, model] of [configs[1], configs[2], configs[4], configs[10], configs[11]]) {
  test(`same JSON/fallback decoding and bound tool continuation: ${model}`, async () => {
    const provider = connection(protocol, baseUrl), adapter = new ModelAdapter(provider, model);
    const target = targetOf(provider, model, adapter), data = fixture(protocol);
    const decoded = decodeResponse(target, data), reply = adapter.decode(data, 'bot', [tool]);
    assert.equal(reply.text, textOf(decoded));
    assert.equal(reply.reasoning, decoded.reasoning_content);
    assert.equal(reply.reasoning, 'Plan');
    assert.deepEqual(reply.providerState, decoded.providerState);
    assert.doesNotMatch(reply.text + reply.reasoning, /opaque/);
    const fetcher = async () => Response.json(data);
    assert.deepEqual(await chatOnce(target, { messages, tools: [tool] }, fetcher), decoded);
    assert.deepEqual(await chatStream(target, { messages, tools: [tool] }, undefined, undefined, undefined, fetcher), decoded);
    const portableCalls = reply.calls.map(c => ({ id: 'local-call', provider_id: c.id, type: 'function', function: c.function }));
    const botHistory = [...messages, { role: 'assistant', content: reply.text, reasoning_content: reply.reasoning, tool_calls: portableCalls, providerState: JSON.parse(JSON.stringify(reply.providerState)) }, { role: 'tool', content: 'result', tool_call_id: 'local-call' }];
    const chatHistory = [...messages, decoded, { role: 'tool', content: 'result', tool_call_id: 'upstream-call' }];
    const next = adapter.encode({ messages: botHistory, tools: [tool] }).body;
    assert.deepEqual(next, requestBody(target, { messages: chatHistory, tools: [tool] }, chatHistory, false));
    assert.match(JSON.stringify(next), /opaque/);
    assert.doesNotMatch(JSON.stringify(next), /local-call/);
    for (const changed of [new ModelAdapter({ ...provider, baseUrl: 'https://changed.invalid/v1' }, model), new ModelAdapter({ ...provider, id: 'other' }, model), new ModelAdapter(provider, 'other-model'), new ModelAdapter({ ...provider, protocol: protocol === 'openai-chat' ? 'openai-responses' : 'openai-chat' }, model)]) {
      const body = changed.encode({ messages: botHistory, tools: [tool] }).body;
      assert.doesNotMatch(JSON.stringify(body), /opaque/, 'changed endpoint/provider/model/protocol must discard native state');
      assert.match(JSON.stringify(body), /result/);
    }
  });
}

test('shared protocol restrictions, capability overrides and incomplete-tool safety', () => {
  for (const [model, capabilities] of [['gpt-5.2-pro', undefined], ['gpt-5.2', { toolCalling: false }]]) {
    const provider = connection('openai-chat', 'https://api.openai.com/v1'), adapter = new ModelAdapter(provider, model, capabilities);
    const target = targetOf(provider, model, adapter, capabilities);
    assert.throws(() => adapter.encode({ messages, tools: [tool] }));
    assert.throws(() => requestBody(target, { messages, tools: [tool] }, messages, false));
  }
  for (const [protocol, baseUrl, model] of configs.slice(0, 3)) {
    const provider = connection(protocol, baseUrl), adapter = new ModelAdapter(provider, model), target = targetOf(provider, model, adapter);
    const data = fixture(protocol);
    if (protocol === 'anthropic-messages') data.stop_reason = 'max_tokens';
    else if (protocol === 'openai-responses') { data.status = 'incomplete'; data.incomplete_details = { reason: 'max_output_tokens' }; }
    else data.choices[0].finish_reason = 'length';
    assert.equal(decodeResponse(target, data).finish_reason, 'length');
    assert.throws(() => adapter.decode(data, 'bot'), error => error.code === 'model_incomplete_or_refused');
  }
});

test('real BotRunner shares preferences and persists reasoning/native state through a tool round', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'bot-codec-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const owner = crypto.randomUUID(), at = new Date().toISOString();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, at);
  const config = new CloudConfiguration(store, path.join(directory, 'config')), records = new CloudRecords(store);
  const put = (id, value) => records.apply(owner, [{ id: crypto.randomUUID(), table: 'preferences', key: id, before: records.get(owner, 'preferences', id), after: { id, value } }]);
  let runner;
  try {
    for (const [protocol, baseUrl, model] of [configs[1], configs[2], configs[4]]) {
      const provider = connection(protocol, baseUrl);
      config.save(owner, { ...config.get(owner, true), providers: [provider], llmModel: { providerId: provider.id, model }, policy: { ...config.get(owner).policy, shell: 'allow' } });
      put('thinkingEnabled', true); put('thinkingEffort', 'high');
      const thread = crypto.randomUUID(), run = crypto.randomUUID();
      store.db.prepare('INSERT INTO threads(id,owner_id,mode,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(thread, owner, 'bot', 'Codec', at, at);
      store.db.prepare('INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,?,?,?)').run(run, thread, 'bot', 'queued', at);
      let count = 0;
      runner = new BotRunner(store, { configuration: config,
        sandbox: async () => ({ stdout: '42', stderr: '', exitCode: 0 }),
        fetch: async (_url, init) => {
          const body = JSON.parse(init.body); count++;
          if (protocol === 'anthropic-messages') { assert.equal(body.thinking.type, 'adaptive'); assert.equal(body.output_config.effort, 'high'); }
          else if (protocol === 'openai-responses') assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
          else { assert.equal(body.thinking.type, 'enabled'); assert.equal(body.reasoning_effort, 'high'); }
          if (count === 1) {
            put('thinkingEffort', 'low'); // the running loop retains its captured intent
            return Response.json(fixture(protocol, 'shell', '{"command":"echo 42"}'));
          }
          assert.equal(count, 2);
          assert.match(JSON.stringify(body), /42/);
          assert.match(JSON.stringify(body), protocol === 'openai-chat' ? /reasoning_content.*Plan/ : /opaque/);
          assert.match(JSON.stringify(body), /upstream-call/);
          return Response.json(fixture(protocol, 'send_message', '{"kind":"text","text":"Done"}'));
        },
      });
      runner.start();
      const deadline = Date.now() + 10000;
      let row;
      do {
        row = store.db.prepare('SELECT status,context_json,error_code FROM runs WHERE id=?').get(run);
        if (['completed', 'failed', 'paused'].includes(row.status)) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      } while (Date.now() < deadline);
      await runner.close(); runner = undefined;
      assert.equal(row.status, 'completed', JSON.stringify(row));
      assert.equal(count, 2);
      const history = JSON.parse(row.context_json).filter(m => m.role === 'assistant');
      assert.ok(history.some(m => m.reasoning_content === 'Plan' && m.providerState?.items.length));
      assert.doesNotMatch(JSON.stringify(history), /not-a-real-key|api\.anthropic\.com|api\.openai\.com|api\.deepseek\.com/);
      // Canonical requests made outside BotRunner get the same synchronized
      // preference fallback, and valid per-call snapshots take precedence.
      put('savedModels', [{ providerId: provider.id, model, maxOutputTokens: 2048 }]);
      for (const [explicit, expected] of [[undefined, 'low'], ['invalid', 'low'], ['high', 'high']]) {
        const gateway = createModelGateway(store, config, async (_url, init) => {
          const body = JSON.parse(init.body);
          const effort = protocol === 'anthropic-messages' ? body.output_config.effort : protocol === 'openai-responses' ? body.reasoning.effort : body.reasoning_effort;
          assert.equal(effort, expected);
          assert.equal(body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens, 2048, 'Bot and Chat resolve the same saved model capabilities');
          return Response.json(fixture(protocol));
        });
        const result = await gateway.request({ owner, purpose: 'bot', messages, outputTokens: 8192, thinkingLevel: explicit, signal: new AbortController().signal });
        assert.equal(result.response.reasoning, 'Plan');
      }
    }
  } finally { await runner?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
