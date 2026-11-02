import type { CloudProvider, ModelCandidate, ModelPreset, ModelPurpose, ModelRef, ModelRouteDefaults } from '@wangke/contracts/cloud';
import type { Settings } from '../store/settings';

export type PresetDraft = { modelPresets?: ModelPreset[]; modelRoutes?: ModelRouteDefaults };
export const MODEL_USES = [
  { purpose: 'chat', label: '普通聊天 / 课程问答', slot: 'chat', hint: '日常对话与课程相关的问答', source: '主模型' },
  { purpose: 'bot', label: 'Bot 助手', slot: 'chat', hint: 'Bot 执行任务时使用的模型', source: '主模型' },
  { purpose: 'vision', label: '图片理解', slot: 'vision', hint: '识别图片、截图里的内容', source: '图片理解模型（未指定时使用主模型）' },
  { purpose: 'asr', label: '语音转写', slot: 'asr', hint: '把音频与视频中的语音转成文字', source: '语音识别模型' },
  { purpose: 'decision', label: '决策', slot: 'decision', hint: '技能路由与历史筛选，不负责生成回答', source: '决策模型' },
  { purpose: 'memory', label: '记忆整理', slot: 'chat', hint: '整理需要长期保留的对话信息', source: '主模型' },
] as const;

const fields = { chat: 'llmModel', bot: 'llmModel', memory: 'llmModel', vision: 'visionModel', asr: 'asrModel', decision: 'decisionModel' } as const;
export function defaultRouteRef(settings: Pick<Settings, 'llmModel' | 'visionModel' | 'asrModel' | 'decisionModel'>, purpose: ModelPurpose): ModelRef {
  const ref = settings[fields[purpose]];
  return purpose === 'vision' && !ref.model ? settings.llmModel : ref;
}

export function purposePreset(value: PresetDraft, purpose: ModelPurpose) {
  const id = value.modelRoutes?.byPurpose[purpose];
  return id && !id.startsWith('builtin-') ? value.modelPresets?.find(p => p.id === id) : undefined;
}

/** Editing one use must never silently edit a shared plan used by another use. */
export function editPurposeRoute(value: PresetDraft, purpose: ModelPurpose, fallback: ModelRef, patch: Partial<Pick<ModelPreset, 'candidates' | 'policy'>>): PresetDraft {
  const current = purposePreset(value, purpose);
  const shared = current && (current.purposes.length > 1 || Object.entries(value.modelRoutes?.byPurpose ?? {}).some(([key, id]) => key !== purpose && id === current.id));
  const preset: ModelPreset = current && !shared ? { ...current, ...patch } : {
    ...current,
    id: `route-${purpose}-${crypto.randomUUID()}`,
    name: `${MODEL_USES.find(use => use.purpose === purpose)!.label}的主备模型`,
    purposes: [purpose],
    candidates: current?.candidates ?? [{ ref: { ...fallback } }],
    policy: current?.policy ?? { allowCrossProvider: false, maxAttemptsPerCandidate: 2 },
    ...patch,
  };
  return {
    ...value,
    modelPresets: current && !shared ? value.modelPresets!.map(p => p.id === current.id ? preset : p) : [...(value.modelPresets ?? []), preset],
    modelRoutes: { byPurpose: { ...value.modelRoutes?.byPurpose, [purpose]: preset.id } },
  };
}

export function followDefaultRoute(value: PresetDraft, purpose: ModelPurpose): PresetDraft {
  const byPurpose = { ...value.modelRoutes?.byPurpose };
  // Omitting the override lets the server regenerate the matching builtin, even
  // when the default was configured for the first time in this same draft.
  delete byPurpose[purpose];
  return { ...value, modelRoutes: { byPurpose } };
}

export function routeDraftIssue(value: PresetDraft, providerIds: Set<string>): string | undefined {
  for (const preset of value.modelPresets ?? []) {
    if (preset.id.startsWith('builtin-')) continue; // regenerated from the live default slots on save
    const use = MODEL_USES.find(use => value.modelRoutes?.byPurpose[use.purpose] === preset.id);
    const name = use?.label ?? `已保存方案「${preset.name}」`;
    if (!preset.candidates.length || !preset.candidates.some(c => c.enabled !== false)) return `${name}：请至少保留一个启用的模型。`;
    for (const candidate of preset.candidates) {
      if (!providerIds.has(candidate.ref.providerId)) return `${name}：模型的供应商已删除，请重新选择模型或删除这条配置。`;
      if (!candidate.ref.model.trim()) return `${name}：请选择模型后再保存。`;
    }
  }
}

export function candidateLabel(candidates: ModelCandidate[], index: number) {
  if (candidates[index].enabled === false) return '已停用模型';
  const position = candidates.slice(0, index).filter(c => c.enabled !== false).length;
  return position === 0 ? '主模型' : `备用模型 ${position}`;
}

/** Mirrors the gateway's fallback admission; selecting a model is not permission to send data to it. */
export function fallbackWarning(primary: ModelRef, backup: ModelRef, providers: CloudProvider[], preset?: ModelPreset) {
  const first = providers.find(p => p.id === primary.providerId), next = providers.find(p => p.id === backup.providerId);
  if (!first || !next) return '供应商已删除，请重新选择模型。';
  const deployment = (p: CloudProvider, ref: ModelRef) => p.deployments?.find(d => d.model === ref.model);
  const firstDeployment = deployment(first, primary), nextDeployment = deployment(next, backup);
  const policy = (p: CloudProvider, d: ReturnType<typeof deployment>) => d?.dataPolicy ?? p.dataPolicy ?? 'default';
  if (policy(first, firstDeployment) !== policy(next, nextDeployment)) return '这两个模型的数据策略不同，系统不会自动切换到这个备用模型。';
  if ([{ p: first, d: firstDeployment }, { p: next, d: nextDeployment }].some(({ p, d }) => p.id === 'opencode-go' ? d?.allowFallback !== true || policy(p, d) === 'default' : d?.allowFallback === false)) return '供应商限制了自动切换；这个备用模型目前不会接替，请先核对服务端的数据策略与切换许可。';
  if (first.id !== next.id && preset?.policy?.allowCrossProvider === false) return '此备用模型来自另一供应商。勾选下方的跨供应商许可后，才会在故障时尝试它。';
}
