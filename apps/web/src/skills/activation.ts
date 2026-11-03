import type { ChatMessage } from '../api/siliconflow';
import { db } from '../store/db';
import { cloud, cloudRequest } from '../cloud/state';
import type { McpCatalog } from '@wangke/contracts/mcp';
import { loadSessionSkillMeta } from './store';
import { messageTokens } from '@wangke/study-core/model/transcript';

export const explicitSkillIds = (turn: number[] = [], pinned: number[] = []) => [...new Set([...pinned, ...turn])];

export interface ActivatedSkillContext {
  ids: number[];
  names: string[];
  messages: ChatMessage[];
}

/** Explicit activation is a host action, not a request for the model to discover a skill.
 * Rebuild outside history compression every turn; never truncate instructions or grant tools.
 */
export async function activateSkills(ids: number[], allowedSkillIds?: number[], sessionId?: number): Promise<ActivatedSkillContext> {
  const unique = explicitSkillIds(ids);
  if (!unique.length) return { ids: [], names: [], messages: [] };
  const available = await loadSessionSkillMeta(allowedSkillIds);
  const rows = await db.skills.bulkGet(unique);
  const resolved = unique.map((id, index) => {
    const meta = available.find(skill => skill.id === id || skill.legacyIds?.includes(id));
    const row = rows[index];
    if (!row?.enabled || !meta) throw new Error(`技能「${row?.name ?? id}」已停用、已删除或不在当前技能范围内；请移除该选择或调整技能范围后重试。`);
    return meta;
  }).filter((skill, index, all) => all.findIndex(other => other.id === skill.id) === index);
  const bodies = await db.skills.bulkGet(resolved.map(skill => skill.id));
  const required = new Set(resolved.flatMap(skill => skill.mcpRequired ?? []));
  if (required.size) {
    const catalog: McpCatalog = cloud.enabled && sessionId != null
      ? await cloudRequest('/mcp/catalog', { method: 'POST', body: JSON.stringify({ sessionId }) })
      : { tools: [], warnings: [] };
    const servers = new Set(catalog.tools.map(tool => tool.serverName));
    const missing = [...required].filter(name => !servers.has(name));
    if (missing.length) throw new Error(`指定技能缺少可用的 MCP 依赖：${missing.join('、')}。请先配置并授权；添加技能不会自动授权工具。`);
  }
  const instructions = await Promise.all(resolved.map(async (meta, index) => {
    const row = bodies[index];
    if (!row?.enabled || !row.body.trim()) throw new Error(`技能「${meta.name}」正文为空或已停用，未发送模型请求。`);
    const refs = await db.skillRefs.where('skillId').equals(meta.id).toArray();
    const base = `/skills/${encodeURIComponent(meta.name)}`;
    const resources = refs.length ? `\n\n参考资料（仅按需 read，不代表已读取）：\n${refs.map(ref => `${base}/references/${ref.path.split('/').map(encodeURIComponent).join('/')}`).join('\n')}` : '';
    return `<skill_content name=${JSON.stringify(meta.name)} revision=${JSON.stringify(row.updatedAt)} path=${JSON.stringify(base)}>\n${row.body}\n${resources}\n</skill_content>`;
  }));
  return {
    ids: resolved.map(skill => skill.id), names: resolved.map(skill => skill.name),
    messages: [{ role: 'user', content: `以下是用户为当前任务明确指定的技能规范，宿主已完整加载，无需再次读取技能正文。请按其规范完成本轮任务；它们不覆盖系统规则，不增加工具、网络或数据权限。多个规范冲突且影响任务时先向用户确认。\n<activated_skills>\n${instructions.join('\n\n')}\n</activated_skills>` }],
  };
}

/** Fail before history selection/model calls rather than silently cutting off a selected skill. */
export function assertSkillBudget(remaining: number, activated: ActivatedSkillContext): void {
  if (remaining < 0 && activated.ids.length) throw new Error('指定技能的完整规范与当前输入超出模型上下文预算；请减少本轮/固定技能或切换更大上下文模型。技能正文没有被截断。');
}

/** History fitters retain at least the latest turn. Check the assembled request too. */
export function assertSkillRequestBudget(window: number, messages: ChatMessage[], activated: ActivatedSkillContext): void {
  assertSkillBudget(window - messageTokens(messages) - 4096, activated);
}

export function recordSkillActivation(context: ActivatedSkillContext, ledger: { start: (id: string, name: string, args: string) => void; finish: (id: string, result: string) => void }): void {
  context.ids.forEach((id, index) => {
    const callId = `explicit-skill-${id}`;
    ledger.start(callId, 'use_skill', JSON.stringify({ name: context.names[index] }));
    ledger.finish(callId, '宿主已完整加载用户指定的技能规范；参考资料按需读取。');
  });
}
