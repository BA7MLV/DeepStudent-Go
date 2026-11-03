import type { ModelTarget } from './modelTypes.ts';
import { createDsmlRecoverer, recoverDsmlText, type DsmlPart } from './dsml.ts';
import { assertRequestSafe, describeMessage, messageDefects, sanitizeMessages } from './messageHygiene.ts';
import { getModelMeta } from './modelMeta.ts';
import { parseDiscoveredModel, type DiscoveredModel } from './modelDiscoveryData.ts';
import type { ModelListConnection } from './modelTypes.ts';
import { modelUsage, usageCollector, type ModelUsage, type ModelRequestRecord } from './usage.ts';
import { applyPromptCache, stableTools } from './promptCache.ts';
import { groupToolResults } from './toolMessages.ts';
import { reasoningProfile, reasoningWire, reasoningTemperatureAllowed } from './reasoning.ts';
import type { ModelProviderState, ModelThinkingLevel } from '@wangke/contracts/cloud';
export type { ModelUsage } from './usage.ts';

/**
 * OpenAI 兼容 API 客户端（浏览器直调）。
 *
 * 过去这里接的是整个 `Settings`（只有一个全局 apiKey/baseUrl 时那样最省事）；
 * 现在接的是 `ModelTarget` —— **端点与模型绑定成一个整体**（见 settings.ts 的说明）。
 * 这样「拿文本模型的连接去打别家供应商的视觉模型」这类错配在类型上就写不出来，
 * 而多供应商下它会变成真的把请求发到错误的地址。
 */

export class ApiError extends Error {
  status: number;
  /** 429 时服务端要求的等待毫秒数（来自 Retry-After 响应头） */
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A short transport hiccup should not immediately become a failed answer. */
const MAX_TRANSPORT_RETRIES = 2;

function isRetryableTransportError(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  if (typeof status === 'number') return status === 408 || status === 425 || status === 429 || status >= 500;
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  const name = (error as { name?: unknown } | null)?.name;
  if (name === 'AbortError') return false;
  const message = error instanceof Error ? error.message : String(error);
  return /failed to fetch|load failed|network|socket|econnreset|econnaborted|etimedout|timed out|socket hang up|terminated|connection reset|connection.*closed|响应流意外结束|无效的流式 JSON|数据不完整|返回为空|没有返回可读取的流|连接.*断开|网络.*失败/i.test(message);
}

function retryDelay(error: unknown, attempt: number): number {
  const retryAfterMs = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) return Math.min(30_000, Math.max(0, retryAfterMs));
  // Exponential backoff with jitter avoids a group of clients reconnecting at
  // the same instant after a provider hiccup.
  return Math.min(4_000, 250 * 2 ** attempt) + Math.floor(Math.random() * 250);
}

async function waitForRetry(error: unknown, attempt: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, retryDelay(error, attempt));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function withTransportRetry<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
  canRetry: () => boolean = () => true,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await operation();
    } catch (error) {
      if (signal?.aborted || attempt >= MAX_TRANSPORT_RETRIES || !canRetry() || !isRetryableTransportError(error)) throw error;
      await waitForRetry(error, attempt, signal);
    }
  }
}

/** Retry-After 头：秒数或 HTTP 日期，返回毫秒；无法解析返回 undefined */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

/**
 * 网关的消息校验类报错。
 *
 * 这些 400 有一个共同点：**它们说的东西和用户看到的现象毫无关系**。
 * 界面上是「点了没反应 / 回答失败」，报出来却是 `Invalid assistant message:
 * content or tool_calls must be set` 加一个 request_id —— 不看请求体根本无从下手。
 * 所以命中这些模式时要把**我们送出去的历史形状**一并附上（见 `diagnose400`）。
 */
const MESSAGE_REJECTION_RE =
  /content or tool_calls must be set|must be followed by tool messages|invalid\s+\w*\s*message|must be one of/i;

/**
 * 把「消息不合法」这类 400 翻成人能直接定位的话：把请求里每条消息的形状列出来。
 *
 * 只在网关明确抱怨消息结构时才说话（`MESSAGE_REJECTION_RE` 命中才返回非 null）——
 * 否则返回一个与真实原因无关的猜测，只会把人带偏。
 */
export function diagnose400(serverMessage: string, messages: readonly ChatMessage[]): string | null {
  if (!MESSAGE_REJECTION_RE.test(serverMessage)) return null;
  const lines = [
    `网关拒绝了这次请求，说的是消息结构不合法：${serverMessage}`,
    `本次共送出 ${messages.length} 条消息，形状如下：`,
    ...messages.map((m, i) => `  ${describeMessage(m, i)}`),
  ];
  const defects = messageDefects(messages);
  if (defects.length > 0) {
    // 走到这里说明收口点漏了：把漏在哪写明，比让用户去猜强得多
    lines.push(`本地复查也发现 ${defects.length} 处可疑：`, ...defects.map((d) => `  ! ${d}`));
  } else {
    lines.push('本地复查没有发现不合法的消息 —— 那多半是网关对某种形态比我们更严格（例如空正文、纯图片段、或超长上下文）。');
  }
  return lines.join('\n');
}

