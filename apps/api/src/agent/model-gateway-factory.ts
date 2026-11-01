import { DEFAULT_AGENT_POLICY, type CloudConfig } from '@wangke/contracts/cloud';
import type { CloudConfiguration } from '../cloud/config.js';
import type { DatabaseStore } from '../storage/database.js';
import { UsageLedger } from './budget.js';
import { ModelGateway } from './model-gateway.js';
import { ModelTargetResolver } from './model-target-resolver.js';
import { appendAudit } from '../storage/audit.js';

/** Environment compatibility is confined to the connection boundary. */
function environmentConfig(): CloudConfig {
  const model = process.env.MODEL_NAME ?? 'gpt-4o-mini';
  return {
    providers: process.env.MODEL_API_KEY ? [{ id: 'server', name: 'Server', baseUrl: process.env.MODEL_BASE_URL ?? 'https://api.openai.com/v1', apiKey: process.env.MODEL_API_KEY, protocol: 'openai-chat', catalogId: '', serves: ['chat', 'vision', 'asr'] }] : [],
    llmModel: { providerId: 'server', model }, visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' }, policy: { ...DEFAULT_AGENT_POLICY },
  };
}
export function createModelGateway(store: DatabaseStore, configuration?: CloudConfiguration, fetcher: typeof fetch = fetch) {
  // Owner binding happens before each event; no request payload is captured.
  const resolver = new ModelTargetResolver(owner => configuration?.get(owner, true) ?? environmentConfig());
  return new ModelGateway(resolver, new UsageLedger(store, configuration), fetcher, {
    event: event => { if (event.owner) { const { owner, ...safe } = event; appendAudit(store, owner, safe.type, safe); } },
  });
}
