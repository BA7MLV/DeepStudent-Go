import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import * as browserModels from '../apps/web/src/api/siliconflow.ts';
import * as decision from '../apps/web/src/api/typesafe.ts';
import { cloud } from '../apps/web/src/cloud/state.ts';
import { accountLifecycle, accountLifetime } from '../apps/web/src/client/account-lifecycle.ts';

globalThis.location = new URL('https://application.invalid/study');
const target = { providerId: 'saved-provider', baseUrl: 'https://untrusted-provider.invalid/v1', apiKey: 'must-never-leave-browser', model: 'saved-asr', catalogId: '', protocol: 'openai-chat' };
const originalFetch = globalThis.fetch;
test.afterEach(() => { globalThis.fetch = originalFetch; accountLifecycle.invalidate(); cloud.enabled = false; cloud.userId = ''; });
const login = () => { cloud.enabled = true; cloud.userId = 'account-A'; };

test('browser exports contain data contracts/server transports, not a provider executor or systemone fallback', () => {
  assert.equal(browserModels.chatStream, undefined);
  assert.equal(browserModels.requestBody, undefined);
  assert.equal(browserModels.decodeResponse, undefined);
  assert.equal(decision.evaluateNouls, undefined);
  assert.equal(browserModels.textOf({ content: [{ type: 'text', text: 'input ' }, { type: 'image_url', image_url: { url: 'data:input' } }, { type: 'text', text: 'display' }] }), 'input display');
  assert.equal(fs.existsSync(new URL('../apps/web/src/cloud/learning-products.ts', import.meta.url)), false);
  const module = fs.readFileSync(new URL('../apps/web/src/api/modelClient.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(module, /export\s+\*|\bfetch\s*\(/);
});

test('disabled server mode rejects instead of invoking a direct provider or a local task', async () => {
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('unexpected network'); };
  await assert.rejects(browserModels.chatOnce(target, { messages: [] }), /server_model_task_required/);
  await assert.rejects(browserModels.transcribe(target, new Blob(['input'])), /server_voice_input_required/);
  await assert.rejects(browserModels.listModelDetails(target), /server_model_connection_required/);
  assert.equal(calls, 0);
});

test('discovery rejects arbitrary provider URLs before network and uses only authenticated server pagination', async () => {
  login(); const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return Response.json(calls.length === 1 ? { data: [{ id: 'model-B' }], has_more: true, last_id: 'page token' } : { data: [{ id: 'model-A' }, { id: 'model-B' }] });
  };
  await assert.rejects(browserModels.listModelDetails(target), /server_model_connection_required/);
  assert.equal(calls.length, 0);
  const models = await browserModels.listModels({ ...target, baseUrl: '/api/v1/cloud/models/saved-provider' });
  assert.deepEqual(models, ['model-A', 'model-B']);
  assert.equal(calls[0].url, '/api/v1/cloud/model-gateway/providers/saved-provider/models');
  assert.equal(calls[1].url, '/api/v1/cloud/model-gateway/providers/saved-provider/models?after_id=page%20token');
  for (const { init } of calls) { assert.equal(init.credentials, 'include'); assert.equal(init.redirect, 'error'); assert.equal(init.headers, undefined); }
});

test('microphone Blob stays intact, uses saved server ASR and never forwards provider keys/URLs', async () => {
  login(); let submitted;
  globalThis.fetch = async (url, init) => { submitted = { url, init }; return Response.json({ text: 'voice input', duration: 1, segments: [{ start: 0, end: 1, text: ' voice input ' }, { start: 4, end: 2, text: 'bad' }] }); };
  const input = new Blob(['original microphone bytes'], { type: 'audio/wav' });
  const result = await browserModels.transcribe(target, input, 'microphone.wav');
  assert.equal(submitted.url, '/api/v1/cloud/model-gateway/providers/saved-provider/audio/transcriptions');
  assert.equal(submitted.init.credentials, 'include');
  assert.equal(submitted.init.headers, undefined);
  assert.equal(submitted.init.body.get('model'), target.model);
  assert.equal(await submitted.init.body.get('file').text(), 'original microphone bytes');
  assert.equal(submitted.init.body.get('file').name, 'microphone.wav');
  assert.deepEqual(result, { text: 'voice input', duration: 1, segments: [{ start: 0, end: 1, text: 'voice input' }] });
});

test('late microphone response cannot enter a rebuilt same-account lifetime', async () => {
  login(); let release, capturedSignal;
  globalThis.fetch = async (_url, init) => { capturedSignal = init.signal; return { ok: true, json: () => new Promise(resolve => { release = () => resolve({ text: 'late old-account input' }); }) }; };
  const pending = browserModels.transcribe(target, new Blob(['input']));
  await Promise.resolve();
  accountLifecycle.invalidate(); const next = accountLifetime(cloud.userId);
  assert.equal(capturedSignal.aborted, true);
  release();
  await assert.rejects(pending, /client_account_changed/);
  assert.equal(next.current(), true);
});

test('ASR failure is not retried as a browser provider call', async () => {
  login(); let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: 'model_http_400' }, { status: 400 }); };
  await assert.rejects(browserModels.transcribe(target, new Blob(['input'])), error => error instanceof browserModels.ApiError && error.status === 400);
  assert.equal(calls, 1);
});
