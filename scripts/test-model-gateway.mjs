import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelGateway } from '../apps/api/src/agent/model-gateway.ts';
import { ModelTargetResolver } from '../apps/api/src/agent/model-target-resolver.ts';
import { ModelCircuitBreaker } from '../apps/api/src/agent/model-circuit-breaker.ts';
import { BudgetBlocked } from '../apps/api/src/agent/budget.ts';
import { retryAfter } from '../apps/api/src/agent/model-client.ts';

const ref = id => ({ providerId: id, model: 'fixture-model' });
const config = () => ({ providers: ['primary', 'backup'].map(id => ({ id, name: id, baseUrl: `https://${id}.invalid/v1`, apiKey: 'fixture-only-credential', catalogId: '', serves: ['chat', 'vision'], protocol: 'openai-chat' })), llmModel: ref('primary'), visionModel: ref('primary'), asrModel: { providerId: '', model: '' }, policy: {}, modelPresets: [{ id: 'fixture', name: 'Fixture', purposes: ['bot'], candidates: [{ ref: ref('primary') }, { ref: ref('backup') }], policy: { maxAttemptsPerCandidate: 1, maxChainMs: 10000 } }], modelRoutes: { byPurpose: { bot: 'fixture' } } });
const reply = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'fixture-result' } }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
const input = () => ({ owner: 'fixture-owner', purpose: 'bot', messages: [{ role: 'user', content: 'fixture-input' }], signal: new AbortController().signal });
function setup(fetcher, settings = config(), options = {}) {
  const reserves = [], settlements = [], events = [];
  const ledger = { model: () => ({ contextTokens: 100000, outputTokens: 4096 }), limits: () => ({ contextTokens: 100000 }), reserve(a, attempt, tokens) { reserves.push({ ...a, attempt, tokens }); return String(reserves.length); }, settle(id, status, usage) { settlements.push({ id, status, usage }); return false; }, checkAdmission() {} };
  const gateway = new ModelGateway(new ModelTargetResolver(() => settings), ledger, fetcher, { circuit: new ModelCircuitBreaker(), sleep: async () => {}, event: e => events.push(e), ...options });
  return { gateway, reserves, settlements, events, ledger };
}
test('429 fallback is ordered, independently reserved and settled exactly once', async () => {
  const seen = [];
  const state = setup(async (url, init) => { seen.push(new URL(url).host); assert.equal(init.redirect, 'error'); return seen.length === 1 ? Response.json({}, { status: 429, headers: { 'retry-after': '0' } }) : reply(); });
  const result = await state.gateway.request(input());
  assert.deepEqual(seen, ['primary.invalid', 'backup.invalid']);
  assert.equal(result.providerId, 'backup'); assert.equal(result.continuationReusable, false);
  assert.deepEqual(result.attempts.map(a => a.outcome), ['failed', 'completed']);
  assert.equal(state.reserves.length, 2); assert.equal(state.settlements.length, 2);
  assert.doesNotMatch(JSON.stringify([result.attempts, state.events]), /fixture-only-credential|https:|fixture-input|fixture-result/);
});
test('auth, billing, invalid requests and missing models do not fallback', async () => {
  for (const [status, errorClass] of [[401, 'auth_failed'], [403, 'auth_failed'], [402, 'quota_exhausted'], [400, 'invalid_request'], [404, 'model_not_found']]) {
    const state = setup(async () => Response.json({}, { status }));
    await assert.rejects(state.gateway.request(input()), e => e.errorClass === errorClass);
    assert.equal(state.reserves.length, 1);
  }
  const quota = setup(async () => Response.json({ error: { code: 'insufficient_quota' } }, { status: 429 }));
  await assert.rejects(quota.gateway.request(input()), e => e.errorClass === 'quota_exhausted');
  assert.equal(quota.reserves.length, 1);
});
test('retry policy has one owner, respects Retry-After and keeps last error class', async () => {
  const settings = config(); settings.modelPresets[0].policy.maxAttemptsPerCandidate = 2;
  const waits = [], state = setup(async () => Response.json({}, { status: 503, headers: { 'retry-after': '0.25' } }), settings, { sleep: async ms => waits.push(ms) });
  await assert.rejects(state.gateway.request(input()), e => e.errorClass === 'server_error' && e.attempts.length === 4);
  assert.deepEqual(waits, [250, 250]);
  assert.equal(state.reserves.length, 4); assert.equal(state.settlements.length, 4);
  assert.equal(retryAfter('2', 0), 2000); assert.equal(retryAfter('Thu, 01 Jan 1970 00:00:03 GMT', 0), 3000);
});
test('budget block never falls back and cancellation is sanitized', async () => {
  const state = setup(async () => { throw new Error('must-not-send'); });
  state.ledger.reserve = () => { throw new BudgetBlocked('owner_daily_token_budget'); };
  await assert.rejects(state.gateway.request(input()), { code: 'owner_daily_token_budget' });
  const controller = new AbortController(); controller.abort(new Error('private-cancel-reason'));
  const cancelled = setup(async () => { throw new Error('must-not-send'); });
  await assert.rejects(cancelled.gateway.request({ ...input(), signal: controller.signal }), e => e.errorClass === 'cancelled' && !JSON.stringify(e).includes('private-cancel-reason'));
  assert.equal(cancelled.reserves.length, 0);
});
test('privacy and cross-provider controls fail closed', async () => {
  for (const restricted of ['policy', 'privacy']) {
    const settings = config();
    if (restricted === 'policy') settings.modelPresets[0].policy.allowCrossProvider = false;
    else settings.providers[1].dataPolicy = 'other-boundary';
    const state = setup(async () => Response.json({}, { status: 503 }), settings);
    await assert.rejects(state.gateway.request(input())); assert.equal(state.reserves.length, 1);
  }
});
test('native continuation is stripped when changing target, not portable tool history', async () => {
  const seen = [];
  const state = setup(async (_url, init) => { seen.push(JSON.parse(init.body)); return seen.length === 1 ? Response.json({}, { status: 503 }) : reply(); });
  await state.gateway.request({ ...input(), messages: [{ role: 'assistant', content: 'portable-fixture', response_items: [{ type: 'reasoning', encrypted_content: 'native-fixture' }] }, { role: 'user', content: 'next' }], sideEffectsOccurred: true });
  assert.match(JSON.stringify(seen[1]), /portable-fixture/); assert.doesNotMatch(JSON.stringify(seen[1]), /native-fixture/);
});
test('context admission can move to a larger candidate without sending the small one', async () => {
  const state = setup(async () => reply());
  state.ledger.model = (_owner, target) => ({ contextTokens: target.providerId === 'primary' ? 1 : 100000, outputTokens: 4096 });
  const result = await state.gateway.request(input());
  assert.equal(result.providerId, 'backup'); assert.equal(state.reserves.length, 1);
  assert.equal(result.attempts[0].errorClass, 'context_exceeded');
});
test('circuit TTL, single half-open probe, owner isolation and capacity', () => {
  let now = 1000;
  const circuit = new ModelCircuitBreaker(() => now, 2, 100, 20, 1);
  circuit.failure('owner-a'); assert.equal(circuit.enter('owner-a'), false); assert.equal(circuit.enter('owner-b'), true);
  now += 21; assert.equal(circuit.enter('owner-a'), true); assert.equal(circuit.enter('owner-a'), false);
  circuit.release('owner-a'); assert.equal(circuit.enter('owner-a'), true); circuit.success('owner-a'); assert.equal(circuit.enter('owner-a'), true);
  for (const key of ['a', 'b', 'c']) circuit.failure(key);
  assert.ok(circuit.snapshot().length <= 2); now += 101; assert.deepEqual(circuit.snapshot(), []);
});
test('explicit references validate provider, capability and exact private model id', () => {
  const resolver = new ModelTargetResolver(config);
  assert.equal(resolver.resolve({ ...input(), modelRef: { providerId: 'primary', model: 'private/model-v2' } }).candidates[0].adapter.target.model, 'private/model-v2');
  assert.throws(() => resolver.resolve({ ...input(), modelRef: ref('missing') }), /model_provider_not_found/);
  assert.throws(() => resolver.resolve({ ...input(), purpose: 'asr', modelRef: ref('primary') }), /model_capability_unavailable/);
  assert.throws(() => resolver.resolve({ ...input(), presetId: 'missing' }), /model_preset_not_found/);
});
const nativeInput = (extra = {}) => ({ owner: 'fixture-owner', purpose: 'bot', modelRef: ref('primary'), endpoint: 'chat/completions', body: JSON.stringify({ model: 'fixture-model', messages: [{ role: 'user', content: 'private-prompt' }] }), signal: new AbortController().signal, attribution: { run: 'fixture-run' }, ...extra });
test('native SSE preserves bytes and usage and never retries after a visible chunk', async () => {
  let requests = 0, controller;
  const state = setup(async () => { requests++; return new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"fixture"}}]}\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }); });
  const response = await state.gateway.forward(nativeInput());
  const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /fixture/);
  controller.error(new Error('https://secret.invalid/private fixture-only-credential'));
  await assert.rejects(reader.read(), e => e.message === 'model_connection_failed');
  assert.equal(requests, 1); assert.equal(state.reserves.length, 1);
});
test('native request cancellation releases an uncooperative fetch without leaking reason', async () => {
  const controller = new AbortController(); let requests = 0;
  const state = setup(async () => { requests++; controller.abort(new Error('private-cancel')); return new Promise(() => {}); });
  await assert.rejects(state.gateway.forward(nativeInput({ signal: controller.signal })), e => e.code === 'model_cancelled' && !JSON.stringify(e).includes('private-cancel'));
  assert.equal(requests, 1);
});
test('native one-shot audio uploads are attributed and never retried', async () => {
  const settings = config(); settings.providers[0].serves.push('asr');
  let requests = 0;
  const state = setup(async (_url, init) => { requests++; assert.equal(init.duplex, 'half'); assert.equal(init.body.get('model'), 'fixture-model'); assert.equal(init.headers['content-type'], undefined); throw new Error('private-provider-error'); }, settings);
  const form = new FormData(); form.set('file', new Blob(['fixture-audio'], { type: 'audio/wav' }), 'fixture.wav'); form.set('model', 'untrusted-upload-model');
  const upload = new Request('https://fixture.invalid', { method: 'POST', body: form });
  await assert.rejects(state.gateway.forward(nativeInput({ purpose: 'asr', endpoint: 'audio/transcriptions', body: upload.body, contentType: upload.headers.get('content-type') })), e => e.code === 'model_connection_failed');
  assert.equal(requests, 1); assert.equal(state.reserves.length, 1); assert.equal(state.settlements.length, 1);
});
test('native quota errors and protocol mismatches do not replay or leak provider body', async () => {
  let requests = 0;
  const state = setup(async () => { requests++; return Response.json({ error: { code: 'insufficient_quota', message: 'fixture-only-credential' } }, { status: 429 }); });
  const response = await state.gateway.forward(nativeInput());
  assert.equal(response.status, 402); assert.doesNotMatch(await response.text(), /fixture-only-credential/); assert.equal(requests, 1);
  await assert.rejects(state.gateway.forward(nativeInput({ endpoint: 'messages' })), /model_protocol_mismatch/); assert.equal(requests, 1);
});
test('ASR uses multipart at Gateway and reserves one physical request', async () => {
  const settings = config(); settings.providers[0].serves.push('asr');
  const state = setup(async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/audio/transcriptions'); assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('model'), 'fixture-model'); assert.equal(init.headers['content-type'], undefined);
    return Response.json({ text: 'fixture-transcription' });
  }, settings);
  const result = await state.gateway.request({ ...input(), purpose: 'asr', modelRef: ref('primary'), audio: { mime: 'audio/wav', data: Buffer.from('fixture').toString('base64') } });
  assert.equal(result.response.text, 'fixture-transcription'); assert.equal(state.reserves.length, 1); assert.equal(state.settlements.length, 1);
});
test('refusal, truncation and malformed protocol payloads have distinct safe classes', async () => {
  for (const [body, errorClass] of [[{ choices: [{ finish_reason: 'content_filter', message: {} }] }, 'content_policy'], [{ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }, 'incomplete_response'], [{ choices: 'malformed' }, 'incomplete_response']]) {
    const state = setup(async () => Response.json(body));
    await assert.rejects(state.gateway.request(input()), e => e.errorClass === errorClass);
    assert.equal(state.reserves.length, 1);
  }
});
test('per-model deployments select protocol and endpoint without changing connection credentials', async () => {
  const settings = config();
  settings.providers[0].deployments = [{ model: 'fixture-model', protocol: 'anthropic-messages', baseUrl: 'https://deployment.invalid/anthropic/v1' }];
  const state = setup(async (url, init) => {
    assert.equal(url, 'https://deployment.invalid/anthropic/v1/messages');
    assert.equal(init.headers['x-api-key'], 'fixture-only-credential'); assert.equal(init.headers.authorization, undefined);
    assert.ok(Array.isArray(JSON.parse(init.body).messages));
    return Response.json({ content: [{ type: 'text', text: 'fixture' }], stop_reason: 'end_turn' });
  }, settings);
  const result = await state.gateway.request(input());
  assert.equal(result.protocol, 'anthropic-messages');
  assert.doesNotMatch(JSON.stringify([result, state.events]), /deployment.invalid|fixture-only-credential/);
});
test('restricted deployment cannot enter fallback even inside one provider', async () => {
  const settings = config();
  settings.modelPresets[0].candidates[1].ref = { providerId: 'primary', model: 'restricted' };
  settings.providers[0].deployments = [{ model: 'restricted', protocol: 'openai-chat', allowFallback: false }];
  let requests = 0;
  const state = setup(async () => { requests++; return Response.json({}, { status: 503 }); }, settings);
  await assert.rejects(state.gateway.request(input())); assert.equal(requests, 1);
});
test('native complete SSE settles cumulative usage exactly once', async () => {
  const state = setup(async () => new Response('data: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }));
  const response = await state.gateway.forward(nativeInput());
  await response.text();
  assert.equal(state.reserves.length, 1); assert.equal(state.settlements.length, 1);
  assert.equal(state.settlements[0].usage.input, 2); assert.equal(state.settlements[0].usage.output, 3);
});
test('vision preserves partial text with truncation flag but never accepts filtered evidence', async () => {
  const state = setup(async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: 'partial evidence' } }] }));
  const result = await state.gateway.request({ ...input(), purpose: 'vision', modelRef: ref('primary') });
  assert.equal(result.response.text, 'partial evidence'); assert.equal(result.response.truncated, true);
  assert.equal(result.response.continuation, undefined);
  const filtered = setup(async () => Response.json({ choices: [{ finish_reason: 'content_filter', message: { content: 'filtered' } }] }));
  await assert.rejects(filtered.gateway.request({ ...input(), purpose: 'vision', modelRef: ref('primary') }), e => e.errorClass === 'content_policy');
});
test('native stream cancellation propagates upstream and never replays', async () => {
  let cancelled = 0, requests = 0;
  const state = setup(async () => { requests++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {}\n\n')); }, cancel() { cancelled++; } }), { headers: { 'content-type': 'text/event-stream' } }); });
  const reader = (await state.gateway.forward(nativeInput())).body.getReader();
  await reader.read(); await reader.cancel();
  assert.equal(requests, 1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});
test('native bounded attempt deadline interrupts a stalled success body without replay', async () => {
  const previous = process.env.MODEL_TIMEOUT_MS; process.env.MODEL_TIMEOUT_MS = '1000';
  let requests = 0;
  try {
    const state = setup(async () => { requests++; return new Response(new ReadableStream({}), { headers: { 'content-type': 'text/event-stream' } }); });
    const response = await state.gateway.forward(nativeInput());
    // Keep the event loop alive: AbortSignal.timeout's timer itself is unreferenced.
    const keepAlive = setInterval(() => {}, 100);
    try { await assert.rejects(response.text(), e => e.code === 'model_timeout'); }
    finally { clearInterval(keepAlive); }
    assert.equal(requests, 1);
  } finally { if (previous === undefined) delete process.env.MODEL_TIMEOUT_MS; else process.env.MODEL_TIMEOUT_MS = previous; }
});
test('native cancellation during Retry-After cannot expose the caller abort reason', async () => {
  const controller = new AbortController();
  const state = setup(async () => Response.json({}, { status: 503 }), config(), { sleep: async (_ms, signal) => { controller.abort(new Error('private-backoff-reason')); signal.throwIfAborted(); } });
  await assert.rejects(state.gateway.forward(nativeInput({ signal: controller.signal })), e => e.code === 'model_cancelled' && !JSON.stringify(e).includes('private-backoff-reason'));
  assert.equal(state.reserves.length, 1);
});
test('legacy explicit vision opt-in survives chat-only metadata without opening arbitrary candidates', () => {
  const settings = config(); settings.providers[0].serves = ['chat'];
  const resolver = new ModelTargetResolver(() => settings);
  assert.equal(resolver.resolve({ owner: 'fixture-owner', purpose: 'vision', modelRef: ref('primary') }).candidates[0].adapter.target.model, 'fixture-model');
  assert.throws(() => resolver.resolve({ owner: 'fixture-owner', purpose: 'vision', modelRef: { providerId: 'primary', model: 'not-the-saved-vision' } }), /model_capability_unavailable/);
});
for (const [protocol, endpoint, events] of [
  ['openai-responses', 'responses', [{ type: 'response.output_text.delta', delta: 'fixture' }, { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3 } } }]],
  ['anthropic-messages', 'messages', [{ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } }, { type: 'content_block_delta', delta: { type: 'text_delta', text: 'fixture' } }, { type: 'message_delta', usage: { output_tokens: 3 } }]],
]) test(`${protocol}: native SSE bytes and terminal usage survive the Gateway unchanged`, async () => {
  const settings = config(); settings.providers[0].protocol = protocol;
  const wire = events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  const state = setup(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }), settings);
  const response = await state.gateway.forward(nativeInput({ endpoint }));
  assert.equal(await response.text(), wire);
  assert.equal(state.reserves.length, 1); assert.equal(state.settlements.length, 1);
  assert.equal(state.settlements[0].usage.input, 2); assert.equal(state.settlements[0].usage.output, 3);
});
