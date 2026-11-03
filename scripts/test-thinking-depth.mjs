#!/usr/bin/env node
/** Offline request/response contracts. No API key, real model or generated files. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatOnce, chatStream, requestBody } from '../packages/study-core/src/api/modelClient.ts';
import { configureModelMetaStorage, getModelMeta, refreshModelMeta, MODEL_META_CACHE_VERSION } from '../packages/study-core/src/api/modelMeta.ts';
import { effectiveThinkingLevel, normalizeThinkingLevel, reasoningChoices, reasoningProfile, reasoningWire } from '../packages/study-core/src/api/reasoning.ts';

const limits = { context: 128000, output: 8192 };
const entry = (options = [], reasoning = true) => ({ reasoning, reasoning_options: options, limit: limits });
const toggle = { type: 'toggle' };
const budget = { type: 'budget_tokens', min: 128, max: 32768 };
const effort = values => ({ type: 'effort', values });
const catalog = {
  'siliconflow-cn': { models: {
    'Qwen/Qwen3-14B': entry([toggle, budget]),
    'Qwen/Qwen3.5-27B': entry([toggle]),
    'deepseek-ai/DeepSeek-V4-Flash': entry([budget]),
    'deepseek-ai/DeepSeek-V4-Flash-0731': entry([toggle, budget]),
    'deepseek-ai/DeepSeek-V4-Pro': entry(),
    'x/shared': entry([effort(['high', 'max'])]),
    plain: entry([], false),
  } },
  siliconflow: { models: { 'x/shared': entry([toggle, { ...budget, max: 4096 }]) } },
  custom: { models: { standard: entry([effort(['none', 'low', 'high'])]), budgetOnly: entry([budget]) } },
  openrouter: { models: { 'anthropic/claude-sonnet-4.6': entry([toggle, effort(['low', 'medium', 'high'])]) } },
};
const originalFetch = globalThis.fetch;
try {
  configureModelMetaStorage({ getItem: () => null, setItem: () => {} });
  globalThis.fetch = async () => Response.json(catalog);
  await refreshModelMeta([]);
} finally { globalThis.fetch = originalFetch; }

const target = (model, protocol = 'openai-chat', catalogId = '', baseUrl = 'https://fixture.invalid/v1') => ({ providerId: 'fixture', apiKey: '', model, protocol, catalogId, baseUrl });
const opts = { messages: [{ role: 'user', content: 'test' }], max_tokens: 8192, temperature: .3 };
const body = (t, level, extra = {}) => requestBody(t, { ...opts, thinkingLevel: level, ...extra }, opts.messages, false);
const choices = t => reasoningChoices(t).map(c => c.value);

test('OpenAI Chat and Responses share intent but not parameter names', () => {
  for (const level of ['none', 'low', 'high', 'xhigh']) {
    const chat = body(target('gpt-5.2'), level);
    assert.equal(chat.reasoning_effort, level);
    assert.equal(chat.enable_thinking, undefined);
    assert.equal(chat.temperature, undefined);
    assert.equal(chat.max_completion_tokens, 8192);
    assert.equal(chat.max_tokens, undefined);
    const responses = body(target('gpt-5.2', 'openai-responses'), level);
    assert.deepEqual(responses.reasoning, { effort: level, ...(level !== 'none' ? { summary: 'auto' } : {}) });
    assert.equal(responses.reasoning_effort, undefined);
    assert.equal(responses.enable_thinking, undefined);
  }
});

test('forced-reasoning models never send none; max and xhigh remain distinct', () => {
  for (const model of ['o3', 'o4-mini', 'gpt-5', 'gpt-6-astra', 'gpt-6.1-sol']) {
    assert.ok(!choices(target(model)).includes('none'), model);
    assert.notEqual(body(target(model), 'none').reasoning_effort, 'none', model);
  }
  assert.deepEqual(choices(target('gpt-6.1-sol')), ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(body(target('gpt-6.1-sol'), 'max').reasoning_effort, 'max');
  assert.equal(body(target('gpt-6.1-sol'), 'xhigh').reasoning_effort, 'xhigh');
  assert.equal(body(target('gpt-5.1'), 'minimal').reasoning_effort, 'low');
  assert.equal(body(target('gpt-5-chat-latest'), 'high').reasoning_effort, undefined);
  assert.deepEqual(choices(target('gpt-5.2-pro', 'openai-responses')), ['medium', 'high', 'xhigh']);
  assert.ok(!choices(target('o3-pro', 'openai-responses')).includes('xhigh'), 'GPT Pro effort overrides cannot bleed into o-series');
  assert.equal(body(target('gpt-5.6-terra'), 'max').reasoning_effort, 'max');
  const tools = [{ type: 'function', function: { name: 'read', description: '', parameters: { type: 'object' } } }];
  assert.throws(() => body(target('gpt-6.1-sol'), 'high', { tools }), /Responses/);
  assert.throws(() => body(target('gpt-5.2-pro'), 'high'), /Responses/);
  assert.doesNotThrow(() => body(target('gpt-6-luna'), 'none', { tools }));
});

test('Claude adaptive and legacy budget thinking use different contracts', () => {
  const t = target('claude-opus-4-6', 'anthropic-messages');
  assert.deepEqual(body(t, 'max').thinking, { type: 'adaptive' });
  assert.deepEqual(body(t, 'max').output_config, { effort: 'max' });
  assert.equal(body(t, 'high').temperature, undefined);
  assert.deepEqual(body(t, 'none').thinking, { type: 'disabled' });
  const legacy = target('claude-sonnet-4-5-20250929', 'anthropic-messages');
  const b = body(legacy, 'xhigh', { max_tokens: 4096 });
  assert.equal(b.thinking.type, 'enabled');
  assert.equal(b.thinking.budget_tokens, 3072, 'reserve final answer space');
  assert.equal(b.output_config, undefined);
  assert.throws(() => body(legacy, 'high', { max_tokens: 1024 }), /1024/);
  assert.ok(!choices(target('claude-opus-5-5', 'anthropic-messages')).includes('none'));
  assert.ok(choices(target('claude-opus-4-7', 'anthropic-messages')).includes('xhigh'));
  assert.deepEqual(body(target('claude-haiku-5-5', 'anthropic-messages'), 'none').output_config, { effort: 'high' });
});

test('DeepSeek, Kimi and GLM native Chat/Messages controls', () => {
  const ds = target('deepseek-v4-pro', 'openai-chat', 'deepseek');
  assert.deepEqual(reasoningWire(ds, 'max', 8192), { thinking: { type: 'enabled' }, reasoning_effort: 'max' });
  assert.deepEqual(reasoningWire(ds, 'none', 8192), { thinking: { type: 'disabled' } });
  assert.deepEqual(reasoningWire({ ...ds, protocol: 'anthropic-messages' }, 'high', 8192), { thinking: { type: 'enabled' }, output_config: { effort: 'high' } });
  assert.deepEqual(body({ ...ds, protocol: 'openai-responses' }, 'low').reasoning, { effort: 'low' });
  const kimi = target('kimi-k2.5', 'openai-chat', 'moonshotai');
  assert.deepEqual(reasoningWire(kimi, 'high', 8192), { thinking: { type: 'enabled' } });
  assert.deepEqual(choices(kimi), ['none'], 'toggle-only models do not get fake depth');
  const k3 = target('kimi-k3.1-pro', 'openai-chat', 'moonshotai');
  assert.deepEqual(choices(k3), ['low', 'high', 'max']);
  assert.equal(body(k3, 'none').reasoning_effort, 'low');
  const glm = target('glm-5.3', 'openai-chat', 'zai');
  assert.deepEqual(choices(glm), ['low', 'high', 'max']);
  assert.equal(body(glm, 'none').thinking, undefined);
  assert.equal(body(glm, 'none').reasoning_effort, 'low');
});

test('SiliconFlow and Qwen switches/budgets are provider scoped', () => {
  const sf = model => target(model, 'openai-chat', 'siliconflow-cn');
  assert.deepEqual(reasoningWire(sf('Qwen/Qwen3.5-27B'), 'none', 8192), { enable_thinking: false });
  assert.deepEqual(reasoningWire(sf('Qwen/Qwen3.5-27B'), 'high', 8192), { enable_thinking: true });
  assert.deepEqual(reasoningWire(sf('Qwen/Qwen3-14B'), 'high', 8192), { enable_thinking: true, thinking_budget: 16384 });
  assert.deepEqual(reasoningWire(sf('deepseek-ai/DeepSeek-V4-Flash'), 'xhigh', 8192), { enable_thinking: true, reasoning_effort: 'max' });
  assert.equal(body(sf('deepseek-ai/DeepSeek-V4-Flash-0731'), 'high').thinking_budget, 16384);
  assert.equal(body(sf('x/shared'), 'high').reasoning_effort, 'high');
  assert.equal(body(target('x/shared', 'openai-chat', 'siliconflow'), 'high').thinking_budget, 2048);
  assert.equal(getModelMeta('siliconflow-cn', 'deepseek-ai/DeepSeek-V4-Pro').thinking.toggle, false, 'empty options are not a switch');
  const qwen = target('qwen3.6-plus', 'openai-chat', 'alibaba-cn');
  assert.equal(body(qwen, 'none').enable_thinking, false);
});

test('Gemini compatibility requests summaries and only real levels', () => {
  const g = target('gemini-3-flash-preview', 'openai-chat', 'google');
  assert.deepEqual(reasoningWire(g, 'medium', 8192), { extra_body: { google: { thinking_config: { include_thoughts: true, thinking_level: 'medium' } } } });
  assert.deepEqual(choices(g), ['minimal', 'low', 'medium', 'high']);
  assert.deepEqual(choices({ ...g, model: 'gemini-3.8-flash' }), ['low', 'medium', 'high']);
  assert.equal(body({ ...g, model: 'gemini-2.5-flash' }, 'none').extra_body.google.thinking_config.thinking_budget, 0);
  assert.ok(!choices({ ...g, model: 'gemini-2.5-pro' }).includes('none'));
});

test('OpenRouter, MiniMax and xAI do not receive generic enable_thinking', () => {
  const router = target('anthropic/claude-sonnet-4.6', 'openai-chat', 'openrouter');
  assert.deepEqual(body(router, 'high').reasoning, { enabled: true, exclude: false, effort: 'high' });
  assert.deepEqual(body(router, 'none').reasoning, { enabled: false });
  const mini = target('MiniMax-M3.1-Flash', 'openai-chat', 'minimax');
  assert.equal(body(mini, 'max').reasoning_effort, 'max');
  assert.equal(body(mini, 'max').reasoning_split, true);
  assert.ok(!choices(mini).includes('none'));
  assert.deepEqual(body({ ...mini, protocol: 'anthropic-messages' }, 'high').output_config, { effort: 'high' });
  assert.deepEqual(choices({ ...mini, model: 'MiniMax-M2.5' }), []);
  const grok = target('grok-4.7', 'openai-responses', 'xai');
  assert.deepEqual(body(grok, 'xhigh').reasoning, { effort: 'xhigh' });
  assert.ok(!choices(grok).includes('none'));
});

test('unknown endpoints, invalid levels and explicit overrides are conservative', () => {
  const unknown = target('unknown');
  assert.deepEqual(reasoningWire(unknown, 'none', 8192), {});
  assert.deepEqual(reasoningWire(unknown, 'high', 8192), {});
  const declared = { ...unknown, capabilities: { reasoningEffort: 'low,high' } };
  assert.deepEqual(reasoningWire(declared, 'high', 8192), { reasoning_effort: 'high' });
  assert.equal(reasoningProfile({ ...unknown, capabilities: { metadataCatalogId: 'siliconflow-cn' } }).mode, 'unknown');
  assert.deepEqual(reasoningChoices(target('budgetOnly', 'openai-chat', 'custom')), [], 'unknown budget wire is not fabricated');
  assert.deepEqual(choices(target('standard', 'openai-chat', 'custom')), ['none', 'low', 'high']);
  assert.deepEqual(reasoningWire({ ...target('gpt-5.2'), capabilities: { reasoningEffort: '' } }, 'high', 8192), {});
  for (const bad of ['ultra', NaN, null, {}, '', '__proto__']) {
    assert.equal(normalizeThinkingLevel(bad), undefined);
    assert.deepEqual(reasoningWire(declared, bad, 8192), {});
  }
  assert.equal(normalizeThinkingLevel('max'), 'max');
  assert.equal(effectiveThinkingLevel(target('gpt-5.2'), 'max'), 'xhigh');
});

const sse = chunks => new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const reasoningItem = (text = 'Plan', encrypted = 'secret') => ({ type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text }], encrypted_content: encrypted });
const textItem = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Answer' }] };

test('Responses JSON fallback exposes summary once and never ciphertext', async () => {
  const t = target('gpt-5.2', 'openai-responses');
  const output = [reasoningItem(), textItem];
  const deltas = [], thoughts = [];
  const msg = await chatStream(t, opts, x => deltas.push(x), x => thoughts.push(x), undefined, async () => Response.json({ output, status: 'completed' }));
  assert.equal(msg.content, 'Answer');
  assert.equal(msg.reasoning_content, 'Plan');
  assert.deepEqual(thoughts, ['Plan']);
  assert.deepEqual(deltas, ['Answer']);
  const again = requestBody(t, opts, [...opts.messages, JSON.parse(JSON.stringify(msg))], false);
  assert.deepEqual(again.input.slice(-2), output, 'opaque state survives persistence');
  const changed = requestBody({ ...t, model: 'gpt-5.1' }, opts, [...opts.messages, msg], false);
  assert.ok(!JSON.stringify(changed).includes('secret'));
});

test('Responses delta/done/completed snapshots do not duplicate summaries', async () => {
  const t = target('gpt-5.2', 'openai-responses');
  const thoughts = [];
  const chunks = [
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Pl' },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'an' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Plan' },
    { type: 'response.output_item.done', output_index: 0, item: reasoningItem() },
    { type: 'response.output_text.delta', delta: 'Answer' },
    { type: 'response.completed', response: { status: 'completed', output: [reasoningItem(), textItem] } },
  ];
  const msg = await chatStream(t, opts, undefined, x => thoughts.push(x), undefined, async () => sse(chunks));
  assert.equal(thoughts.join(''), 'Plan');
  assert.equal(msg.reasoning_content, 'Plan');
  assert.equal(msg.providerState.items[0].encrypted_content, 'secret');
  const snapshotOnly = await chatStream(t, opts, undefined, undefined, undefined, async () => sse([chunks.at(-1)]));
  assert.equal(snapshotOnly.reasoning_content, 'Plan');
});

test('DeepSeek Responses reasoning_text is separate from final text', async () => {
  const t = target('deepseek-flash', 'openai-responses', 'deepseek');
  const item = { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Plan' }] };
  const once = await chatOnce(t, opts, async () => Response.json({ output: [item, textItem], status: 'completed' }));
  assert.equal(once.reasoning_content, 'Plan');
  assert.equal(once.content, 'Answer', 'reasoning.content cannot become final text');
  const chunks = [
    { type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, delta: 'Plan' },
    { type: 'response.reasoning_text.done', output_index: 0, content_index: 0, text: 'Plan' },
    { type: 'response.completed', response: { status: 'completed', output: [item] } },
  ];
  const msg = await chatStream(t, opts, undefined, undefined, undefined, async () => sse(chunks));
  assert.equal(msg.reasoning_content, 'Plan');
});

test('Claude thinking/signature/redacted blocks replay intact, never as visible ciphertext', async () => {
  const t = target('claude-sonnet-4-6', 'anthropic-messages');
  const blocks = [{ type: 'thinking', thinking: 'Plan', signature: 'signature' }, { type: 'redacted_thinking', data: 'secret' }, { type: 'text', text: 'Answer' }];
  const once = await chatOnce(t, opts, async () => Response.json({ content: blocks, stop_reason: 'end_turn' }));
  assert.equal(once.reasoning_content, 'Plan');
  assert.deepEqual(requestBody(t, opts, [...opts.messages, once], false).messages.at(-1).content, blocks);
  const chunks = [
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Plan' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature' } },
    { type: 'content_block_start', index: 1, content_block: blocks[1] },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  const msg = await chatStream(t, opts, undefined, undefined, undefined, async () => sse(chunks));
  assert.equal(msg.reasoning_content, 'Plan');
  assert.equal(msg.providerState.items[0].signature, 'signature');
});

test('Chat reasoning_content and OpenRouter reasoning_details survive tool continuation only on the same target', async () => {
  for (const [t, fields] of [
    [target('deepseek-flash', 'openai-chat', 'deepseek'), { reasoning_content: 'Plan' }],
    [target('anthropic/claude-sonnet-4.6', 'openai-chat', 'openrouter'), { reasoning_details: [{ type: 'reasoning.summary', summary: 'Plan', index: 0 }, { type: 'reasoning.encrypted', data: 'secret', index: 1 }] }],
  ]) {
    const call = { id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } };
    const result = await chatOnce(t, opts, async () => Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call], ...fields }, finish_reason: 'tool_calls' }] }));
    assert.equal(result.reasoning_content, 'Plan');
    const messages = [...opts.messages, result, { role: 'tool', tool_call_id: 'call', content: 'result' }];
    const replay = requestBody(t, opts, messages, false).messages[1];
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(replay[key], value);
    for (const changed of [{ ...t, providerId: 'other' }, { ...t, model: 'other' }, { ...t, baseUrl: 'https://other.invalid/v1' }]) {
      const replay = requestBody(changed, opts, messages, false).messages[1];
      assert.equal(replay.reasoning_content, undefined);
      assert.equal(replay.reasoning_details, undefined);
    }
  }
});

test('Gemini streamed tool thought_signature is retained but not leaked on model switch', async () => {
  const t = target('gemini-3-flash-preview', 'openai-chat', 'google');
  const signature = { google: { thought_signature: 'signed' } };
  const chunks = [
    { choices: [{ delta: { reasoning: 'Plan', tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: 'read', arguments: '{}' }, extra_content: signature }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  ];
  const msg = await chatStream(t, opts, undefined, undefined, undefined, async () => sse(chunks));
  const messages = [...opts.messages, msg, { role: 'tool', tool_call_id: 'call', content: 'result' }];
  assert.equal(msg.reasoning_content, 'Plan');
  assert.deepEqual(requestBody(t, opts, messages, false).messages[1].tool_calls[0].extra_content, signature);
  assert.ok(!JSON.stringify(requestBody({ ...t, model: 'other' }, opts, messages, false)).includes('signed'));
});

test('OpenRouter streamed encrypted details are retained, never displayed', async () => {
  const t = target('anthropic/claude-sonnet-4.6', 'openai-chat', 'openrouter');
  const chunks = [
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'Pl', index: 0 }, { type: 'reasoning.encrypted', data: 'sec', index: 1 }] } }] },
    { choices: [{ delta: { reasoning_details: [{ type: 'reasoning.summary', summary: 'an', index: 0 }, { type: 'reasoning.encrypted', data: 'ret', index: 1 }], content: 'Answer' }, finish_reason: 'stop' }] },
  ];
  const msg = await chatStream(t, opts, undefined, undefined, undefined, async () => sse(chunks));
  assert.equal(msg.reasoning_content, 'Plan');
  assert.equal(msg.providerState.items[0].reasoning_details[1].data, 'secret');
});

test('old metadata caches are invalidated, not mistaken for disabled reasoning', () => {
  configureModelMetaStorage({ getItem: () => JSON.stringify({ version: MODEL_META_CACHE_VERSION - 1, models: { test: {} } }), setItem: () => {} });
  assert.equal(getModelMeta('test', 'test').declaredReasoning, undefined);
  assert.equal(getModelMeta('test', 'test').thinking, null);
});

test('Chat reasoning aliases select the first nonempty field, with identical JSON/SSE continuation', async () => {
  const t = target('deepseek-flash', 'openai-chat', 'deepseek');
  for (const fields of [
    { reasoning_content: '', reasoning: 'Plan', reasoning_text: 'duplicate' },
    { reasoning_content: '', reasoning: '', reasoning_text: 'Plan' },
    { reasoning_content: 'Plan', reasoning: 'duplicate', reasoning_text: 'duplicate' },
  ]) {
    const once = await chatOnce(t, opts, async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Answer', ...fields }, finish_reason: 'stop' }] }));
    const thoughts = [];
    const streamed = await chatStream(t, opts, undefined, x => thoughts.push(x), undefined,
      async () => sse([{ choices: [{ delta: { content: 'Answer', ...fields }, finish_reason: 'stop' }] }]));
    assert.equal(once.reasoning_content, 'Plan');
    assert.equal(streamed.reasoning_content, 'Plan');
    assert.equal(thoughts.join(''), 'Plan');
    assert.deepEqual(once.providerState, streamed.providerState);
    const changed = requestBody({ ...t, model: 'other' }, opts, [...opts.messages, once], false);
    assert.doesNotMatch(JSON.stringify(changed), /Plan|duplicate|reasoning_text/);
  }
});

test('OpenRouter details preserve type, id and order even when indexes collide', async () => {
  const t = target('anthropic/claude-sonnet-4.6', 'openai-chat', 'openrouter');
  const chunks = [
    { choices: [{ delta: { reasoning_details: [
      { type: 'reasoning.summary', summary: 'Pl', index: 0 },
      { type: 'reasoning.encrypted', id: 'first', data: 'sec', index: 0 },
      { type: 'reasoning.encrypted', id: 'second', data: 'opaque', index: 0 },
    ] } }] },
    { choices: [{ delta: { content: 'Answer', reasoning_details: [
      { type: 'reasoning.summary', summary: 'an', index: 0 },
      { type: 'reasoning.encrypted', id: 'first', data: 'ret', index: 0 },
    ] }, finish_reason: 'stop' }] },
  ];
  const thoughts = [];
  const msg = await chatStream(t, opts, undefined, x => thoughts.push(x), undefined, async () => sse(chunks));
  assert.equal(thoughts.join(''), 'Plan');
  assert.deepEqual(msg.providerState.items[0].reasoning_details, [
    { type: 'reasoning.summary', summary: 'Plan', index: 0 },
    { type: 'reasoning.encrypted', id: 'first', data: 'secret', index: 0 },
    { type: 'reasoning.encrypted', id: 'second', data: 'opaque', index: 0 },
  ]);
});

test('Responses final tool arguments reconcile added, delta, arguments.done and item.done without duplication', async () => {
  const t = target('gpt-5.2', 'openai-responses');
  const item = { type: 'function_call', id: 'fc_1', call_id: 'call', name: 'read', arguments: '{"path":"x"}' };
  const added = { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '' } };
  const terminal = { type: 'response.completed', response: { status: 'completed', output: [item] } };
  for (const chunks of [
    [terminal],
    [added, { type: 'response.function_call_arguments.done', output_index: 0, arguments: item.arguments }, terminal],
    [added, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' }, { type: 'response.output_item.done', output_index: 0, item }, terminal],
    [{ type: 'response.output_item.added', output_index: 0, item }, { type: 'response.output_item.done', output_index: 0, item }, terminal],
  ]) {
    const updates = [];
    const streamed = await chatStream(t, opts, undefined, undefined, call => updates.push(call), async () => sse(chunks));
    const once = await chatOnce(t, opts, async () => Response.json(terminal.response));
    assert.deepEqual(streamed.tool_calls, once.tool_calls);
    assert.deepEqual(updates.at(-1), { index: 0, id: 'call', name: 'read', arguments: item.arguments });
    assert.equal(streamed.finish_reason, 'tool_calls');
    const history = [...opts.messages, streamed, { role: 'tool', tool_call_id: 'call', content: 'result' }];
    assert.deepEqual(requestBody(t, opts, history, false).input.slice(-2), [item, { type: 'function_call_output', call_id: 'call', output: 'result' }]);
  }
});

test('Responses completion cannot authorize unfinished tools or substitute a generic DONE for a terminal event', async () => {
  const t = { ...target('gpt-5.2', 'openai-responses'), gatewayManaged: true };
  const added = { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call', name: 'read', arguments: '' } };
  const delta = { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"path":' };
  await assert.rejects(() => chatStream(t, opts, undefined, undefined, undefined, async () => sse([
    added, delta, { type: 'response.completed', response: { status: 'completed', output: [] } },
  ])), /未完成.*工具|工具.*未完成/);
  await assert.rejects(() => chatStream(t, opts, undefined, undefined, undefined, async () => new Response(
    `data: ${JSON.stringify(added)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } },
  )), /完成标记/);
  await assert.rejects(() => chatStream(t, opts, undefined, undefined, undefined, async () => sse([
    { type: 'response.failed', response: { status: 'failed', error: { code: 'upstream_error', message: 'fixture failure' } } },
  ])), /fixture failure/);
});

test('Claude block starts retain initial text/tool input, and JSON deltas replace the initial empty object', async () => {
  const t = target('claude-sonnet-4-6', 'anthropic-messages');
  for (const fragmented of [false, true]) {
    const chunks = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Ready' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'read', input: fragmented ? {} : { path: 'x' } } },
      ...(fragmented ? [{ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"x"}' } }] : []),
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' },
    ];
    const deltas = [];
    const msg = await chatStream(t, opts, x => deltas.push(x), undefined, undefined, async () => sse(chunks));
    assert.equal(msg.content, 'Ready');
    assert.equal(deltas.join(''), 'Ready');
    assert.equal(msg.tool_calls[0].function.arguments, '{"path":"x"}');
    assert.deepEqual(msg.providerState.items[1].input, { path: 'x' });
  }
});
