import { getModelMeta } from './modelMeta.ts';
import type { ModelTarget } from './modelTypes.ts';
import type { ThinkingLevel } from './modelClient.ts';

/** Audited wire contracts and model exceptions; see docs/model-reasoning.md.
 * A metadata-catalog override is NOT a transport override. Unknown gateways get
 * only declared standard effort, never guessed vendor-specific switches. */
type Mode = 'openai' | 'adaptive' | 'budget' | 'enable' | 'thinking' | 'router' | 'google' | 'minimax' | 'effort' | 'unknown';
export interface ReasoningProfile {
  mode: Mode;
  supported: boolean;
  canDisable: boolean;
  efforts?: string[];
  budget?: { min: number; max: number };
  preserve?: boolean;
  summary?: boolean;
  chatTools?: 'never' | 'non-reasoning';
  responsesOnly?: boolean;
}
type Target = Pick<ModelTarget, 'model' | 'protocol' | 'catalogId' | 'baseUrl' | 'capabilities' | 'reasoningProvider'>;
const ranks: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
const ratios: Record<string, number> = { minimal: 1 / 16, low: 1 / 8, medium: 1 / 4, high: 1 / 2, xhigh: 1, max: 1 };
const labels: Record<string, string> = { none: '不思考', minimal: '极简', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' };
const noReasoning: ReasoningProfile = { mode: 'unknown', supported: false, canDisable: false };

export function normalizeThinkingLevel(value: unknown): ThinkingLevel | undefined {
  return typeof value === 'string' && Object.hasOwn(ranks, value) ? value as ThinkingLevel : undefined;
}

/** Keep only a public adapter key when the Gateway replaces the private URL. */
export function reasoningProviderOf(t: Pick<ModelTarget, 'baseUrl' | 'catalogId'>): string {
  let host = '';
  try { host = new URL(t.baseUrl).hostname; } catch { return t.catalogId; }
  if (host === 'openrouter.ai') return 'openrouter';
  if (/^api\.siliconflow\.(cn|com)$/.test(host)) return host.endsWith('.cn') ? 'siliconflow-cn' : 'siliconflow';
  if (host === 'generativelanguage.googleapis.com') return 'google';
  if (host === 'api.deepseek.com') return 'deepseek';
  if (/^api\.moonshot\.(ai|cn)$/.test(host)) return 'moonshotai';
  if (host === 'open.bigmodel.cn' || host === 'api.z.ai') return 'zai';
  if (/(?:^|\.)(?:dashscope\.aliyuncs\.com|maas\.aliyuncs\.com)$/.test(host)) return 'alibaba-cn';
  if (/(?:^|\.)minimax\.(io|com)$/.test(host)) return 'minimax';
  if (host === 'api.x.ai') return 'xai';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'api.openai.com') return 'openai';
  return t.catalogId;
}

