import { useState } from 'react';
import { Button } from '@heroui/react';
import type { CloudProvider, ModelCandidate, ModelPreset, ModelRef } from '@wangke/contracts/cloud';
import type { SavedModel, Settings } from '../store/settings';
import { modelKey, modelsForSlot, savedModelsOf } from '../store/modelLibrary';
import { SectionCard, Sym } from '../ui';
import { candidateLabel, defaultRouteRef, editPurposeRoute, fallbackWarning, followDefaultRoute, MODEL_USES, purposePreset, type PresetDraft } from './modelRoutes';

const control = 'w-full min-w-0 min-h-11 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-accent';
const emptyRef: ModelRef = { providerId: '', model: '' };

function ModelOptions({ models, providers }: { models: SavedModel[]; providers: Settings['providers'] }) {
  return providers.map(provider => {
    const items = models.filter(model => model.providerId === provider.id);
    return items.length ? <optgroup key={provider.id} label={provider.name}>{items.map(model => <option key={modelKey(model)} value={modelKey(model)}>{model.name || model.model} · {provider.name}</option>)}</optgroup> : null;
  });
}

function PurposeModels({ use, value, settings, providers, onChange }: { use: typeof MODEL_USES[number]; value: PresetDraft; settings: Settings; providers: CloudProvider[]; onChange: (value: PresetDraft) => void }) {
  const [adding, setAdding] = useState(false);
  const preset = purposePreset(value, use.purpose);
  const fallback = defaultRouteRef(settings, use.purpose);
  const candidates: ModelCandidate[] = preset?.candidates ?? [{ ref: fallback }];
  const available = modelsForSlot(settings, use.slot);
  const unused = available.filter(model => !candidates.some(c => modelKey(c.ref) === modelKey(model)));
  const named = (value.modelPresets ?? []).filter(p => !p.id.startsWith('builtin-') && p.purposes.includes(use.purpose));
  const primary = candidates.find(c => c.enabled !== false)?.ref ?? emptyRef;
  const activeCount = candidates.filter(c => c.enabled !== false).length;
  const edit = (patch: Partial<Pick<ModelPreset, 'candidates' | 'policy'>>) => onChange(editPurposeRoute(value, use.purpose, fallback, patch));
  const changeCandidate = (index: number, patch: Partial<ModelCandidate>) => edit({ candidates: candidates.map((candidate, i) => i === index ? { ...candidate, ...patch } : candidate) });
  const modelName = (ref: ModelRef) => {
    const model = savedModelsOf(settings).find(m => modelKey(m) === modelKey(ref));
    const provider = settings.providers.find(p => p.id === ref.providerId);
    return ref.model ? `${model?.name || ref.model} · ${provider?.name ?? '供应商已删除'}` : '尚未选择模型';
  };

  return <section className="flex min-w-0 flex-col gap-3 rounded-xl bg-background-secondary p-4" aria-label={use.label} data-testid={`model-route-${use.purpose}`}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h4 className="text-sm font-medium">{use.label}</h4><p className="mt-1 text-xs text-muted">{use.hint}</p></div>
      <span className="rounded-md bg-background px-2 py-1 text-xs text-muted">{preset ? '单独设置' : '跟随默认'}</span>
    </div>
    {!preset && <p className="text-xs text-muted">跟随上方「选择模型」中的{use.source}；在这里改选或添加备用后，仅对此用途生效。</p>}
    {candidates.map((candidate, index) => {
      const label = candidateLabel(candidates, index);
      const choices = available.filter(model => !candidates.some((c, i) => i !== index && modelKey(c.ref) === modelKey(model)));
      const known = choices.some(model => modelKey(model) === modelKey(candidate.ref));
      const warning = candidate.enabled !== false && candidate.ref !== primary && primary.model && candidate.ref.model ? fallbackWarning(primary, candidate.ref, providers, preset) : undefined;
      return <div key={index} className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5 text-xs"><span>{label}</span>
            <select className={control} aria-label={`${use.label} · ${label}`} title={candidate.ref.model || undefined} value={candidate.ref.model ? modelKey(candidate.ref) : ''} onChange={e => {
              const selected = available.find(model => modelKey(model) === e.target.value);
              if (selected) changeCandidate(index, { ref: { providerId: selected.providerId, model: selected.model } });
            }}>
              <option value="" disabled>请选择已添加的模型</option>
              {!known && candidate.ref.model && <option value={modelKey(candidate.ref)}>{modelName(candidate.ref)}（当前配置）</option>}
              <ModelOptions models={choices} providers={settings.providers} />
            </select>
          </label>
          {preset && candidates.length > 1 && <div className="flex flex-wrap items-center gap-1">
            {index > 0 && <Button size="sm" variant="tertiary" aria-label={`${use.label} · ${label}优先使用`} onPress={() => {
              const next = [...candidates]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; edit({ candidates: next });
            }}><Sym name="arrow_upward" />上移</Button>}
            <Button size="sm" variant="tertiary" aria-label={`${use.label} · 移除${label}`} onPress={() => edit({ candidates: candidates.filter((_, i) => i !== index) })}>移除</Button>
          </div>}
        </div>
        {candidate.enabled === false && <Button className="self-start" size="sm" variant="tertiary" onPress={() => changeCandidate(index, { enabled: true })}>重新启用此模型</Button>}
        {candidate.ref.model && !settings.providers.some(p => p.id === candidate.ref.providerId) && <p role="alert" className="text-xs text-danger">供应商已删除，请重新选择模型或移除这一项。</p>}
        {warning && <p role="status" className="text-xs text-warning">{warning}</p>}
      </div>;
    })}
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="secondary" isDisabled={!primary.model || !unused.length || candidates.length >= 30} onPress={() => setAdding(true)}><Sym name="add" />添加备用模型</Button>
      {activeCount < 2 && <span className="text-xs text-muted">未设置备用，失败后不会换模型</span>}
      {preset && <Button size="sm" variant="tertiary" onPress={() => { onChange(followDefaultRoute(value, use.purpose)); setAdding(false); }}>恢复跟随默认</Button>}
    </div>
    {adding && <div className="flex min-w-0 flex-wrap items-end gap-2 rounded-lg bg-background p-3">
      <label className="flex min-w-0 flex-1 basis-48 flex-col gap-1.5 text-xs">选择备用模型
        <select autoFocus className={control} aria-label={`${use.label} · 选择备用模型`} value="" onChange={e => {
          const selected = unused.find(model => modelKey(model) === e.target.value);
          if (!selected) return;
          edit({ candidates: [...candidates, { ref: { providerId: selected.providerId, model: selected.model } }] }); setAdding(false);
        }}><option value="" disabled>从已添加的模型中选择</option><ModelOptions models={unused} providers={settings.providers} /></select>
      </label>
      <Button size="sm" variant="tertiary" onPress={() => setAdding(false)}>取消</Button>
    </div>}
    {!unused.length && <p className="text-xs text-muted">没有更多可选模型。请先在上方供应商中添加支持此用途的模型，再回来设置备用。</p>}
    {preset && candidates.length > 1 && <label className="flex items-start gap-2 text-xs leading-relaxed">
      <input className="mt-0.5" type="checkbox" checked={preset.policy?.allowCrossProvider !== false} onChange={e => edit({ policy: { ...preset.policy, allowCrossProvider: e.target.checked } })} />
      <span>允许故障时切换到其他供应商<span className="block text-muted">仅限数据策略一致且允许自动切换的模型；切换时会向备用供应商发送本次请求。</span></span>
    </label>}
    {named.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">使用已保存的方案</summary>
      <label className="mt-2 flex flex-col gap-1.5">选择方案（编辑时不会影响其他用途）
        <select className={control} aria-label={`${use.label} · 已保存方案`} value={preset?.id ?? ''} onChange={e => { onChange({ ...value, modelRoutes: { byPurpose: { ...value.modelRoutes?.byPurpose, [use.purpose]: e.target.value } } }); setAdding(false); }}>
          <option value="" disabled>选择已有方案</option>{named.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}
        </select>
      </label>
    </details>}
  </section>;
}

