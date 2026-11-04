import { BudgetBlocked, type RequestAttribution, type UsageLedger } from './budget.js';
import { boundedRequest, checkRequestCapacity } from './request-budget.js';
import { modelUsage } from '@wangke/study-core/model/usage';
import { modelRequestPolicy, type ModelRequestOptions } from './model-policy.js';
import { agentHttpInit } from './http.js';
import { observeModelFetch } from './model-observations.js';
export { modelUsage } from '@wangke/study-core/model/usage';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject | undefined => v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : undefined;
export function retryAfter(value: string | null, time = Date.now()) {
  if (!value) return undefined;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - time;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
export class ModelFailure extends Error {
  constructor(readonly code: string, readonly retryable = false, readonly delay?: number, readonly lastFailure?: ModelFailure) { super(code); }
}
function classify(status: number, delay?: number) {
  if (status === 401 || status === 403) return new ModelFailure('model_auth_failed');
  if (status === 402) return new ModelFailure('model_quota_exhausted');
  if (status === 404) return new ModelFailure('model_not_found');
  if (status === 429) return new ModelFailure('model_rate_limited', true, delay);
  if (status === 408 || status === 409) return new ModelFailure('model_transient_error', true, delay);
  if (status >= 500) return new ModelFailure('model_server_error', true, delay);
  return new ModelFailure('model_invalid_request');
}
export async function limitedJson(response: Response, limit = 8 * 1024 * 1024): Promise<unknown> {
  if (!response.body) throw new ModelFailure('model_empty_response');
  const reader = response.body.getReader();
  let text = '', bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > limit) throw new ModelFailure('model_response_too_large');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    try { return JSON.parse(text); } catch { throw new ModelFailure('model_invalid_json'); }
  } finally { void reader.cancel().catch(() => {}); }
}
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // The caller may have started work that aborts synchronously before returning
  // its promise. Observe that promise even when cancellation already won.
  if (signal.aborted) { void promise.catch(() => {}); signal.throwIfAborted(); }
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}
async function sleep(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Each retry is a distinct physical request. Unknown network usage keeps its
 * reservation; model retries never replay a tool or commit a late response. */
export class ModelClient {
  constructor(readonly ledger: UsageLedger, readonly fetcher: typeof fetch = fetch) {}
  async request(url: string, init: RequestInit, attribution: RequestAttribution, reserveTokens: number, options: ModelRequestOptions = {}): Promise<unknown> {
    const policy = modelRequestPolicy(options);
    if (typeof init.body === 'string') {
      const payload: unknown = JSON.parse(init.body);
      if (!object(payload)) throw new Error('invalid_model_body');
      const model = this.ledger.model(attribution.owner, { providerId: attribution.provider, model: attribution.model });
      const request = boundedRequest(payload as JsonObject, url, model.outputTokens);
      checkRequestCapacity(request.total, Math.min(model.contextTokens, this.ledger.limits(attribution.owner, attribution.run).contextTokens));
      reserveTokens = request.total;
      init = { ...init, body: JSON.stringify(request.body) };
    }
    const signal = AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(policy.chainMs)]);
    // Preserve ordinary-traffic semantics: observe once, do not debit Bot budgets.
    const ordinary = options.ordinary && Boolean(this.ledger.store) && !this.ledger.taskBudgeted(attribution.owner, attribution.task);
    const fetcher: typeof fetch = ordinary ? (url, init) => observeModelFetch(this.ledger.store, attribution.owner, attribution.provider, attribution.model, this.fetcher, url, init, this.ledger.observation(attribution, reserveTokens)) : this.fetcher;
    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      signal.throwIfAborted();
      const id = ordinary ? undefined : this.ledger.reserve(attribution, attempt, reserveTokens);
      let failure: ModelFailure;
      try {
        const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]);
        const response = await abortable(fetcher(url, agentHttpInit({ ...init, redirect: 'error', signal: requestSignal })), requestSignal);
        requestSignal.throwIfAborted();
        if (!response.ok) {
          if (response.status === 429) {
            let errorBody: unknown;
            try { errorBody = await abortable(limitedJson(response, 65536), requestSignal); } catch { /* classify status without echoing body */ }
            const code = object(object(errorBody)?.error)?.code;
            if (['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low'].includes(String(code))) throw new ModelFailure('model_quota_exhausted');
          } else await response.body?.cancel();
          throw classify(response.status, retryAfter(response.headers.get('retry-after')));
        }
        const body = await abortable(limitedJson(response), requestSignal);
        requestSignal.throwIfAborted();
        if (id && this.ledger.settle(id, 'completed', modelUsage(body))) throw new BudgetBlocked('model_usage_exceeded_reservation');
        if (!ordinary) this.ledger.checkAdmission(attribution);
        return body;
      } catch (error) {
        if (id) this.ledger.settle(id, signal.aborted ? 'cancelled' : error instanceof ModelFailure ? error.code : 'network_unknown');
        signal.throwIfAborted();
        if (error instanceof BudgetBlocked) throw error;
        if (!ordinary) this.ledger.checkAdmission(attribution);
        failure = error instanceof ModelFailure ? error : new ModelFailure(error instanceof DOMException && error.name === 'TimeoutError' ? 'model_timeout' : 'model_connection_failed', true);
      }
      if (!failure.retryable) throw failure;
      if (attempt === policy.attempts) throw new ModelFailure('model_request_failed', failure.retryable, failure.delay, failure);
      await sleep(failure.delay ?? Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)), signal);
    }
    throw new ModelFailure('model_request_failed');
  }
}
