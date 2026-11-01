import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelAdapter } from '../apps/api/src/agent/model-adapter.ts';

const fixtures = {
  'openai-chat': { choices: [{ finish_reason: 'tool_calls', message: { content: 'ready', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] } }] },
  'openai-responses': { status: 'completed', output: [{ type: 'reasoning', encrypted_content: 'opaque-fixture' }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ready' }] }, { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' }] },
  'anthropic-messages': { stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'fixture', signature: 'opaque-fixture' }, { type: 'text', text: 'ready' }, { type: 'tool_use', id: 'call-1', name: 'read', input: {} }] },
};
for (const [protocol, fixture] of Object.entries(fixtures)) {
  test(`${protocol}: text, tools, result, image and native continuation stay independent`, () => {
    const adapter = new ModelAdapter({ id: 'fixture', protocol, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-only-credential', catalogId: '', name: 'Fixture', serves: ['chat', 'vision'] }, 'fixture-model');
    const reply = adapter.decode(fixture);
    assert.equal(reply.text, 'ready');
    assert.equal(reply.calls[0].id, 'call-1');
    const messages = [{ role: 'user', content: 'fixture' }, { role: 'assistant', content: reply.text, tool_calls: [{ id: 'local-1', provider_id: 'call-1', type: 'function', function: reply.calls[0].function }], response_items: reply.continuation }, { role: 'tool', content: 'fixture-result', tool_call_id: 'local-1' }];
    const native = adapter.encode({ messages, continuationRef: adapter.target });
    assert.match(JSON.stringify(native.body), /call-1/);
    assert.doesNotMatch(JSON.stringify(native.body), /local-1/);
    if (protocol !== 'openai-chat') assert.match(JSON.stringify(native.body), /opaque-fixture/);
    const portable = adapter.encode({ messages, continuationRef: { providerId: 'other', model: 'other' } });
    assert.doesNotMatch(JSON.stringify(portable.body), /opaque-fixture/);
    assert.match(JSON.stringify(portable.body), /fixture-result/);
    const image = adapter.encode({ messages: [{ role: 'user', content: 'fixture-question' }], image: { mime: 'image/png', data: 'AAAA' } });
    assert.match(JSON.stringify(image.body), /image/);
    assert.match(JSON.stringify(image.body), /fixture-question/);
    assert.doesNotMatch(JSON.stringify(adapter), /fixture-only-credential|fixture\.invalid/);
    assert.doesNotMatch(JSON.stringify(native), /fixture-only-credential/);
    const transport = adapter.transport(native.path);
    assert.match(transport.url, /^https:\/\/fixture\.invalid\/v1\//);
    assert.throws(() => adapter.transport('https://other.invalid'), /model_endpoint_not_found/);
  });
}
test('transport rejects credential-bearing, non-http and query-bearing saved URLs without echo', () => {
  for (const baseUrl of ['file:///fixture', 'https://user:password@fixture.invalid', 'https://fixture.invalid?secret=fixture']) {
    const adapter = new ModelAdapter({ id: 'fixture', protocol: 'openai-chat', baseUrl, catalogId: '', name: 'Fixture', serves: ['chat'] }, 'fixture');
    assert.throws(() => adapter.transport('chat/completions'), { message: 'invalid_provider_url' });
  }
});
