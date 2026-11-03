/**
 * 模型能力查询：用户覆盖优先，未配置字段用 models.dev（按供应商逐家索引）。
 * 视觉/推理能力未知时不按名称猜测；上下文估值仍保留历史兜底。
 *
 * `catalogId` 是可选匹配提示；缺省时仅采用全目录唯一的精确 ID，不按名称猜测。
 *
 * 思考控制统一委托共享 reasoning.ts；这里的 catalog-only 函数仅供旧调用方兼容。
 */

import type { ReasoningEffort, ThinkingLevel } from './siliconflow';
import { getModelMeta, type ModelOverrides, type ThinkingControl } from './modelMeta';
import { normalizeThinkingLevel, reasoningProfile, reasoningWire } from '@wangke/study-core/model/reasoning';

export function isVisionModel(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  return getModelMeta(catalogId, id, overrides)?.vision ?? false;
}

export function supportsThinking(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  return reasoningProfile({ catalogId, model: id, protocol: 'openai-chat', baseUrl: '', capabilities: overrides }).supported;
}

/** Portable intent labels; ModelPicker passes a target-specific subset. */
export const THINKING_LEVELS: readonly { value: ThinkingLevel; label: string }[] = [
  { value: 'none', label: '不思考' },
  { value: 'minimal', label: '极简' },
  { value: 'low', label: '低' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '高' },
  { value: 'xhigh', label: '极高' },
  { value: 'max', label: '最高' },
];

/**
 * 把任意来源的值收敛成一个合法档位；认不出来返回 null（= 当没设过）。
 *
 * 要挡的是**跨版本 / 跨设备的值**：localStorage 里的旧设置、旧版本导出的迁移包、
 * 将来的同步载荷，都可能带一个现在不存在的档位名。放任它进 store 的后果不是「显示不对」
 * 那么轻 —— 预算型模型的折算会算出 `NaN`，`JSON.stringify` 把它变成 `null` 发出去，
 * 网关回一句和界面现象毫无关系的 400。所以入口处一律收敛。
 *
 * `'none'` 也返回 null：它是滑块第一档，由 `thinkingEnabled` 表达，**不该出现在这个字段里**。
 */
export function normalizeThinkingEffort(value: unknown): ReasoningEffort | null {
  const known = normalizeThinkingLevel(value);
  return known && known !== 'none' ? known : null;
}

/**
 * @deprecated Catalog-only Chat projection. UI should query a full ModelTarget.
 */
export function thinkingControlOf(catalogId: string, id: string, overrides?: ModelOverrides): ThinkingControl | null {
  const p = reasoningProfile({ catalogId, model: id, protocol: 'openai-chat', baseUrl: '', capabilities: overrides });
  if (!p.supported) return null;
  return { toggle: p.canDisable, canDisable: p.canDisable, ...(p.efforts?.length ? { effort: p.efforts } : {}), ...(p.budget ? { budget: p.budget } : {}) };
}

/** 这个模型能不能调思考深度：只有它声明了 effort 档位或 budget 区间才算 */
export function hasThinkingDepth(catalogId: string, id: string, overrides?: ModelOverrides): boolean {
  const control = thinkingControlOf(catalogId, id, overrides);
  return !!control && (!!control.effort?.length || !!control.budget);
}

/** @deprecated Catalog-only Chat compatibility helper. New callers must pass
 * thinkingLevel to modelClient so protocol, endpoint and model are all known. */
export function thinkingParams(catalogId: string, model: string, level: ThinkingLevel, overrides?: ModelOverrides) {
  return reasoningWire({ catalogId, model, protocol: 'openai-chat', baseUrl: '', capabilities: overrides }, level, 4096);
}

/**
 * 模型单次输出的上限（tokens），即 `max_tokens` 的天花板；元数据缺失时回退到 8192。
 *
 * 与 `contextWindow` 不是一回事：这个只管**输出**那一半，窗口是输入+输出的总容量。
 * 超了它网关直接拒，所以每轮算输出预算时拿它当上限。
 *
 * 实测在架模型（models.dev）：DeepSeek-V4-Pro 384k、Kimi-K3 / GLM-5.2 262k、
 * Qwen3.5-122B 64k，但也有 Qwen2.5-72B 只有 4k —— **所以必须逐模型取，不能取全局最大**。
 */
export function outputLimitOf(catalogId: string, id: string, overrides?: ModelOverrides): number {
  return getModelMeta(catalogId, id, overrides)?.output ?? 8192;
}

/**
 * 算输出预算时该用的窗口：**取设置值与模型真实窗口里更大的那个**。
 *
 * 为什么不用设置值：`contextWindow` 是给历史裁剪用的**保守估值**（默认 131072），
 * 用户不一定改过，而模型真实窗口可能是 1M（DeepSeek-V4-Pro / Kimi-K3 / GLM-5.2）。
 * 拿估值当上限会让 `max_tokens` 被压到几万，白白浪费模型能力 ——
 * 而 `max_tokens` 是天花板不是预留，给足不花钱。
 *
 * 取 max 而不是无条件信元数据：设置值可能被用户**调大**过（换过窗口更大的服务），
 * 那是显式意图，不能被元数据拉回去。两者都缺时返回 null，交给调用方按未知处理。
 * 模型编辑器中的显式窗口覆盖优先于上述估值，无论它调大还是调小。
 */
export function effectiveContextWindow(
  catalogId: string,
  id: string,
  configured?: number | null,
  overrides?: ModelOverrides,
): number | null {
  if (overrides?.contextWindow !== undefined) return overrides.contextWindow;
  const meta = getModelMeta(catalogId, id)?.context ?? null;
  const conf = configured != null && configured > 0 ? configured : null;
  if (meta == null && conf == null) return null;
  return Math.max(meta ?? 0, conf ?? 0);
}

/** 启发式上下文窗口对照表（tokens），仅作元数据缺失时的兜底，未知 131072 */
const WINDOW_TABLE: [RegExp, number][] = [
  [/deepseek-v4/i, 1000000],
  [/deepseek/i, 131072],
  [/qwen3-vl/i, 262144],
  [/qwen3/i, 131072],
  [/qwen2\.5/i, 131072],
  [/glm/i, 131072],
  [/kimi|moonshot/i, 131072],
  [/gpt-4o|gpt-5/i, 128000],
  [/claude/i, 200000],
  [/gemini/i, 1048576],
];

export function guessContextWindow(catalogId: string, id: string, overrides?: ModelOverrides): number {
  const meta = getModelMeta(catalogId, id, overrides);
  if (meta) return meta.context;
  for (const [re, win] of WINDOW_TABLE) if (re.test(id)) return win;
  return 131072;
}
