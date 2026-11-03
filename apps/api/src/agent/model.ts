import type { CloudProvider, ModelCall, ModelMessage, ModelTool } from '@wangke/contracts/cloud';
import type { ModelTarget } from '@wangke/study-core/model/types';
import { decodeResponse, requestBody, textOf, type ChatMessage, type ChatOptions, type ToolDef } from '@wangke/study-core/model/client';
export type { ModelCall, ModelMessage } from '@wangke/contracts/cloud';

/** Runtime ID/provenance bridge only. All protocol encoding/decoding lives in
 * study-core/model/client, shared with Chat (including thinking and hygiene). */
export function modelMessageView(target: ModelTarget, messages: ModelMessage[], legacy = false): ChatMessage[] {
  const ids = new Map(messages.flatMap(m => (m.tool_calls ?? []).map(c => [c.id, c.provider_id ?? c.id] as const)));
  return messages.map(m => {
    if (!['system', 'user', 'assistant', 'tool'].includes(m.role)) throw new Error('invalid_model_message');
    const calls = m.tool_calls?.map(c => ({ id: c.provider_id ?? c.id, type: 'function' as const, function: c.function }));
    // response_items belongs to older persisted Bot runs. It can be upgraded
    // only by the caller that has already checked the saved target/revision.
    const state = m.providerState ?? (legacy && m.response_items?.length ? {
      providerId: target.providerId, model: target.model, protocol: target.protocol,
      baseUrl: target.stateScope ?? target.baseUrl, items: m.response_items,
    } : undefined);
    return { role: m.role as ChatMessage['role'], content: m.content,
      ...(calls ? { tool_calls: calls } : {}),
      ...(m.tool_call_id ? { tool_call_id: ids.get(m.tool_call_id) ?? m.tool_call_id } : {}),
      ...(m.reasoning_content ? { reasoning_content: m.reasoning_content } : {}),
      ...(state ? { providerState: state } : {}),
    };
  });
}

/** @deprecated Compatibility entry for older tests/integrations. Not a second
 * codec: convert Bot's local tool IDs then call the same encoder as Chat. */
export function botRequest(provider: Pick<CloudProvider, 'protocol' | 'apiKey'> & Partial<Pick<CloudProvider, 'id' | 'baseUrl' | 'catalogId'>>, model: string, messages: ModelMessage[], tools: ModelTool[], outputTokens = 4096, cacheKey?: string, options: Pick<ChatOptions, 'thinkingLevel' | 'temperature' | 'tool_choice'> = {}) {
  const target: ModelTarget = { providerId: provider.id ?? '', protocol: provider.protocol, baseUrl: provider.baseUrl ?? '', catalogId: provider.catalogId ?? '', apiKey: '', model };
  const turns = modelMessageView(target, messages, true);
  const body = requestBody(target, { messages: turns, tools: tools as ToolDef[], max_tokens: outputTokens, cacheKey, ...options }, turns, false);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (target.protocol === 'anthropic-messages') {
    headers['anthropic-version'] = '2023-06-01';
    if (provider.apiKey) headers['x-api-key'] = provider.apiKey;
  } else if (provider.apiKey) headers.authorization = `Bearer ${provider.apiKey}`;
  return { path: target.protocol === 'anthropic-messages' ? 'messages' : target.protocol === 'openai-responses' ? 'responses' : 'chat/completions', headers, body };
}

/** Legacy array projection. New runtime checkpoints store endpoint-bound state. */
export function responseContinuation(protocol: CloudProvider['protocol'], body: unknown): object[] | undefined {
  return decodeResponse({ providerId: '', model: '', protocol, baseUrl: '', apiKey: '', catalogId: '' }, body).providerState?.items;
}

export function botReply(protocol: CloudProvider['protocol'], body: unknown): { text: string; calls: Array<{ id?: string; function: ModelCall['function'] }> } {
  // Preserve the legacy caller's incomplete-response error contract, even if a
  // refused response omitted the normal content envelope entirely.
  const status = body as { status?: string; stop_reason?: string } | null;
  if (['incomplete', 'failed'].includes(status?.status ?? '') || ['max_tokens', 'refusal'].includes(status?.stop_reason ?? '')) throw new Error('model_incomplete_or_refused');
  const message = decodeResponse({ providerId: '', model: '', protocol, baseUrl: '', apiKey: '', catalogId: '' }, body);
  if (message.finish_reason && ['length', 'content_filter', 'error', 'aborted'].includes(message.finish_reason)) throw new Error('model_incomplete_or_refused');
  const text = textOf(message), calls = (message.tool_calls ?? []).map(c => ({ ...(c.id ? { id: c.id } : {}), function: c.function }));
  if (!calls.length && !text.trim()) throw new Error('invalid_structured_response');
  return { text, calls };
}

export function botCalls(protocol: CloudProvider['protocol'], body: unknown) { return botReply(protocol, body).calls; }
