import { ModelFailure } from './model-client.js';
/** Fail closed rollout/kill switch. No legacy path may bypass accounting/auth. */
export function gatewayDisabledPurposes() {
  return (process.env.MODEL_GATEWAY_DISABLED_PURPOSES ?? '').split(',').map(s => s.trim()).filter(s => ['bot', 'chat', 'vision', 'asr', 'memory', 'decision'].includes(s));
}
export function checkGatewayRollout(purpose: string) {
  if (gatewayDisabledPurposes().includes(purpose)) throw new ModelFailure('model_invalid_request');
}
