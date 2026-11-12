import crypto from 'node:crypto';
import type { ModelAttemptSummary, ModelErrorClass, ModelGatewayRequest, ModelGatewayResult } from '@wangke/contracts/cloud';
import { ModelClient, ModelFailure, modelUsage } from './model-client.js';
import { ModelTargetResolver } from './model-target-resolver.js';
import { ModelCircuitBreaker, type CircuitState } from './model-circuit-breaker.js';
import { ModelGatewayFailure, modelErrorClass } from './model-errors.js';
import { BudgetBlocked, type UsageLedger } from './budget.js';
import { boundedRequest, checkRequestCapacity } from './request-budget.js';
import { modelRequestPolicy } from './model-policy.js';
import { createStreamDeadline } from './stream-deadline.js';
import { accountedFetch } from './accounted-fetch.js';
import { ModelAdapter } from './model-adapter.js';
import { agentHttpInit } from './http.js';
import { retryAfter, abortable, limitedJson } from './model-client.js';
import { checkGatewayRollout } from './model-rollout.js';
import { normalizeThinkingLevel } from '@wangke/study-core/model/reasoning';
import { ImagePreparationError, prepareModelImages } from './image-preparation.js';

const transient: ModelErrorClass[] = ['network', 'timeout', 'rate_limited', 'server_error', 'context_exceeded'];
// Shared across request-scoped Gateway instances; bounded, owner-isolated state.
const circuits = new ModelCircuitBreaker();
export type RouteEvent = { type: 'model.route.started' | 'model.route.selected' | 'model.route.fallback' | 'model.route.failed'; owner?: string; traceId: string; purpose: string; presetId?: string; providerId?: string; model?: string; errorClass?: ModelErrorClass; attempts?: ModelAttemptSummary[] };
type GatewayOptions = { circuit?: CircuitState; clock?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; event?: (event: RouteEvent) => void;
  defaults?: (owner: string, purpose: ModelGatewayRequest['purpose']) => Pick<ModelGatewayRequest, 'thinkingLevel'> };
