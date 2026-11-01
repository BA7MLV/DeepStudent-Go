import { Button } from '@heroui/react';
import type { CloudProvider, ModelPreset, ModelPurpose, ModelRouteDefaults } from '@wangke/contracts/cloud';

export type PresetDraft = { modelPresets?: ModelPreset[]; modelRoutes?: ModelRouteDefaults };
const purposes: Array<[ModelPurpose, string]> = [['chat', '普通聊天 / 课程问答'], ['bot', 'Bot'], ['vision', '视觉'], ['asr', '语音转写'], ['decision', '决策'], ['memory', '记忆整理']];
const control = 'min-w-0 rounded-lg border border-default bg-transparent p-2 text-sm';
/** Draft-only editor: no credentials, persistence middleware or discovery side effects. */
export default function ModelPresets({ value, providers, onChange }: { value: PresetDraft; providers: CloudProvider[]; onChange: (value: PresetDraft) => void }) {
  const presets = value.modelPresets ?? [], byPurpose = value.modelRoutes?.byPurpose ?? {};
  const update = (id: string, patch: Partial<ModelPreset>) => onChange({ ...value, modelPresets: presets.map(p => p.id === id ? { ...p, ...patch } : p) });
  return <section className="flex min-w-0 flex-col gap-4" aria-label="模型 Preset 与 fallback" data-testid="model-presets">
    <div><h3 className="font-medium">模型 Preset 与 fallback</h3><p className="text-xs text-muted">按候选顺序路由；鉴权、账单额度和参数错误不切换。流式输出后不会重放。内置 Preset 跟随旧默认模型。</p></div>
    <div className="grid gap-3 sm:grid-cols-2">{purposes.map(([purpose, label]) => <label className="flex min-w-0 flex-col gap-1 text-sm" key={purpose}>{label}
      <select className={control} value={byPurpose[purpose] ?? ''} onChange={e => {
        const next = { ...byPurpose }; if (e.target.value) next[purpose] = e.target.value; else delete next[purpose];
        onChange({ ...value, modelRoutes: { byPurpose: next } });
      }}><option value="">未配置</option>{presets.filter(p => p.purposes.includes(purpose)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </label>)}</div>
    {presets.filter(p => !p.id.startsWith('builtin-')).map(preset => <fieldset key={preset.id} className="flex min-w-0 flex-col gap-3 rounded-xl bg-default/5 p-3">
      <legend className="text-xs text-muted">{preset.id}</legend>
      <label className="flex flex-col gap-1 text-sm">Preset 名称<input className={control} value={preset.name} maxLength={100} onChange={e => update(preset.id, { name: e.target.value })} /></label>
      <div className="flex flex-wrap gap-3">{purposes.map(([purpose, label]) => <label key={purpose} className="text-xs"><input type="checkbox" checked={preset.purposes.includes(purpose)} onChange={e => update(preset.id, { purposes: e.target.checked ? [...preset.purposes, purpose] : preset.purposes.filter(p => p !== purpose) })} /> {label}</label>)}</div>
      {preset.candidates.map((candidate, index) => <div key={index} className="flex min-w-0 flex-wrap items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">候选 {index + 1} · 供应商<select aria-label={`候选 ${index + 1} · 供应商`} className={control} value={candidate.ref.providerId} onChange={e => update(preset.id, { candidates: preset.candidates.map((c, i) => i === index ? { ...c, ref: { ...c.ref, providerId: e.target.value } } : c) })}>
          <option value="">选择供应商</option>{providers.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          {candidate.ref.providerId && !providers.some(p => p.id === candidate.ref.providerId) && <option value={candidate.ref.providerId}>供应商已删除</option>}
        </select></label>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">精确 Model ID<input className={control} value={candidate.ref.model} maxLength={200} onChange={e => update(preset.id, { candidates: preset.candidates.map((c, i) => i === index ? { ...c, ref: { ...c.ref, model: e.target.value } } : c) })} /></label>
        <Button size="sm" variant="tertiary" isDisabled={index === 0} onPress={() => { const candidates = [...preset.candidates]; [candidates[index - 1], candidates[index]] = [candidates[index], candidates[index - 1]]; update(preset.id, { candidates }); }}>上移</Button>
        <Button size="sm" variant="tertiary" onPress={() => update(preset.id, { candidates: preset.candidates.filter((_, i) => i !== index) })}>移除</Button>
      </div>)}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="secondary" onPress={() => update(preset.id, { candidates: [...preset.candidates, { ref: { providerId: providers[0]?.id ?? '', model: '' } }] })}>添加备用模型</Button>
        <label className="text-xs"><input type="checkbox" checked={preset.policy?.allowCrossProvider !== false} onChange={e => update(preset.id, { policy: { ...preset.policy, allowCrossProvider: e.target.checked } })} /> 允许相同数据策略的跨供应商 fallback</label>
        <Button size="sm" variant="tertiary" isDisabled={Object.values(byPurpose).includes(preset.id)} onPress={() => onChange({ ...value, modelPresets: presets.filter(p => p.id !== preset.id) })}>删除 Preset</Button>
      </div>
    </fieldset>)}
    <Button className="self-start" variant="secondary" onPress={() => onChange({ ...value, modelPresets: [...presets, { id: `preset-${crypto.randomUUID()}`, name: '新 Preset', purposes: ['chat', 'bot'], candidates: [{ ref: { providerId: providers[0]?.id ?? '', model: '' } }], policy: { allowCrossProvider: false, maxAttemptsPerCandidate: 2 } }] })}>创建 Preset</Button>
    <p className="text-xs text-muted">修改后点击「保存模型设置」。正在作为用途默认的 Preset 需先更换默认再删除；失效候选会阻止保存，不会静默选择其他供应商。</p>
  </section>;
}