async function request(
  s: Pick<ModelTarget, 'apiKey' | 'baseUrl'> & Partial<Pick<ModelTarget, 'protocol'>>,
  path: string,
  init: RequestInit = {},
  /** 出错时用来定位的消息历史（只有对话请求才有） */
  sent?: readonly ChatMessage[],
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const res = await fetcher(`${s.baseUrl}${path}`, {
    ...init,
    headers: {
      // apiKey 为空时**不发** Authorization 头：发一个空 Bearer 会让「忘了填 key」
      // 表现为 401 认证失败，而不是「你没填 key」—— 两件事的排查方向完全不同。
      ...(s.apiKey && s.protocol === 'anthropic-messages' ? { 'x-api-key': s.apiKey, 'anthropic-version': '2023-06-01' } : {}),
      ...(s.protocol === 'anthropic-messages' ? { 'anthropic-dangerous-direct-browser-access': 'true' } : {}),
      ...(s.apiKey && s.protocol !== 'anthropic-messages' ? { Authorization: `Bearer ${s.apiKey}` } : {}),
      ...(init.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      msg = data?.message || data?.error?.message || JSON.stringify(data);
    } catch {
      msg = await res.text().catch(() => msg);
    }
    const explained = sent ? diagnose400(msg, sent) : null;
    throw new ApiError(
      res.status,
      explained ?? msg,
      res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : undefined,
    );
  }
  return res;
}

/** 拉某家供应商在架的模型 id 列表（用于设置页的候选与「检查模型可用性」） */
export async function listModelDetails(
  s: ModelListConnection,
  signal?: AbortSignal,
): Promise<DiscoveredModel[]> {
  const connection = { ...s, baseUrl: s.baseUrl.trim().replace(/\/+$/, ''), apiKey: s.apiKey.trim() };
  const found = new Map<string, DiscoveredModel>();
  const cursors = new Set<string>();
  let path = '/models';
  for (let page = 0; page < 100; page++) {
    const res = await request(connection, path, { method: 'GET', signal, cache: 'no-store', credentials: s.credentials ?? 'omit', redirect: 'error' });
    const data: unknown = await res.json();
    if (!data || typeof data !== 'object') throw new Error('模型列表响应格式无效');
    const body = data as { data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown };
    const models = Array.isArray(data) ? data : body.data ?? body.models;
    if (!Array.isArray(models)) throw new Error('接口未返回模型列表，可手动添加模型');
    for (const model of models) {
      const parsed = parseDiscoveredModel(model);
      if (!parsed) throw new Error('模型列表条目缺少有效 ID');
      if (!found.has(parsed.id)) found.set(parsed.id, parsed);
    }
    if (body.has_more === undefined || body.has_more === false) return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id)) {
      throw new Error('模型列表分页信息无效');
    }
    cursors.add(body.last_id);
    path = `/models?after_id=${encodeURIComponent(body.last_id)}`;
  }
  throw new Error('模型列表分页超出安全上限');
}

/** 兼容仅消费 ID 的调用方。 */
export async function listModels(
  s: ModelListConnection,
  signal?: AbortSignal,
): Promise<string[]> {
  return (await listModelDetails(s, signal)).map((m) => m.id);
}

export interface TranscriptionSegment {
  /** 段内相对时间，秒 */
  start: number;
  end: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  duration?: number;
  /** 句级时间戳（verbose_json，模型支持时才有；时间为音频内相对秒数） */
  segments?: TranscriptionSegment[];
}

/** 防御性解析 verbose_json 的句级 segments；任一项无效或整体缺失则返回 undefined */
function parseSegments(data: unknown): TranscriptionSegment[] | undefined {
  const list = (data as { segments?: unknown } | null)?.segments;
  if (!Array.isArray(list)) return undefined;
  const out: TranscriptionSegment[] = [];
  for (const x of list as { start?: unknown; end?: unknown; text?: unknown }[]) {
    if (typeof x?.start !== 'number' || typeof x?.end !== 'number' || typeof x?.text !== 'string') continue;
    const text = x.text.trim();
    if (x.end > x.start && text) out.push({ start: x.start, end: x.end, text });
  }
  return out.length > 0 ? out : undefined;
}

export async function transcribe(
  s: ModelTarget,
  audio: Blob,
  filename = 'chunk.wav',
  signal?: AbortSignal,
): Promise<TranscriptionResult> {
  if (s.protocol === 'anthropic-messages') {
    throw new Error('Anthropic Messages 协议不提供 OpenAI 兼容的音频转写接口，请为语音识别槽位选择 OpenAI Chat 供应商');
  }
  const submit = (verbose: boolean) => {
    const form = new FormData();
    form.append('file', audio, filename);
    form.append('model', s.model);
    if (verbose) form.append('response_format', 'verbose_json');
    return request(s, '/audio/transcriptions', { method: 'POST', body: form, signal });
  };
  let res: Response;
  try {
    // 优先请求 verbose_json 以拿句级时间戳（字幕按真实句子边界对齐）
    res = await submit(true);
  } catch (e) {
    // 模型/服务端不支持 verbose_json：退回默认 json 格式
    if ((e as ApiError).status === 400) res = await submit(false);
    else throw e;
  }
  const data = await res.json();
  return {
    text: typeof data?.text === 'string' ? data.text : '',
    duration: typeof data?.duration === 'number' ? data.duration : undefined,
    segments: parseSegments(data),
  };
}

export interface ToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  /** 思考过程（推理模型返回的非标准字段） */
  reasoning_content?: string;
  /**
   * 网关回的 `finish_reason`（= pi 内部的 `stopReason`）。判断这一轮是否完整只看它：
   * `length` = 输出撞了 `max_tokens` 上限（tool 参数可能已被截断），`error`/`aborted` = 残缺轮次。
   * **不回传**：它是这一轮的元数据，不是对话内容（与 `reasoning_content` 同理）。
   */
  finish_reason?: FinishReason;
  usage?: ModelUsage;
  /** Exact provider blocks, including signed/encrypted reasoning. Only replay
   * to the same connection/model/protocol; UI text is a separate projection. */
  providerState?: ModelProviderState;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'aborted' | 'error';

/** Keep provider-specific finish values from leaking into the agent protocol. */
function normalizeFinishReason(value: unknown): FinishReason | undefined {
  if (value == null || value === '') return undefined;
  switch (String(value)) {
    case 'stop':
    case 'completed':
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'length':
    case 'max_tokens':
    case 'max_output_tokens':
    case 'incomplete':
      return 'length';
    case 'tool_calls':
    case 'function_call':
    case 'tool_use':
      return 'tool_calls';
    case 'content_filter':
    case 'refusal':
      return 'content_filter';
    case 'aborted':
    case 'cancelled':
      return 'aborted';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return undefined;
  }
}

function streamErrorOf(chunk: any): string | undefined {
  const error = chunk?.error ?? (chunk?.type === 'error' ? chunk : undefined);
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error.message === 'string' && error.message) return error.message;
  if (typeof error.error?.message === 'string' && error.error.message) return error.error.message;
  try { return JSON.stringify(error); } catch { return '模型服务返回了未知流式错误'; }
}