type NativeGatewayInput = {
  owner: string; purpose: ModelGatewayRequest['purpose']; modelRef: { providerId: string; model: string };
  endpoint: string; body?: BodyInit | null; contentType?: string; signal: AbortSignal; conversationId?: string; cacheKey?: string;
  attribution?: { run?: string; step?: string; task?: string; purpose?: string }; pagination?: URLSearchParams;
};
async function delay(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
/** Only a request that explicitly asked for SSE gets streaming idle semantics.
 * A provider that ignores stream=true still keeps the non-stream total deadline. */
function wantsStream(endpoint: string, body: BodyInit | null | undefined) {
  if (!['chat/completions', 'responses', 'messages'].includes(endpoint) || typeof body !== 'string') return false;
  try { return (JSON.parse(body) as { stream?: unknown })?.stream === true; } catch { return false; }
}
/** The only policy/replay owner. ModelClient executes exactly ONE physical
 * request per attempt and is the sole budget reserver/settler on this path.
 * This non-streaming API never executes tools. Native streaming transport is
 * deliberately separate: do not buffer/replay a stream through request(). */
export class ModelGateway {
  readonly client: ModelClient;
  private circuit: CircuitState;
  private clock: () => number;
  constructor(readonly resolver: ModelTargetResolver, readonly ledger: UsageLedger, fetcher: typeof fetch = fetch, readonly options: GatewayOptions = {}) {
    this.client = new ModelClient(ledger, fetcher);
    this.circuit = options.circuit ?? circuits;
    this.clock = options.clock ?? Date.now;
  }
  private event(event: RouteEvent) {
    try { this.options.event?.(event); } catch { /* observational only; never replay on observer failure */ }
  }
  target(request: Pick<ModelGatewayRequest, 'owner' | 'purpose' | 'presetId' | 'modelRef' | 'frozenModel'>) {
    return this.resolver.resolve(request).candidates[0].adapter.target;
  }
  health(owner: string) {
    return (this.circuit.snapshot?.() ?? []).flatMap(({ key, ...state }) => {
      const [scopedOwner, providerId, model, purpose] = JSON.parse(key);
      return scopedOwner === owner ? [{ providerId, model, purpose, ...state }] : [];
    });
  }
  estimate(request: ModelGatewayRequest) {
    request = this.withDefaults(request);
    const adapter = this.resolver.resolve(request).candidates[0].adapter;
    if (request.audio) return adapter.encodeAudio(request.audio).total;
    const wire = adapter.encode(request);
    return boundedRequest(wire.body, wire.path, request.outputTokens ?? this.ledger.model(request.owner, adapter.target).outputTokens).total;
  }
  /** Native compatibility/streaming boundary. A trusted exact ModelRef is used
   * here, so protocol-native bodies are never silently moved to another model.
   * Once headers/body leave this method, there is no retry, even on the first
   * body read. SSE bytes, tool deltas, continuation and usage stay untouched.
   * Canonical callers use request() for cross-protocol Preset fallback. */
  async forward(input: NativeGatewayInput): Promise<Response> {
    if (input.endpoint !== 'models') checkGatewayRollout(input.purpose);
    const traceId = crypto.randomUUID(), attempts: ModelAttemptSummary[] = [];
    const base = { owner: input.owner, traceId, purpose: input.purpose, ...input.modelRef };
    const key = JSON.stringify([input.owner, input.modelRef.providerId, input.modelRef.model, input.purpose]);
    this.event({ ...base, type: 'model.route.started' });
    let failed = false, acquired = false;
    try {
      if (input.endpoint !== 'models') { acquired = this.circuit.enter(key); if (!acquired) throw new ModelFailure('model_server_error'); }
      const response = await this.forwardNative(input, attempts);
      if (response.ok) { this.circuit.success(key); this.event({ ...base, type: 'model.route.selected', attempts }); }
      else {
        const errorClass = response.status === 402 ? 'quota_exhausted' : response.status === 401 || response.status === 403 ? 'auth_failed' : response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'server_error' : response.status === 404 ? 'model_not_found' : 'invalid_request';
        if (transient.includes(errorClass) && input.endpoint !== 'models') { this.circuit.failure(key); failed = true; }
        this.event({ ...base, type: 'model.route.failed', errorClass, attempts });
      }
      return response;
    } catch (error) {
      const errorClass = modelErrorClass(error, input.signal);
      if (acquired && transient.includes(errorClass)) { this.circuit.failure(key); failed = true; }
      this.event({ ...base, type: 'model.route.failed', errorClass, attempts });
      if (errorClass === 'cancelled' || errorClass === 'timeout') throw new ModelFailure(errorClass === 'cancelled' ? 'model_cancelled' : 'model_timeout');
      throw error;
    } finally { if (acquired && !failed) this.circuit.release(key); }
  }
  private async forwardNative(input: NativeGatewayInput, attempts: ModelAttemptSummary[]): Promise<Response> {
    const config = this.resolver.config(input.owner);
    const provider = config.providers.find(p => p.id === input.modelRef.providerId);
    if (!provider) throw new ModelFailure('model_not_found');
    const adapter = input.endpoint === 'models' ? new ModelAdapter(provider, '')
      : this.resolver.resolve({ owner: input.owner, purpose: input.purpose, modelRef: input.modelRef }).candidates[0].adapter;
    const transport = adapter.nativeTransport(input.endpoint, input);
    let body = typeof input.body === 'string' && ['chat/completions', 'responses', 'messages'].includes(input.endpoint) ? adapter.prepareNative(input.body, input.cacheKey) : input.body;
    const headers = { ...transport.headers };
    if (input.contentType) headers['content-type'] = input.contentType;
    else if (input.body instanceof FormData) delete headers['content-type'];
    // The native bridge cannot safely replay a one-shot upload stream.
    const replayable = input.body === undefined || input.body === null || typeof input.body === 'string' || input.body instanceof FormData;
    const policy = modelRequestPolicy({ purpose: input.purpose, ...(replayable ? {} : { attempts: 1 }) });
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(input.endpoint === 'models' ? 20000 : policy.chainMs)]);
    const audio = input.endpoint === 'audio/transcriptions' ? await adapter.prepareNativeAudio(input.body, input.contentType, signal) : undefined;
    if (audio) { body = audio.body; delete headers['content-type']; }
    const streaming = wantsStream(input.endpoint, body);
    const pagination = new URLSearchParams();
    if (input.endpoint === 'models') for (const key of ['after_id', 'limit']) {
      const value = input.pagination?.get(key); if (value !== null && value !== undefined) pagination.set(key, value);
    }
    const url = `${transport.url}${pagination.size ? `?${pagination}` : ''}`;
    const native = ['audio/transcriptions', 'systemone'].includes(input.endpoint) ? { model: input.modelRef.model, reserveTokens: audio?.total ?? this.ledger.model(input.owner, input.modelRef).contextTokens } : undefined;
    const meteringProvider = { ...provider, protocol: adapter.target.protocol, baseUrl: transport.url.slice(0, -input.endpoint.length).replace(/\/$/, '') };
    const fetcher = accountedFetch(this.ledger, { owner: input.owner, ...input.attribution, purpose: input.attribution?.purpose ?? input.purpose }, [meteringProvider], this.client.fetcher, native, adapter.target);
    for (let attempt = 1; ; attempt++) {
      const started = this.clock();
      const record = (outcome: 'completed' | 'failed', errorClass?: ModelErrorClass) => attempts.push({ ...input.modelRef, candidateIndex: 0, attempt, durationMs: Math.max(0, this.clock() - started), outcome, ...(errorClass ? { errorClass } : {}) });
      if (signal.aborted) throw new ModelFailure(input.signal.aborted ? 'model_cancelled' : 'model_timeout');
      // A stream is bounded by first-token, inter-chunk idle and absolute-turn
      // deadlines. Non-stream bodies keep one complete-response deadline.
      const deadline = streaming ? createStreamDeadline(signal, policy) : undefined;
      const attemptSignal = deadline?.signal ?? AbortSignal.any([signal, AbortSignal.timeout(policy.timeoutMs)]);
      let response: Response;
      try {
        response = await abortable(fetcher(url, agentHttpInit({ method: input.endpoint === 'models' ? 'GET' : 'POST', headers, body, redirect: 'error', signal: attemptSignal,
          ...(!replayable ? { duplex: 'half' } : {}) })), attemptSignal);
      } catch (error) {
        record('failed', modelErrorClass(error, attemptSignal));
        deadline?.close();
        if (error instanceof BudgetBlocked || error instanceof ImagePreparationError) throw error;
        if (signal.aborted || attempt >= policy.attempts || !replayable) throw new ModelFailure(input.signal.aborted ? 'model_cancelled' : attemptSignal.aborted ? 'model_timeout' : 'model_connection_failed');
        await (this.options.sleep ?? delay)(500 * 2 ** (attempt - 1), signal);
        continue;
      }
      if (response.ok) {
        record('completed');
        if (!response.body) { deadline?.close(); return response; }
        // A provider may ignore stream=true and return one JSON body. It has no
        // inter-chunk gaps, so only the absolute turn limit should apply.
        if (deadline && !(response.headers.get('content-type') ?? '').toLowerCase().includes('text/event-stream')) deadline.nonStream();
        const reader = response.body.getReader();
        // Once returned, no transport exception or SSE parser failure may replay.
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { value, done } = await abortable(reader.read(), attemptSignal);
              if (done) { deadline?.close(); reader.releaseLock(); controller.close(); }
              else { deadline?.chunk(); controller.enqueue(value); }
            }
            catch { deadline?.close(); void reader.cancel().catch(() => {}); controller.error(new ModelFailure(input.signal.aborted ? 'model_cancelled' : attemptSignal.aborted ? 'model_timeout' : 'model_connection_failed')); }
          },
          async cancel() { deadline?.close(); await reader.cancel().catch(() => {}); },
        }), { status: response.status, headers: response.headers });
      }
      let quota = false;
      if (response.status === 429) {
        // Read only bounded classification data, never propagate provider text.
        try {
          const body = await abortable(limitedJson(response, 65536), attemptSignal) as { error?: { code?: string } };
          quota = ['insufficient_quota', 'billing_hard_limit_reached', 'credit_balance_too_low'].includes(body?.error?.code ?? '');
        } catch { /* classify by status; never echo provider body */ }
      } else void response.body?.cancel().catch(() => {});
      deadline?.close();
      const status = quota ? 402 : response.status;
      record('failed', quota ? 'quota_exhausted' : status === 429 ? 'rate_limited' : status >= 500 ? 'server_error' : status === 401 || status === 403 ? 'auth_failed' : status === 404 ? 'model_not_found' : 'invalid_request');
      const retry = !quota && [408, 409, 429, 500, 502, 503, 504].includes(status);
      const wait = retryAfter(response.headers.get('retry-after')) ?? 500 * 2 ** (attempt - 1);
      if (retry && replayable && attempt < policy.attempts) { await (this.options.sleep ?? delay)(wait, signal); continue; }
      return Response.json({ error: { message: `model_http_${status}` } }, { status, headers: { 'x-wangke-model-gateway': '1', ...(retry ? { 'retry-after': String(Math.ceil(wait / 1000)) } : {}) } });
    }
  }
  async request(request: ModelGatewayRequest, limits: { maxReservedTokens?: number; maxAttemptsPerCandidate?: number; attributionPurpose?: string } = {}): Promise<ModelGatewayResult> {
    request = this.withDefaults(request);
    checkGatewayRollout(request.purpose);
    const traceId = crypto.randomUUID(), attempts: ModelAttemptSummary[] = [];
    const base = { owner: request.owner, traceId, purpose: request.purpose, ...(request.presetId ? { presetId: request.presetId } : {}) };
    this.event({ ...base, type: 'model.route.started' });
    const { candidates, preset } = this.resolver.resolve(request);
    const policy = modelRequestPolicy({ purpose: request.purpose, attempts: limits.maxAttemptsPerCandidate ?? preset?.policy?.maxAttemptsPerCandidate, chainMs: preset?.policy?.maxChainMs });
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(policy.chainMs)]);
    const deadline = this.clock() + policy.chainMs;
    let lastClass: ModelErrorClass = 'server_error';
    const fail = (errorClass: ModelErrorClass, legacyCode?: string): never => {
      this.event({ ...base, type: 'model.route.failed', errorClass, attempts });
      throw new ModelGatewayFailure(errorClass, traceId, attempts, legacyCode);
    };
    for (const [candidateIndex, { adapter, privacy, allowFallback }] of candidates.entries()) {
      const target = adapter.target;
      if (candidateIndex && (!allowFallback || !candidates[0].allowFallback || privacy !== candidates[0].privacy || target.providerId !== candidates[0].adapter.target.providerId && preset?.policy?.allowCrossProvider === false)) continue;
      const key = JSON.stringify([request.owner, target.providerId, target.model, request.purpose]);
      if (!this.circuit.enter(key)) {
        attempts.push({ ...target, candidateIndex, attempt: 0, durationMs: 0, outcome: 'skipped', errorClass: 'server_error' });
        lastClass = 'server_error';
        continue;
      }
      let circuitFailed = false;
      try {
        for (let attempt = 1; attempt <= policy.attempts; attempt++) {
          if (signal.aborted) return fail(modelErrorClass(signal.reason, signal));
          const started = this.clock();
          try {
            const model = this.ledger.model(request.owner, target);
            if (request.purpose === 'asr' && !request.audio || request.audio && request.purpose !== 'asr') throw new ModelFailure('model_invalid_request');
            const audio = request.audio ? adapter.encodeAudio(request.audio) : undefined;
            const wire = audio ?? adapter.encode({ ...request, continuationRef: request.continuationRef ?? candidates[0].adapter.target });
            if (!audio) wire.body = await prepareModelImages(wire.body, target, signal);
            const bounded = audio ?? boundedRequest(wire.body as Record<string, unknown>, wire.path, request.outputTokens ?? model.outputTokens);
            if (limits.maxReservedTokens !== undefined && bounded.total > limits.maxReservedTokens) throw new BudgetBlocked('memory_job_token_budget');
            checkRequestCapacity(bounded.total, Math.min(model.contextTokens, this.ledger.limits(request.owner, request.run).contextTokens));
            const transport = adapter.transport(wire.path, request);
            if (audio) delete transport.headers['content-type'];
            const body = await this.client.request(transport.url, { method: 'POST', headers: transport.headers, body: audio?.body ?? JSON.stringify(bounded.body), redirect: 'error', signal }, { owner: request.owner, run: request.run, step: request.step, task: request.task, purpose: limits.attributionPurpose ?? request.purpose, provider: target.providerId, model: target.model }, bounded.total,
              { ordinary: !request.run, purpose: request.purpose, imagesPrepared: true, attempts: 1, timeoutMs: policy.timeoutMs, chainMs: Math.max(1, Math.min(policy.chainMs, deadline - this.clock())) });
            // Decode before publishing a visible result. Never return provider body in errors.
            const response = audio ? adapter.decodeAudio(body) : adapter.decode(body, request.purpose, request.tools);
            attempts.push({ providerId: target.providerId, model: target.model, candidateIndex, attempt, durationMs: Math.max(0, this.clock() - started), outcome: 'completed' });
            this.circuit.success(key);
            this.event({ ...base, type: 'model.route.selected', providerId: target.providerId, model: target.model, attempts });
            return { providerId: target.providerId, model: target.model, protocol: target.protocol, response, usage: modelUsage(body), traceId, attempts, continuationReusable: candidateIndex === 0 && (!request.continuationRef || request.continuationRef.providerId === target.providerId && request.continuationRef.model === target.model) };
          } catch (error) {
            const failure = error instanceof ModelFailure ? error.lastFailure ?? error : error;
            lastClass = modelErrorClass(failure, signal);
            attempts.push({ providerId: target.providerId, model: target.model, candidateIndex, attempt, durationMs: Math.max(0, this.clock() - started), outcome: 'failed', errorClass: lastClass });
            // Budget errors retain their stable pause codes and never switch provider.
            if (error instanceof BudgetBlocked && lastClass !== 'context_exceeded') throw error;
            if (signal.aborted || !transient.includes(lastClass)) return fail(lastClass, failure instanceof ModelFailure ? failure.code : failure instanceof ImagePreparationError ? failure.message : undefined);
            if (lastClass === 'context_exceeded') break;
            if (attempt < policy.attempts) {
              const wait = failure instanceof ModelFailure && failure.delay !== undefined ? failure.delay : Math.round(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
              // Do not turn Retry-After into an immediate cross-provider replay.
              if (wait >= deadline - this.clock()) return fail('timeout');
              try { await (this.options.sleep ?? delay)(wait, signal); } catch { return fail(modelErrorClass(signal.reason, signal)); }
            }
          }
        }
        if (lastClass !== 'context_exceeded') { this.circuit.failure(key); circuitFailed = true; }
      } finally { if (!circuitFailed) this.circuit.release(key); }
      if (!(preset?.policy?.fallbackOn ?? transient).includes(lastClass)) return fail(lastClass);
      if (candidateIndex + 1 < candidates.length) this.event({ ...base, type: 'model.route.fallback', providerId: target.providerId, model: target.model, errorClass: lastClass });
    }
    return fail(lastClass);
  }
  private withDefaults(request: ModelGatewayRequest): ModelGatewayRequest {
    return { ...request, thinkingLevel: request.frozenModel?.thinkingLevel ?? normalizeThinkingLevel(request.thinkingLevel) ?? this.options.defaults?.(request.owner, request.purpose).thinkingLevel };
  }
}
