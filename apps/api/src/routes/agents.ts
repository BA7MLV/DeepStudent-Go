import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import type { ProjectRepository } from '../projects/repository.js';
import { agentProfileRowSchema, expectRow, expectRows, type AgentProfileRow } from '../storage/row-schema.js';

/** Agent 档案与线程参与者的目录型路由。投影、默认档案与数量上限的判定
 * 原样保留;所有写入都在 requireAuth + checkOrigin 之后。 */
export function registerChatAgentRoutes(app: FastifyInstance, deps: {
  store: DatabaseStore;
  projects: ProjectRepository;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => { id: string } | null;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  bad: (reply: FastifyReply, code: number, error: string) => FastifyReply;
}) {
  const { store, projects, requireAuth, checkOrigin, bad } = deps;
  /** Agent 行只投影这五个字段;行在查询处已用 agentProfileRowSchema 收窄。 */
  function agentDto(row: Pick<AgentProfileRow, 'id' | 'name' | 'avatar' | 'role' | 'enabled'>) {
    return { id: row.id, name: row.name, avatar: row.avatar ?? null, role: row.role, enabled: Boolean(row.enabled) };
  }
  function ensureDefaultAgent(userId: string) {
    // Reuse the old default profile so a branding change does not create a second Bot.
    const existing = expectRow<AgentProfileRow>(agentProfileRowSchema, store.db.prepare("SELECT * FROM agent_profiles WHERE owner_id=? AND name IN ('DeepStudent Go', 'Wangke Bot') ORDER BY created_at LIMIT 1").get(userId), 'agent_profile_row_invalid');
    if (existing) return existing;
    const timestamp = now();
    const row = { id: crypto.randomUUID(), owner_id: userId, name: 'DeepStudent Go', avatar: null, role: '本机学习助手', system_prompt: 'You are DeepStudent Go, a safe learning assistant.', enabled: 1, created_at: timestamp, updated_at: timestamp };
    store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,avatar,role,system_prompt,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.owner_id, row.name, row.avatar, row.role, row.system_prompt, row.enabled, row.created_at, row.updated_at);
    projects.provisionAgent(userId, row.id);
    return row;
  }
  const now = () => new Date().toISOString();
  app.get('/api/v1/agents', async (request, reply) => {
    const user = requireAuth(request, reply); if (!user) return;
    ensureDefaultAgent(user.id);
    return { agents: expectRows<AgentProfileRow>(agentProfileRowSchema, store.db.prepare('SELECT * FROM agent_profiles WHERE owner_id=? ORDER BY created_at').all(user.id), 'agent_profile_row_invalid').map(agentDto) };
  });
  app.post<{ Body: { name?: string; avatar?: string; role?: string; systemPrompt?: string } }>('/api/v1/agents', async (request, reply) => {
    if (!checkOrigin(request, reply)) return;
    const user = requireAuth(request, reply); if (!user) return;
    const body = request.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const role = typeof body.role === 'string' ? body.role.trim() : '';
    const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt.trim() : '';
    const avatar = typeof body.avatar === 'string' ? body.avatar.trim() : '';
    if (!name || name.length > 80 || /[\u0000\r\n]/.test(name) || role.length > 120 || systemPrompt.length > 4000 || avatar.length > 500) return bad(reply, 400, 'invalid_agent_profile');
    if ((expectRow<{ count: number }>({ type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }, store.db.prepare('SELECT COUNT(*) AS count FROM agent_profiles WHERE owner_id=?').get(user.id), 'agent_profile_count_invalid')?.count ?? 0) >= 16) return bad(reply, 409, 'agent_limit_reached');
    const timestamp = now(); const row = { id: crypto.randomUUID(), name, avatar: avatar || null, role: role || '协作 Agent', system_prompt: systemPrompt || `You are ${name}, a safe collaborative learning assistant.`, enabled: 1, created_at: timestamp, updated_at: timestamp };
    try { store.db.prepare('INSERT INTO agent_profiles(id,owner_id,name,avatar,role,system_prompt,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, user.id, row.name, row.avatar, row.role, row.system_prompt, row.enabled, row.created_at, row.updated_at); } catch (error: any) { if (String(error?.code) === 'SQLITE_CONSTRAINT_UNIQUE') return bad(reply, 409, 'agent_name_taken'); throw error; }
    projects.provisionAgent(user.id, row.id);
    return reply.code(201).send(agentDto(row));
  });

  // 创建 bot 线程时的默认档案兜底:threads 路由需要同一个实例配置,
  // 不能在两边各自实现一次(名字匹配与前缀规则必须一致)。
  return { ensureDefaultAgent };
}
