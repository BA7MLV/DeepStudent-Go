import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { fetchVideoView, probeBiliLogin } from '@wangke/study-core/bilibili/api';
import { resolveBiliTarget } from '@wangke/study-core/bilibili/target';
import { fetchBiliSubtitleList } from '@wangke/study-core/bilibili/dmview';
import { biliCookie, saveBiliCookie } from './credentials.js';
import { biliNetwork } from './network.js';
import { extractBiliInput } from '@wangke/study-core/bilibili/parse';
import { biliResolveFailure } from './errors.js';

export function registerBilibiliRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore; configuration: CloudConfiguration; fetch?: typeof fetch;
  requireAuth(request: FastifyRequest, reply: FastifyReply): { id: string } | null;
  checkOrigin(request: FastifyRequest, reply: FastifyReply): boolean;
}) {
  const auth = (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' && !deps.checkOrigin(request, reply)) return null;
    reply.header('cache-control', 'no-store');
    return deps.requireAuth(request, reply);
  };
  const network = (owner: string) => biliNetwork(deps.fetch ?? fetch, biliCookie(deps.store, deps.configuration, owner), AbortSignal.timeout(60000));
  app.get('/api/v1/cloud/bilibili/status', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const cookie = biliCookie(deps.store, deps.configuration, user.id);
    const login = await probeBiliLogin({ request: network(user.id) });
    return { configured: Boolean(cookie), login };
  });
  app.put<{ Body: { cookie: string } }>('/api/v1/cloud/bilibili/credentials', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    if (!request.body || Object.keys(request.body).some(k => k !== 'cookie')) return reply.code(400).send({ error: 'Cookie 格式无效。' });
    try { return saveBiliCookie(deps.store, deps.configuration, user.id, request.body.cookie); }
    catch (error) { return reply.code(400).send({ error: (error as Error).message }); }
  });
  app.post<{ Body: { raw: string } }>('/api/v1/cloud/bilibili/resolve', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    if (typeof request.body?.raw !== 'string' || request.body.raw.length > 16384 || Object.keys(request.body).some(k => k !== 'raw')) return reply.code(400).send({ error: '请输入有效的 B 站视频链接或 BV 号。' });
    const input = extractBiliInput(request.body.raw);
    if (!input) return reply.code(400).send({ error: '未识别到 B 站视频链接，请粘贴视频分享文案、视频链接或 BV 号。' });
    try {
      const target = await resolveBiliTarget({ request: network(user.id) }, input);
      // The browser selects language identifiers, never fetches signed URLs.
      return { ...target, subtitles: target.subtitles.map(item => ({ ...item, url: '' })) };
    } catch (error) {
      const failure = biliResolveFailure(error);
      request.log.warn({ event: 'bilibili_resolve_failed', status: failure.status, reason: failure.error }, 'Bilibili resolve failed');
      return reply.code(failure.status).send({ error: failure.error });
    }
  });
  app.post<{ Body: { bvid: string; cid: number } }>('/api/v1/cloud/bilibili/subtitles', async (request, reply) => {
    const user = auth(request, reply); if (!user) return;
    const body = request.body;
    if (!body || !/^BV[0-9A-Za-z]{10}$/.test(body.bvid) || !Number.isSafeInteger(body.cid) || body.cid <= 0 || Object.keys(body).some(k => !['bvid', 'cid'].includes(k))) return reply.code(400).send({ error: '视频标识无效。' });
    try {
      const requestBili = network(user.id), view = await fetchVideoView({ request: requestBili }, body.bvid);
      if (!view.pages.some(p => p.cid === body.cid)) return reply.code(400).send({ error: '分 P 已变化，请重新解析视频。' });
      const items = await fetchBiliSubtitleList(requestBili, view.aid, body.cid);
      return { items: items.map(item => ({ ...item, url: '' })) };
    } catch { return reply.code(502).send({ error: '服务器暂时无法获取 B 站字幕列表。' }); }
  });
}