export function reasoningProfile(t: Target): ReasoningProfile {
  if (t.capabilities?.reasoningEffort === '') return noReasoning;
  const meta = getModelMeta(t.catalogId, t.model, t.capabilities);
  let host = '';
  try { host = new URL(t.baseUrl).hostname; } catch { /* virtual/server targets use catalogId */ }
  const catalog = t.reasoningProvider ?? reasoningProviderOf(t);
  const model = t.model.toLowerCase().replace(/^(openai|anthropic|google)\//, '');
  let p: ReasoningProfile = { mode: 'unknown', supported: meta?.reasoning ?? false, canDisable: false,
    efforts: meta?.thinking?.effort, ...(meta?.thinking?.budget?.max ? { budget: { min: meta.thinking.budget.min ?? 128, max: meta.thinking.budget.max } } : {}) };
  if (host === 'openrouter.ai' || catalog === 'openrouter') {
    p = { ...p, mode: 'router', canDisable: meta?.thinking?.canDisable ?? meta?.thinking?.toggle ?? false, preserve: true };
  } else if (catalog === 'siliconflow' || catalog === 'siliconflow-cn' || /^api\.siliconflow\.(cn|com)$/.test(host)) {
    const documented = ['Pro/deepseek-ai/DeepSeek-V4', 'deepseek-ai/DeepSeek-V4-Flash', 'Pro/zai-org/GLM-5.2'].includes(t.model);
    p = { ...p, mode: 'enable', canDisable: meta?.thinking?.toggle ?? false,
      ...(documented ? { supported: true, canDisable: true, efforts: ['high', 'max'], budget: undefined } : {}) };
  } else if (host === 'generativelanguage.googleapis.com' || catalog === 'google') {
    if (/^gemini-2\.5-(pro|flash)/.test(model)) {
      const pro = model.startsWith('gemini-2.5-pro');
      p = { mode: 'google', supported: true, canDisable: !pro, budget: { min: pro ? 128 : model.includes('lite') ? 512 : 128, max: pro ? 32768 : 24576 }, preserve: true };
    } else if (/^gemini-(?:3(?:\.[1568])?-(?:pro|flash)|4-argon)(?:-|$)/.test(model)) {
      const minimal = model.includes('flash') && !model.startsWith('gemini-3.8-');
      const medium = model.includes('flash') || model.startsWith('gemini-4-') || model.startsWith('gemini-3.1-');
      p = { mode: 'google', supported: true, canDisable: false, efforts: [...(minimal ? ['minimal'] : []), 'low', ...(medium ? ['medium'] : []), 'high'], preserve: true };
    }
  } else if (host === 'api.deepseek.com' || catalog === 'deepseek') {
    p = { ...p, mode: 'thinking', preserve: true };
    if (/^deepseek-(?:v4|flash|pro)/.test(model)) p = { ...p, supported: true, canDisable: true, efforts: ['low', 'high', 'max'], budget: undefined };
    else if (model === 'deepseek-chat' || /^deepseek-v3[.-]/.test(model)) p = { ...p, supported: true, canDisable: true };
    else if (model === 'deepseek-reasoner') p = { ...p, supported: true, canDisable: false };
  } else if (['moonshotai', 'moonshotai-cn', 'moonshot'].includes(catalog) || /^api\.moonshot\.(ai|cn)$/.test(host)) {
    p = { ...p, mode: 'thinking', preserve: true };
    if (/^kimi-k3(?:[.-]|$)/.test(model)) p = { ...p, supported: true, canDisable: false, efforts: ['low', 'high', 'max'] };
    else if (/^kimi-k2\.[56](?:-|$)/.test(model)) p = { ...p, supported: true, canDisable: true, efforts: undefined, budget: undefined };
    else if (/^kimi-k2(?:\.7-code|-thinking)/.test(model)) p = { ...p, supported: true, canDisable: false, efforts: undefined, budget: undefined };
  } else if (['zai', 'zhipuai', 'zai-coding-plan', 'zhipuai-coding-plan'].includes(catalog) || host === 'open.bigmodel.cn' || host === 'api.z.ai') {
    p = { ...p, mode: 'thinking', preserve: true };
    if (/^glm-5\.3(?:-|$)/.test(model)) p = { ...p, supported: true, canDisable: false, efforts: ['low', 'high', 'max'], budget: undefined };
    else if (/^glm-5\.2(?:-|$)/.test(model)) p = { ...p, supported: true, canDisable: true, efforts: ['high', 'max'], budget: undefined };
    else if (/^glm-(?:5(?:\.1)?|4\.[567])(?:-|$)/.test(model)) p = { ...p, supported: true, canDisable: true };
  } else if (['alibaba', 'alibaba-cn'].includes(catalog) || /(?:^|\.)(?:dashscope\.aliyuncs\.com|maas\.aliyuncs\.com)$/.test(host)) {
    p = { ...p, mode: 'enable', canDisable: meta?.thinking?.canDisable ?? meta?.thinking?.toggle ?? false };
    if (/^qwen(?:3(?:\.[5678])?-(?:max|plus|flash|\d)|-(?:plus|flash))/.test(model) && !/thinking|preview|2\.4t/.test(model)) p = { ...p, supported: true, canDisable: true };
  } else if (['minimax', 'minimax-cn'].includes(catalog) || /(?:^|\.)minimax\.(io|com)$/.test(host)) {
    if (/^minimax-m(?:2(?:[.-]|$)|3(?:[.-]|$))/.test(model)) p = { mode: 'minimax', supported: true, canDisable: model === 'minimax-m3', preserve: true,
      ...(model === 'minimax-m3.1-flash' ? { efforts: ['low', 'medium', 'high', 'xhigh', 'max'] } : {}) };
  } else if (catalog === 'xai' || host === 'api.x.ai') {
    if (/^grok-3-mini(?:-|$)/.test(model)) p = { mode: 'effort', supported: true, canDisable: false, efforts: ['low', 'high'] };
    else if (/^grok-4\.[567](?:-|$)/.test(model) && !model.includes('non-reasoning')) p = { mode: 'effort', supported: true, canDisable: false, efforts: ['low', 'medium', 'high', ...(/^grok-4\.[67]/.test(model) ? ['xhigh'] : [])] };
    else if (/^grok-4(?:-|$)/.test(model) && !model.includes('non-reasoning')) p = { mode: 'effort', supported: true, canDisable: false };
  } else if (t.protocol === 'anthropic-messages' && /^claude-/.test(model)) {
    // Explicit generations, not "all Claude models support adaptive thinking".
    if (/^claude-(?:(?:opus|sonnet)-4[-.]6|opus-4[-.][78]|(?:opus|sonnet|haiku)-5(?:[-.]5)?|(?:fable|mythos)-5(?:[-.]1)?|mythos-preview)(?:-|$)/.test(model)) {
      const always = /^claude-(?:(?:fable|mythos)-|opus-5[-.]5|sonnet-5[-.]5)/.test(model);
      const xhigh = !/4[-.]6|mythos-preview/.test(model);
      p = { mode: 'adaptive', supported: true, canDisable: !always, efforts: ['low', 'medium', 'high', ...(xhigh ? ['xhigh'] : []), 'max'] };
    } else if (/^claude-(?:3[-.]7-sonnet|(?:opus|sonnet)-4(?:[-.][15])?|haiku-4[-.]5)(?:-|$)/.test(model)) {
      p = { mode: 'budget', supported: true, canDisable: true, budget: { min: 1024, max: Math.min(32768, (meta?.output ?? 8192) - 1024) } };
    }
  } else if (/^(?:gpt-5(?:\.[1-6])?(?:-|$)|gpt-6(?:\.1)?-(?:astra|sol|luna|terra)(?:-|$)|o[134](?:-|$))/.test(model)) {
    // Chat-latest / non-reasoning chat aliases do not accept effort controls.
    if (!model.includes('chat-latest') && model !== 'o1-mini' && model !== 'o1-preview') {
      const original5 = /^gpt-5(?:-|$)/.test(model);
      const first51 = /^gpt-5\.1(?:-|$)/.test(model);
      const gpt6 = /^gpt-6(?:[.-]|$)/.test(model);
      p = { mode: 'openai', supported: true, summary: true,
        canDisable: !/^o\d/.test(model) && !original5 && !model.includes('pro') && !/^gpt-6(?:-astra|\.1-sol)/.test(model),
        efforts: /^o\d/.test(model) ? ['low', 'medium', 'high'] : original5 ? ['minimal', 'low', 'medium', 'high'] : first51 ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', ...(gpt6 || /^gpt-5\.6(?:-|$)/.test(model) ? ['max'] : [])] };
      if (model.includes('-pro')) p = { ...p, responsesOnly: true,
        ...(!/^o\d/.test(model) ? { efforts: original5 ? ['high'] : ['medium', 'high', 'xhigh'] } : {}) };
      if (gpt6) p.chatTools = /^gpt-6(?:-astra|\.1-)/.test(model) ? 'never' : 'non-reasoning';
    }
  }
  // User effort overrides change legal values, not the provider's wire shape or
  // a documented inability to turn reasoning off.
  if (t.capabilities?.reasoningEffort !== undefined && p.mode !== 'unknown') p = { ...p, supported: !!meta?.reasoning, efforts: meta?.thinking?.effort, budget: undefined };
  if (p.mode === 'unknown') {
    // Metadata can declare standard effort but cannot identify a vendor's budget
    // parameter. Never render a budget slider that the unknown wire cannot send.
    p = { ...p, budget: undefined, canDisable: meta?.thinking?.canDisable ?? false, summary: t.protocol === 'openai-responses' };
    if (t.protocol === 'anthropic-messages') p = { ...p, supported: false };
  }
  return p;
}

function effortFor(p: ReasoningProfile, requested: ThinkingLevel): string | undefined {
  if (p.mode === 'enable' && requested === 'xhigh' && !p.efforts?.includes('xhigh') && p.efforts?.includes('max')) return 'max';
  const sorted = [...(p.efforts ?? [])].sort((a, b) => (ranks[a] ?? 0) - (ranks[b] ?? 0));
  return sorted.filter(v => (ranks[v] ?? 0) <= ranks[requested]).at(-1) ?? sorted[0];
}

export function reasoningChoices(t: Target): { value: ThinkingLevel; label: string }[] {
  const p = reasoningProfile(t);
  if (!p.supported) return [];
  const levels = p.efforts?.length ? p.efforts : p.budget ? ['minimal', 'low', 'medium', 'high', 'xhigh'] : [];
  return [...(p.canDisable ? ['none'] : []), ...levels].flatMap(value => {
    const known = normalizeThinkingLevel(value);
    return known ? [{ value: known, label: labels[known] }] : [];
  });
}

/** Invalid persisted levels cannot leak NaN/unknown enums onto the wire. A
 * forced-thinking model maps a stale "off" preference to its weakest real level. */
export function effectiveThinkingLevel(t: Target, value: unknown): ThinkingLevel | undefined {
  const level = normalizeThinkingLevel(value);
  const p = reasoningProfile(t);
  if (!level || !p.supported) return;
  if (level === 'none' && p.canDisable) return level;
  return (effortFor(p, level) as ThinkingLevel | undefined) ?? (level === 'none' ? 'minimal' : level);
}

export function reasoningWire(t: Target, requested: unknown, maxTokens: number): Record<string, unknown> {
  const p = reasoningProfile(t);
  const level = effectiveThinkingLevel(t, requested);
  if (!level) return {};
  const off = level === 'none';
  const effort = effortFor(p, level);
  const budget = p.budget ? Math.min(p.budget.max, Math.max(p.budget.min, Math.round(p.budget.max * ratios[level]))) : undefined;
  if (t.protocol === 'openai-responses') return { reasoning: { ...(off ? { effort: 'none' } : effort ? { effort } : p.mode === 'minimax' ? { effort: 'high' } : {}), ...(!off && p.summary ? { summary: 'auto' } : {}) } };
  if (t.protocol === 'anthropic-messages') {
    if (off) return { thinking: { type: 'disabled' }, ...(p.mode === 'adaptive' ? { output_config: { effort: 'high' } } : {}) };
    if (p.mode === 'adaptive') return { thinking: { type: 'adaptive' }, ...(effort ? { output_config: { effort } } : {}) };
    if (p.mode === 'budget') {
      if (maxTokens <= 1024) throw new Error('开启 Claude 思考时输出上限必须大于 1024 tokens');
      const ceiling = Math.min(p.budget?.max ?? 32768, Math.max(1024, maxTokens - 1024));
      return { thinking: { type: 'enabled', budget_tokens: Math.min(maxTokens - 1, Math.max(1024, Math.round(ceiling * ratios[level]))) } };
    }
    if (p.mode === 'minimax') return { thinking: { type: 'adaptive' }, ...(effort ? { output_config: { effort } } : {}) };
    // DeepSeek / GLM Messages-compatible endpoints use output_config.effort.
    if (p.mode === 'thinking') return { ...(p.canDisable ? { thinking: { type: 'enabled' } } : {}), ...(effort ? { output_config: { effort } } : {}) };
    return {};
  }
  if (p.mode === 'minimax') return { reasoning_split: true, ...(off ? { thinking: { type: 'disabled' } } : effort ? { reasoning_effort: effort } : {}) };
  if (p.mode === 'router') return { reasoning: off ? { enabled: false } : { enabled: true, exclude: false, ...(effort ? { effort } : budget ? { max_tokens: budget } : {}) } };
  if (p.mode === 'google') return { extra_body: { google: { thinking_config: { include_thoughts: !off,
    ...(p.budget ? { thinking_budget: off ? 0 : budget } : { thinking_level: effort }) } } } };
  if (p.mode === 'thinking') return { ...(p.canDisable ? { thinking: { type: off ? 'disabled' : 'enabled' } } : {}), ...(!off && effort ? { reasoning_effort: effort } : {}) };
  if (p.mode === 'enable') return { ...(p.canDisable ? { enable_thinking: !off } : {}), ...(!off && effort ? { reasoning_effort: effort } : !off && budget ? { thinking_budget: budget } : {}) };
  return { ...(off ? { reasoning_effort: 'none' } : effort ? { reasoning_effort: effort } : {}) };
}

export function reasoningTemperatureAllowed(t: Target, requested: unknown): boolean {
  const p = reasoningProfile(t);
  // Omit rather than trying to force temperature=1; newer Claude models reject it.
  if (p.mode === 'adaptive') return false;
  if (p.mode === 'budget') return effectiveThinkingLevel(t, requested) === 'none' || requested === undefined;
  if (p.mode === 'openai') return false;
  if (p.mode === 'thinking' && /^(?:kimi-|deepseek-)/i.test(t.model)) return effectiveThinkingLevel(t, requested) === 'none';
  if (p.mode === 'minimax' && /^minimax-m3/i.test(t.model)) return false;
  return true;
}
