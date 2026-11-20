import { DEFAULT_AGENT_POLICY, type CloudConfig } from '@wangke/contracts/cloud';
import type { CloudConfiguration } from '../cloud/config.js';
import type { DatabaseStore } from '../storage/database.js';
import { UsageLedger } from './budget.js';
import { ModelGateway } from './model-gateway.js';
import { ModelTargetResolver } from './model-target-resolver.js';
import { appendAudit } from '../storage/audit.js';
import { modelThinkingLevel, savedModelOverrides } from './model-preferences.js';
import { config } from '../config.js';

/** Environment compatibility is confined to the connection boundary. */
function environmentConfig(): CloudConfig {
  const settings = config();
  return {
    providers: settings.modelApiKey ? [{ id: 'server', name: 'Server', baseUrl: settings.modelBaseUrl, apiKey: settings.modelApiKey, protocol: 'openai-chat', catalogId: '', serves: ['chat', 'vision', 'asr'] }] : [],
    llmModel: { providerId: 'server', model: settings.modelName }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' }, policy: { ...DEFAULT_AGENT_POLICY },
  };
}
export function createModelGateway(store: DatabaseStore, configuration?: CloudConfiguration, fetcher: typeof fetch = fetch) {
  // Owner binding happens before each event; no request payload is captured.
  const resolver = new ModelTargetResolver(owner => configuration?.get(owner, true) ?? environmentConfig(),
    (owner, providerId, model) => savedModelOverrides(store, owner, providerId, model));
  return new ModelGateway(resolver, new UsageLedger(store, configuration), fetcher, {
    defaults: (owner, purpose) => ({ thinkingLevel: purpose === 'bot' || purpose === 'chat' ? modelThinkingLevel(store, owner) : undefined }),
    event: event => { if (event.owner) { const { owner, ...safe } = event; appendAudit(store, owner, safe.type, safe); } },
  });
}