/** Responses status takes precedence over the presence of function calls. */
function responseFinishReason(data: any, hasCalls: boolean): FinishReason {
  if (data.status === 'incomplete') {
    const reason = data.incomplete_details?.reason;
    return reason === 'content_filter' ? 'content_filter'
      : reason === 'steered' ? 'aborted'
      : reason == null || reason === 'max_output_tokens' ? 'length' : 'error';
  }
  const reason = normalizeFinishReason(data.status);
  return reason && reason !== 'stop' ? reason : hasCalls ? 'tool_calls' : reason ?? 'stop';
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A progressively assembled function call, useful for rendering large tool arguments. */
export interface ToolCallDelta {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

/** 提取 assistant 消息的纯文本（多模态数组时拼接 text 部分） */
export function textOf(msg: ChatMessage | null | undefined): string {
  if (!msg || msg.content == null) return '';
  if (typeof msg.content === 'string') return msg.content;
  return msg.content.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('');
}

/** Portable effort intent. max and xhigh remain distinct; reasoning.ts maps
 * intent to the selected provider/model's legal wire controls. */
export type ReasoningEffort = Exclude<ModelThinkingLevel, 'none'>;

/** Portable intent; the UI offers only the selected target's legal levels. */
export type ThinkingLevel = ModelThinkingLevel;

/**
 * 清理消息与本轮计量字段；各协议在 serializeBody 中决定如何回放推理状态。
 *
 * 顺带在这里过 `sanitizeMessages` —— 它是发请求前的唯一收口点，所有调用方
 * （agent 循环 / 讲义 / 卡片 / 弹幕 / 评论…）都走这两个函数，所以脏历史只有一处能被修。
 */
function wire(messages: readonly ChatMessage[]): ChatMessage[] {
  const clean = sanitizeMessages(messages);
  // 发送前的最后一道闸。收口点已经让这条断言恒真（`test-message-hygiene.mjs` 守着），
  // 所以它触发只可能是「收口点有漏」—— 那时**宁可自己抛一条说清哪条消息不对的错**，
  // 也不要让网关回一句和界面现象毫无关系的 400，让用户只能对着 request_id 发呆。
  assertRequestSafe(clean);
  return clean.map(({ finish_reason: _f, usage: _u, ...m }) => m);
}

export interface ChatOptions {
  messages: ChatMessage[];
  tools?: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  signal?: AbortSignal;
  /** Portable user intent. Only the shared protocol adapter creates wire fields. */
  thinkingLevel?: ThinkingLevel;
  /** 开启思考（仅支持的模型） */
  enable_thinking?: boolean;
  /** @deprecated Use thinkingLevel; retained for older task payloads. */
  reasoning_effort?: ReasoningEffort;
  /** 思考预算 tokens（多数推理模型生效），128~32768 */
  thinking_budget?: number;
  cacheKey?: string;
  /** Logical conversation identity for a server-managed Gateway connection. */
  conversationId?: string;
  tool_choice?: 'auto' | 'none';
  onRequest?: (record: ModelRequestRecord) => void | Promise<void>;
}

function chatPath(t: ModelTarget): string {
  return t.protocol === 'anthropic-messages' ? '/messages' : t.protocol === 'openai-responses' ? '/responses' : '/chat/completions';
}

function gatewayCacheHeaders(t: ModelTarget, key?: string, conversationId?: string): Record<string, string> | undefined {
  return t.gatewayManaged || /\/api\/v1\/cloud\/models\/[^/]+$/.test(t.baseUrl) ? { ...(key ? { 'x-wangke-cache-key': key } : {}), ...(conversationId ? { 'x-wangke-conversation': conversationId } : {}) } : undefined;
}

function anthropicContent(content: ChatMessage['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map((part) => {
    if (part.type === 'text') return { type: 'text', text: part.text };
    const url = part.image_url.url;
    const data = url.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
    return data
      ? { type: 'image', source: { type: 'base64', media_type: data[1], data: data[2] } }
      : { type: 'image', source: { type: 'url', url } };
  });
}

function responsesContent(content: ChatMessage['content']): unknown {
  if (!Array.isArray(content)) return content ?? '';
  return content.map((part) => part.type === 'text'
    ? { type: 'input_text', text: part.text }
    : { type: 'input_image', image_url: part.image_url.url });
}

export function requestBody(t: ModelTarget, opts: ChatOptions, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  return applyPromptCache(serializeBody(t, { ...opts, max_tokens: opts.max_tokens ?? 4096,
    tool_choice: opts.tool_choice ?? (opts.tools?.length ? 'auto' : undefined),
    tools: opts.tools ? stableTools(opts.tools) : undefined }, wire(messages), stream), t, opts.cacheKey);
}

function nativeItems(t: ModelTarget, message: ChatMessage) {
  const state = message.providerState;
  return state?.protocol === t.protocol && state.model === t.model && state.providerId === t.providerId && state.baseUrl === (t.stateScope ?? t.baseUrl) ? state.items : undefined;
}

function serializeBody(t: ModelTarget, opts: ChatOptions, messages: ChatMessage[], stream: boolean): Record<string, unknown> {
  const meta = getModelMeta(t.catalogId, t.model, t.capabilities);
  if (opts.tools?.length && meta?.declaredToolCall === false) {
    throw new Error('此模型已声明不支持工具调用；请切换支持工具的模型，或在模型编辑器中确认工具调用能力');
  }
  if (meta?.declaredOutput != null && meta.declaredOutput > 0) {
    opts = { ...opts, max_tokens: Math.min(opts.max_tokens ?? 4096, meta.declaredOutput) };
  }
  const profile = reasoningProfile(t);
  const level = opts.thinkingLevel ?? (opts.enable_thinking === false ? 'none' : opts.reasoning_effort ?? (opts.enable_thinking ? 'high' : undefined));
  const thinking = reasoningWire(t, level, opts.max_tokens ?? 4096);
  if (t.protocol === 'openai-chat' && profile.responsesOnly) throw new Error('此模型仅支持 Responses API；请在模型设置中切换协议');
  if (t.protocol === 'openai-chat' && opts.tools?.length && (profile.chatTools === 'never' || profile.chatTools === 'non-reasoning' && thinking.reasoning_effort !== 'none')) {
    throw new Error('此模型的思考模式工具调用需要 Responses API；请在模型设置中切换协议');
  }
  const temperature = opts.temperature != null && reasoningTemperatureAllowed(t, level) ? { temperature: opts.temperature } : {};
  if (t.protocol === 'anthropic-messages') {
    const system = messages.filter((m) => m.role === 'system').map((m) => ({ type: 'text', text: typeof m.content === 'string' ? m.content : '' }));
    const turns = messages.filter((m) => m.role !== 'system').map((m) => {
      if (m.role === 'tool') return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' }] };
      const native = nativeItems(t, m);
      if (m.role === 'assistant' && native?.length) return { role: 'assistant', content: native };
      if (m.role === 'assistant' && m.tool_calls?.length) return { role: 'assistant', content: [
        ...(typeof m.content === 'string' && m.content ? [{ type: 'text', text: m.content }] : []),
        ...m.tool_calls.map((tc) => ({ type: 'tool_use', id: tc.id, name: tc.function.name, input: parseArgs(tc.function.arguments) })),
      ] };
      return { role: m.role, content: anthropicContent(m.content) };
    });
    return {
      model: t.model, messages: groupToolResults(turns), ...(system.length ? { system } : {}), max_tokens: opts.max_tokens ?? 4096,
      ...temperature, ...thinking,
      ...(opts.tools?.length ? { tools: opts.tools.map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters })) } : {}),
      ...(opts.tool_choice ? { tool_choice: { type: opts.tool_choice } } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  if (t.protocol === 'openai-responses') {
    const input = messages.map((m) => {
      if (m.role === 'tool') return { type: 'function_call_output', call_id: m.tool_call_id, output: typeof m.content === 'string' ? m.content : '' };
      const native = nativeItems(t, m);
      if (m.role === 'assistant' && native?.length) return native;
      if (m.role === 'assistant' && m.tool_calls?.length) return [
        ...(m.content ? [{ role: 'assistant', content: m.content }] : []),
        ...m.tool_calls.map((tc) => ({ type: 'function_call', call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments })),
      ];
      return { role: m.role, content: responsesContent(m.content) };
    }).flat();
    return {
      model: t.model, input, store: false, include: ['reasoning.encrypted_content'], ...(opts.max_tokens == null ? {} : { max_output_tokens: opts.max_tokens }),
      ...temperature, ...thinking,
      ...(opts.tools?.length ? { tools: opts.tools.map((tool) => ({ type: 'function', name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters, strict: false })) } : {}),
      ...(opts.tool_choice ? { tool_choice: opts.tool_choice } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }
  return { model: t.model, messages: messages.map(({ providerState: _p, usage: _u, finish_reason: _f, reasoning_content: _r, ...m }) => {
    // Reasoning is portable for display, but replay is bound to the exact model
    // and connection. Never send another provider's signed/opaque state.
    const state = profile.preserve ? nativeItems(t, { ...m, providerState: _p })?.[0] : undefined;
    const { reasoning: _reasoning, reasoning_text: _text, reasoning_details: _details, extra_content: _extra, ...portable } = m as typeof m & { reasoning?: unknown; reasoning_text?: unknown; reasoning_details?: unknown; extra_content?: unknown };
    if (portable.tool_calls) portable.tool_calls = portable.tool_calls.map(call => ({ id: call.id, type: call.type, function: call.function }));
    return { ...portable, ...(state && typeof state === 'object' ? state : {}) };
  }), tools: opts.tools, tool_choice: opts.tool_choice, ...temperature,
    ...(profile.mode === 'openai' ? { max_completion_tokens: opts.max_tokens } : { max_tokens: opts.max_tokens }),
    ...thinking, stream };
}

function parseArgs(value: string): Record<string, unknown> {
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeResponse(data: any, protocol: ModelTarget['protocol']): ChatMessage {
  const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
  const blocks = (value: any): any[] => {
    if (!Array.isArray(value) || value.some(part => !object(part))) throw new Error('invalid_structured_response');
    return value;
  };
  const callsOf = (calls: any[]): ToolCall[] => calls.map(call => {
    if (!object(call) || !object(call.function) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw new Error('invalid_structured_response');
    return call;
  });
  if (!object(data)) throw new Error('invalid_structured_response');
  const error = streamErrorOf(data);
  if (error) throw new Error(`模型服务返回错误：${error}`);
  if (protocol === 'anthropic-messages') {
    const content = blocks(data.content ?? (data.stop_reason === 'refusal' ? [] : undefined));
    const text = content.filter((b: any) => b.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    const calls = callsOf(content.filter((b: any) => b.type === 'tool_use').map((b: any) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } })));
    const reasoning = content.filter((b: any) => b.type === 'thinking' && typeof b.thinking === 'string').map((b: any) => b.thinking).join('\n\n');
    return { role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}), finish_reason: content.some(b => b.type === 'refusal') ? 'content_filter' : normalizeFinishReason(data.stop_reason) ?? (calls.length ? 'tool_calls' : 'stop') };
  }
  if (protocol === 'openai-responses') {
    const output = blocks(data.output);
    const content = output.filter((item: any) => item.type === 'message' && (!item.role || item.role === 'assistant')).flatMap((item: any) => blocks(item.content ?? []));
    const text = content.filter((b: any) => b.type === 'output_text' && typeof b.text === 'string').map((b: any) => b.text).join('');
    const calls = callsOf(output.filter((item: any) => item.type === 'function_call').map((item: any) => ({ id: item.call_id ?? item.id, type: 'function' as const, function: { name: item.name, arguments: item.arguments } })));
    const finish_reason = content.some(b => b.type === 'refusal') ? 'content_filter' : responseFinishReason(data, calls.length > 0);
    const reasoning = responseReasoning(output);
    return { role: 'assistant', content: text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls } : {}), finish_reason };
  }
  const choice = data.choices?.[0];
  if (!object(choice?.message)) throw new Error('invalid_structured_response');
  const { finish_reason: messageFinishReason, ...message } = choice.message;
  const finish_reason = message.refusal ? 'content_filter' : normalizeFinishReason(choice.finish_reason ?? messageFinishReason);
  if (message.tool_calls != null) message.tool_calls = callsOf(blocks(message.tool_calls));
  if (Array.isArray(message.content)) message.content = blocks(message.content).filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('');
  const reasoning = chatReasoningText(message) || reasoningDetailsText(message.reasoning_details);
  return { ...message, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(finish_reason ? { finish_reason } : {}) } as ChatMessage;
}

