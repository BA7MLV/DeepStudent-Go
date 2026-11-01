import type { CloudConfig, ModelGatewayRequest, ModelPreset, ModelPurpose } from '@wangke/contracts/cloud';
import { ModelAdapter } from './model-adapter.js';

const slot = { chat: 'llmModel', bot: 'llmModel', memory: 'llmModel', vision: 'visionModel', asr: 'asrModel', decision: 'decisionModel' } as const;
/** Legacy references remain exact; discovery is never treated as authorization. */
export function legacyModelPresets(config: CloudConfig): { modelPresets: ModelPreset[]; modelRoutes: { byPurpose: Partial<Record<ModelPurpose, string>> } } {
  const modelPresets: ModelPreset[] = [], byPurpose: Partial<Record<ModelPurpose, string>> = {};
  for (const purpose of Object.keys(slot) as ModelPurpose[]) {
    const ref = config[slot[purpose]];
    // Preserve the existing automatic vision selection without guessing a model name.
    const selected = purpose === 'vision' && !ref?.model ? config.llmModel : ref;
    if (!selected?.model) continue;
    const id = `builtin-${purpose}`;
    modelPresets.push({ id, name: purpose, purposes: [purpose], candidates: [{ ref: { ...selected } }] });
    byPurpose[purpose] = id;
  }
  return { modelPresets, modelRoutes: { byPurpose } };
}
export class ModelTargetResolver {
  constructor(readonly config: (owner: string) => CloudConfig) {}
  resolve(request: Pick<ModelGatewayRequest, 'owner' | 'purpose' | 'presetId' | 'modelRef'>) {
    const config = this.config(request.owner);
    const legacy = legacyModelPresets(config);
    const presets = config.modelPresets ?? legacy.modelPresets;
    const presetId = request.presetId ?? (request.modelRef ? undefined : (config.modelRoutes ?? legacy.modelRoutes).byPurpose[request.purpose]);
    const preset = presetId ? presets.find(p => p.id === presetId && p.purposes.includes(request.purpose)) : undefined;
    if (presetId && !preset) throw new Error('model_preset_not_found');
    const candidates = request.modelRef ? [{ ref: request.modelRef }] : preset?.candidates.filter(c => c.enabled !== false) ?? [];
    if (!candidates.length || candidates.length > 30) throw new Error('model_not_configured');
    const adapters = candidates.map(candidate => {
      const { providerId, model } = candidate.ref;
      if (typeof model !== 'string' || !model.trim() || model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('invalid_model_reference');
      const provider = config.providers.find(p => p.id === providerId);
      if (!provider) throw new Error('model_provider_not_found');
      const capability = request.purpose === 'bot' || request.purpose === 'memory' ? 'chat' : request.purpose;
      // Legacy vision selection was explicit opt-in even on chat-only catalog
      // metadata. Preserve that exact saved target, not arbitrary vision refs or
      // new fallback candidates; discovery metadata is not authorization.
      const visionRef = config.visionModel.model ? config.visionModel : config.llmModel;
      const legacyVision = capability === 'vision' && provider.serves.includes('chat') && providerId === visionRef.providerId && model === visionRef.model && (!preset || preset.id === 'builtin-vision');
      if (!provider.serves.includes(capability) && !legacyVision) throw new Error('model_capability_unavailable');
      const deployment = provider.deployments?.find(d => d.model === model);
      const privacy = deployment?.dataPolicy ?? provider.dataPolicy ?? 'default';
      return { adapter: new ModelAdapter(provider, model), privacy, allowFallback: providerId === 'opencode-go' ? deployment?.allowFallback === true && privacy !== 'default' : deployment?.allowFallback !== false };
    });
    return { preset, candidates: adapters };
  }
}
