import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { BotApplicationService } from '../agent/service.js';
import type { CloudTaskRunner } from '../cloud/tasks.js';
import { PluginService } from './service.js';
import type { ResourceFiles } from '../projects/resources.js';

export function registerPluginRoutes(app: FastifyInstance, store: DatabaseStore, bots: BotApplicationService, runner: CloudTaskRunner,
  auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null,
  origin: (r: FastifyRequest, p: FastifyReply) => boolean, learningOptions?: { filesDir: string; resources?: ResourceFiles }) {
  const service = new PluginService(store, bots, runner, learningOptions), files = service.files;
  const safe = async (p: FastifyReply, fn: () => unknown) => {
    try { return await fn(); } catch (e) {
      const error = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'plugin_request_failed';
      return p.code(error.includes('conflict') || error === 'plugin_changed' ? 409 : error.includes('denied') ? 403 : error.endsWith('not_found') ? 404 : 400).send({ error });
    }
  };
  app.get('/api/v1/plugins', async (r, p) => { const u = auth(r, p); if (u) return safe(p, () => ({ plugins: files.catalog(u.id), layout: files.layout(u.id), scopes: files.scopeCatalog(u.id), services: service.definitions(u.id) })); });
  app.post<{ Params: { id: string }; Body: { source: 'v1' | 'v2' | 'builtin'; status: 'enabled' | 'disabled' | 'uninstalled'; expected: string; revision: number } }>('/api/v1/plugins/:id/lifecycle', async (r, p) => {
    if (!origin(r, p)) return; const u = auth(r, p); if (!u) return;
    return safe(p, () => files.lifecycle(u.id, r.params.id, r.body.source, r.body.status, r.body.expected, r.body.revision));
  });
  app.post<{ Body: Record<string, unknown> }>('/api/v1/plugins/tool', async (r, p) => {
    if (!origin(r, p)) return; const u = auth(r, p); if (!u) return;
    return safe(p, () => service.tool(u.id, r.body));
  });
  app.get<{ Params: { id: string; view: string } }>('/api/v1/plugins/:id/views/:view', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    return safe(p, () => {
      const plugin = files.plugin(u.id, r.params.id), view = plugin.manifest.views[r.params.view];
      if (!view) throw new Error('plugin_view_not_found');
      const resource = `${plugin.path}/${view.entry}`;
      return { ...plugin, html: (plugin.source === 'v1' ? files.board.read(u.id, resource) : files.read(u.id, resource)).content };
    });
  });
  app.post<{ Params: { id: string; instance: string }; Body: { revision: number; method: string; args?: Record<string, unknown> } }>('/api/v1/plugins/:id/instances/:instance/rpc', async (r, p) => {
    if (!origin(r, p)) return; const u = auth(r, p); if (!u) return;
    return safe(p, () => service.invoke(u.id, r.params.id, r.params.instance, r.body?.revision, r.body?.method, r.body?.args ?? {}));
  });
  app.post<{ Params: { id: string; instance: string; action: string }; Body: { revision: number; args: Record<string, unknown> } }>('/api/v1/plugins/:id/instances/:instance/actions/:action', async (r, p) => {
    if (!origin(r, p)) return; const u = auth(r, p); if (!u) return;
    return safe(p, () => service.invokeNamed(u.id, r.params.id, r.params.instance, r.body?.revision, r.params.action, r.body?.args ?? {}));
  });
  return service;
}
