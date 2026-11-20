import { ModelFailure } from './model-client.js';
import { config } from '../config.js';
/** Fail closed rollout/kill switch. No legacy path may bypass accounting/auth. */
export function gatewayDisabledPurposes(): readonly string[] {
  return config().modelGatewayDisabledPurposes;
}
export function checkGatewayRollout(purpose: string) {
  if (gatewayDisabledPurposes().includes(purpose)) throw new ModelFailure('model_invalid_request');
}
