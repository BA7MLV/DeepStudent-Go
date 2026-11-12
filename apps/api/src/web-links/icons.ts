import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { linkIconHost, linkIconOrigin } from '@wangke/contracts/web-links';
import { publicUrl, publicWebDispatcher } from '../web-search/fetch.js';

type Icon = { bytes: Buffer; type: string };
const MAX_BYTES = 64 * 1024;
const DAY = 24 * 60 * 60 * 1000;

/** Fetch only the source origin's favicon, never a user's page path or query.
 * Redirects are bounded and DNS is checked at connection time on every host. */
export class LinkIcons {
  private cache = new Map<string, { icon: Icon | null; expires: number }>();
  private pending = new Map<string, Promise<Icon | null>>();
  constructor(private fetcher: typeof fetch = fetch) {}

  async get(origin: string): Promise<Icon | null> {
    if (linkIconOrigin(origin) !== origin) return null;
    const cached = this.cache.get(origin);
    if (cached && cached.expires > Date.now()) return cached.icon;
    const active = this.pending.get(origin);
    if (active) return active;
    if (this.pending.size >= 8) return null;
    const task = this.load(origin).catch(() => null).then(icon => {
      this.cache.delete(origin);
      this.cache.set(origin, { icon, expires: Date.now() + (icon ? DAY : 5 * 60 * 1000) });
      while (this.cache.size > 256) this.cache.delete(this.cache.keys().next().value!);
      return icon;
    }).finally(() => this.pending.delete(origin));
    this.pending.set(origin, task);
    return task;
  }

  private async load(origin: string): Promise<Icon | null> {
    let url = new URL('/favicon.ico', origin);
    const signal = AbortSignal.timeout(4000);
    for (let hop = 0; hop <= 3; hop++) {
      url = publicUrl(url.href);
      if (!linkIconHost(url.hostname)) return null;
      const response = await this.fetcher(url.href, {
        redirect: 'manual', credentials: 'omit', signal, dispatcher: publicWebDispatcher,
        headers: { accept: 'image/x-icon, image/vnd.microsoft.icon, image/png', 'user-agent': 'Wangke-Favicon/1.0' },
      } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 3) return null;
        const next = new URL(location, url);
        if (url.protocol === 'https:' && next.protocol !== 'https:') return null;
        url = next;
        continue;
      }
      return this.read(response);
    }
    return null;
  }

  private async read(response: Response): Promise<Icon | null> {
    if (!response.ok || Number(response.headers.get('content-length')) > MAX_BYTES) {
      await response.body?.cancel(); return null;
    }
    const reader = response.body?.getReader();
    if (!reader) return null;
    const parts: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); return null; }
        parts.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    const bytes = Buffer.concat(parts);
    // Never serve HTML/SVG or trust an upstream Content-Type on our origin.
    const type = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png'
      : bytes.length >= 6 && bytes.readUInt32LE(0) === 0x00010000 && bytes.readUInt16LE(4) > 0 ? 'image/x-icon' : null;
    return type ? { bytes, type } : null;
  }
}

export function registerLinkIconRoutes(app: FastifyInstance, deps: {
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => unknown;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  fetch?: typeof fetch;
}) {
  const icons = new LinkIcons(deps.fetch);
  app.get<{ Querystring: { origin?: string } }>('/api/v1/link-icons', async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (!deps.checkOrigin(request, reply) || !deps.requireAuth(request, reply)) return;
    const origin = linkIconOrigin(request.query.origin);
    if (!origin) return reply.code(204).send();
    const icon = await icons.get(origin);
    reply.header('cache-control', `private, max-age=${icon ? 86400 : 300}`);
    if (!icon) return reply.code(204).send();
    return reply.header('x-content-type-options', 'nosniff').type(icon.type).send(icon.bytes);
  });
}
