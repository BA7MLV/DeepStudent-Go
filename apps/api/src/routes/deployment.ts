import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { inspectDatabase } from '../storage/release.js';

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
  app.get('/api/v1/health', async () => ({ status: 'ok', version: process.env.APP_VERSION ?? '0.1.0', cloud: true, auth: ['password', 'token', 'passkey'] }));
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
  const deploymentDatabase = () => {
    const metadataFile = [new URL('../../../database-identity.json', import.meta.url), new URL('../dist/database-identity.json', import.meta.url)].find(url => fs.existsSync(url));
    if (!metadataFile) throw new Error('database_metadata_missing');
    const database = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
    if (inspectDatabase(deps.db).schemaHash !== database.schemaHash) throw new Error('database_schema_identity_mismatch');
    return database;
  };
  app.get('/api/v1/deployment/status', async (request, reply) => {
    if (!deploymentAuthorized(request, reply)) return;
    return { releaseId: deps.releaseId, held: deps.held(), draining: deps.draining(), database: deploymentDatabase() };
  });
  app.post('/api/v1/deployment/activate', async (request, reply) => {
    if (!deploymentAuthorized(request, reply)) return;
    if (deps.draining()) return reply.code(409).send({ error: 'api_draining' });
    deploymentDatabase();
    if (deps.held()) {
      // Durable before admitting any request or scheduler. A restarted container
      // cannot silently fall back to staged after a successful activation.
      const fd = fs.openSync(deps.activationFile!, 'w', 0o600);
      try { fs.writeFileSync(fd, hashToken(deps.releaseToken)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const directory = fs.openSync(path.dirname(deps.activationFile!), 'r');
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
      deps.activate();
    }
    return { releaseId: deps.releaseId, activated: true };
  });
}

const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
