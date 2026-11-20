import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { inspectDatabase } from '../storage/release.js';
import { getConfig } from '../config.js';

/** 探活/就绪/发布控制与云存储用量。这些路由刻意不依赖账号会话:
 * 发布控制在 staged 状态下仍必须可达,否则新版本无法自证激活。
 * 发布控制只接受本机回环地址 + 令牌哈希比对,与旧实现逐字一致。 */
export function registerDeploymentRoutes(app: FastifyInstance, deps: {
  db: import('better-sqlite3').Database;
  releaseId: string | undefined;
  releaseToken: string;
  activationFile: string | null;
  draining: () => boolean;
  held: () => boolean;
  /** 激活成功后置 held=false 并启动各类 worker;失败仍留在 staged。 */
  activate: () => void;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  readStorageUsage: () => Promise<unknown>;
}) {
  // 版本号走 getConfig():发布脚本会改写 compose 后在同一进程探测新版本,必须读当前值。
  app.get('/api/v1/health', async () => ({ status: 'ok', version: getConfig().appVersion, cloud: true, auth: ['password', 'token', 'passkey'] }));
  app.get('/api/v1/cloud/storage', async (request, reply) => {
    if (!deps.requireAuth(request, reply)) return;
    return deps.readStorageUsage();
  });
  app.get('/api/v1/ready', async (_request, reply) => {
    if (deps.draining()) return reply.code(503).send({ status: 'draining' });
    if (deps.held()) return reply.code(503).send({ status: 'staged' });
    return { status: 'ready' };
  });
  const deploymentAuthorized = (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers['x-deployment-token'];
    if (!deps.releaseId || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.raw.socket.remoteAddress ?? '') || typeof token !== 'string' || !crypto.timingSafeEqual(Buffer.from(hashToken(token)), Buffer.from(hashToken(deps.releaseToken)))) {
      reply.code(403).send({ error: 'deployment_control_denied' }); return false;
    }
    return true;
  };
  /** 发布元数据文件是构建产物;每次请求都要读,因此走异步 I/O。 */
  const deploymentDatabase = async () => {
    // 两种部署布局下的元数据位置:
    // - tsx 直跑 src/routes/x.ts:apps/api/database-identity.json(路径是相对 URL 字符串拼接,不经反向路径合并)
    // - 构建产物 dist/apps/api/src/routes/x.js:apps/api/dist/database-identity.json
    const source = import.meta.url.replace(/src\/routes\/[^/]+$/, 'database-identity.json');
    const compiled = import.meta.url.replace(/dist\/apps\/api\/src\/routes\/[^/]+$/, 'dist/database-identity.json');
    const candidates = [...new Set([new URL(source), new URL(compiled)])];
    let text: string | undefined;
    for (const url of candidates) {
      try { text = await fsp.readFile(url, 'utf8'); break; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    if (text === undefined) throw new Error('database_metadata_missing');
    const database = JSON.parse(text);
    if (inspectDatabase(deps.db).schemaHash !== database.schemaHash) throw new Error('database_schema_identity_mismatch');
    return database;
  };
  app.get('/api/v1/deployment/status', async (request, reply) => {
    if (!deploymentAuthorized(request, reply)) return;
    return { releaseId: deps.releaseId, held: deps.held(), draining: deps.draining(), database: await deploymentDatabase() };
  });
  app.post('/api/v1/deployment/activate', async (request, reply) => {
    if (!deploymentAuthorized(request, reply)) return;
    if (deps.draining()) return reply.code(409).send({ error: 'api_draining' });
    await deploymentDatabase();
    if (deps.held()) {
      // Durable before admitting any request or scheduler. A restarted container
      // cannot silently fall back to staged after a successful activation.
      // 异步等价物:先 writeFile(默认会关闭 fd),再 fsync 文件与目录。
      const handle = await fsp.open(deps.activationFile!, 'w', 0o600);
      try { await handle.writeFile(hashToken(deps.releaseToken)); await handle.sync(); } finally { await handle.close(); }
      const directory = await fsp.open(path.dirname(deps.activationFile!), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      deps.activate();
    }
    return { releaseId: deps.releaseId, activated: true };
  });
}

const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
