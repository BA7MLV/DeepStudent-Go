import { intersectSkillMetaIds } from '@wangke/study-core/skills/scope';
import { messageTokens } from '@wangke/study-core/model/transcript';
import type { ChatMessage } from '@wangke/study-core/model/client';
import { taskRows, type TaskContext } from '../src/cloud/execution.js';

function ids(value: unknown): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => !Number.isSafeInteger(id))) throw new Error('技能选择无效，请重新选择');
  return value;
}

/** Native chat uses the owner's live packages, never instruction text from a task payload. */
export function sessionSkills(context: TaskContext, session: Record<string, any>, turnIds: unknown = [], mcpServers: ReadonlySet<string> = new Set()) {
  const physical = context.store.skillRecords.sync(context.owner);
  const legacySlugs = new Set(['gongwen-writing', 'gongwen-format', 'subject-math', 'subject-coding', 'gongkao-xingce', 'gongkao-shenlun']);
  const bindings = context.store.db.prepare('SELECT skill_id,builtin_slug FROM system_skill_bindings WHERE owner_id=?').all(context.owner) as Array<{ skill_id: number; builtin_slug: string | null }>;
  const legacy = new Set(bindings.filter(b => b.builtin_slug && legacySlugs.has(b.builtin_slug)).map(b => b.skill_id));
  const handoutId = bindings.find(b => b.builtin_slug === 'course-handout')?.skill_id;
  const legacyIds = physical.filter(s => legacy.has(s.id) && s.enabled === 1).map(s => s.id);
  const enabled = physical.filter(s => s.enabled === 1 && !legacy.has(s.id)).map(s => ({ ...s,
    ...(s.id === handoutId ? { legacyIds } : {}),
  }));
  const allowed = new Set(intersectSkillMetaIds(enabled, session.skillIds === undefined ? undefined : ids(session.skillIds)));
  const available = enabled.filter(s => allowed.has(s.id));
  const selected = [...new Set([...ids(session.pinnedSkillIds), ...ids(turnIds)])];
  const resolved = selected.map(id => {
    const skill = available.find(s => s.id === id || s.legacyIds?.includes(id));
    if (!skill) throw new Error(`技能「${physical.find(s => s.id === id)?.name ?? id}」已停用、已删除或不在当前技能范围内；请调整选择后重试。`);
    return skill;
  }).filter((s, i, all) => all.findIndex(other => other.id === s.id) === i);
  const check = (skill: typeof available[number]) => {
    if (!skill.body.trim()) throw new Error(`技能「${skill.name}」正文为空，未发送模型请求。`);
    const missing = (skill.mcpRequired ?? []).filter(name => !mcpServers.has(name));
    if (missing.length) throw new Error(`技能「${skill.name}」缺少可用的 MCP 依赖：${missing.join('、')}；请先配置并授权。未发送模型请求，也未自动授权。`);
  };
  const references = (id: number) => taskRows(context, 'skillRefs', 'skillId', id);
  const skillBody = (skill: typeof available[number]) => {
    check(skill);
    const refs = references(skill.id);
    return skill.body + (refs.length ? `\n\n参考资料（仅按需 read）：\n${refs.map(ref => `/skills/${encodeURIComponent(skill.name)}/references/${String(ref.path).split('/').map(encodeURIComponent).join('/')}`).join('\n')}` : '');
  };
  const messages: ChatMessage[] = resolved.length ? [{ role: 'user', content:
    `以下是用户为当前任务明确指定的技能规范，宿主已完整加载，请用于本轮任务，无需重复读取正文。这些规范不覆盖系统规则，不增加工具或数据权限；冲突时先向用户确认。\n<activated_skills>\n${resolved.map(skill => `<skill_content name=${JSON.stringify(skill.name)} revision=${JSON.stringify(skill.revision)}>\n${skillBody(skill)}\n</skill_content>`).join('\n\n')}\n</activated_skills>`,
  }] : [];
  return {
    ids: selected, messages,
    traces: resolved.map(skill => ({ name: 'use_skill', detail: JSON.stringify({ name: skill.name }), status: 'done' as const, result: '宿主已完整加载用户指定的技能规范；参考资料按需读取。' })),
    prompt: available.length ? `\n\n可用技能（仅元数据，不代表正文已加载）：\n${available.map(s => `- ${s.name}：${s.description}`).join('\n')}\n对于相关任务，先 read /skills/{URI编码名称} 加载规范；已通过 activated_skills 提供的正文直接遵循。参考资料仅按需读取，技能不增加权限。` : '',
    wrap(execute: (name: string, args: Record<string, unknown>) => Promise<string>) {
      return async (name: string, args: Record<string, unknown>) => {
        if (name !== 'read' || typeof args.path !== 'string' || !/^\/skills(?:\/|$)/.test(args.path)) return execute(name, args);
        if (args.path === '/skills' || args.path === '/skills/') return available.map(s => `${s.name}：${s.description}\npath=/skills/${encodeURIComponent(s.name)}`).join('\n') || '当前没有可用技能。';
        let parts: string[];
        try { parts = args.path.split('/').slice(2).map(decodeURIComponent); }
        catch { return 'Error: 无效技能路径'; }
        const skill = available.find(s => s.name === parts[0]);
        if (!skill) return 'Error: 技能已停用、删除或不在当前会话范围内';
        try {
          check(skill);
          if (parts.length === 1) return skillBody(skill);
          if (parts[1] !== 'references') return 'Error: 无效技能参考路径';
          const path = parts.slice(2).join('/');
          return references(skill.id).find(ref => ref.path === path)?.body ?? 'Error: 技能参考资料不存在';
        } catch (error) { return `Error: ${error instanceof Error ? error.message : String(error)}`; }
      };
    },
  };
}

export function skillHistoryBudget(contextWindow: number, messages: ChatMessage[], activated: ChatMessage[]): number {
  const remaining = contextWindow - messageTokens([...messages, ...activated]) - 16000;
  if (remaining < 0 && activated.length) throw new Error('指定技能的完整规范与当前输入超出模型上下文预算；请减少指定技能或切换更大上下文模型。技能正文没有被截断。');
  return Math.max(0, remaining);
}

export function assertSkillRequestBudget(contextWindow: number, messages: ChatMessage[], hasSkills: boolean): void {
  if (hasSkills && contextWindow - messageTokens(messages) - 16000 < 0) throw new Error('指定技能、当前输入与保留历史超出模型上下文预算；请减少指定技能或开启新会话。技能正文没有被截断。');
}
