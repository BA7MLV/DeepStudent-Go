import crypto from 'node:crypto';
import type { ModelProtocol } from '@wangke/contracts/cloud';
import { ModelFailure } from './model-client.js';

export const GO_PROVIDER = 'opencode-go';
export const GO_BASE = 'https://opencode.ai/inference/go';
export const GO_USER_AGENT = 'wangke-model-gateway/0.1';
/** No user-supplied origin, endpoint or auth header is ever used for Go. Google
 * native needs its own codec and is deliberately not advertised as supported. */
export function goBase(protocol: ModelProtocol) {
  return `${GO_BASE}/${protocol === 'anthropic-messages' ? 'anthropic' : 'openai'}/v1`;
}
export function goTransport(protocol: ModelProtocol, path: string, key: string | undefined, identity?: { owner: string; conversationId?: string }) {
  if (!['models', 'responses', 'chat/completions', 'messages'].includes(path)) throw new Error('model_protocol_mismatch');
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': GO_USER_AGENT };
  if (path !== 'models') {
    if (!key) throw new ModelFailure('model_auth_failed');
    if (!identity?.conversationId || typeof identity.conversationId !== 'string' || identity.conversationId.length > 500 || /[\u0000-\u001f\u007f]/.test(identity.conversationId)) throw new Error('model_conversation_required');
    // Owner-scoped, deterministic and opaque; never derive from run/attempt IDs.
    headers['x-opencode-session'] = crypto.createHash('sha256').update(JSON.stringify([identity.owner, identity.conversationId])).digest('hex');
  }
  if (key) headers.authorization = `Bearer ${key}`;
  if (protocol === 'anthropic-messages') headers['anthropic-version'] = '2023-06-01';
  return { url: path === 'models' ? `${GO_BASE}/v1/models` : `${goBase(protocol)}/${path}`, headers };
}
