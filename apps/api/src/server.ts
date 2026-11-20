import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import { DatabaseStore } from './storage/database.js';
import { BootstrapRepository } from './storage/bootstrapRepository.js';
import { BotRunner } from './agent/runner.js';
import { registerBotManagement } from './agent/routes.js';
import { MemoryWorker } from './agent/memory-worker.js';
import { BotApplicationService } from './agent/service.js';
import { StudyTools } from './agent/study.js';
import { GatewayCore } from './gateway/core.js';
import { FeishuPlugin } from './gateway/adapters/feishu.js';
import { IlinkPlugin } from './gateway/adapters/ilink.js';
import { registerGatewayRoutes } from './gateway/routes.js';
import { CloudRecords } from './cloud/records.js';
import { CloudConfiguration } from './cloud/config.js';
import { registerCloudRoutes } from './cloud/routes.js';
import { registerBilibiliRoutes } from './bilibili/routes.js';
import { SystemMaterials } from './storage/system-materials.js';
import { registerSystemRoutes } from './storage/system-routes.js';
import { BoardFiles } from './board/files.js';
import { BoardScheduler } from './board/scheduler.js';
import { registerBoardRoutes } from './board/routes.js';
import { registerPluginRoutes } from './plugins/routes.js';
import { pluginTool } from './plugins/tool.js';
import { McpRepository } from './mcp/repository.js';
import { McpManager } from './mcp/manager.js';
import { registerMcpRoutes } from './mcp/routes.js';
import { WebSearchConfiguration } from './web-search/config.js';
import { WebSearchService } from './web-search/service.js';
import { registerWebSearchRoutes } from './web-search/routes.js';
import { registerLinkIconRoutes } from './web-links/icons.js';
import { ProjectRepository } from './projects/repository.js';
import { ProjectError } from './projects/files.js';
import { registerProjectRoutes } from './projects/routes.js';
import { ResourceFiles } from './projects/resources.js';
import { recoverResourceCommands } from './realtime/resources.js';
import { registerResourceRoutes } from './projects/resource-routes.js';
import type { SandboxCleanup, SandboxExecutor } from './agent/sandbox.js';
import { settleWithin } from './lifecycle.js';
import { storageUsageReader } from './storage/usage.js';
import { BotMessageHistory } from './agent/message-history.js';
import { registerClientRuntime } from './realtime/host.js';
import { submitOwnerTask } from './cloud/task-commands.js';
import { sql } from './storage/sql.js';
import { authUserRowSchema, expectRow, expectRows, type AuthUserRow } from './storage/row-schema.js';
import { registerDeploymentRoutes } from './routes/deployment.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerChatAgentRoutes } from './routes/agents.js';
import { registerThreadRoutes } from './routes/threads.js';
import { registerFileRoutes } from './routes/files.js';
import { registerConversationRoutes } from './routes/conversation.js';
import { config, getConfig, initializeConfig } from './config.js';
import { releaseHeld } from './deployment-gate.js';
import { loadOrCreateBootstrapSecretSync, removeBootstrapSecretSync, type BootstrapSecret } from './bootstrap-secret.js';
import { clearDirectory, loadOrCreateBootstrapSecret, removeBootstrapSecret, replaceBootstrapSecret } from './bootstrap-secret.js';
const messageKinds = new Set(['text', 'progress', 'attachment', 'widget', 'question', 'approval']);

const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const parseCookies = (header = '') => {
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals < 1) continue;
    const key = part.slice(0, equals).trim();
    try { result[key] = decodeURIComponent(part.slice(equals + 1).trim()); } catch { /* ignore malformed cookie */ }
  }
  return result;
};
const publicUser = (user: { id: string; name?: string }) => ({ id: user.id, name: user.name ?? '' });

/** 路由按域拆到 src/routes/;本文件只保留装配、中间件、会话/来源校验与生命周期。
 * 路由注册顺序与旧版逐条对应(Fastify 的 notFoundHandler 与 hook 顺序对行为有影响)。 */
