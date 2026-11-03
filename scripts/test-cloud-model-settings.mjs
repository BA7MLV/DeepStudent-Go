import assert from 'node:assert/strict';
import { createCloudModelDraft, cloudModelConfig, cloudModelPreferences, cloudDiscoveryProviders, cloudModelUpdate, cloudModelsDirty, cloudProviderDirty } from '../apps/web/src/cloud/modelSettings.ts';
import { useSettings, targetOfSlot, targetOrNull } from '../apps/web/src/store/settings.ts';
import { DEFAULT_AGENT_POLICY } from '../packages/contracts/src/cloud.ts';
import { applyCloudConfig } from '../apps/web/src/cloud/sync.ts';
import { requestBody } from '@wangke/study-core/model/client';

const config = {
  providers: [{ id: 'p1', name: 'Test', baseUrl: 'https://models.example/v1', protocol: 'openai-chat', configured: true, catalogId: 'test', serves: ['chat'] }],
  llmModel: { providerId: 'p1', model: 'model' }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
  policy: { ...DEFAULT_AGENT_POLICY },
};
const original = useSettings.getState();
const store = createCloudModelDraft(config, original);
const before = store.getState();
assert.equal(before.providers[0].apiKey, '', 'server credentials are never hydrated into the editor');
assert.equal(cloudModelsDirty(before, config), false);
const hinted = { ...config, providers: [{ ...config.providers[0], keyHint: '••••7xQ2' }] };
assert.equal(cloudModelsDirty(createCloudModelDraft(hinted, original).getState(), hinted), false, 'display-only key hints never create unsaved edits');
for (const accounts of [[], [{ id: 'key-1', name: 'Main account', configured: true }]]) {
  const withAccounts = { ...config, providers: [{ ...config.providers[0], accounts, activeAccountId: accounts[0]?.id }] };
  const accountDraft = createCloudModelDraft(withAccounts, original).getState();
  assert.equal(cloudModelsDirty(accountDraft, withAccounts), false, 'saved key accounts never create false unsaved edits');
  assert.equal(cloudModelsDirty({ ...accountDraft, providers: [{ ...accountDraft.providers[0], apiKey: 'rotated-key' }] }, withAccounts), true, 'key rotation still requires saving');
}
assert.equal(cloudProviderDirty(before.providers[0], config), false);
assert.equal(cloudProviderDirty({ ...before.providers[0], name: 'Renamed' }, config), true, 'display-only edits still require saving the connection');
assert.equal(cloudModelsDirty({ ...before, llmModel: { providerId: '', model: '' } }, config), true);
const withDecision = { ...config, decisionModel: { providerId: 'p1', model: 'decision' } };
assert.deepEqual(createCloudModelDraft(withDecision, original).getState().decisionModel, withDecision.decisionModel, 'hidden decision references are editable and removable');
assert.deepEqual(cloudModelConfig(createCloudModelDraft(withDecision, original).getState(), withDecision).decisionModel, withDecision.decisionModel);
assert.equal('policy' in cloudModelUpdate(before, config), false, 'scoped updates cannot carry account policy');
assert.equal(cloudModelConfig(before, config).providers[0].apiKey, undefined, 'blank keys preserve existing server credentials');
assert.equal(cloudDiscoveryProviders(before, config)[0].baseUrl, '/api/v1/cloud/models/p1');
store.getState().update({ providers: [{ ...before.providers[0], apiKey: 'new-secret' }] });
assert.strictEqual(useSettings.getState(), original, 'draft updates cannot affect persistent runtime settings');
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved credentials cannot discover through a stale connection or leak to the browser transport');
const latest = { ...config, policy: { ...config.policy, shell: 'deny' }, trustedAgentIds: ['trusted'] };
const payload = cloudModelConfig(store.getState(), latest);
assert.equal(payload.providers[0].apiKey, 'new-secret');
assert.equal(payload.providers[0].baseUrl, 'https://models.example/v1', 'proxy URL is never saved as an upstream endpoint');
assert.equal(payload.policy.shell, 'deny', 'model saves preserve the latest policy');
assert.deepEqual(payload.trustedAgentIds, ['trusted']);
assert.ok(!JSON.stringify(cloudModelPreferences(store.getState())).includes('new-secret'), 'account preferences never include credentials');
store.getState().update({ providers: [{ ...before.providers[0], baseUrl: 'https://changed.example/v1' }] });
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved endpoint changes do not reuse old discovery');
store.getState().update({ providers: [{ ...before.providers[0], protocol: 'anthropic-messages' }] });
assert.deepEqual(cloudDiscoveryProviders(store.getState(), config), [], 'unsaved protocol changes do not reuse old discovery');
console.log('PASS: cloud draft isolation, credential retention, server-only discovery, endpoint/protocol changes and policy preservation');
const deployed = { ...before, providers: [{ ...before.providers[0], apiKey: 'server-managed', gatewayManaged: true, deploymentProtocols: { model: 'anthropic-messages' } }] };
assert.equal(targetOfSlot(deployed, 'chat').protocol, 'anthropic-messages');
assert.equal(targetOrNull(deployed, config.llmModel).protocol, 'anthropic-messages');
assert.equal(targetOrNull(deployed, { providerId: 'p1', model: 'other' }).protocol, 'openai-chat');
const hintedTarget = { ...deployed, providers: [{ ...deployed.providers[0], reasoningProvider: 'deepseek', deploymentReasoningProviders: { model: 'anthropic' }, stateScope: 'configuration:opaque-revision' }] };
for (const target of [targetOfSlot(hintedTarget, 'chat'), targetOrNull(hintedTarget, config.llmModel)]) {
  assert.equal(target.reasoningProvider, 'anthropic', 'wire provider follows the deployment, not the metadata catalog or proxy URL');
  assert.equal(target.stateScope, 'configuration:opaque-revision');
}
assert.equal(targetOrNull(hintedTarget, { providerId: 'p1', model: 'other' }).reasoningProvider, 'deepseek');
try {
  // A misleading catalog and a replaced browser URL must not change the actual
  // provider's protocol fields. Per-model deployments may use another upstream.
  applyCloudConfig({ ...config, modelRevision: 'rev1', providers: [{ ...config.providers[0], baseUrl: 'https://api.deepseek.com', catalogId: 'openrouter', deployments: [{ model: 'deployed', protocol: 'openai-chat', baseUrl: 'https://api.openai.com/v1' }] }], llmModel: { providerId: 'p1', model: 'deepseek-v4-pro' } });
  const target = targetOfSlot(useSettings.getState(), 'chat');
  assert.equal(target.reasoningProvider, 'deepseek');
  assert.equal(target.stateScope, 'configuration:rev1');
  assert.doesNotMatch(target.baseUrl, /api\.deepseek\.com/);
  const messages = [{ role: 'user', content: 'test' }];
  const body = requestBody(target, { messages, thinkingLevel: 'high' }, messages, false);
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.reasoning, undefined, 'metadata catalog cannot select the OpenRouter wire protocol');
  assert.equal(targetOrNull(useSettings.getState(), { providerId: 'p1', model: 'deployed' }).reasoningProvider, 'openai');
  applyCloudConfig({ ...config, modelRevision: 'rev2' });
  assert.equal(targetOfSlot(useSettings.getState(), 'chat').stateScope, 'configuration:rev2');
} finally { useSettings.setState(original, true); }
