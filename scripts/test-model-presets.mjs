import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { validateModelPresets } from '../apps/api/src/cloud/model-presets.ts';
const ref = { providerId: 'fixture', model: 'fixture-model' };
const preset = { id: 'named', name: 'Named', purposes: ['bot'], candidates: [{ ref }] };
test('Preset migration, encrypted restart persistence, CAS and deletion are atomic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-presets-'));
  const store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  try {
    store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run('owner', 'fixture', new Date().toISOString());
    let configuration = new CloudConfiguration(store, directory);
    let config = configuration.save('owner', { ...configuration.get('owner'), providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture-secret', protocol: 'openai-chat', catalogId: '', serves: ['chat'] }], llmModel: ref });
    assert.ok(config.modelPresets.some(p => p.id === 'builtin-bot'));
    const oldRevision = config.modelRevision;
    config = configuration.saveModels('owner', { ...config, modelPresets: [...config.modelPresets, preset], modelRoutes: { byPurpose: { bot: 'named' } } });
    assert.notEqual(config.modelRevision, oldRevision);
    configuration = new CloudConfiguration(store, directory);
    assert.equal(configuration.get('owner').modelRoutes.byPurpose.bot, 'named');
    assert.doesNotMatch(JSON.stringify(config), /fixture-secret/);
    assert.doesNotMatch(store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get('owner').value, /fixture-secret|fixture-model/);
    assert.throws(() => configuration.saveModels('owner', { ...config, modelRevision: oldRevision }), e => e.status === 409);
    assert.throws(() => configuration.saveModels('owner', { ...config, providers: [], llmModel: { providerId: '', model: '' } }), /invalid_model_presets/);
    assert.equal(configuration.get('owner').providers.length, 1);
    assert.throws(() => configuration.saveModels('owner', { ...config, modelPresets: config.modelPresets.filter(p => p.id !== 'named') }), /invalid_model_presets/);
    assert.equal(configuration.get('owner').modelRevision, config.modelRevision);
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
test('Preset validation rejects empty, malformed, dangling and disabled-only candidates', () => {
  const base = { providers: [{ id: 'fixture' }], llmModel: ref, visionModel: {}, asrModel: {} };
  for (const value of [null, {}, { ...preset, candidates: [] }, { ...preset, candidates: [null] }, { ...preset, candidates: [{ ref, enabled: false }] }, { ...preset, policy: 'wrong' }, { ...preset, candidates: [{ ref: { ...ref, providerId: 'missing' } }] }]) {
    assert.throws(() => validateModelPresets({ ...base, modelPresets: [value] }));
  }
  assert.throws(() => validateModelPresets({ ...base, modelPresets: [preset], modelRoutes: { byPurpose: { vision: 'named' } } }));
});
