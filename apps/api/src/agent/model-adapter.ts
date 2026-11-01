import type { CloudProvider, ModelGatewayRequest, ModelRef, ModelAudio } from '@wangke/contracts/cloud';
import { botRequest, botReply, responseContinuation } from './model.js';
import { ModelFailure, abortable } from './model-client.js';
import { applyPromptCache } from '@wangke/study-core/model/cache';
import { GO_PROVIDER, goBase, goTransport } from './opencode-go.js';

/** Safe runtime metadata: never a connection, key or URL. */
export interface RuntimeModelTarget extends ModelRef {
  protocol: CloudProvider['protocol']; catalogId: string;
}

/** Protocol-native continuation is kept intact unless a caller changes target.
 * Credentials live in private fields, not in serializable runtime targets. */
export class ModelAdapter {
  #connection: CloudProvider;
  readonly target: RuntimeModelTarget;
  constructor(connection: CloudProvider, model: string) {
    const deployment = connection.deployments?.find(d => d.model === model);
    const account = connection.accounts?.find(candidate => candidate.id === connection.activeAccountId && candidate.apiKey)
      ?? connection.accounts?.find(candidate => candidate.apiKey);
    this.#connection = { ...connection, apiKey: account?.apiKey ?? connection.apiKey, protocol: deployment?.protocol ?? connection.protocol, baseUrl: deployment?.baseUrl ?? connection.baseUrl };
    if (connection.id === GO_PROVIDER) this.#connection.baseUrl = goBase(this.#connection.protocol);
    this.target = { providerId: connection.id, model, protocol: this.#connection.protocol, catalogId: connection.catalogId };
  }
  encode(input: Pick<ModelGatewayRequest, 'messages' | 'tools' | 'image' | 'outputTokens' | 'cacheKey' | 'continuationRef'>) {
    const { protocol, model, providerId } = this.target;
    const portable = input.continuationRef && (input.continuationRef.providerId !== providerId || input.continuationRef.model !== model);
    const messages = (input.messages ?? []).map(({ response_items, ...message }) => ({ ...message, ...(!portable && response_items ? { response_items } : {}) }));
    const request = botRequest({ protocol, baseUrl: this.#connection.baseUrl }, model, messages, input.tools ?? [], input.outputTokens, input.cacheKey);
    if (input.image) {
      const { data, mime } = input.image;
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mime) || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error('invalid_model_image');
      const parts = protocol === 'anthropic-messages'
        ? [{ type: 'image', source: { type: 'base64', media_type: mime, data } }]
        : protocol === 'openai-responses' ? [{ type: 'input_image', image_url: `data:${mime};base64,${data}` }]
          : [{ type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } }];
      const key = protocol === 'openai-responses' ? 'input' : 'messages';
      const list = request.body[key] as Array<{ role: string; content: unknown }>;
      const last = list.at(-1);
      if (!last || last.role !== 'user') throw new Error('invalid_model_image_message');
      last.content = [...parts, ...(Array.isArray(last.content) ? last.content : [{ type: protocol === 'openai-responses' ? 'input_text' : 'text', text: last.content ?? '' }])];
    }
    return request;
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
  decode(body: unknown, purpose?: ModelGatewayRequest['purpose']) {
    const result = body as { stop_reason?: string; status?: string; incomplete_details?: { reason?: string }; output?: Array<{ content?: Array<{ type?: string }> }>; choices?: Array<{ finish_reason?: string; message?: { refusal?: unknown } }> } | null;
    if (result?.stop_reason === 'refusal' || result?.incomplete_details?.reason === 'content_filter' || Array.isArray(result?.choices) && result.choices.some(c => c?.finish_reason === 'content_filter' || c?.message?.refusal) || Array.isArray(result?.output) && result.output.some(o => Array.isArray(o?.content) && o.content.some(c => c?.type === 'refusal'))) throw new ModelFailure('model_content_policy');
    // Existing vision tools expose useful partial evidence with an explicit flag.
    // Bot/tool rounds still reject truncation, and no incomplete continuation survives.
    const truncated = result?.stop_reason === 'max_tokens' || result?.status === 'incomplete' && result.incomplete_details?.reason === 'max_output_tokens' || Array.isArray(result?.choices) && result.choices.some(c => c?.finish_reason === 'length');
    if (purpose === 'vision' && truncated && body && typeof body === 'object') {
      const complete = { ...body, ...(result?.stop_reason === 'max_tokens' ? { stop_reason: 'end_turn' } : {}), ...(result?.status === 'incomplete' ? { status: 'completed' } : {}), ...(Array.isArray(result?.choices) ? { choices: result.choices.map(c => ({ ...c, finish_reason: c.finish_reason === 'length' ? 'stop' : c.finish_reason })) } : {}) };
      try {
        const response = botReply(this.target.protocol, complete);
        if (!response.text.trim() || response.calls.length) throw new Error('invalid_structured_response');
        return { ...response, truncated: true };
      } catch { throw new ModelFailure('invalid_structured_response'); }
    }
    try { return { ...botReply(this.target.protocol, body), continuation: responseContinuation(this.target.protocol, body) }; }
    catch (error) {
      if (error instanceof Error && error.message === 'invalid_structured_response') throw new ModelFailure('invalid_structured_response');
      if (error instanceof Error && error.message === 'model_incomplete_or_refused') throw new ModelFailure('model_incomplete_or_refused');
      throw new ModelFailure('model_empty_response');
    }
  }
}