export function buildServer(options: { dbPath?: string; fetch?: typeof fetch; sandbox?: SandboxExecutor; sandboxCleanup?: SandboxCleanup } = {}) {
  // 配置在装配入口一次性校验并快照;后面的模块只经 config() 读取,不再碰 env。
  // 同一进程重建 server(测试)时重新校验,所以旧进程里改过的 env 依然生效。
  initializeConfig();
  const settings = config();
  const secretFile = settings.bootstrapSecretFile;
  const releaseId = settings.apiReleaseId;
  const releaseToken = settings.apiReleaseToken;
  const activationFile = releaseId ? path.join(path.dirname(secretFile), `release-activated-${releaseId}`) : null;
  // 发布门禁必须在任何监听/worker 之前就确定;这里是启动期的一次只读探测。
  let held = releaseHeld({ releaseId, releaseToken, activationFile, hashToken });
  const dbPath = options.dbPath ?? settings.dbPath;
  const bootstrapTtlMs = settings.bootstrapTtlMs;
  const sessionTtlMs = settings.sessionTtlMs;
  const filesDir = settings.filesDir;
  const readStorageUsage = storageUsageReader({ dataDir: settings.dataDir, dbPath, filesDir, configDir: path.dirname(secretFile) });
  const maxFileBytes = settings.maxFileBytes;
  fs.mkdirSync(filesDir, { recursive: true }); // 启动期:数据库与系统文件目录随后立刻要用
  const store = new DatabaseStore(dbPath, path.join(filesDir, 'system-files'));
  const messageHistory = new BotMessageHistory(store);
  const systemMaterials = new SystemMaterials(store);
  systemMaterials.migrate();
  const cloudRecords = new CloudRecords(store);
  const cloudConfig = new CloudConfiguration(store, path.dirname(secretFile));
  const repo = new BootstrapRepository(store);
  const mcp = new McpManager(new McpRepository(store, cloudConfig));
  const webSearch = new WebSearchService(new WebSearchConfiguration(store, cloudConfig), options.fetch);
  const projects = new ProjectRepository(store, path.join(filesDir, 'projects'));
  const resources = new ResourceFiles(projects, filesDir);
  const study = new StudyTools(store, cloudConfig, filesDir, options.fetch);
  const runner = new BotRunner(store, { fetch: options.fetch, sandbox: options.sandbox, sandboxCleanup: options.sandboxCleanup, configuration: cloudConfig, mcp, projects, study, webSearch });
  projects.isActive = id => runner.isProjectActive(id);
  if (!held) recoverResourceCommands(resources);
  const memoryWorker = new MemoryWorker(store, cloudConfig, options.fetch);
  const botService = new BotApplicationService(store, runner, projects);
  const boardFiles = new BoardFiles(store);
  const boardScheduler = new BoardScheduler(boardFiles, botService);
  // Factories are account-scoped; a plugin never resolves another owner's file.
  const gateway = new GatewayCore(store, cloudConfig, botService, {
    feishu: account => new FeishuPlugin(async (_peer, file) => {
      if (!account) throw new Error('account_not_found'); return study.file(account.owner_id, file);
    }, options.fetch),
    ilink: account => new IlinkPlugin(async (_peer, file) => {
      if (!account) throw new Error('account_not_found'); return study.file(account.owner_id, file);
    }, options.fetch),
  }, filesDir);
  // Never recreate a bootstrap secret after the database has been initialized.
  // 口令文件只在装配期确定。装配期启动的这次读写在首个请求之前完成,属于允许的
  // 同步 I/O;已初始化则同一时机删除残留文件(与旧实现一致)。
  const initialized = repo.isInitialized();
  // 启动期例外(与旧实现同一时机):口令必须在处理第一个请求前就绪,否则引导
  // 接口会拿空口令比较。这里同步建/读一次,之后所有请求都走异步路径。
  let bootstrap: BootstrapSecret = initialized ? { secret: '', createdAt: 0 } : loadOrCreateBootstrapSecretSync(secretFile);
  if (initialized) removeBootstrapSecretSync(secretFile);
  let sealing: Promise<BootstrapSecret> | undefined;
  /** 后续只有「上一行遇到并发启动的 EEXIST 才落盘」这种情况需要补一次。 */
  const ensureBootstrapSealed = () => {
    if (initialized || bootstrap.secret) return Promise.resolve(bootstrap);
    sealing ??= loadOrCreateBootstrapSecret(secretFile).then(value => (bootstrap = value)).catch(error => { sealing = undefined; throw error; });
    return sealing;
  };
  const app = Fastify({ logger: getConfig().nodeEnv !== 'test', bodyLimit: 16 * 1024 * 1024 });
  let draining = false;
  let drainTask: Promise<boolean> | undefined;
  const writes = new Set<Promise<void>>();
  // Register before any routes: stop external writes/claims, but let scoped
  // active native workers finish their loopback HTTP reports during the grace.
  app.addHook('onRequest', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (held && !['/api/v1/health', '/api/v1/ready', '/api/v1/deployment/status', '/api/v1/deployment/activate'].includes(url)) return reply.code(503).send({ error: 'release_staged' });
    const write = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (draining && write) {
      return reply.header('retry-after', '5').code(503).send({ error: 'api_draining' });
    }
    if (!write) return;
    let resolve!: () => void;
    const done = new Promise<void>(yes => { resolve = yes; });
    writes.add(done);
    const finished = () => { writes.delete(done); resolve(); };
    reply.raw.once('finish', finished);
    reply.raw.once('close', finished);
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ProjectError) return reply.code(error.status).send({ error: error.code });
    return reply.send(error);
  });
  app.addContentTypeParser('application/octet-stream', (_request, stream, done) => done(null, stream));
  app.addContentTypeParser(/^multipart\/form-data/, (_request, stream, done) => done(null, stream));
  const startWorkers = () => { runner.start(); memoryWorker.start(); gateway.start(); boardScheduler.start(); };
  if (!held) startWorkers();
  const secureCookie = (settings.publicOrigin ?? '').startsWith('https://');
  const expectedOrigin = settings.publicOrigin;
  const rpID = settings.webauthnRpId;
  const rpName = settings.webauthnRpName;
  /**
   * 前后端分离：浏览器前端在别的域名时，在 CORS_ORIGINS 里列出它（逗号分隔，完整 origin）。
   * 原生壳层（iOS / macOS）不发 Origin，也不需要 CORS，它们用 Bearer token。
   */
  const corsOrigins = new Set(settings.corsOrigins);
  /** 跨站点（不同注册域）部署时 Cookie 需要 SameSite=None（必须同时 HTTPS）；同站子域名用默认的 Lax 即可。 */
  const sameSite = (() => {
    if (settings.cookieSameSite === 'none' && secureCookie) return 'None';
    if (settings.cookieSameSite === 'strict') return 'Strict';
    return 'Lax';
  })();
  const tokenTtlMs = settings.tokenTtlMs;

  app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    // 放行了跨域前端时，文件下载等响应要允许被别的 origin 读取。
    crossOriginResourcePolicy: { policy: corsOrigins.size ? 'cross-origin' : 'same-origin' },
  });

  // CORS：只对 CORS_ORIGINS 里列出的 origin 回写允许头；预检请求在这里直接结束。
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (!origin || !corsOrigins.has(origin) || !request.url.startsWith('/api/')) return;
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('vary', 'Origin');
    if (request.method === 'OPTIONS') {
      reply.header('access-control-allow-methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'Authorization,Content-Type,Accept,Last-Event-ID,X-File-Name,X-File-Mime,X-Bootstrap-Secret,Range,If-Range,If-None-Match');
      reply.header('access-control-expose-headers', 'Content-Disposition,Content-Range,Content-Length,Accept-Ranges,ETag');
      reply.header('access-control-max-age', '600');
      return reply.code(204).send();
    }
    reply.header('access-control-expose-headers', 'Content-Disposition,Content-Range,Content-Length,Accept-Ranges,ETag');
  });

  function session(request: FastifyRequest) {
    const cookieToken = parseCookies(request.headers.cookie).wangke_session;
    if (cookieToken) {
      const cookieSession = expectRow<AuthUserRow>(authUserRowSchema, store.db.prepare(sql`SELECT s.id AS session_id, u.id, u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>?`.sql).get(hashToken(cookieToken), now()), 'auth_row_invalid');
      if (cookieSession) return cookieSession;
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) return null;
    const bearer = authorization.slice(7).trim();
    if (!bearer || bearer.length > 256) return null;
    /** `api_tokens` 的会话行只带 `{ id, name, token_id }`(没有密码列),因此用宽松 schema。 */
    const authTokenRowSchema = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, token_id: { type: 'string' }, session_id: { type: ['string', 'null'] } }, required: ['id', 'name'] } as const;
    return expectRow<AuthUserRow>(authTokenRowSchema, store.db.prepare(sql`SELECT NULL AS session_id, t.id AS token_id, u.id, u.name FROM api_tokens t JOIN users u ON u.id=t.user_id WHERE t.token_hash=? AND t.revoked_at IS NULL AND t.expires_at>?`.sql).get(hashToken(bearer), now()), 'auth_row_invalid') ?? null;
  }
  function requireAuth(request: FastifyRequest, reply: FastifyReply) {
    const user = session(request);
    if (!user) { reply.code(401).send({ error: 'unauthorized' }); return null; }
    return user;
  }
  function checkOrigin(request: FastifyRequest, reply: FastifyReply) {
    const origin = request.headers.origin;
    if (!origin) return true;
    // Bearer token 不会被浏览器自动附带，没有 CSRF 风险；原生壳层和脚本走这条。
    if (request.headers.authorization?.startsWith('Bearer ') && !request.headers.cookie?.includes('wangke_session=')) return true;
    if (corsOrigins.has(origin)) return true;
    const allowed = expectedOrigin ?? `${request.protocol}://${request.headers.host}`;
    if (origin !== allowed && !settings.allowInsecureCsrf) { reply.code(403).send({ error: 'origin_not_allowed' }); return false; }
    return true;
  }
  function issueSession(userId: string, reply: FastifyReply) {
    const token = crypto.randomBytes(32).toString('base64url');
    const created = Date.now();
    store.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), userId, hashToken(token), new Date(created).toISOString(), new Date(created + sessionTtlMs).toISOString());
    reply.header('set-cookie', `wangke_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}${secureCookie ? '; Secure' : ''}; Max-Age=${Math.floor(sessionTtlMs / 1000)}`);
  }
  const bad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
  // 准入拒绝多带一个 `status` 字段(契约 ApiAdmissionErrorResponse):客户端按它区分
  // 「改配置可恢复」与「真故障」,其余错误响应保持历史最小形状不动。
  const admissionBad = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error, status: code });

  // ---- 路由装配:顺序与旧 server.ts 逐条一致 ----
  const cloudRunner = registerCloudRoutes(app, { store, records: cloudRecords, configuration: cloudConfig, requireAuth, checkOrigin, filesDir, maxFileBytes, fetch: options.fetch, webSearch, mcp, sandbox: options.sandbox, sandboxCleanup: options.sandboxCleanup,
    canStart: () => !held && !draining,
  });
  registerBilibiliRoutes(app, { store, configuration: cloudConfig, requireAuth, checkOrigin, fetch: options.fetch });
  registerResourceRoutes(app, resources, requireAuth, checkOrigin);
  registerSystemRoutes(app, systemMaterials, cloudConfig, requireAuth, checkOrigin);
  registerBoardRoutes(app, boardFiles, cloudRunner, botService, requireAuth, checkOrigin);
  const pluginService = registerPluginRoutes(app, store, botService, cloudRunner, requireAuth, checkOrigin, { filesDir, resources });
  cloudRunner.pluginService = pluginService;
  const clientRuntime = registerClientRuntime(app, { store, plugins: pluginService,
    resources, configuration: cloudConfig,
    identity: request => session(request as FastifyRequest),
    origin: checkOrigin, canStart: () => !held && !draining, canExecute: () => !held,
    submitTask: (owner, request) => submitOwnerTask(store, cloudRecords, cloudConfig, owner, request) });
  study.register(pluginTool(pluginService));
  registerMcpRoutes(app, { manager: mcp, store, records: cloudRecords, requireAuth, checkOrigin });
  registerWebSearchRoutes(app, { service: webSearch, store, records: cloudRecords, configuration: cloudConfig, requireAuth, checkOrigin });
  registerLinkIconRoutes(app, { requireAuth, checkOrigin, fetch: options.fetch });
  registerProjectRoutes(app, { projects, requireAuth, checkOrigin, maxFileBytes, stopProject: (id) => {
    const runs = expectRows<{ id: string }>({ type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, store.db.prepare(sql`SELECT r.id FROM runs r JOIN threads t ON t.id=r.thread_id
      LEFT JOIN bot_workspaces b ON b.owner_id=t.owner_id AND t.mode='bot'
        AND (t.agent_id IS NOT NULL OR EXISTS(SELECT 1 FROM thread_participants WHERE thread_id=t.id))
      WHERE COALESCE(t.project_id,b.project_id)=? AND r.status IN ('queued','running','waiting_user')`.sql).all(id), 'run_row_invalid');
    for (const run of runs) { store.db.prepare("UPDATE runs SET status='cancelled',completed_at=?,wake_at=NULL WHERE id=?").run(now(), run.id); runner.cancel(run.id); }
  } });
  registerDeploymentRoutes(app, { db: store.db, releaseId, releaseToken, activationFile, draining: () => draining, held: () => held, requireAuth, readStorageUsage, activate: () => {
    held = false;
    recoverResourceCommands(resources);
    startWorkers();
    const address = app.server.address();
    if (!settings.cloudWorkerDisabled && address && typeof address === 'object') cloudRunner.start(`http://127.0.0.1:${address.port}`);
  } });
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.split('?')[0] === '/api/v1/files' && request.method === 'POST') {
      if (!checkOrigin(request, reply)) return;
      if (!requireAuth(request, reply)) return;
      const size = request.headers['content-length'];
      if (size && (!Number.isSafeInteger(Number(size)) || Number(size) > maxFileBytes)) return reply.code(413).send({ error: 'file_too_large_or_invalid' });
    }
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  registerAuthRoutes(app, { store, repo, secretFile, bootstrap: () => bootstrap, ensureBootstrapSealed, bootstrapTtlMs, sessionTtlMs, tokenTtlMs, secureCookie, sameSite, expectedOrigin, rpID, rpName, hashToken, issueSession, session, checkOrigin, requireAuth, bad, publicUser,
    resetOwner: async () => {
      await cloudRunner.reset();
      await runner.reset();
      await clearDirectory(filesDir);
      store.resetData();
    },
    replaceBootstrapSecret: async () => { bootstrap = await replaceBootstrapSecret(secretFile); sealing = undefined; return bootstrap; },
  });
  const { ensureDefaultAgent } = registerChatAgentRoutes(app, { store, projects, requireAuth, checkOrigin, bad });
  registerThreadRoutes(app, { store, projects, botService, runner, requireAuth, checkOrigin, bad, admissionBad, ensureDefaultAgent, messageKinds });
  registerFileRoutes(app, { store, records: cloudRecords, filesDir, maxFileBytes, requireAuth, session, checkOrigin, bad });
  registerConversationRoutes(app, { store, botService, runner, messageHistory, projects, requireAuth, checkOrigin, bad });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));
  registerGatewayRoutes(app, gateway, requireAuth, checkOrigin);
  registerBotManagement(app, store, cloudConfig, runner, memoryWorker, requireAuth, checkOrigin);
  function drainForRelease(milliseconds: number) {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) return Promise.reject(new Error('invalid_drain_deadline'));
    if (drainTask) return drainTask;
    draining = true;
    boardScheduler.close();
    // Calling each operation before awaiting closes all admission paths at once.
    // A false deadline result is NOT a snapshot or proof that writers stopped.
    const bot = runner.quiesce(milliseconds);
    const cloud = cloudRunner.quiesce(milliseconds);
    const background = [gateway.close(), memoryWorker.close()];
    drainTask = Promise.all([
      bot, cloud, settleWithin([...background, ...writes], milliseconds),
    ]).then(results => results.every(Boolean));
    return drainTask;
  }
  app.addHook('preClose', async () => { await drainForRelease(0); });
  app.addHook('onClose', async () => { await clientRuntime.close(); await pluginService.close(); await gateway.close(); await memoryWorker.close(); await cloudRunner.close(); await runner.close(); await mcp.close(); store.close(); });
  return Object.assign(app, { drainForRelease });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // buildServer 内部完成校验;这里读到的已是校验过的快照。
  const app = buildServer();
  const grace = config().apiDrainMs;
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    // A stuck executor must not leave a second deployment thinking shutdown
    // succeeded. Forced exit is nonzero; restart recovery owns unfinished work.
    const timeout = setTimeout(() => { app.log.error('api_shutdown_timeout'); process.exit(1); }, grace + 30_000);
    try {
      const finished = await app.drainForRelease(grace);
      app.log.info({ finished }, 'api_drained');
      await app.close();
    } catch (error) { app.log.error(error); process.exit(1); }
    finally { clearTimeout(timeout); }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  app.listen({ host: config().host, port: config().port }).catch((error) => { app.log.error(error); process.exit(1); });
}
