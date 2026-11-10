import { db, type SkillRow } from '../store/db';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { readSkillIndex } from './demand';
import { COURSE_HANDOUT_SKILL, isLegacyHandoutSkill } from './catalog';
import { intersectSkillMetaIds } from './scope';
import { parseSkillMarkdown } from './types';
import { parseSkillZip, type ParsedSkillPackage } from './zip';
import { learningId, saveSkillPackage } from '../client/learning';

/** 注入提示词的 skill 正文总预算（字符） */
const SKILL_BLOCK_BUDGET = 6000;

/** Level 1：技能元数据（常驻上下文，name + description） */
export interface SkillMeta {
  /** 界面区分内置与用户技能；不进入模型提示词。 */
  builtin?: boolean;
  /** 已合并入口的旧内置 ID（仅启用项），不进入模型提示词。 */
  legacyIds?: number[];
  mcpRequired?: string[];
  id: number;
  revision: number;
  name: string;
  description: string;
}

/**
 * 进行中的「补齐内置 skill」任务（并发闸门）。
 *
 * 为什么必须有：本函数是「先按名查、查不到就插」，而调用点有好几个且互不感知
 * （设置页 SkillsCard 的 effect、HandoutPanel、ChatPanel、skills/router）。
 * React StrictMode 在 dev 下会把 effect 跑两次，于是两个调用并发进入循环、
 * **都在任何一次插入落库之前查完**，6 个内置技能被插成 12 行
 * （实测：dev 12 行 / 生产构建 6 行；生产不触发 StrictMode 双调用所以看不出来）。
 *
 * 用模块级 in-flight promise 把并发调用收敛成同一次执行；完成后清空，
 * 这样用户删掉内置技能后再次调用仍会重新补齐。
 */
let builtinInflight: Promise<void> | null = null;


/** 首次启动写入 + 版本升级：内置 skill 在 UI 中只读（编辑存为副本、可重置），
 *  因此按名 upsert——同名内置行直接升级为最新内容，用户副本不受影响；references 同步落库。 */
export function ensureBuiltinSkills(): Promise<void> {
  builtinInflight ??= doEnsureBuiltinSkills().finally(() => {
    builtinInflight = null;
  });
  return builtinInflight;
}

async function doEnsureBuiltinSkills(): Promise<void> {
  // In account mode the server materializes builtins once and projects the live
  // package files. Re-upserting bundled text here would undo library/Shell edits.
  await (await import('../cloud/sync')).flushCloud();
}

/** Level 1：对话与旧 IR 流水线各自发现适用规范，失败兜底也不会混入另一套协议。 */
export async function loadEnabledSkillMeta(context: 'chat' | 'legacy-handout' = 'chat'): Promise<SkillMeta[]> {
  const skills = (cloud.enabled ? await readSkillIndex() : await db.skills.orderBy('id').toArray()).filter(s => !!s.enabled);
  const legacyIds = skills.filter(isLegacyHandoutSkill).map((s) => s.id!);
  return skills
    .filter((s) => !s.builtin || (context === 'legacy-handout' ? isLegacyHandoutSkill(s) : !isLegacyHandoutSkill(s)))
    .map((s) => ({
      id: s.id!, name: s.name, description: s.description, revision: s.updatedAt,
      builtin: !!s.builtin,
      ...(s.legacyIds ? { legacyIds: s.legacyIds } : {}),
      ...(s.mcpRequired ? { mcpRequired: s.mcpRequired } : {}),
      ...(context === 'chat' && s.builtin && s.name === COURSE_HANDOUT_SKILL ? { legacyIds } : {}),
    }));
}

/**
 * 会话白名单 → 实际可用的技能元数据（问答侧取数入口）。
 *
 * 三态判定与求交在 `./scope`（零依赖，Node 可直接单测）；这里只负责把启用集合喂进去。
 * **顺序不能反**：先取启用集合、再按白名单求交，天然满足「技能被禁用后，白名单里的
 * 残留 id 自动失效」，不需要另写一套 enabled 判断。
 * 未限定（`undefined`）时结果等价于 `loadEnabledSkillMeta()`，即改动前的行为。
 */
export async function loadSessionSkillMeta(skillIds?: number[]): Promise<SkillMeta[]> {
  const enabled = await loadEnabledSkillMeta();
  const usable = new Set(intersectSkillMetaIds(enabled, skillIds));
  return enabled.filter((m) => usable.has(m.id));
}

/** Level 2：按 id 加载技能正文并拼接（带总预算截断） */
export async function loadSkillBodies(ids: number[]): Promise<string> {
  if (ids.length === 0) return '';
  const database = db, owner = cloud.userId;
  const lifetime = cloud.enabled ? accountLifetime(owner) : undefined;
  const rows: SkillRow[] = [];
  // One exact body per request preserves the exceptional-record allowance; a
  // large selected skill cannot make an otherwise valid multi-key batch fail.
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    lifetime?.assertCurrent();
    const row = cloud.enabled ? (await (await import('../cloud/sync')).readRecordKeys<SkillRow>('skills', [id]))[0] : await database.skills.get(id);
    lifetime?.assertCurrent();
    if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
    if (row) rows.push(row);
    if (rows.reduce((total, skill) => total + skill.body.trim().length, 0) >= SKILL_BLOCK_BUDGET) break;
  }
  return rows
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((s) => s.body.trim())
    .filter(Boolean)
    .join('\n\n---\n\n')
    .slice(0, SKILL_BLOCK_BUDGET);
}

/** 元数据列表 → 提示词用的清单文本 */
export function skillMetaBlock(metas: SkillMeta[]): string {
  return metas.map((m) => `- ${m.name}：${m.description || '（无描述）'}${m.mcpRequired?.length ? ` [MCP: ${m.mcpRequired.join(', ')}]` : ''}`).join('\n');
}

/** 导入 .md 单文件或 skill zip 包（含 references/），落库并默认启用 */
export async function importSkillFile(file: File): Promise<{ name: string; refCount: number }> {
  const database = db, lifetime = cloud.enabled ? accountLifetime(cloud.userId) : undefined;
  let pkg: ParsedSkillPackage;
  if (/\.zip$/i.test(file.name)) {
    pkg = parseSkillZip(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.zip$/i, ''));
  } else {
    pkg = {
      skill: parseSkillMarkdown(file.name, await file.text()),
      refs: [],
    };
    if (!pkg.skill.body) throw new Error('正文为空');
  }

  lifetime?.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  await saveSkillPackage(null, { ...pkg.skill, id: learningId(), enabled: 1, builtin: 0, updatedAt: Date.now() }, pkg.refs);
  return { name: pkg.skill.name, refCount: pkg.refs.length };
}