function responseReasoning(output: any[]): string {
  return output.filter(item => item?.type === 'reasoning').flatMap(item => [...(item.summary ?? []), ...(item.content ?? [])])
    .filter(part => ['summary_text', 'reasoning_text'].includes(part?.type) && typeof part.text === 'string').map(part => part.text).join('\n\n');
}

function reasoningDetailsText(details: any): string {
  return Array.isArray(details) ? details.flatMap(part => part?.type === 'reasoning.text' && typeof part.text === 'string' ? [part.text]
    : part?.type === 'reasoning.summary' && typeof part.summary === 'string' ? [part.summary] : []).join('\n\n') : '';
}

/** Compatible endpoints may send several aliases, including empty placeholders. */
function chatReasoningText(message: any): string {
  return [message?.reasoning_content, message?.reasoning, message?.reasoning_text]
    .find(value => typeof value === 'string' && value.length > 0) ?? '';
}

/** An index is not an identity across detail types (or distinct signed blocks).
 * Keep provider order and never concatenate one block's ciphertext into another. */
function appendReasoningDetail(details: Record<string, any>[], detail: any): void {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  const previous = details.find(item => item.type === detail.type && (item.index ?? 0) === (detail.index ?? 0)
    && (!item.id || !detail.id || item.id === detail.id));
  if (!previous) { details.push({ ...detail }); return; }
  const next = { ...previous, ...detail };
  for (const key of ['text', 'summary', 'data', 'signature']) {
    if (typeof detail[key] === 'string') next[key] = (previous[key] ?? '') + detail[key];
  }
  Object.assign(previous, next);
}

