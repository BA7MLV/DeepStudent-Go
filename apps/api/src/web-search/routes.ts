import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from '../cloud/records.js';
import type { CloudConfiguration } from '../cloud/config.js';
import type { WebSearchConfig } from '@wangke/contracts/web-search';
import { WebSearchError } from './config.js';
import { WebSearchService, webError } from './service.js';

export function registerWebSearchRoutes(app: FastifyInstance, deps: {
  service: WebSearchService; store: DatabaseStore; records: CloudRecords; configuration: CloudConfiguration;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => any;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
}) {
  const { service, store, records, configuration } = deps;
  const authorize = (request: FastifyRequest, reply: FastifyReply, admin = false) => {
    if (request.method !== 'GET' && !deps.checkOrigin(request, reply)) return null;
    const user = deps.requireAuth(request, reply);
    reply.header('cache-control', 'no-store'); return user;
  };
  const scope = (owner: string, sessionId: unknown, request: FastifyRequest) => {
    if (!Number.isSafeInteger(sessionId) || !records.get(owner, 'chatSessions', sessionId as number)) throw new WebSearchError('web_context_denied', 403);
    const policy = configuration.get(owner).policy;
    return policy.network === 'allow';
  };
  const fail = (reply: FastifyReply, error: unknown) => { const e = webError(error); return reply.code(e.status >= 400 && e.status <= 599 ? e.status : 502).send({ error: e.code }); };
  app.get('/api/v1/cloud/web-search/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return service.configuration.get(user.id);
  });
  app.put<{ Body: WebSearchConfig }>('/api/v1/cloud/web-search/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return service.configuration.save(user.id, request.body); } catch (e) { return fail(reply, e); }
  });
  app.post<{ Body: { sessionId: number } }>('/api/v1/cloud/web-search/catalog', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return { tools: service.definitions(user.id, scope(user.id, request.body?.sessionId, request)) }; } catch (e) { return fail(reply, e); }
  });
  for (const test of [false, true]) app.post<{ Body: { sessionId?: number; name: string; arguments: Record<string, unknown> } }>(`/api/v1/cloud/web-search/${test ? 'test' : 'call'}`, async (request, reply) => {
    const user = authorize(request, reply, test); if (!user) return;
    const controller = new AbortController();
    const abort = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on('close', abort);
    try {
      const permitted = () => test ? configuration.get(user.id).policy.network === 'allow' : scope(user.id, request.body?.sessionId, request);
      const result = await service.call(user.id, test ? 'websearch' : request.body?.name, request.body?.arguments, controller.signal, permitted);
      return result;
    } catch (e) { return fail(reply, e); }
    finally { reply.raw.off('close', abort); }
  });
}
