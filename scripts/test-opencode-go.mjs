import assert from 'node:assert/strict';
import { test } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelGateway } from '../apps/api/src/agent/model-gateway.ts';
import { ModelAdapter } from '../apps/api/src/agent/model-adapter.ts';
import { ModelTargetResolver } from '../apps/api/src/agent/model-target-resolver.ts';
import { ModelCircuitBreaker } from '../apps/api/src/agent/model-circuit-breaker.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { modelUsage, usageCollector } from '../packages/study-core/src/api/usage.ts';

// Ephemeral test credential; no real credential/environment is read by fixtures.
const secret = crypto.randomUUID();
const ref = { providerId: 'opencode-go', model: 'dynamic-fixture-id' };
const provider = { id: ref.providerId, name: 'OpenCode Go', protocol: 'openai-chat', baseUrl: 'https://ignored.invalid', apiKey: secret, catalogId: '', serves: ['chat'], dataPolicy: 'eu-no-training-zdr', deployments: [{ model: ref.model, protocol: 'openai-chat', dataPolicy: 'eu-no-training-zdr', allowFallback: true }] };
const input = { owner: 'fixture-owner', purpose: 'bot', conversationId: 'conversation-one', messages: [{ role: 'user', content: 'fixture' }], signal: new AbortController().signal };
const reply = () => Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0, opencode: { allowance: 0.012, billing_source: 'go', list_cost: 0.02 } } });
function setup(fetcher, change = {}) {
  const config = { providers: [structuredClone(provider), { ...provider, id: 'backup', baseUrl: 'https://backup.invalid/v1', deployments: undefined }], llmModel: ref, visionModel: { model: '' }, modelPresets: [{ id: 'go', name: 'Go', purposes: ['bot'], candidates: [{ ref }, { ref: { ...ref, providerId: 'backup' } }], policy: { maxAttemptsPerCandidate: 1 } }], modelRoutes: { byPurpose: { bot: 'go' } } };
  Object.assign(config, change);
  const settlements = [], reserves = [];
  const ledger = { model: () => ({ contextTokens: 100000, outputTokens: 4096 }), limits: () => ({ contextTokens: 100000 }), reserve(a) { reserves.push(a); return String(reserves.length); }, settle(id, status, usage) { settlements.push({ id, status, usage }); return false; }, checkAdmission() {} };
  return { config, settlements, reserves, gateway: new ModelGateway(new ModelTargetResolver(() => config), ledger, fetcher, { circuit: new ModelCircuitBreaker(), sleep: async () => {} }) };
}
for (const [protocol, endpoint, body] of [
  ['openai-chat', 'chat/completions', { choices: [{ message: { content: 'ok' } }] }],
  ['openai-responses', 'responses', { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }] }],
  ['anthropic-messages', 'messages', { content: [{ type: 'text', text: 'ok' }] }],
]) test(`Go ${protocol}: fixed endpoint, own UA, stable owner-scoped session across logical calls`, async () => {
  const headers = [];
  const state = setup(async (url, init) => {
    assert.equal(url, `https://opencode.ai/inference/go/${protocol === 'anthropic-messages' ? 'anthropic' : 'openai'}/v1/${endpoint}`);
    assert.equal(init.headers.authorization, `Bearer ${secret}`); assert.equal(init.headers['user-agent'], 'wangke-model-gateway/0.1');
    assert.equal(init.redirect, 'error'); headers.push(init.headers['x-opencode-session']); return Response.json(body);
  });
  state.config.providers[0].deployments[0].protocol = protocol;
  await state.gateway.request(input); await state.gateway.request({ ...input, run: 'different-run' });
  await state.gateway.request({ ...input, conversationId: 'conversation-two' });
  await state.gateway.request({ ...input, owner: 'other-owner' });
  assert.equal(headers[0], headers[1]); assert.notEqual(headers[0], headers[2]); assert.notEqual(headers[0], headers[3]);
  assert.doesNotMatch(headers[0], /conversation-one/);
});
test('Go native selected model overrides untrusted wire model before accounting and transport', async () => {
  const state = setup(async (_url, init) => { assert.equal(JSON.parse(init.body).model, ref.model); return reply(); });
  const response = await state.gateway.forward({ ...input, modelRef: ref, endpoint: 'chat/completions', body: JSON.stringify({ model: 'untrusted-model', messages: [] }), attribution: { run: 'fixture-run' } });
  await response.text(); assert.equal(state.reserves[0].model, ref.model); assert.equal(state.settlements.length, 1);
});
test('Go discovery is dynamic, official and independent of inference session; Google native is rejected', async () => {
  const state = setup(async (url, init) => { assert.equal(url, 'https://opencode.ai/inference/go/v1/models'); assert.equal(init.method, 'GET'); return Response.json({ data: [{ id: 'new-live-model' }] }); });
  const response = await state.gateway.forward({ ...input, modelRef: ref, endpoint: 'models' });
  assert.equal((await response.json()).data[0].id, 'new-live-model'); assert.equal(state.reserves.length, 0);
  await assert.rejects(state.gateway.forward({ ...input, modelRef: ref, endpoint: 'google/v1beta/models/test' }), /model_protocol_mismatch/);
});
test('Go 429 falls back only within explicit policy; quota/auth/unknown model do not', async () => {
  const state = setup(async url => url.includes('opencode.ai') ? Response.json({}, { status: 429 }) : reply());
  assert.equal((await state.gateway.request(input)).providerId, 'backup');
  for (const [status, code, expected] of [[429, 'insufficient_quota', 'quota_exhausted'], [402, '', 'quota_exhausted'], [401, '', 'auth_failed'], [403, '', 'auth_failed'], [404, '', 'model_not_found']]) {
    const s = setup(async () => Response.json({ error: { code } }, { status }));
    await assert.rejects(s.gateway.request(input), e => e.errorClass === expected); assert.equal(s.reserves.length, 1);
  }
  for (const change of [p => { p.deployments[0].allowFallback = false; }, p => { p.deployments[0].dataPolicy = 'global-training-retained'; }, p => { p.deployments = undefined; p.dataPolicy = undefined; }]) {
    const s = setup(async () => Response.json({}, { status: 429 })); change(s.config.providers[0]);
    await assert.rejects(s.gateway.request(input)); assert.equal(s.reserves.length, 1, 'no silent policy crossing');
  }
});
test('Go missing conversation fails before network; retries retain session', async () => {
  let count = 0; const seen = [];
  const state = setup(async (_url, init) => { seen.push(init.headers['x-opencode-session']); return ++count === 1 ? Response.json({}, { status: 429 }) : reply(); });
  state.config.modelPresets[0].policy.maxAttemptsPerCandidate = 2;
  await assert.rejects(state.gateway.request({ ...input, conversationId: undefined })); assert.equal(count, 0);
  const result = await state.gateway.request(input); assert.equal(count, 2); assert.equal(seen[0], seen[1]);
  assert.equal(result.usage.billing.allowanceUsd, 0.012); assert.equal(result.usage.billing.chargedUsd, 0);
});
test('Go native first bytes never replay; cumulative stream allowance stays separate', async () => {
  let count = 0;
  const state = setup(async () => { count++; return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[]}\n\n')); }, pull(c) { c.error(new Error('private-upstream')); } }), { headers: { 'content-type': 'text/event-stream' } }); });
  const response = await state.gateway.forward({ ...input, modelRef: ref, endpoint: 'chat/completions', body: JSON.stringify({ model: ref.model, messages: [] }), attribution: { run: 'fixture-run' } });
  await assert.rejects(response.text()); assert.equal(count, 1);
  const collector = usageCollector();
  collector.observe({ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3, cost: 0, opencode: { allowance: 0.3, billing_source: 'go' } } } });
  assert.equal(collector.value.billing.allowanceUsd, 0.3);
  assert.equal(modelUsage({ usage: { prompt_tokens: 2, completion_tokens: 3, opencode: { allowance: -1 } } }).billing, undefined);
});
for (const [protocol, endpoint, events] of [
  ['openai-chat', 'chat/completions', [{ usage: { prompt_tokens: 2, completion_tokens: 3, cost: 0, opencode: { allowance: 0.12, billing_source: 'go' } } }]],
  ['openai-responses', 'responses', [{ type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 3, cost: 0, opencode: { allowance: 0.12, billing_source: 'go' } } } }]],
  ['anthropic-messages', 'messages', [{ type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } }, { type: 'message_delta', usage: { output_tokens: 3, cost: 0, opencode: { allowance: 0.12, billing_source: 'go' } } }]],
]) test(`Go ${protocol}: native SSE billing settles once without adding allowance to tokens`, async () => {
  const wire = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const state = setup(async () => new Response(wire, { headers: { 'content-type': 'text/event-stream' } }));
  state.config.providers[0].deployments[0].protocol = protocol;
  const response = await state.gateway.forward({ ...input, modelRef: ref, endpoint, body: JSON.stringify({ model: ref.model, messages: [], input: [] }), attribution: { run: 'fixture-run' } });
  assert.equal(await response.text(), wire); assert.equal(state.settlements.length, 1);
  assert.equal(state.settlements[0].usage.billing.allowanceUsd, 0.12);
  assert.equal(state.settlements[0].usage.input, 2); assert.equal(state.settlements[0].usage.output, 3);
});
test('Go environment credential is key-only, never persisted or returned; metadata audit is single-settled', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'go-config-')), store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const old = process.env.OPENCODE_GO_API_KEY;
  try {
    process.env.OPENCODE_GO_API_KEY = secret;
    for (const owner of [input.owner, 'other-owner']) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, 'fixture', new Date().toISOString());
    const config = new CloudConfiguration(store, directory);
    for (const owner of [input.owner, 'other-owner']) config.save(owner, { ...config.get(owner), providers: [{ ...provider, apiKey: undefined }], llmModel: ref });
    assert.equal(config.get(input.owner, true).providers[0].apiKey, secret); assert.equal(config.get('other-owner', true).providers[0].apiKey, secret);
    assert.doesNotMatch(JSON.stringify(config.get(input.owner)), new RegExp(secret));
    assert.equal(config.get(input.owner).providers[0].keyHint, `••••${secret.slice(-4)}`, 'environment keys have the same safe display hint');
    const row = store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(input.owner);
    assert.ok(!config.open(row.value).includes(secret));
    const { createModelGateway } = await import('../apps/api/src/agent/model-gateway-factory.ts');
    const gateway = createModelGateway(store, config, async () => reply());
    await gateway.request({ ...input, purpose: 'chat', modelRef: ref });
    const metrics = store.db.prepare("SELECT detail FROM cloud_audit WHERE owner_id=? AND action='model.metric'").all(input.owner);
    assert.equal(metrics.length, 1); assert.equal(JSON.parse(metrics[0].detail).providerBilling.allowanceUsd, 0.012);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n, 1);
    assert.doesNotMatch(JSON.stringify(metrics), new RegExp(secret));
    const { default: Fastify } = await import('fastify');
    const { registerCloudRoutes } = await import('../apps/api/src/cloud/routes.ts');
    const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
    const app = Fastify(), seen = [];
    registerCloudRoutes(app, { store, configuration: config, records: new CloudRecords(store), filesDir: directory, maxFileBytes: 1024, requireAuth: () => ({ id: input.owner }), checkOrigin: () => true,
      fetch: async (url, init) => { seen.push({ url, init }); return url.endsWith('/models') ? Response.json({ data: [{ id: 'new-model' }] }) : reply(); } });
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/cloud/model-gateway/providers/opencode-go/chat/completions', headers: { authorization: 'Bearer attacker', 'x-opencode-session': 'attacker-session', 'user-agent': 'attacker-sdk', 'x-wangke-conversation': 'stable-http-session' }, payload: { model: ref.model, messages: [] } });
      assert.equal(response.statusCode, 200); assert.equal(seen[0].init.headers.authorization, `Bearer ${secret}`);
      assert.notEqual(seen[0].init.headers['x-opencode-session'], 'attacker-session'); assert.equal(seen[0].init.headers['user-agent'], 'wangke-model-gateway/0.1');
      const discovery = await app.inject({ method: 'GET', url: '/api/v1/cloud/model-gateway/providers/opencode-go/models' });
      assert.equal(discovery.json().data[0].id, 'new-model');
      const status = await app.inject({ method: 'GET', url: '/api/v1/cloud/model-gateway/status' });
      assert.equal(status.json().recentUsage.length, 2); assert.doesNotMatch(status.body, new RegExp(secret));
    } finally { await app.close(); }
  } finally {
    if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old;
    store.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('Go saved accounts are encrypted, switchable and never exposed to the client', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'go-accounts-')), store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const old = process.env.OPENCODE_GO_API_KEY; delete process.env.OPENCODE_GO_API_KEY;
  try {
    const configuration = new CloudConfiguration(store, directory), owner = 'account-owner';
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
    const base = configuration.get(owner);
    let saved = configuration.save(owner, { ...base, providers: [{ ...provider, apiKey: undefined }] });
    saved = configuration.addProviderAccount(owner, 'opencode-go', { name: '主 Key', apiKey: 'go-key-a', modelRevision: saved.modelRevision });
    saved = configuration.addProviderAccount(owner, 'opencode-go', { name: '备用 Key', apiKey: 'go-key-b', modelRevision: saved.modelRevision });
    const view = configuration.get(owner);
    assert.equal(view.providers[0].accounts?.length, 2);
    assert.equal(view.providers[0].accounts?.every(account => !('apiKey' in account)), true);
    assert.ok(view.providers[0].accounts.every(account => account.keyHint === '••••（短密钥）'), 'short account keys are never revealed as suffixes');
    const backup = view.providers[0].accounts?.find(account => account.name === '备用 Key');
    assert.ok(backup);
    saved = configuration.activateProviderAccount(owner, 'opencode-go', backup.id, saved.modelRevision);
    const runtime = configuration.get(owner, true).providers[0];
    assert.equal(runtime.activeAccountId, backup.id);
    assert.equal(new ModelAdapter(runtime, ref.model).transport('chat/completions', { owner, conversationId: 'c' }).headers.authorization, 'Bearer go-key-b');
    const row = store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(owner);
    assert.doesNotMatch(row.value, /go-key-[ab]/);
    saved = configuration.addProviderAccount(owner, 'opencode-go', { name: '工作账号', apiKey: 'long-account-key-7xQ2', modelRevision: saved.modelRevision });
    const displayAccount = saved.providers[0].accounts.find(account => account.name === '工作账号');
    assert.equal(displayAccount.keyHint, '••••7xQ2');
    assert.equal('apiKey' in displayAccount, false);
    assert.ok(!JSON.stringify(saved).includes('long-account-key-7xQ2'));
  } finally {
    if (old === undefined) delete process.env.OPENCODE_GO_API_KEY; else process.env.OPENCODE_GO_API_KEY = old;
    store.close(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('Gateway rollout kill switch cannot bypass the Gateway or reach upstream', async () => {
  const previous = process.env.MODEL_GATEWAY_DISABLED_PURPOSES;
  try { process.env.MODEL_GATEWAY_DISABLED_PURPOSES = 'bot'; const state = setup(async () => { assert.fail('network disabled'); }); await assert.rejects(state.gateway.request(input)); assert.equal(state.reserves.length, 0); }
  finally { if (previous === undefined) delete process.env.MODEL_GATEWAY_DISABLED_PURPOSES; else process.env.MODEL_GATEWAY_DISABLED_PURPOSES = previous; }
});
