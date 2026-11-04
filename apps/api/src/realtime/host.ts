import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { Context } from '@deepseek-ai/cordis';
import { Peer, clientRequestSchema, type ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import { TypertRegistry, type TypertContribution } from '@deepseek-ai/dsh-typert-registry';
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway';
import { ClientRuntimeService, ExecutorRuntimeService } from '@wangke/remote-host';
import { ExecutorRuntimeDomain } from './executor.js';
import { workerTokens, workerTokenHash } from '../cloud/workerAuth.js';
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
  interface PrincipalMap { wangkeExecutor: { kind: 'wangkeExecutor'; taskId: string } }
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
  prepareRecords(owner: string): void;
}) {
  const ctx = new Context();
  const domain = new ClientRuntimeDomain(options.store, options.plugins, options.submitTask, options.prepareRecords, options.resources);
  const executor = new ExecutorRuntimeDomain(options.store, options.configuration, 30000, options.resources);
  let handler: ConnectionRpcHandler | undefined;
  const livePeers = new Map<Peer, { request: { headers: IncomingMessage['headers'] }; account?: string; workerToken?: string }>();
  const createPeer = (request: { headers: IncomingMessage['headers'] }) => {
    if (request.headers.authorization?.startsWith('Bearer ')) {
      const token = request.headers.authorization.slice(7), worker = workerTokens.get(token);
      // Bearer is a transport, not a principal type. Only a registered task
      // capability is a Worker; normal api_tokens are account credentials.
      if (worker) {
        if (worker.expiresAt <= Date.now()) return;
        const peer = new Peer(ctx, { principal: { kind: 'wangkeExecutor', taskId: worker.taskId } });
        executor.admit(peer, token);
        return peer;
      }
    }
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
        principal.kind === 'wangke' && action.startsWith('clientRuntime/') || principal.kind === 'wangkeExecutor' && action.startsWith('executorRuntime/') ? { kind: 'allow' } : { kind: 'deny', reason: 'scope' },
    });
    ctx.provide('connection', {
      rpc: { intercept: (_channel: string, _matches: unknown, callback: ConnectionRpcHandler) => { handler = callback; return async () => { handler = undefined; }; } },
      admitConnection: (request: IncomingMessage) => {
        if (!validOrigin(request)) return { rejection: 403 };
        const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
        if (bearer && workerTokens.has(bearer)) return { rejection: 403 };
        const protocols = String(request.headers['sec-websocket-protocol'] ?? '').split(',').map(value => value.trim());
        if (protocols[0] === 'wangke-executor') {
          if (!options.canExecute()) return { rejection: 403 };
          // Explicit capability carrier. Never fall back to ambient Cookie,
          // including for unknown, expired, malformed or wrong-task tokens.
          const token = protocols[1], worker = protocols.length === 2 && token && workerTokens.get(token);
          const task = worker && options.store.db.prepare('SELECT worker_id,lease_expires_at,status FROM cloud_tasks WHERE id=? AND owner_id=?').get(worker.taskId, worker.id) as any;
          if (!worker || worker.expiresAt <= Date.now() || !task || !['running', 'waiting_user'].includes(task.status) || task.worker_id !== workerTokenHash(token) || !Number.isFinite(Date.parse(task.lease_expires_at)) || Date.parse(task.lease_expires_at) <= Date.now()) return { rejection: 403 };
          if (livePeers.size >= 64) return { rejection: 409 };
          const peer = new Peer(ctx, { principal: { kind: 'wangkeExecutor', taskId: worker.taskId } });
          executor.admit(peer, token);
          livePeers.set(peer, { request, workerToken: token });
          return { peer, release: async () => { livePeers.delete(peer); await peer.dispose(); } };
        }
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
    await ctx.plugin((scope: Context) => { new ExecutorRuntimeService(scope, executor); });
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
    const bearer = request.headers.authorization?.startsWith('Bearer ') ? request.headers.authorization.slice(7) : undefined;
    if (bearer && workerTokens.has(bearer) && request.params.namespace !== 'executorRuntime') return reply.code(403).send({ error: 'worker_scope_denied' });
    const executorCall = request.params.namespace === 'executorRuntime' && request.headers.authorization?.startsWith('Bearer ');
    if (!(executorCall ? options.canExecute() : options.canStart())) return reply.code(503).send({ error: 'api_draining' });
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
      const worker = entry.workerToken && workerTokens.get(entry.workerToken);
      const task = worker && options.store.db.prepare('SELECT worker_id,status,lease_expires_at FROM cloud_tasks WHERE id=? AND owner_id=?').get(worker.taskId, worker.id) as any;
      const valid = entry.workerToken ? options.canExecute() && worker && worker.expiresAt > Date.now() && task && ['running', 'waiting_user'].includes(task.status) && task.worker_id === workerTokenHash(entry.workerToken) && Number.isFinite(Date.parse(task.lease_expires_at)) && Date.parse(task.lease_expires_at) > Date.now() : options.canStart() && options.identity(entry.request)?.id === entry.account;
      if (!valid) { livePeers.delete(peer); void peer.dispose(); }
    }
  }, 1000);
  authLease.unref();
  return {
    diagnostics: () => ({ peers: livePeers.size, ...domain.diagnostics() }),
    close: async () => { clearInterval(authLease); await setup; await ctx.fiber.dispose(); domain.close(); },
  };
}