function chatReasoningState(data: any): Record<string, unknown>[] | undefined {
  const msg = data?.choices?.[0]?.message;
  if (!msg) return;
  const reasoning = chatReasoningText(msg);
  const state = { ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(Array.isArray(msg.reasoning_details) ? { reasoning_details: msg.reasoning_details } : {}),
    ...(msg.extra_content ? { extra_content: msg.extra_content } : {}),
    ...(msg.tool_calls?.some((call: any) => call.extra_content) ? { tool_calls: msg.tool_calls } : {}) };
  return Object.keys(state).length ? [state] : undefined;
}

function responseMetadata(msg: ChatMessage, data: any, target: ModelTarget): ChatMessage {
  const items = target.protocol === 'anthropic-messages' ? data.content : target.protocol === 'openai-responses' ? data.output : chatReasoningState(data);
  const usage = modelUsage(data);
  return { ...msg, ...(usage ? { usage } : {}), ...(Array.isArray(items) && items.length ? {
    providerState: { providerId: target.providerId, baseUrl: target.stateScope ?? target.baseUrl, model: target.model, protocol: target.protocol, items },
  } : {}) };
}

/** Shared JSON codec for Bot, Chat and JSON returned to streaming callers.
 * Whether a partial answer may trigger tools is a runtime policy, not a codec. */
export function decodeResponse(target: ModelTarget, data: unknown, options: Pick<ChatOptions, 'tools'> = {}): ChatMessage {
  let msg = responseMetadata(normalizeResponse(data, target.protocol), data, target);
  if (options.tools?.length && typeof msg.content === 'string') msg = applyRecoveredDsml(msg, msg.content);
  return msg;
}

/** Keep the codec's machine error for Bot while presenting a useful Chat error. */
function decodeChatResponse(target: ModelTarget, data: unknown, options: Pick<ChatOptions, 'tools'>): ChatMessage {
  try { return decodeResponse(target, data, options); }
  catch (error) {
    if (error instanceof Error && error.message === 'invalid_structured_response') throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
    throw error;
  }
}

/**
 * 非流式对话（用于工具调用循环中的决策）。
 *
 * `target` 同时给出端点与模型 id —— 两者不再分开传，调用方无法把它们配错。
 */
async function observeRequest(t: ModelTarget, opts: ChatOptions, operation: (capture: (usage?: ModelUsage) => void) => Promise<ChatMessage>): Promise<ChatMessage> {
  const startedAt = Date.now(), id = crypto.randomUUID();
  let message: ChatMessage | undefined;
  let usage: ModelUsage | undefined;
  try { message = await operation(value => { if (value) usage = value; }); return message; }
  finally {
    await opts.onRequest?.({ id, providerId: t.providerId, model: t.model, protocol: t.protocol,
      startedAt, endedAt: Date.now(), status: opts.signal?.aborted || message?.finish_reason === 'aborted' ? 'cancelled'
        : !message || message.finish_reason === 'error' ? 'failed' : 'completed',
      ...(message?.usage || usage ? { usage: message?.usage ?? usage } : {}) });
  }
}

export function chatOnce(t: ModelTarget, opts: ChatOptions, fetcher?: typeof fetch): Promise<ChatMessage> {
  // The whole attempt is retried because no partial assistant content has
  // been exposed by chatOnce. Each attempt remains separately observable via
  // onRequest, which keeps usage and failure accounting correct.
  return withTransportRetry(() => observeRequest(t, opts, () => chatOnceInner(t, opts, fetcher)), opts.signal, () => !t.gatewayManaged);
}
async function chatOnceInner(t: ModelTarget, opts: ChatOptions, fetcher?: typeof fetch): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, chatPath(t), {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify(requestBody(t, opts, messages, false)),
    headers: gatewayCacheHeaders(t, opts.cacheKey, opts.conversationId),
  }, messages, fetcher);
  const body = await res.text();
  opts.signal?.throwIfAborted();
  if (!body.trim()) throw new Error('模型接口返回为空，请重试或检查模型服务');
  let data: unknown;
  try { data = JSON.parse(body); } catch {
    throw new Error('模型接口返回的数据不完整或不是有效 JSON，请重试或检查模型服务');
  }
  if (!data || typeof data !== 'object') throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
  return decodeChatResponse(t, data, opts);
}

