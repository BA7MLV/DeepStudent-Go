import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import argon2 from 'argon2';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
// 这些 JSON 类型只作为「客户端提交的凭据」的形状入口;内容由 simplewebauthn 自己校验。
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import type { BootstrapInitializeRequest } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';
import type { BootstrapRepository } from '../storage/bootstrapRepository.js';
import { authUserRowSchema, expectRow, expectRows, type AuthUserRow } from '../storage/row-schema.js';
import { removeBootstrapSecret } from '../bootstrap-secret.js';

/** 引导、密码/Bearer 登录、退出、账号重置、设备配对与 Passkey。
 * 从 server.ts 原样搬出:各路由的判定顺序(尤其是 bootstrap 一次性口令
 * 与登录退避)决定安全语义,不做重排;重定向仍由 requireAuth/checkOrigin 决定。 */
export function registerAuthRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore;
  repo: BootstrapRepository;
  secretFile: string;
  /** 引导口令只在创建时可见;初始化成功后 secret 为空串。
   * 传取值函数而不是快照:重置账号会整体替换口令对象,快照会变陈旧。 */
  bootstrap: () => { readonly secret: string; readonly createdAt: number };
  /** 首次启动时口令可能还在异步落盘,引导接口必须先等到它。 */
  ensureBootstrapSealed: () => Promise<{ readonly secret: string; readonly createdAt: number }>;
  bootstrapTtlMs: number;
  sessionTtlMs: number;
  tokenTtlMs: number;
  secureCookie: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  expectedOrigin: string | undefined;
  rpID: string | undefined;
  rpName: string | undefined;
  hashToken: (value: string) => string;
  issueSession: (userId: string, reply: FastifyReply) => void;
  session: (request: FastifyRequest) => AuthUserRow | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string; name: string } | null;
  bad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
  resetOwner: () => Promise<void>;
  /** 重置后轮换引导口令并返回新口令,调用方负责返回给客户端。 */
  replaceBootstrapSecret: () => Promise<{ secret: string; createdAt: number }>;
  publicUser: (user: { id: string; name?: string }) => { id: string; name: string };
}) {
  const { store, repo, session, checkOrigin, requireAuth, bad, hashToken, issueSession, secureCookie, sameSite, expectedOrigin, rpID, rpName } = deps;
  const publicUser = deps.publicUser;
  const bootstrapTtlMs = deps.bootstrapTtlMs, tokenTtlMs = deps.tokenTtlMs;
  /** 行形状:认证相关 SQL 结果一律在信任边界收窄,不再按类型断言穿透。 */
  const credentialRowSchema = {
    type: 'object', properties: { id: { type: 'string' }, public_key: {}, counter: { type: 'integer' }, user_id: { type: ['string', 'null'] } },
    required: ['id', 'public_key', 'counter'],
  } as const;
  const challengeRowSchema = { type: 'object', properties: { id: { type: 'string' }, challenge: { type: 'string' } }, required: ['id', 'challenge'] } as const;
  const userRowSchema = { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } }, required: ['id', 'name'] } as const;
  const idRowSchema = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } as const;
  const now = () => new Date().toISOString();
  function webauthnChallengeFromResponse(body: unknown): string | null {
    const clientDataJSON = (body as { response?: { clientDataJSON?: unknown } } | null)?.response?.clientDataJSON;
    if (typeof clientDataJSON !== 'string' || clientDataJSON.length > 16384) return null;
    try {
      const clientData = JSON.parse(Buffer.from(clientDataJSON, 'base64url').toString('utf8')) as { challenge?: unknown };
      return typeof clientData.challenge === 'string' && clientData.challenge.length > 0 ? clientData.challenge : null;
    } catch {
      return null;
    }
  }
  const attempts = new Map<string, { count: number; until: number; seen: number }>();
  const dummyHash = argon2.hash('unusable-login-dummy', { type: argon2.argon2id });
  const pruneAttempts = () => { const cutoff = Date.now() - 15 * 60_000; for (const [ip, value] of attempts) if (value.until < cutoff && value.seen < cutoff) attempts.delete(ip); while (attempts.size > 10_000) attempts.delete(attempts.keys().next().value!); };
  const secretFile: string = deps.secretFile;
  /** 每次读取当前口令对象:重置会替换它。 */
  const currentBootstrap = () => deps.bootstrap();
   app.get('/api/v1/bootstrap/status', async () => {
     const initialized = repo.isInitialized();
     const bootstrap = currentBootstrap();
     const available = !initialized && Date.now() < bootstrap.createdAt + bootstrapTtlMs;
     const hasPasskey = initialized && Boolean(store.db.prepare('SELECT 1 FROM passkey_credentials LIMIT 1').get());
     return { initialized, bootstrapAvailable: available, expiresAt: available ? new Date(bootstrap.createdAt + bootstrapTtlMs).toISOString() : null, botSyncVersion: 1, hasPasskey };
   });
  app.post<{ Body: BootstrapInitializeRequest }>('/api/v1/bootstrap/initialize', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    if (repo.isInitialized()) return bad(reply, 410, 'bootstrap_closed');
    // 首次启动时口令文件可能仍在异步落盘:先等到它,再比对。
    const bootstrap = await deps.ensureBootstrapSealed();
     if (Date.now() >= bootstrap.createdAt + bootstrapTtlMs || request.headers['x-bootstrap-secret'] !== bootstrap.secret) return bad(reply, 403, 'invalid_or_expired_bootstrap_secret');
    const { adminPassword } = request.body ?? {};
    if (typeof adminPassword !== 'string' || adminPassword.length < 12 || adminPassword.length > 256) return bad(reply, 400, 'admin_password_must_be_12_to_256_characters');
    const initialized = repo.initializeAdmin('Administrator', await argon2.hash(adminPassword, { type: argon2.argon2id }));
    if (!initialized) return bad(reply, 410, 'bootstrap_closed');
    await removeBootstrapSecret(secretFile);
    return reply.code(201).send({ initialized: true });
  });

  /** 密码校验 + 按 IP 退避。浏览器登录（发 Cookie）和原生壳层登录（发 token）共用。 */
  async function verifyPassword(request: FastifyRequest<{ Body: { password?: string } }>) {
    pruneAttempts(); const key = request.ip; const attempt = attempts.get(key); const wait = attempt && attempt.until > Date.now() ? attempt.until - Date.now() : 0;
    if (wait) await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 1500)));
    // Each personal deployment has one administrator; fail closed if ambiguous.
    const records = expectRows<AuthUserRow>(authUserRowSchema, store.db.prepare('SELECT u.id,u.name,p.password_hash FROM users u JOIN password_credentials p ON p.user_id=u.id LIMIT 2').all(), 'auth_row_invalid');
    const record = records.length === 1 ? records[0] : undefined;
    const valid = typeof request.body?.password === 'string' && request.body.password.length <= 256 && await argon2.verify(record?.password_hash ?? await dummyHash, request.body.password) && Boolean(record);
    if (!valid) { const seen = Date.now(); attempts.set(key, { count: (attempt?.count ?? 0) + 1, until: seen + Math.min(1000 * 2 ** Math.min(attempt?.count ?? 0, 4), 10000), seen }); return null; }
    // 走到这里 valid 已包含 Boolean(record) 的检查;显式再收窄一次,避免可选链泄漏到调用方。
    attempts.delete(key); return record ? { id: record.id, name: record.name } : null;
  }
  app.post<{ Body: { password?: string } }>('/api/v1/auth/password/login', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const record = await verifyPassword(request);
    if (!record) return bad(reply, 401, 'invalid_credentials');
    issueSession(record.id, reply); return { user: publicUser(record) };
  });
  /**
   * 原生壳层（iOS / macOS）和脚本的登录：密码换一个 Bearer token。
   * token 只在这次响应里出现一次，库里只存哈希；`POST /auth/logout` 带上它即可吊销。
   */
  app.post<{ Body: { password?: string; deviceName?: string } }>('/api/v1/auth/token', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const record = await verifyPassword(request);
    if (!record) return bad(reply, 401, 'invalid_credentials');
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + tokenTtlMs).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const tokenId = crypto.randomUUID();
    store.db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(tokenId, record.id, hashToken(token), deviceName || 'Native client', new Date(createdAt).toISOString(), expiresAt);
    return reply.code(201).send({ token, tokenId, tokenType: 'Bearer', expiresAt, user: publicUser(record) });
  });
  app.get('/api/v1/auth/session', async (request) => { const user = session(request); return { authenticated: Boolean(user), user: user ? publicUser(user) : null }; });
  app.post('/api/v1/auth/logout', async (request, reply) => { if (!checkOrigin(request, reply)) return; const user = session(request); const authorization = request.headers.authorization; if (authorization?.startsWith('Bearer ')) { const bearer = authorization.slice(7).trim(); if (bearer) store.db.prepare('UPDATE api_tokens SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL').run(now(), hashToken(bearer)); } else if (user?.session_id) store.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=?').run(now(), user.session_id); reply.header('set-cookie', `wangke_session=; Path=/; HttpOnly; SameSite=${sameSite}${secureCookie ? '; Secure' : ''}; Max-Age=0`); return { ok: true }; });
  app.post<{ Body: { password?: string } }>('/api/v1/account/reset', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const current = session(request);
    if (!current) return bad(reply, 401, 'unauthorized');
    const record = await verifyPassword(request);
    if (!record || record.id !== current.id) return bad(reply, 401, 'invalid_credentials');
    await deps.resetOwner();
    const bootstrap = await deps.replaceBootstrapSecret();
    attempts.clear();    reply.header('set-cookie', `wangke_session=; Path=/; HttpOnly; SameSite=${sameSite}${secureCookie ? '; Secure' : ''}; Max-Age=0`);
    return { reset: true, initialized: false, bootstrapSecret: bootstrap.secret, expiresAt: new Date(bootstrap.createdAt + bootstrapTtlMs).toISOString() };
  });

  app.post<{ Body: { deviceName?: string } }>('/api/v1/pairing/create', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const code = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + 5 * 60_000).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    store.db.prepare('INSERT INTO device_pairings(id,owner_id,code_hash,device_name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), user.id, hashToken(code), deviceName || null, new Date(createdAt).toISOString(), expiresAt);
    return reply.code(201).send({ code, expiresAt });
  });

  app.get<{ Params: { code: string } }>('/api/v1/pairing/:code', async (request, reply) => {
    const code = request.params.code;
    if (typeof code !== 'string' || code.length < 32 || code.length > 128) return bad(reply, 404, 'pairing_not_found');
    const pairing = store.db.prepare('SELECT approved_at,used_at,expires_at FROM device_pairings WHERE code_hash=?').get(hashToken(code)) as { approved_at: string | null; used_at: string | null; expires_at: string } | undefined;
    if (!pairing || pairing.used_at || pairing.expires_at <= now()) return { status: 'expired' as const };
    return { status: pairing.approved_at ? 'approved' as const : 'pending' as const, expiresAt: pairing.expires_at };
  });

  app.post<{ Params: { code: string }; Body: { deviceName?: string } }>('/api/v1/pairing/:code/approve', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const approved = store.transaction(() => {
      const pairing = store.db.prepare('SELECT id FROM device_pairings WHERE code_hash=? AND owner_id=? AND used_at IS NULL AND expires_at>?').get(hashToken(request.params.code), user.id, now()) as { id: string } | undefined;
      if (!pairing) return false;
      store.db.prepare('UPDATE device_pairings SET approved_at=COALESCE(approved_at,?), device_name=COALESCE(?,device_name) WHERE id=?').run(now(), deviceName || null, pairing.id);
      return true;
    });
    if (!approved) return bad(reply, 404, 'pairing_not_found');
    return { approved: true };
  });

  app.post<{ Params: { code: string }; Body: { deviceName?: string } }>('/api/v1/pairing/:code/exchange', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const token = crypto.randomBytes(32).toString('base64url');
    const createdAt = Date.now();
    const expiresAt = new Date(createdAt + 90 * 24 * 60 * 60_000).toISOString();
    const deviceName = typeof request.body?.deviceName === 'string' ? request.body.deviceName.trim().slice(0, 100) : '';
    const exchanged = store.transaction(() => {
      const pairing = store.db.prepare('SELECT id,owner_id,device_name FROM device_pairings WHERE code_hash=? AND approved_at IS NOT NULL AND used_at IS NULL AND expires_at>?').get(hashToken(request.params.code), now()) as { id: string; owner_id: string; device_name: string | null } | undefined;
      if (!pairing) return false;
      const claimed = store.db.prepare('UPDATE device_pairings SET used_at=? WHERE id=? AND used_at IS NULL').run(new Date(createdAt).toISOString(), pairing.id);
      if (claimed.changes !== 1) return false;
      const tokenId = crypto.randomUUID();
      store.db.prepare('INSERT INTO api_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(tokenId, pairing.owner_id, hashToken(token), deviceName || pairing.device_name || 'Paired device', new Date(createdAt).toISOString(), expiresAt);
      return tokenId;
    });
    if (!exchanged) return bad(reply, 403, 'pairing_not_approved_or_expired');
    return { token, tokenId: exchanged, tokenType: 'Bearer', expiresAt };
  });

  function webauthnConfigured(reply: FastifyReply) { if (!expectedOrigin || !rpID || !rpName || (!expectedOrigin.startsWith('https://') && !/^http:\/\/localhost(?::\d+)?$/.test(expectedOrigin))) { bad(reply, 503, 'webauthn_not_configured'); return false; } return true; }
  app.post('/api/v1/auth/passkey/register/options', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user || !webauthnConfigured(reply)) return;
    store.db.prepare("DELETE FROM webauthn_challenges WHERE (used_at IS NOT NULL OR expires_at<=?) AND (user_id=? OR user_id IS NULL)").run(now(), user.id);
    const credentials = expectRows<{ id: string }>(idRowSchema, store.db.prepare('SELECT id FROM passkey_credentials WHERE user_id=?').all(user.id), 'passkey_row_invalid');
      const options = await generateRegistrationOptions({ rpName: rpName!, rpID: rpID!, userName: user.name, userID: new TextEncoder().encode(user.id), attestationType: 'none', authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, excludeCredentials: credentials.map((x) => ({ id: x.id })) });
    store.db.prepare('INSERT INTO webauthn_challenges(id,user_id,kind,challenge,created_at,expires_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), user.id, 'registration', options.challenge, now(), new Date(Date.now() + 120000).toISOString());
    return options;
  });
  app.post('/api/v1/auth/passkey/register/verify', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; const user = requireAuth(request, reply); if (!user || !webauthnConfigured(reply)) return;
    const responseChallenge = webauthnChallengeFromResponse(request.body);
    if (!responseChallenge) return bad(reply, 400, 'challenge_missing_or_expired');
    const challenge = expectRow<{ id: string; challenge: string }>(challengeRowSchema, store.db.prepare("SELECT * FROM webauthn_challenges WHERE user_id=? AND kind='registration' AND challenge=? AND used_at IS NULL AND expires_at>? LIMIT 1").get(user.id, responseChallenge, now()), 'challenge_row_invalid');
    if (!challenge) return bad(reply, 400, 'challenge_missing_or_expired');
    // simplewebauthn 的 response 是客户端提交的 JSON:库内自己做结构校验,失败会抛出并被下面的 catch 统一返回 400。
    try { const result = await verifyRegistrationResponse({ response: request.body as RegistrationResponseJSON, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigin!, expectedRPID: rpID!, requireUserVerification: true }); if (!result.verified || !result.registrationInfo) return bad(reply, 400, 'passkey_verification_failed'); const c = result.registrationInfo.credential; const consumed = store.transaction(() => { const claimed = store.db.prepare("UPDATE webauthn_challenges SET used_at=? WHERE id=? AND used_at IS NULL").run(now(), challenge.id); if (claimed.changes !== 1) return false; store.db.prepare('INSERT INTO passkey_credentials(id,user_id,public_key,counter,transports,created_at) VALUES(?,?,?,?,?,?)').run(c.id, user.id, Buffer.from(c.publicKey), c.counter, JSON.stringify(c.transports ?? []), now()); return true; }); if (!consumed) return bad(reply, 400, 'challenge_missing_or_expired'); return { verified: true }; } catch { return bad(reply, 400, 'passkey_verification_failed'); }
  });
  app.post('/api/v1/auth/passkey/login/options', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; if (!webauthnConfigured(reply)) return;
    store.db.prepare("DELETE FROM webauthn_challenges WHERE used_at IS NOT NULL OR expires_at<=?").run(now());
    const options = await generateAuthenticationOptions({ rpID: rpID!, userVerification: 'required' }); const id = crypto.randomUUID(); store.db.prepare('INSERT INTO webauthn_challenges(id,kind,challenge,created_at,expires_at) VALUES(?,?,?,?,?)').run(id, 'authentication', options.challenge, now(), new Date(Date.now() + 120000).toISOString()); return options;
  });
  app.post('/api/v1/auth/passkey/login/verify', async (request, reply) => {
    if (!checkOrigin(request, reply)) return; if (!webauthnConfigured(reply)) return;
    const body = request.body as AuthenticationResponseJSON;
    const credential = expectRow<{ id: string; user_id: string | null; public_key: Uint8Array; counter: number }>(credentialRowSchema, store.db.prepare('SELECT * FROM passkey_credentials WHERE id=?').get(body?.id), 'passkey_row_invalid');
    const responseChallenge = webauthnChallengeFromResponse(body);
    const challenge = responseChallenge ? expectRow<{ id: string; challenge: string }>(challengeRowSchema, store.db.prepare("SELECT * FROM webauthn_challenges WHERE kind='authentication' AND challenge=? AND used_at IS NULL AND expires_at>? LIMIT 1").get(responseChallenge, now()), 'challenge_row_invalid') : null;
    if (!credential || !challenge) return bad(reply, 401, 'passkey_verification_failed');
    try { const result = await verifyAuthenticationResponse({ response: body, expectedChallenge: challenge.challenge, expectedOrigin: expectedOrigin!, expectedRPID: rpID!, credential: { id: credential.id, publicKey: new Uint8Array(credential.public_key), counter: credential.counter }, requireUserVerification: true }); if (!result.verified) return bad(reply, 401, 'passkey_verification_failed'); const consumed = store.transaction(() => { const claimed = store.db.prepare("UPDATE webauthn_challenges SET used_at=?, credential_id=?, user_id=? WHERE id=? AND used_at IS NULL AND (credential_id IS NULL OR credential_id=?) AND (user_id IS NULL OR user_id=?)").run(now(), credential.id, credential.user_id, challenge.id, credential.id, credential.user_id); if (claimed.changes !== 1) return false; store.db.prepare('UPDATE passkey_credentials SET counter=? WHERE id=?').run(result.authenticationInfo.newCounter, credential.id); return true; }); // 认证成功的凭据必然绑定过 user_id(注册时写入);为空说明库被改坏,按失败处理而不是写入无主会话。
      if (!consumed || !credential.user_id) return bad(reply, 401, 'passkey_verification_failed');
      issueSession(credential.user_id, reply);
      return { verified: true, user: publicUser(expectRow<{ id: string; name: string }>(userRowSchema, store.db.prepare('SELECT * FROM users WHERE id=?').get(credential.user_id), 'user_row_invalid')!) }; } catch { return bad(reply, 401, 'passkey_verification_failed'); }
  });

}
