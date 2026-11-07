import { requestBody, type ChatOptions } from '@wangke/study-core/model/client';
import type { ModelTarget } from '@wangke/study-core/model/types';
import { boundedRequest, checkRequestCapacity } from '../src/agent/request-budget.js';

/** Use the configured/declared ceiling (or explicitly unknown fallback). Estimate the same native
 * envelope as the Gateway (including tools/images) on every round, so growing
 * tool results cannot make input + output exceed the model context window. */
export function chatOutputTokens(target: ModelTarget, options: ChatOptions, limits: { contextTokens: number; outputTokens: number }): number {
  const endpoint = target.protocol === 'anthropic-messages' ? 'messages' : target.protocol === 'openai-responses' ? 'responses' : 'chat/completions';
  const body = requestBody(target, { ...options, max_tokens: limits.outputTokens }, options.messages, true);
  const { input } = boundedRequest(body, endpoint, limits.outputTokens);
  // This conservative byte-based estimate is NOT a tokenizer. Fail explicitly
  // when there is no useful response room, rather than asking for one token.
  checkRequestCapacity(input + 1024 + Math.min(512, limits.outputTokens), limits.contextTokens);
  return Math.min(limits.outputTokens, limits.contextTokens - input - 1024);
}

/** A single bounded increase only when a known/configured ceiling and current
 * context estimate both permit it. Unknown 8192 is policy, never a hard limit. */
export function truncationRetryTokens(current: number, available: number, source: string, attempts: number): number | undefined {
  if (attempts > 0 || source === 'fallback' || available < current + 1024) return undefined;
  return Math.min(available, current * 2);
}
