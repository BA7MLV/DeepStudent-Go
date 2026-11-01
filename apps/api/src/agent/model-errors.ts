import type { ModelErrorClass } from '@wangke/contracts/cloud';
import { BudgetBlocked } from './budget.js';
import { ModelFailure } from './model-client.js';

/** Never infer from provider text, URL, prompt, or arbitrary exception messages. */
export function modelErrorClass(error: unknown, signal?: AbortSignal): ModelErrorClass {
  if (signal?.aborted) return signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
  if (error instanceof BudgetBlocked) return error.code === 'context_capacity_exceeded' ? 'context_exceeded' : 'quota_exhausted';
  if (error instanceof DOMException) return error.name === 'TimeoutError' ? 'timeout' : error.name === 'AbortError' ? 'cancelled' : 'network';
  if (error instanceof ModelFailure) {
    const classes: Record<string, ModelErrorClass> = {
      model_auth_failed: 'auth_failed', model_quota_exhausted: 'quota_exhausted', model_rate_limited: 'rate_limited',
      model_server_error: 'server_error', model_transient_error: 'server_error', model_connection_failed: 'network',
      model_timeout: 'timeout', model_not_found: 'model_not_found', model_invalid_request: 'invalid_request',
      model_content_policy: 'content_policy', model_cancelled: 'cancelled', invalid_structured_response: 'incomplete_response', model_incomplete_or_refused: 'incomplete_response',
      model_empty_response: 'incomplete_response', model_invalid_json: 'incomplete_response', model_response_too_large: 'incomplete_response',
    };
    return classes[error.code] ?? 'invalid_request';
  }
  return 'invalid_request';
}
export class ModelGatewayFailure extends ModelFailure {
  constructor(readonly errorClass: ModelErrorClass, readonly traceId: string, readonly attempts: import('@wangke/contracts/cloud').ModelAttemptSummary[], legacyCode?: string) {
    super(legacyCode && ['invalid_structured_response', 'model_incomplete_or_refused'].includes(legacyCode) ? legacyCode : ['network', 'timeout', 'server_error', 'rate_limited'].includes(errorClass) ? 'model_request_failed' : `model_${errorClass}`);
    this.name = 'ModelGatewayFailure';
  }
}
