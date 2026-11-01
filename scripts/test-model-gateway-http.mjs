import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { registerCloudRoutes } from '../apps/api/src/cloud/routes.ts';

test('HTTP Gateway: canonical/native isolation, route preview, ordinary metering and Preset CAS', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-http-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite')), app = Fastify();
  const previous = process.env.CLOUD_WORKER_DISABLED; process.env.CLOUD_WORKER_DISABLED = '1';
  try {
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'fixture', new Date().toISOString());
    const configuration = new CloudConfiguration(store, directory), calls = [];
    const ref = { providerId: 'fixture', model: 'fixture-model' };
    configuration.save('owner', { ...configuration.get('owner'), providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'private-fixture-key', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: ref });
    registerCloudRoutes(app, { store, configuration, records: new CloudRecords(store), filesDir: directory, maxFileBytes: 1024,
      requireAuth: (_request) => ({ id: 'owner' }), checkOrigin: () => true,
      fetch: async (url, init) => { calls.push({ url, init }); return Response.json({ choices: [{ finish_reason: 'stop', message: { content: 'private-fixture-output' } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }); },
    });
    const request = (url, payload, method = 'POST') => app.inject({ method, url: `/api/v1/cloud${url}`, ...(payload ? { payload } : {}) });
    let response = await request('/model-gateway/request', { purpose: 'chat', messages: [{ role: 'user', content: 'private-fixture-prompt' }] });
    assert.equal(response.statusCode, 200); assert.equal(response.json().providerId, 'fixture');
    assert.equal(calls[0].init.headers.authorization, 'Bearer private-fixture-key');
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n, 1);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM bot_requests').get().n, 0, 'ordinary requests never debit Bot budgets');
    for (const extras of [{ owner: 'other' }, { baseUrl: 'https://attacker.invalid' }, { headers: { authorization: 'attacker' } }]) {
      response = await request('/model-gateway/request', { purpose: 'chat', ...extras }); assert.equal(response.statusCode, 400);
    }
    assert.equal(calls.length, 1);
    response = await request('/model-gateway/preview', { purpose: 'bot' }); assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.body, /private-fixture-key|https:/); assert.equal(calls.length, 1);
    response = await request('/model-gateway/status', undefined, 'GET'); assert.equal(response.statusCode, 200);
    assert.ok(response.json().recentRoutes.length >= 2);
    assert.doesNotMatch(response.body, /private-fixture-(key|prompt|output)|https:/);
    const config = configuration.get('owner');
    const payload = { modelRevision: config.modelRevision, modelPresets: [...config.modelPresets, { id: 'named', name: 'Named', purposes: ['bot'], candidates: [{ ref }] }], modelRoutes: { byPurpose: { bot: 'named' } } };
    response = await request('/model-presets', { ...payload, modelRevision: undefined }, 'PUT'); assert.equal(response.statusCode, 400);
    response = await request('/model-presets', payload, 'PUT'); assert.equal(response.statusCode, 200);
    response = await request('/model-presets', payload, 'PUT'); assert.equal(response.statusCode, 409);
    response = await request('/model-gateway/preview', { purpose: 'bot' }); assert.equal(response.json().presetId, 'named');
    response = await request('/model-gateway/providers/fixture/chat/completions', { model: ref.model, messages: [{ role: 'user', content: 'fixture' }] });
    assert.equal(response.statusCode, 200); assert.equal(calls.length, 2);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM model_observations').get().n, 2);
  } finally { await app.close(); store.close(); if (previous === undefined) delete process.env.CLOUD_WORKER_DISABLED; else process.env.CLOUD_WORKER_DISABLED = previous; fs.rmSync(directory, { recursive: true, force: true }); }
});