/** The wire format stays compatible; users edit uses and model priorities, not Preset IDs. */
export default function ModelPresets({ value, settings, providers, onChange }: { value: PresetDraft; settings: Settings; providers: CloudProvider[]; onChange: (value: PresetDraft) => void }) {
  const unused = (value.modelPresets ?? []).filter(p => !p.id.startsWith('builtin-') && !Object.values(value.modelRoutes?.byPurpose ?? {}).includes(p.id));
  return <SectionCard title="主模型与备用模型" testId="model-presets" subtitle="每个用途先用主模型；遇到可恢复的故障，再按顺序尝试备用模型。不需要备用时，保持默认即可。">
    {/* Avoid mobile scroll-layer culling of the button library's GPU transforms. */}
    <div className="flex min-w-0 flex-col gap-3 max-md:[&_button]:min-h-11 max-md:[&_button]:transform-none">
      <p className="text-xs text-muted">直接选择上方供应商中已添加的模型，不用手填模型编号。修改后点击「保存模型设置」生效。</p>
      {MODEL_USES.map(use => <PurposeModels key={use.purpose} use={use} value={value} settings={settings} providers={providers} onChange={onChange} />)}
      <div className="rounded-lg bg-background-secondary p-3 text-xs leading-relaxed text-muted">
        <p className="font-medium text-foreground">什么时候会换模型？</p>
        <p className="mt-1">网络超时、服务异常等可恢复故障，会按系统策略尝试备用；密钥错误、余额或额度不足、请求参数错误会直接报错。已经开始显示的回答，中途失败也不会换模型重新生成。</p>
        <p className="mt-1">备用切换适用于按用途调用的请求；手动指定模型或直接使用供应商流式接口时，不会跨模型重试。</p>
      </div>
      {unused.length > 0 && <details className="text-xs text-muted"><summary className="cursor-pointer">未使用的已保存方案（{unused.length}）</summary>
        <p className="mt-2">恢复默认后原方案仍会保留，可从各用途的「使用已保存的方案」重新选择。删除后点击保存生效。</p>
        {unused.map(p => <div key={p.id} className="mt-2 flex min-w-0 flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-all">{p.name}</span><Button size="sm" variant="tertiary" aria-label={`删除未使用方案 ${p.name}`} onPress={() => onChange({ ...value, modelPresets: value.modelPresets?.filter(item => item.id !== p.id) })}>删除</Button></div>)}
      </details>}
    </div>
  </SectionCard>;
}
