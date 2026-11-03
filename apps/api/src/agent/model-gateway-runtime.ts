import type { ModelTarget } from '@wangke/study-core/model/types';
import type { TaskContext } from '../cloud/execution.js';
import { createModelGateway } from './model-gateway-factory.js';

const virtualOrigin = 'https://model-gateway.invalid';
/** Compatibility target for the existing streaming codec. It is NOT a provider
 * connection. The virtual address is accepted only by gatewayTaskFetch below. */
export function gatewayTaskTarget(context: TaskContext, options?: { useDefaultModel: boolean }): ModelTarget {
  const input = context.task.input;
  const modelRef = context.task.kind === 'modelOnce' && !options?.useDefaultModel ? { providerId: String(input.providerId ?? ''), model: String(input.model ?? '') }
    : input.modelRef as { providerId: string; model: string } | undefined;
  const gateway = createModelGateway(context.store, context.configuration, context.fetch);
  let target: ReturnType<typeof gateway.target>;
  try { target = gateway.target({ owner: context.owner, purpose: 'chat', modelRef }); }
  catch { throw new Error('model_not_configured'); }
  return { ...target, baseUrl: `${virtualOrigin}/${encodeURIComponent(target.providerId)}`, apiKey: '', gatewayManaged: true };
}
export function gatewayTaskFetch(context: TaskContext): typeof fetch {
  return async (url, init) => {
    context.checkActive();
    let address: URL;
    try { address = new URL(String(url)); } catch { throw new Error('invalid_gateway_request'); }
    const match = /^\/([^/]+)\/(chat\/completions|responses|messages)$/.exec(address.pathname);
    if (address.origin !== virtualOrigin || address.username || address.password || address.search || address.hash || !match || typeof init?.body !== 'string') throw new Error('invalid_gateway_request');
    let body: { model?: unknown };
    try { body = JSON.parse(init.body); } catch { throw new Error('invalid_gateway_request'); }
    if (!body || typeof body.model !== 'string') throw new Error('invalid_gateway_request');
    const linked = context.store.db.prepare('SELECT parent_run_id,parent_step_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { parent_run_id: string | null; parent_step_id: string | null };
    const response = await createModelGateway(context.store, context.configuration, context.fetch).forward({ owner: context.owner, purpose: 'chat', modelRef: { providerId: decodeURIComponent(match[1]), model: body.model }, endpoint: match[2], body: init.body,
      cacheKey: new Headers(init.headers).get('x-wangke-cache-key') ?? undefined,
      conversationId: typeof context.task.input.conversationId === 'string' ? context.task.input.conversationId : context.task.input.sessionId !== undefined ? `session:${context.task.input.sessionId}` : `task:${context.task.id}`,
      signal: AbortSignal.any([context.signal, ...(init.signal ? [init.signal] : [])]), attribution: { run: linked.parent_run_id ?? undefined, step: linked.parent_step_id ?? undefined, task: context.task.id, purpose: `study:${context.task.kind}` } });
    context.checkActive();
    return response;
  };
}
