import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatOutputTokens, truncationRetryTokens } from '../apps/api/runtime/chat-output-budget.ts';
import { requestBody } from '@wangke/study-core/model/client';
import { boundedRequest } from '../apps/api/src/agent/request-budget.ts';
import { modelSettings } from '../apps/api/src/agent/model-settings.ts';
import { configureModelMetaStorage, MODEL_META_CACHE_VERSION, parseModelMeta } from '@wangke/study-core/model/meta';

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic-messages']) {
  const target = { providerId: 'fixture', baseUrl: 'https://fixture.example/v1', apiKey: '', model: 'test-model', catalogId: '', protocol };
  const endpoint = protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions';
  const limits = { contextTokens: 64000, outputTokens: 32768 };
  test(`${protocol}: use the saved output ceiling instead of 8192`, () => {
    const options = { messages: [{ role: 'user', content: '画一个交互图' }] };
    assert.equal(chatOutputTokens(target, options, limits), 32768);
    assert.equal(chatOutputTokens(target, options, { ...limits, outputTokens: 4096 }), 4096, 'smaller models keep their real ceiling');
  });
  test(`${protocol}: recalculate remaining context with tool results and schemas`, () => {
    const options = { messages: [{ role: 'user', content: 'x'.repeat(40000) }],
      tools: [{ type: 'function', function: { name: 'fixture', description: 'd'.repeat(2000), parameters: { type: 'object' } } }] };
    const output = chatOutputTokens(target, options, limits);
    assert.ok(output > 0 && output < limits.outputTokens);
    const wire = requestBody(target, { ...options, max_tokens: output }, options.messages, true);
    assert.ok(boundedRequest(wire, endpoint, limits.outputTokens).total <= limits.contextTokens - 1000);
    const withoutSchema = chatOutputTokens(target, { messages: options.messages }, limits);
    assert.ok(output < withoutSchema, 'tool definitions consume context too');
    const later = { ...options, messages: [...options.messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'read-1', type: 'function', function: { name: 'fixture', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'read-1', content: 'r'.repeat(5000) }] };
    assert.ok(chatOutputTokens(target, later, limits) < output, 'later rounds leave less output room');
  });
  test(`${protocol}: reject an input that cannot fit even one output token`, () => {
    assert.throws(() => chatOutputTokens(target, { messages: [{ role: 'user', content: 'x'.repeat(64000) }] }, limits), /context_capacity_exceeded/);
  });
  test(`${protocol}: no one-token fallback when safety headroom exhausts context`, () => {
    const options = { messages: [{ role: 'user', content: 'x'.repeat(2000) }] };
    const input = boundedRequest(requestBody(target, { ...options, max_tokens: 8192 }, options.messages, true), endpoint, 8192).input;
    assert.throws(() => chatOutputTokens(target, options, { contextTokens: input + 1100, outputTokens: 8192 }), /context_capacity_exceeded/);
  });
}

test('truncation retry raises only once with known headroom, never inventing unknown model limits', () => {
  assert.equal(truncationRetryTokens(8192, 32768, 'model', 0), 16384);
  assert.equal(truncationRetryTokens(8192, 32768, 'configured', 0), 16384);
  assert.equal(truncationRetryTokens(8192, 32768, 'fallback', 0), undefined);
  assert.equal(truncationRetryTokens(8192, 8192, 'model', 0), undefined);
  assert.equal(truncationRetryTokens(8192, 32768, 'model', 1), undefined);
});

test('budget provenance distinguishes model declaration, user configuration and unknown fallback', () => {
  const store = { db: { prepare: () => ({ get: () => undefined }) } };
  const ref = { providerId: 'fixture', model: 'unknown-model' };
  configureModelMetaStorage({ getItem: () => null, setItem() {} });
  try {
    const fallback = modelSettings(store, 'owner', undefined, ref);
    assert.equal(fallback.outputTokens, 8192); assert.equal(fallback.outputSource, 'fallback');
    assert.equal(fallback.knownOutputTokens, undefined); assert.equal(fallback.contextSource, 'fallback');
    configureModelMetaStorage({ getItem: () => JSON.stringify({ version: MODEL_META_CACHE_VERSION, updatedAt: Date.now(), models: {
      'fixture\u0000unknown-model': parseModelMeta({ limit: { context: 100000, output: 24000 } }),
    } }), setItem() {} });
    const declared = modelSettings(store, 'owner', undefined, { ...ref, catalogId: 'fixture' });
    assert.equal(declared.outputTokens, 24000); assert.equal(declared.outputSource, 'model'); assert.equal(declared.contextSource, 'model');
    const configured = modelSettings(store, 'owner', undefined, { ...ref, capabilities: { maxOutputTokens: 4000, contextWindow: 32000 } });
    assert.equal(configured.outputTokens, 4000); assert.equal(configured.outputSource, 'configured'); assert.equal(configured.contextSource, 'configured');
  } finally { configureModelMetaStorage({ getItem: () => null, setItem() {} }); }
});