/**
 * 把一次性还原的结果并回 assistant 消息（非流式路径）。
 *
 * 有一条不能省的兜底：**还原后正文与调用都空了，就原样返回**。
 * 否则会得到「正文空 + 无 tool_calls」—— 那正是 `messageHygiene` 要拦的非法消息，
 * 下一轮请求直接 400；显示几行脏字符比整个会话卡死好得多。
 */
function applyRecoveredDsml(msg: ChatMessage, raw: string): ChatMessage {
  const { text, calls } = recoverDsmlText(raw);
  if (calls.length === 0 && !text.trim()) return msg;
  return {
    ...msg,
    content: text || null,
    ...(calls.length
      ? {
          tool_calls: [
            ...(msg.tool_calls ?? []),
            ...calls.map((c) => ({
              id: `dsml_${crypto.randomUUID()}`,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          ],
        }
      : {}),
  };
}

/**
 * 少数网关会把未解析的工具调用压成字段名串并塞进正文，例如
 * `show_widgetformatsvgcode`。它不是用户内容，也不是合法的 DSML；即使
 * 无法安全还原调用，也不能把这段内部协议泄漏到聊天气泡里。
 *
 * 这里只移除明确的工具调用前缀，不做宽泛的 XML/HTML 清洗，避免误伤 SVG
 * 或讲义正文。真正的结构化调用仍由 DSML recoverer 负责。
 */
function stripLeakedToolPreamble(text: string): string {
  return text.replace(
    /(?:^|\s)(?:show_widget|writeFile|write)\s*(?:format|filePath|path)\s*(?:svg|mermaid|diagram|html|\/tmp\/[^\s]+)?\s*(?:code|content)?(?=\s|<|$)/gi,
    (match) => match.startsWith(' ') ? ' ' : '',
  );
}

/** 流式对话：onDelta 回调正文增量，onReasoning 回调思考增量，返回完整 assistant 消息（含 tool_calls） */
export function chatStream(
  t: ModelTarget, opts: ChatOptions, onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void, onToolCallDelta?: (call: ToolCallDelta) => void, fetcher: typeof fetch = fetch,
): Promise<ChatMessage> {
  let attemptProducedOutput = false;
  return withTransportRetry(
    () => {
      // Replaying a request after any streamed token/tool delta could
      // duplicate visible text or a side-effecting tool call. Only retry an
      // attempt that failed before it produced anything observable.
      attemptProducedOutput = false;
      return observeRequest(t, opts, capture => chatStreamInner(
        t,
        opts,
        onDelta ? text => { attemptProducedOutput = true; onDelta(text); } : undefined,
        onReasoning ? text => { attemptProducedOutput = true; onReasoning(text); } : undefined,
        onToolCallDelta ? call => { attemptProducedOutput = true; onToolCallDelta(call); } : undefined,
        fetcher,
        capture,
      ));
    },
    opts.signal,
    () => !t.gatewayManaged && !attemptProducedOutput,
  );
}
async function chatStreamInner(
  t: ModelTarget,
  opts: ChatOptions,
  onDelta?: (content: string) => void,
  onReasoning?: (text: string) => void,
  onToolCallDelta?: (call: ToolCallDelta) => void,
  fetcher: typeof fetch = fetch,
  capture?: (usage?: ModelUsage) => void,
): Promise<ChatMessage> {
  const messages = wire(opts.messages);
  const res = await request(t, chatPath(t), {
    method: 'POST',
    signal: opts.signal,
    body: JSON.stringify(requestBody(t, opts, messages, true)),
    headers: gatewayCacheHeaders(t, opts.cacheKey, opts.conversationId),
  }, messages, fetcher);

  /**
   * Some OpenAI-compatible gateways ignore `stream=true` and return one JSON
   * response. Treat that as a one-chunk stream instead of trying to parse JSON
   * as SSE (which otherwise looks like an empty answer).
   */
  const contentType = res.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/event-stream')) {
    const body = await res.text();
    opts.signal?.throwIfAborted();
    if (!body.trim()) throw new Error('模型接口返回为空，请重试或检查模型服务');
    let data: unknown;
    try { data = JSON.parse(body); } catch { throw new Error('模型接口返回的数据不完整或不是有效 JSON，请重试或检查模型服务'); }
    if (!data || typeof data !== 'object') throw new Error('模型接口未返回有效消息，请重试或检查模型配置');
    const msg = decodeChatResponse(t, data, opts);
    const content = textOf(msg);
    if (msg.reasoning_content) onReasoning?.(msg.reasoning_content);
    if (content) onDelta?.(content);
    msg.tool_calls?.forEach((call, index) => onToolCallDelta?.({
      index, id: call.id, name: call.function.name, arguments: call.function.arguments,
    }));
    return msg;
  }

  if (!res.body) throw new Error('模型接口没有返回可读取的流，请重试或检查模型服务');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoning = '';
  let finish: FinishReason | undefined;
  let ended = false;
  const toolCalls: Record<number, ToolCall> = {};
  const usage = usageCollector();
  const native: Record<number, Record<string, any>> = {};
  let responseItems: Record<string, any>[] | undefined;
  const summaryParts = new Map<string, string>();
  const reasoningDetails: Record<string, any>[] = [];
  const finishedResponseCalls = new Set<number>();
  const anthropicArgumentDeltas = new Set<number>();
  const toolExtras = new Map<number, Record<string, unknown>>();
  let extraContent: Record<string, unknown> | undefined;
  const emitReasoning = (text: string) => { reasoning += text; onReasoning?.(text); };
  const summaryPart = (key: string, text: string, append: boolean) => {
    const previous = summaryParts.get(key) ?? '';
    const next = append ? previous + text : text;
    if (next.startsWith(previous)) {
      const delta = next.slice(previous.length);
      if (delta) emitReasoning((!previous && summaryParts.size && !summaryParts.has(key) ? '\n\n' : '') + delta);
    }
    summaryParts.set(key, next);
  };
  const absorbSummary = (item: any, index: number) => {
    if (item?.type !== 'reasoning') return;
    [...(item.summary ?? []), ...(item.content ?? [])].forEach((part: any, i: number) => {
      if (['summary_text', 'reasoning_text'].includes(part.type) && typeof part.text === 'string') summaryPart(`${index}:${i}`, part.text, false);
    });
  };
  /**
   * DSML 兜底还原器，**只在真的声明了工具时装**。
   *
   * 没给工具时模型没有理由吐 DSML 标记，那时的尖括号更可能是正文（讲义片段、
   * HTML），还原器会把它们吞掉 —— 那就是拿一个 bug 换另一个 bug。
   */
  const dsml = opts.tools?.length ? createDsmlRecoverer() : null;
  /** 从 DSML 还原出来的调用单独放最后合并：网关给的 index 是连续的，直接往
   *  `toolCalls` 里塞会撞号（网关跳过某个 index 时就会覆盖前一个）。 */
  const recovered: ToolCall[] = [];

  const emitToolCall = (index: number) => {
    const call = toolCalls[index];
    if (!call) return;
    onToolCallDelta?.({
      index,
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
    });
  };

  const absorbResponseCall = (item: any, index: number, complete: boolean) => {
    if (item?.type !== 'function_call') return;
    const previous = toolCalls[index];
    const call: ToolCall = { id: item.call_id ?? item.id ?? previous?.id ?? '', type: 'function',
      function: { name: item.name ?? previous?.function.name ?? '', arguments: item.arguments ?? previous?.function.arguments ?? '' } };
    toolCalls[index] = call;
    if (complete && typeof item.arguments === 'string') finishedResponseCalls.add(index);
    if (!previous || previous.id !== call.id || previous.function.name !== call.function.name || previous.function.arguments !== call.function.arguments) emitToolCall(index);
  };

  /** 还原器的产出：只有 text 能给界面，toolCall 进 recovered */
  const absorb = (parts: DsmlPart[]) => {
    let text = '';
    for (const p of parts) {
      if (p.kind === 'text') text += p.text;
      else {
        const id = `dsml_${crypto.randomUUID()}`;
        recovered.push({
          id,
          type: 'function',
          function: { name: p.name, arguments: p.arguments },
        });
        onToolCallDelta?.({
          index: Object.keys(toolCalls).length + recovered.length - 1,
          id,
          name: p.name,
          arguments: p.arguments,
        });
      }
    }
    if (text) {
      content += text;
      onDelta?.(text);
    }
  };

  try {
    stream: for (;;) {
      opts.signal?.throwIfAborted();
      const { done, value } = await reader.read();
      opts.signal?.throwIfAborted();
      // Flush TextDecoder on the terminal read so a split UTF-8 code point is not
      // silently lost at the end of an otherwise successful stream.
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      // At EOF the remaining text is itself an event; during streaming retain it
      // until the next blank line arrives.
      buffer = done ? '' : (events.pop() ?? '');
      for (const evt of events) {
        const payload = evt.split(/\r?\n/)
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).replace(/^ /, '')).join('\n').trim();
        if (!payload) continue;
        if (payload === '[DONE]') { ended = t.protocol === 'openai-chat'; break stream; }
        let chunk: any;
        try {
          chunk = JSON.parse(payload);
        } catch {
          // A complete SSE event is not an incomplete JSON fragment. Propagate
          // this as a stream failure instead of returning a misleading empty or
          // partial answer after silently discarding the provider error.
          throw new Error('模型接口返回了无效的流式 JSON，请重试或检查模型服务');
        }
        if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) throw new Error('模型接口未返回有效的流式消息');
        const streamError = streamErrorOf(/^event:\s*error\s*$/m.test(evt) ? { ...chunk, type: 'error' } : chunk);
        if (streamError) throw new Error(`模型服务返回错误：${streamError}`);
        usage.observe(chunk);
        capture?.(usage.value);
        if (t.protocol === 'anthropic-messages') {
          const delta = chunk.delta;
          if (chunk.type === 'content_block_start') {
            native[chunk.index] = structuredClone(chunk.content_block);
            if (chunk.content_block?.type === 'thinking' && chunk.content_block.thinking) emitReasoning(chunk.content_block.thinking);
            if (chunk.content_block?.type === 'text' && chunk.content_block.text) {
              const text = stripLeakedToolPreamble(chunk.content_block.text);
              if (text) { content += text; onDelta?.(text); }
            }
          }
          const block = native[chunk.index];
          if (chunk.type === 'content_block_delta' && block) {
            if (delta?.type === 'text_delta') block.text = (block.text ?? '') + delta.text;
            if (delta?.type === 'thinking_delta') block.thinking = (block.thinking ?? '') + delta.thinking;
            if (delta?.type === 'signature_delta') block.signature = (block.signature ?? '') + delta.signature;
          }
          if (chunk.type === 'content_block_start' && chunk.content_block?.type === 'tool_use') {
            const i = chunk.index ?? Object.keys(toolCalls).length;
            toolCalls[i] = { id: chunk.content_block.id, type: 'function', function: { name: chunk.content_block.name, arguments: JSON.stringify(chunk.content_block.input ?? {}) } };
            emitToolCall(i);
          }
          if (chunk.type === 'content_block_delta' && delta?.type === 'text_delta' && typeof delta.text === 'string') {
            const text = stripLeakedToolPreamble(delta.text);
            if (text) { content += text; onDelta?.(text); }
          }
          if (chunk.type === 'content_block_delta' && delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') { reasoning += delta.thinking; onReasoning?.(delta.thinking); }
          if (chunk.type === 'content_block_delta' && delta?.type === 'input_json_delta' && delta.partial_json) {
            const i = chunk.index ?? 0;
            const call = toolCalls[i];
            if (call) {
              if (!anthropicArgumentDeltas.has(i)) { call.function.arguments = ''; anthropicArgumentDeltas.add(i); }
              call.function.arguments += delta.partial_json;
              emitToolCall(i);
            }
          }
          if (chunk.type === 'content_block_stop' && block?.type === 'tool_use') block.input = parseArgs(toolCalls[chunk.index]?.function.arguments ?? '{}');
          if (chunk.type === 'message_delta') finish = normalizeFinishReason(chunk.delta?.stop_reason) ?? finish;
          if (chunk.type === 'message_stop') { ended = true; break stream; }
          continue;
        }
        if (t.protocol === 'openai-responses') {
          if (chunk.type === 'response.output_item.done') {
            native[chunk.output_index] = chunk.item;
            absorbSummary(chunk.item, chunk.output_index);
            absorbResponseCall(chunk.item, chunk.output_index, true);
          }
          if (chunk.type === 'response.output_text.delta' && typeof chunk.delta === 'string') {
            const text = stripLeakedToolPreamble(chunk.delta);
            if (text) { content += text; onDelta?.(text); }
          }
          if (chunk.type === 'response.reasoning_summary_text.delta' && typeof chunk.delta === 'string') summaryPart(`${chunk.output_index ?? 0}:${chunk.summary_index ?? 0}`, chunk.delta, true);
          if (chunk.type === 'response.reasoning_summary_text.done' && typeof chunk.text === 'string') summaryPart(`${chunk.output_index ?? 0}:${chunk.summary_index ?? 0}`, chunk.text, false);
          if (chunk.type === 'response.reasoning_text.delta' && typeof chunk.delta === 'string') summaryPart(`${chunk.output_index ?? 0}:${chunk.content_index ?? 0}`, chunk.delta, true);
          if (chunk.type === 'response.reasoning_text.done' && typeof chunk.text === 'string') summaryPart(`${chunk.output_index ?? 0}:${chunk.content_index ?? 0}`, chunk.text, false);
          if (chunk.type === 'response.output_item.added' && chunk.item?.type === 'function_call') {
            const i = chunk.output_index ?? Object.keys(toolCalls).length;
            absorbResponseCall(chunk.item, i, false);
          }
          if (chunk.type === 'response.function_call_arguments.delta') {
            const i = chunk.output_index ?? 0;
            const call = toolCalls[i];
            if (call) {
              call.function.arguments += chunk.delta ?? '';
              emitToolCall(i);
            }
          }
          if (chunk.type === 'response.function_call_arguments.done') {
            const i = chunk.output_index ?? 0;
            const call = toolCalls[i];
            if (call && typeof chunk.arguments === 'string') {
              call.function.arguments = chunk.arguments;
              finishedResponseCalls.add(i);
              emitToolCall(i);
            }
          }
          if (['response.completed', 'response.incomplete', 'response.failed'].includes(chunk.type)) {
            const responseError = streamErrorOf(chunk.response);
            if (responseError) throw new Error(`模型服务返回错误：${responseError}`);
            responseItems = chunk.response?.output;
            responseItems?.forEach(absorbSummary);
            responseItems?.forEach((item, index) => absorbResponseCall(item, index, true));
            finish = responseFinishReason({ ...chunk.response, status: chunk.response?.status ?? chunk.type.slice('response.'.length) }, Object.values(toolCalls).length > 0);
            ended = true;
            break stream;
          }
          continue;
        }
        const choice = chunk.choices?.[0];
        // finish_reason 只在最后一个 chunk 上出现一次：判断这一轮是否完整全靠它
        if (choice?.finish_reason) finish = normalizeFinishReason(choice.finish_reason) ?? finish;
        const delta = choice?.delta;
        if (!delta) continue;
        if (typeof delta.content === 'string' && delta.content) {
          // ⚠️ 这里过去是「原样显示」，正是 DSML 泄漏被看见的地方：
          // 标记进界面、tool_calls 却是空的，于是 agent 以为模型答完了。
          if (dsml) absorb(dsml.push(delta.content));
          else {
            const text = stripLeakedToolPreamble(delta.content);
            if (text) { content += text; onDelta?.(text); }
          }
        }
        const thought = chatReasoningText(delta);
        if (thought) emitReasoning(thought);
        if (delta.extra_content) extraContent = { ...extraContent, ...delta.extra_content };
        if (!thought && delta.reasoning_details) {
          const visible = reasoningDetailsText(delta.reasoning_details);
          if (visible) emitReasoning(visible);
        }
        if (Array.isArray(delta.reasoning_details)) for (const detail of delta.reasoning_details) appendReasoningDetail(reasoningDetails, detail);
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const i = tc.index ?? 0;
            if (tc.extra_content) toolExtras.set(i, { ...toolExtras.get(i), ...tc.extra_content });
            if (!toolCalls[i]) {
              toolCalls[i] = { id: tc.id ?? '', type: 'function', function: { name: '', arguments: '' } };
              emitToolCall(i);
            }
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
            if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
            if (tc.id || tc.function?.name || tc.function?.arguments) emitToolCall(i);
          }
        }
      }
      if (done) break;
    }
  } finally {
    // Do not retain a live response after [DONE], parser failure or a throwing
    // UI callback. Never let cancellation mask the original error.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  // A clean HTTP EOF does not prove the model finished. Some proxies simply
  // close a broken upstream connection; do not execute its partial tool calls.
  if (!ended && (t.protocol === 'openai-responses' || !finish)) throw new Error('模型响应流意外结束，未收到完成标记');
  if (t.protocol === 'openai-responses' && finish === 'tool_calls'
    && Object.keys(toolCalls).some(index => !finishedResponseCalls.has(Number(index)))) {
    throw new Error('模型返回了未完成的工具调用，请重试或检查模型服务');
  }
  if (dsml) absorb(dsml.flush());
  const msg: ChatMessage = { role: 'assistant', content: content || null };
  if (reasoning) msg.reasoning_content = reasoning;
  // [DONE]/native terminal events are sufficient even without finish_reason.
  if (finish) msg.finish_reason = finish;
  const calls = [...Object.values(toolCalls), ...recovered];
  if (calls.length > 0) msg.tool_calls = calls;
  if (usage.value) msg.usage = usage.value;
  const items = t.protocol === 'openai-chat'
    ? [{ ...(reasoning ? { reasoning_content: reasoning } : {}), ...(reasoningDetails.length ? { reasoning_details: reasoningDetails } : {}),
      ...(extraContent ? { extra_content: extraContent } : {}),
      ...(toolExtras.size ? { tool_calls: Object.entries(toolCalls).map(([index, call]) => ({ ...call, ...(toolExtras.has(Number(index)) ? { extra_content: toolExtras.get(Number(index)) } : {}) })) } : {}) }].filter(item => Object.keys(item).length)
    : responseItems ?? Object.values(native);
  if (items.length) msg.providerState = { providerId: t.providerId, baseUrl: t.stateScope ?? t.baseUrl, model: t.model, protocol: t.protocol, items };
  return msg;
}
