import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { Peer, clientRequestSchema, type ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import { TypertRegistry, type TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import { ClientRuntimeService } from '@wangke/remote-host';
import type { ResourceFiles } from '../projects/resources.js';
import { TYPERT } from '@wangke/remote-artifacts/host';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { PluginService } from '../plugins/service.js';
import { ClientRuntimeDomain } from './domain.js';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';
import type { CloudConfiguration } from '../cloud/config.js';

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap { wangke: { kind: 'wangke'; accountId: string } }
}

/** Fastify and Wangke account policy only; Typert owns dispatch/codec/mux. */
export function registerClientRuntime(app: FastifyInstance, options: {
  store: DatabaseStore; plugins: PluginService;
  identity(request: { headers: IncomingMessage['headers'] }): { id: string } | null;
  origin(request: FastifyRequest, reply: FastifyReply): boolean;
  canStart(): boolean;
  canExecute(): boolean;
  resources: ResourceFiles;
  configuration: CloudConfiguration;
  submitTask(owner: string, request: RuntimeTaskSubmit): unknown;
}) {
  const ctx = new Context();
  const domain = new ClientRuntimeDomain(options.store, options.plugins, options.submitTask, options.resources, options.configuration);
  let handler: ConnectionRpcHandler | undefined;
  const livePeers = new Map<Peer, { request: { headers: IncomingMessage['headers'] }; account?: string }>();
  const createPeer = (request: { headers: IncomingMessage['headers'] }) => {
    const account = options.identity(request)?.id;
    if (!account) return;
    const peer = new Peer(ctx, { principal: { kind: 'wangke', accountId: account } });
    domain.admit(peer, () => options.identity(request)?.id === account ? account : undefined);
    return peer;
  };
  const validOrigin = (request: IncomingMessage) => {
    let refused = false;
    const reply = { code: () => ({ send: () => { refused = true; } }) } as unknown as FastifyReply;
    const allowed = options.origin({ headers: request.headers, protocol: 'encrypted' in request.socket && request.socket.encrypted ? 'https' : 'http' } as FastifyRequest, reply);
    return allowed && !refused;
  };
  const setup = (async () => {
    await ctx.plugin(TypertRegistry);
    ctx.typert.register(TYPERT as TypertContribution);
    ctx.provide('remoteAccess', {
      // Only this facade is admitted. It resolves all resources using the
      // authenticated account and retains original per-call domain checks.
      decide: ({ principal, action }: { principal: { kind: string }; action: string }) =>
         principal.kind === 'wangke' && action.startsWith('clientRuntime/') ? { kind: 'allow' } : { kind: 'deny', reason: 'scope' },
    });
    ctx.provide('connection', {
      rpc: { intercept: (_channel: string, _matches: unknown, callback: ConnectionRpcHandler) => { handler = callback; return async () => { handler = undefined; }; } },
      admitConnection: (request: IncomingMessage) => {
        if (!validOrigin(request)) return { rejection: 403 };
        const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
        if (protocols.some(protocol => protocol.startsWith('wangke-executor'))) return { rejection: 403 };
        if (!options.canStart()) return { rejection: 403 };
        const peer = createPeer(request);
        if (!peer) return { rejection: 401 };
        if (livePeers.size >= 64) { void peer.dispose(); return { rejection: 409 }; }
        livePeers.set(peer, { request, account: options.identity(request)!.id });
        return { peer, release: async () => { livePeers.delete(peer); await peer.dispose(); } };
      },
    });
    ctx.provide('webServer', {
      registerUpgrade: (route: { path: string; handler(request: IncomingMessage, socket: Duplex, head: Buffer): void }) => {
        const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
          if (request.url?.split('?')[0] === route.path) route.handler(request, socket, head);
        };
        app.server.on('upgrade', upgrade);
        return () => { app.server.off('upgrade', upgrade); };
      },
    });
    await ctx.plugin((scope: Context) => { new ClientRuntimeService(scope, domain); });
    await ctx.plugin(TypertGatewayService, { websocketHeartbeatIntervalMs: 15_000, streamInboxBytes: 262144, websocketCompression: 'none' });
    // Ready is emitted by upstream only after this event source is attached.
    ctx.typertGateway.registerRemoteEvents(async function* (signal: AbortSignal) {
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); });
    }, { home: '' });
  })();
  app.addHook('onReady', async () => { await setup; });
  app.post<{ Params: { namespace: string; method: string } }>('/api/:namespace/:method', async (request, reply) => {
    await setup;
    if (!options.origin(request, reply)) return;
    if (!options.canStart()) return reply.code(503).send({ error: 'api_draining' });
    const peer = createPeer(request);
    if (!peer) return reply.code(401).send({ error: 'unauthorized' });
    const control = new AbortController();
    const closed = () => { if (!reply.raw.writableFinished) control.abort(); };
    reply.raw.once('close', closed);
    try {
      const parsed = clientRequestSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_remote_envelope' });
      const body = parsed.data;
      const endpoint = `${request.params.namespace}/${request.params.method}`;
      if (body.method !== endpoint || !handler) return reply.code(400).send({ error: 'invalid_remote_target' });
      return { type: 'server-response', rpcId: body.rpcId, result: await handler(endpoint, body.payload, control.signal, peer) };
    } finally { reply.raw.off('close', closed); await peer.dispose(); }
  });
  // Authentication expiry is a lease check, not business polling. Every domain
  // invocation also revalidates. Disposing a Peer closes all its streams/socket.
  const authLease = setInterval(() => {
    for (const [peer, entry] of livePeers) {
      const valid = options.canStart() && options.identity(entry.request)?.id === entry.account;
      if (!valid) { livePeers.delete(peer); void peer.dispose(); }
    }
  }, 1000);
  authLease.unref();
  return {
    diagnostics: () => ({ peers: livePeers.size, ...domain.diagnostics() }),
    close: async () => { clearInterval(authLease); await setup; await ctx.fiber.dispose(); domain.close(); },
  };
}
