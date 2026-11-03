import type { CloudProvider, ModelGatewayRequest, ModelRef, ModelAudio } from '@wangke/contracts/cloud';
import { modelMessageView } from './model.js';
import crypto from 'node:crypto';
import { requestBody, decodeResponse, textOf, type ToolDef } from '@wangke/study-core/model/client';
import type { ModelTarget } from '@wangke/study-core/model/types';
import type { ModelOverrides } from '@wangke/study-core/model/meta';
import { ModelFailure, abortable } from './model-client.js';
import { applyPromptCache } from '@wangke/study-core/model/cache';
import { reasoningProviderOf } from '@wangke/study-core/model/reasoning';
import { GO_PROVIDER, goBase, goTransport } from './opencode-go.js';

/** Safe runtime metadata: never a connection, key or URL. */
export interface RuntimeModelTarget extends ModelRef {
  protocol: CloudProvider['protocol']; catalogId: string;
  reasoningProvider?: string;
  stateScope: string;
  capabilities?: ModelOverrides;
}

/** Protocol-native continuation is kept intact unless a caller changes target.
 * Credentials live in private fields, not in serializable runtime targets. */
export class ModelAdapter {
  #connection: CloudProvider;
  readonly target: RuntimeModelTarget;
  constructor(connection: CloudProvider, model: string, capabilities?: ModelOverrides) {
    const deployment = connection.deployments?.find(d => d.model === model);
    const account = connection.accounts?.find(candidate => candidate.id === connection.activeAccountId && candidate.apiKey)
      ?? connection.accounts?.find(candidate => candidate.apiKey);
    this.#connection = { ...connection, apiKey: account?.apiKey ?? connection.apiKey, protocol: deployment?.protocol ?? connection.protocol, baseUrl: deployment?.baseUrl ?? connection.baseUrl };
    if (connection.id === GO_PROVIDER) this.#connection.baseUrl = goBase(this.#connection.protocol);
    this.target = { providerId: connection.id, model, protocol: this.#connection.protocol, catalogId: connection.catalogId, capabilities,
      stateScope: `endpoint:${crypto.createHash('sha256').update(this.#connection.baseUrl).digest('hex')}`,
      reasoningProvider: reasoningProviderOf({ baseUrl: this.#connection.baseUrl, catalogId: connection.catalogId }) };
  }
  private codecTarget(): ModelTarget {
    return { ...this.target, baseUrl: this.#connection.baseUrl, apiKey: '', gatewayManaged: true };
  }
  encode(input: Pick<ModelGatewayRequest, 'messages' | 'tools' | 'image' | 'outputTokens' | 'cacheKey' | 'continuationRef' | 'thinkingLevel' | 'temperature' | 'toolChoice'>) {
    const { protocol, model, providerId } = this.target;
    const portable = input.continuationRef && (input.continuationRef.providerId !== providerId || input.continuationRef.model !== model);
    const target = this.codecTarget();
    const messages = modelMessageView(target, (input.messages ?? []).map(({ response_items, providerState, ...message }) => ({ ...message,
      ...(!portable ? { response_items, providerState } : {}) })), !portable);
    if (input.image) {
      const { data, mime } = input.image;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('invalid_model_image');
      const last = messages.at(-1);
      if (!last || last.role !== 'user') throw new Error('invalid_model_image_message');
      last.content = [{ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }, ...(Array.isArray(last.content) ? last.content : [{ type: 'text' as const, text: last.content ?? '' }])];
    }
    return { path: protocol === 'anthropic-messages' ? 'messages' : protocol === 'openai-responses' ? 'responses' : 'chat/completions',
      body: requestBody(target, { messages, tools: input.tools as ToolDef[] | undefined, max_tokens: input.outputTokens,
        thinkingLevel: input.thinkingLevel, temperature: input.temperature, cacheKey: input.cacheKey,
        tool_choice: input.toolChoice }, messages, false) };
  }
  encodeAudio(audio: ModelAudio) {
    if (this.target.protocol === 'anthropic-messages' || !/^audio\/(wav|x-wav|mpeg|mp3|mp4|webm|ogg|flac)$/.test(audio.mime) || typeof audio.data !== 'string' || audio.data.length > 28 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(audio.data)) throw new ModelFailure('model_invalid_request');
    const bytes = Buffer.from(audio.data, 'base64');
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new ModelFailure('model_invalid_request');
    const body = new FormData();
    body.append('file', new Blob([bytes], { type: audio.mime }), 'audio');
    body.append('model', this.target.model);
    body.append('response_format', 'verbose_json');
    // Conservative local reservation, not a claim about provider audio billing.
    return { path: 'audio/transcriptions', body, total: Math.ceil(bytes.length / 16000) * 1024 + 4096 };
  }
  decodeAudio(body: unknown) {
    const text = body && typeof body === 'object' && 'text' in body ? body.text : undefined;
    if (typeof text !== 'string') throw new ModelFailure('model_empty_response');
    return { text, calls: [] };
  }
  /** Bind opaque multipart uploads to the selected, accounted model. Parsing is
   * bounded before any credential-bearing request; a consumed stream stays non-replayable. */
  async prepareNativeAudio(body: BodyInit | null | undefined, contentType: string | undefined, signal: AbortSignal) {
    let form: FormData;
    if (body instanceof FormData) form = body;
    else {
      if (!body || !contentType?.startsWith('multipart/form-data;')) throw new ModelFailure('model_invalid_request');
      const reader = new Response(body).body!.getReader(), chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await abortable(reader.read(), signal); if (done) break;
          size += value.byteLength;
          if (size > 20 * 1024 * 1024 + 65536) throw new ModelFailure('model_invalid_request');
          chunks.push(value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      try { form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': contentType } }).formData(); }
      catch { throw new ModelFailure('model_invalid_request'); }
    }
    const file = form.get('file');
    if (!(file instanceof Blob) || !file.size || file.size > 20 * 1024 * 1024 || form.getAll('file').length !== 1) throw new ModelFailure('model_invalid_request');
    form.set('model', this.target.model);
    return { body: form, total: Math.ceil(file.size / 16000) * 1024 + 4096 };
  }
  /** Only the Gateway transport may materialize this object. Never log it. */
  prepareNative(body: string, cacheKey?: string) {
    const payload: unknown = JSON.parse(body);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ModelFailure('model_invalid_request');
    return JSON.stringify(applyPromptCache({ ...payload, model: this.target.model }, { ...this.#connection, model: this.target.model }, cacheKey));
  }
  transport(path: string, identity?: { owner: string; conversationId?: string }) {
    if (this.target.providerId === GO_PROVIDER) return goTransport(this.target.protocol, path, this.#connection.apiKey, identity);
    if (!['chat/completions', 'responses', 'messages', 'audio/transcriptions', 'models', 'systemone'].includes(path)) throw new Error('model_endpoint_not_found');
    let url: URL;
    try { url = new URL(this.#connection.baseUrl); } catch { throw new Error('invalid_provider_url'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('invalid_provider_url');
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.target.protocol === 'anthropic-messages') {
      headers['anthropic-version'] = '2023-06-01';
      if (this.#connection.apiKey) headers['x-api-key'] = this.#connection.apiKey;
    } else if (this.#connection.apiKey) headers.authorization = `Bearer ${this.#connection.apiKey}`;
    return { url: `${url.href.replace(/\/+$/, '')}/${path}`, headers };
  }
  /** Legacy/native bridge: select endpoint from the stored protocol, never a URL. */
  nativeTransport(endpoint: string, identity?: { owner: string; conversationId?: string }) {
    const expected = { 'openai-chat': 'chat/completions', 'openai-responses': 'responses', 'anthropic-messages': 'messages' }[this.target.protocol];
    if (!['models', 'systemone', 'audio/transcriptions', expected].includes(endpoint) || endpoint === 'audio/transcriptions' && this.target.protocol === 'anthropic-messages') throw new Error('model_protocol_mismatch');
    return this.transport(endpoint, identity);
  }
  decode(body: unknown, purpose?: ModelGatewayRequest['purpose'], tools?: ModelGatewayRequest['tools']) {
    try {
      const message = decodeResponse(this.codecTarget(), body, { tools: tools as ToolDef[] | undefined });
      if (message.finish_reason === 'content_filter') throw new ModelFailure('model_content_policy');
      const text = textOf(message), calls = (message.tool_calls ?? []).map(c => ({ ...(c.id ? { id: c.id } : {}), function: c.function }));
      const truncated = message.finish_reason === 'length';
      // Runtime safety, not protocol parsing: partial tool calls never execute.
      if (truncated && purpose === 'vision' && text.trim() && !calls.length) return { text, calls, truncated: true };
      if (message.finish_reason && ['length', 'error', 'aborted'].includes(message.finish_reason)) throw new ModelFailure('model_incomplete_or_refused');
      if (!calls.length && !text.trim()) throw new ModelFailure('invalid_structured_response');
      return { text, calls, ...(message.reasoning_content ? { reasoning: message.reasoning_content } : {}),
        ...(message.providerState ? { providerState: message.providerState, continuation: message.providerState.items } : {}) };
    } catch (error) {
      if (error instanceof ModelFailure) throw error;
      throw new ModelFailure('invalid_structured_response');
    }
  }
}
