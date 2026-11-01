import type { CloudConfig, ModelErrorClass, ModelPreset, ModelPurpose, ModelRouteDefaults } from '@wangke/contracts/cloud';
import { legacyModelPresets } from '../agent/model-target-resolver.js';

export const MODEL_PURPOSES: ModelPurpose[] = ['chat', 'bot', 'vision', 'asr', 'decision', 'memory'];
const errors: ModelErrorClass[] = ['auth_failed', 'quota_exhausted', 'rate_limited', 'timeout', 'network', 'server_error', 'context_exceeded', 'content_policy', 'invalid_request', 'model_not_found', 'incomplete_response', 'cancelled'];
export class PresetConfigurationError extends Error {
  constructor(readonly path: string, readonly reason: 'invalid_preset' | 'provider_not_found' | 'preset_not_found') { super('invalid_model_presets'); }
}
/** Legacy slots remain writable. Only generated builtins follow those slots;
 * user-named Presets and explicit purpose defaults are never silently replaced. */
export function migrateModelPresets(config: CloudConfig) {
  const legacy = legacyModelPresets(config);
  if (!config.modelPresets) return legacy;
  if (!Array.isArray(config.modelPresets) || config.modelPresets.some(p => !p || typeof p.id !== 'string') || config.modelRoutes !== undefined && (!config.modelRoutes || typeof config.modelRoutes.byPurpose !== 'object' || !config.modelRoutes.byPurpose || Array.isArray(config.modelRoutes.byPurpose))) throw new PresetConfigurationError('modelPresets', 'invalid_preset');
  const modelPresets = [...legacy.modelPresets, ...config.modelPresets.filter(p => !p.id.startsWith('builtin-'))];
  const byPurpose = { ...legacy.modelRoutes.byPurpose, ...config.modelRoutes?.byPurpose };
  for (const purpose of MODEL_PURPOSES) if (byPurpose[purpose]?.startsWith('builtin-') && !modelPresets.some(p => p.id === byPurpose[purpose])) delete byPurpose[purpose];
  return { modelPresets, modelRoutes: { byPurpose } };
}
export function validateModelPresets(config: CloudConfig, preserveInvalidReferences = false): { modelPresets: ModelPreset[]; modelRoutes: ModelRouteDefaults } {
  const value = migrateModelPresets(config), ids = new Set<string>();
  const invalid = (path: string, reason: PresetConfigurationError['reason'] = 'invalid_preset'): never => { throw new PresetConfigurationError(path, reason); };
  if (!Array.isArray(value.modelPresets) || value.modelPresets.length > 100) return invalid('modelPresets');
  const modelPresets = value.modelPresets.map((p): ModelPreset => {
    if (!p || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id)) return invalid('modelPresets');
    ids.add(p.id);
    const path = `modelPresets.${p.id}`;
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 || !Array.isArray(p.purposes) || !p.purposes.length || p.purposes.some(purpose => !MODEL_PURPOSES.includes(purpose)) || !Array.isArray(p.candidates) || !p.candidates.length || p.candidates.length > 30 || !p.candidates.some(c => c && c.enabled !== false)) return invalid(path);
    const candidates = p.candidates.map(c => {
      if (!c || !c.ref || typeof c.ref.providerId !== 'string' || typeof c.ref.model !== 'string' || !c.ref.model.trim() || c.ref.model.length > 200 || /[\u0000-\u001f\u007f]/.test(c.ref.model) || c.enabled !== undefined && typeof c.enabled !== 'boolean') return invalid(path);
      if (!preserveInvalidReferences && !config.providers.some(provider => provider.id === c.ref.providerId)) return invalid(path, 'provider_not_found');
      return { ref: { providerId: c.ref.providerId, model: c.ref.model }, ...(c.enabled === undefined ? {} : { enabled: c.enabled }) };
    });
    const policy = p.policy;
    if (policy !== undefined && (!policy || typeof policy !== 'object' || Array.isArray(policy))) return invalid(path);
    if (policy && (policy.maxAttemptsPerCandidate !== undefined && (!Number.isSafeInteger(policy.maxAttemptsPerCandidate) || policy.maxAttemptsPerCandidate < 1 || policy.maxAttemptsPerCandidate > 6)
      || policy.maxChainMs !== undefined && (!Number.isSafeInteger(policy.maxChainMs) || policy.maxChainMs < 1 || policy.maxChainMs > 3660000)
      || policy.allowCrossProvider !== undefined && typeof policy.allowCrossProvider !== 'boolean'
      || policy.fallbackOn !== undefined && (!Array.isArray(policy.fallbackOn) || policy.fallbackOn.some(e => !errors.includes(e))))) return invalid(path);
    return { id: p.id, name: p.name.trim(), purposes: [...new Set(p.purposes)], candidates,
      ...(policy ? { policy: { maxAttemptsPerCandidate: policy.maxAttemptsPerCandidate, maxChainMs: policy.maxChainMs, allowCrossProvider: policy.allowCrossProvider, fallbackOn: policy.fallbackOn ? [...new Set(policy.fallbackOn)] : undefined } } : {}) };
  });
  if (!value.modelRoutes || typeof value.modelRoutes.byPurpose !== 'object' || !value.modelRoutes.byPurpose) return invalid('modelRoutes');
  const byPurpose: ModelRouteDefaults['byPurpose'] = {};
  for (const [purpose, id] of Object.entries(value.modelRoutes.byPurpose)) {
    if (!MODEL_PURPOSES.includes(purpose as ModelPurpose) || typeof id !== 'string' || !modelPresets.some(p => p.id === id && p.purposes.includes(purpose as ModelPurpose))) return invalid('modelRoutes', 'preset_not_found');
    byPurpose[purpose as ModelPurpose] = id;
  }
  return { modelPresets, modelRoutes: { byPurpose } };
}
