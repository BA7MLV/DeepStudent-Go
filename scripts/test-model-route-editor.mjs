import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidateLabel, defaultRouteRef, editPurposeRoute, fallbackWarning, followDefaultRoute, purposePreset, routeDraftIssue } from '../apps/web/src/cloud/modelRoutes.ts';
import { validateModelPresets } from '../apps/api/src/cloud/model-presets.ts';

const main = { providerId: 'p', model: 'main' }, backup = { providerId: 'p', model: 'backup' };
const settings = { llmModel: main, visionModel: { providerId: '', model: '' }, asrModel: { providerId: 'p', model: 'audio' }, decisionModel: { providerId: '', model: '' } };
const config = { ...settings, providers: [{ id: 'p', serves: ['chat', 'vision', 'asr'] }] };

test('default display follows live slot drafts, including implicit vision and newly configured slots', () => {
  for (const use of ['chat', 'bot', 'memory', 'vision']) assert.deepEqual(defaultRouteRef(settings, use), main);
  assert.equal(defaultRouteRef({ ...settings, llmModel: backup }, 'bot'), backup);
  assert.equal(defaultRouteRef({ ...settings, visionModel: backup }, 'vision'), backup);
  assert.equal(defaultRouteRef(settings, 'asr').model, 'audio');
  assert.equal(defaultRouteRef(settings, 'decision').model, '');
});

test('adding backup to a builtin creates a private route and keeps other uses following defaults', () => {
  const builtin = { id: 'builtin-bot', name: 'bot', purposes: ['bot'], candidates: [{ ref: main }] };
  const original = { modelPresets: [builtin], modelRoutes: { byPurpose: { bot: builtin.id, chat: 'builtin-chat' } } };
  const next = editPurposeRoute(original, 'bot', backup, { candidates: [{ ref: backup }, { ref: main }] });
  assert.equal(original.modelPresets.length, 1);
  assert.equal(next.modelPresets[0], builtin);
  assert.equal(next.modelRoutes.byPurpose.chat, 'builtin-chat');
  const selected = purposePreset(next, 'bot');
  assert.deepEqual(selected.candidates, [{ ref: backup }, { ref: main }]);
  assert.equal(selected.policy.allowCrossProvider, false);
  assert.deepEqual(validateModelPresets({ ...config, ...next }).modelRoutes.byPurpose.bot, selected.id);
});

test('edits to a shared saved plan are isolated and preserve safety policies and disabled candidates', () => {
  const plan = { id: 'shared', name: 'Shared', purposes: ['chat', 'bot'], candidates: [{ ref: main }, { ref: backup, enabled: false }], policy: { fallbackOn: ['timeout'], allowCrossProvider: false, maxChainMs: 4000 } };
  const original = { modelPresets: [plan], modelRoutes: { byPurpose: { chat: plan.id, bot: plan.id } } };
  const next = editPurposeRoute(original, 'bot', main, { candidates: [...plan.candidates].reverse() });
  const bot = purposePreset(next, 'bot');
  assert.notEqual(bot.id, plan.id);
  assert.equal(purposePreset(next, 'chat'), plan);
  assert.deepEqual(bot.policy, plan.policy);
  assert.deepEqual(bot.purposes, ['bot']);
  assert.equal(bot.candidates[0].enabled, false);
  const edited = editPurposeRoute(next, 'bot', main, { policy: { ...bot.policy, allowCrossProvider: true } });
  assert.equal(edited.modelPresets.length, next.modelPresets.length, 'repeated edits reuse the private plan');
  assert.equal(purposePreset(edited, 'bot').id, bot.id);
  assert.equal(purposePreset(edited, 'bot').policy.maxChainMs, 4000);
});

test('restore default preserves saved plans and resolves against newly changed default on save', () => {
  const custom = editPurposeRoute({}, 'bot', main, { candidates: [{ ref: main }, { ref: backup }] });
  const restored = followDefaultRoute(custom, 'bot');
  assert.equal(purposePreset(restored, 'bot'), undefined);
  assert.equal(restored.modelPresets, custom.modelPresets);
  const saved = validateModelPresets({ ...config, llmModel: backup, ...restored });
  assert.equal(saved.modelRoutes.byPurpose.bot, 'builtin-bot');
  assert.deepEqual(saved.modelPresets.find(p => p.id === 'builtin-bot').candidates, [{ ref: backup }]);
});

test('save errors identify uses and dangling unused plans rather than mentioning Preset internals', () => {
  let draft = editPurposeRoute({}, 'bot', main, { candidates: [{ ref: { providerId: 'gone', model: 'm' } }] });
  assert.match(routeDraftIssue(draft, new Set(['p'])), /Bot 助手.*供应商已删除/);
  draft = editPurposeRoute(draft, 'bot', main, { candidates: [{ ref: main, enabled: false }] });
  assert.match(routeDraftIssue(draft, new Set(['p'])), /至少保留一个启用/);
  draft = editPurposeRoute(draft, 'bot', main, { candidates: [{ ref: { providerId: 'p', model: '' } }] });
  assert.match(routeDraftIssue(followDefaultRoute(draft, 'bot'), new Set(['p'])), /已保存方案.*请选择模型/);
  assert.equal(routeDraftIssue({ modelPresets: [{ id: 'builtin-bot', candidates: [{ ref: { providerId: 'gone', model: 'old' } }] }] }, new Set(['p'])), undefined);
});

test('priority labels reflect the active order, not disabled entries', () => {
  const candidates = [{ ref: main, enabled: false }, { ref: backup }, { ref: main }];
  assert.deepEqual(candidates.map((_, i) => candidateLabel(candidates, i)), ['已停用模型', '主模型', '备用模型 1']);
});

test('backup warnings match cross-provider consent, privacy and deployment restrictions', () => {
  const providers = [{ id: 'p' }, { id: 'q' }], other = { providerId: 'q', model: 'backup' };
  const blocked = { policy: { allowCrossProvider: false } };
  assert.equal(fallbackWarning(main, backup, providers, blocked), undefined, 'same-provider backups need no cross-provider consent');
  assert.match(fallbackWarning(main, other, providers, blocked), /勾选下方/);
  assert.equal(fallbackWarning(main, other, providers, { policy: { allowCrossProvider: true } }), undefined);
  assert.match(fallbackWarning(main, other, [{ id: 'p', dataPolicy: 'private' }, { id: 'q' }]), /数据策略不同/);
  assert.match(fallbackWarning(main, backup, [{ id: 'p', deployments: [{ model: 'backup', allowFallback: false }] }]), /供应商限制/);
  assert.match(fallbackWarning(main, other, [{ id: 'p' }]), /供应商已删除/);
  const go = { providerId: 'opencode-go', model: 'g' };
  assert.match(fallbackWarning(main, go, [{ id: 'p' }, { id: 'opencode-go' }]), /供应商限制/);
  assert.equal(fallbackWarning(main, go, [{ id: 'p', dataPolicy: 'shared' }, { id: 'opencode-go', deployments: [{ model: 'g', allowFallback: true, dataPolicy: 'shared' }] }]), undefined);
});
