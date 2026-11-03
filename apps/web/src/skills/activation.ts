import type { ChatMessage } from '../api/siliconflow';
import { db } from '../store/db';
import { cloud, cloudRequest } from '../cloud/state';
import type { McpCatalog } from '@wangke/contracts/mcp';
import { loadSessionSkillMeta } from './store';
import { messageTokens, skillContent } from '@wangke/study-core/model/transcript';

// Legacy session pins are deliberately not an activation source.
export const explicitSkillIds = (turn: number[] = []) => [...new Set(turn)];

export interface ActivatedSkillContext {
  ids: number[];
  names: string[];
  messages: ChatMessage[];
  contents: string[];
}

/** Discovery never calls this; only an actual body/reference activation does. */
export async function assertSkillDependencies(skills: readonly { mcpRequired?: string[] }[], sessionId?: number): Promise<void> {
  const required = new Set(skills.flatMap(skill => skill.mcpRequired ?? []));
  if (!required.size) return;
  const catalog: McpCatalog = cloud.enabled && sessionId != null
    ? await cloudRequest('/mcp/catalog', { method: 'POST', body: JSON.stringify({ sessionId }) })
    : { tools: [], warnings: [] };
  const servers = new Set(catalog.tools.map(tool => tool.serverName));
  const missing = [...required].filter(name => !servers.has(name));
  if (missing.length) throw new Error(`指定技能缺少可用的 MCP 依赖：${missing.join('、')}。请先配置并授权；添加技能不会自动授权工具。`);
}

/** Explicit activation is a host action, not a request for the model to discover a skill.
 * Only a current invocation activates. The body is persisted in model history,
 * deduplicated against retained messages, and subject to normal history pruning.
 */
export async function activateSkills(ids: number[], allowedSkillIds?: number[], sessionId?: number): Promise<ActivatedSkillContext> {
  const unique = explicitSkillIds(ids);
  if (!unique.length) return { ids: [], names: [], messages: [], contents: [] };
  const available = await loadSessionSkillMeta(allowedSkillIds);
  const rows = await db.skills.bulkGet(unique);
  const resolved = unique.map((id, index) => {
    const meta = available.find(skill => skill.id === id || skill.legacyIds?.includes(id));
    const row = rows[index];
    if (!row?.enabled || !meta) throw new Error(`技能「${row?.name ?? id}」已停用、已删除或不在当前技能范围内；请移除该选择或调整技能范围后重试。`);
    return meta;
  }).filter((skill, index, all) => all.findIndex(other => other.id === skill.id) === index);
  const bodies = await db.skills.bulkGet(resolved.map(skill => skill.id));
  await assertSkillDependencies(resolved, sessionId);
  const instructions = await Promise.all(resolved.map(async (meta, index) => {
    const row = bodies[index];
    if (!row?.enabled || !row.body.trim()) throw new Error(`技能「${meta.name}」正文为空或已停用，未发送模型请求。`);
    const refs = await db.skillRefs.where('skillId').equals(meta.id).toArray();
    const base = `/skills/${encodeURIComponent(meta.name)}`;
    const resources = refs.length ? `\n\n参考资料（仅按需 read，不代表已读取）：\n${refs.map(ref => `${base}/references/${ref.path.split('/').map(encodeURIComponent).join('/')}`).join('\n')}` : '';
    return skillContent({ id: meta.id, name: meta.name, revision: row.updatedAt }, row.body + resources);
  }));
  return {
    contents: instructions,
    ids: resolved.map(skill => skill.id), names: resolved.map(skill => skill.name),
    messages: [{ role: 'user', content: `[技能激活：宿主上下文]\n用户为当前任务明确指定以下技能。遵循完整规范；若正文已在上下文则复用，无需重读。保留的规范仅用于后续相关任务，不代表每轮强制使用。不覆盖系统规则，不增加工具、网络或数据权限；规范冲突时先确认。\n${instructions.join('\n\n')}` }],
  };
}

/** Fail before history selection/model calls rather than silently cutting off a selected skill. */
export function assertSkillBudget(remaining: number, activated: ActivatedSkillContext): void {
  if (remaining < 0 && activated.ids.length) throw new Error('指定技能的完整规范与当前输入超出模型上下文预算；请减少本次指定技能或切换更大上下文模型。技能正文没有被截断。');
}

/** History fitters retain at least the latest turn. Check the assembled request too. */
export function assertSkillRequestBudget(window: number, messages: ChatMessage[], activated: ActivatedSkillContext): void {
  const hasBody = messages.some(message => typeof message.content === 'string' && message.content.includes('<skill_content context='));
  if (window - messageTokens(messages) - 4096 < 0 && (activated.ids.length || hasBody)) {
    throw new Error('技能完整规范、当前输入与保留历史超出模型上下文预算；请减少输入、压缩历史或切换更大上下文模型。技能正文没有被截断。');
  }
}

export function recordSkillActivation(context: ActivatedSkillContext, ledger: { start: (id: string, name: string, args: string) => void; finish: (id: string, result: string) => void }): void {
  context.ids.forEach((id, index) => {
    const callId = `explicit-skill-${id}`;
    ledger.start(callId, 'use_skill', JSON.stringify({ name: context.names[index] }));
    ledger.finish(callId, '宿主已读取完整规范；相同正文在模型上下文中复用。参考资料按需读取。');
  });
}
