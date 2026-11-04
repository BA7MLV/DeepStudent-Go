import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { SystemMaterials } from './system-materials.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { MCP_PATH, systemSaveArguments } from '@wangke/contracts/system';

export function registerSystemRoutes(app: FastifyInstance, files: SystemMaterials, configuration: CloudConfiguration,
  auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null,
  origin: (r: FastifyRequest, p: FastifyReply) => boolean) {
  const safe = (p: FastifyReply, action: () => unknown) => {
    try { return action(); } catch (e) {
      const code = e instanceof Error && /^[a-z_]{1,80}$/.test(e.message) ? e.message : 'system_file_failed';
      return p.code(code.includes('conflict') || code === 'system_file_changed' ? 409 : code.endsWith('not_found') ? 404 : 400).send({ error: code });
    }
  };
  app.get<{ Querystring: { path: string; offset?: string; query?: string } }>('/api/v1/system/files', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    return safe(p, () => files.list(u.id, r.query.path, Number(r.query.offset ?? 0), r.query.query ?? ''));
  });
  app.get<{ Querystring: { path: string } }>('/api/v1/system/file', async (r, p) => {
    const u = auth(r, p); if (!u) return;
    return safe(p, () => files.read(u.id, r.query.path));
  });
  app.post<{ Body: { path: string; content: string; expected: string; revision: number; permissionId?: string } }>('/api/v1/system/file', async (r, p) => {
    if (!origin(r, p)) return;
    const u = auth(r, p); if (!u) return;
    return safe(p, () => {
      const result = files.save(u.id, r.body?.path, r.body?.content, r.body?.expected, r.body?.revision);
      return result;
    });
  });
}
