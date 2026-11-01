import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CloudConfig } from '@wangke/contracts/cloud';
import ModelsModule from '../components/settings/ModelsModule';
import { ModelSettingsContext } from '../components/settings/modelSettingsContext';
import { useSettings, type Provider } from '../store/settings';
import { LoadingButton, confirmDialog } from '../ui';
import { cloudRequest } from './state';
import { applyCloudConfig, flushCloud } from './sync';
import { cloudDiscoveryProviders, cloudEditorProviders, cloudModelConfig, cloudModelPreferences, cloudModelUpdate, cloudModelsDirty, cloudProviderDirty, createCloudModelDraft, modelSettingsError } from './modelSettings';
import { modelReferenceIssues } from '@wangke/contracts/model-settings';
import { registerSettingsLeaveGuard } from '../components/settingsDialogStore';
import ModelPresets, { type PresetDraft } from './ModelPresets';
import ModelGatewayStatus from './ModelGatewayStatus';

function ProviderAccounts({ config, provider, onSaved }: { config: CloudConfig; provider: CloudConfig['providers'][number]; onSaved: (value: CloudConfig) => void }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accounts = provider.accounts ?? [];
  const prefix = `/providers/${encodeURIComponent(provider.id)}/accounts`;
  const run = async (path: string, init: RequestInit) => {
    setBusy(true); setError('');
    try { onSaved(await cloudRequest<CloudConfig>(path, init)); }
    catch (e) { setError(modelSettingsError(e)); }
    finally { setBusy(false); }
  };
  return <div className="mt-2 flex flex-col gap-2 rounded-lg border border-foreground/10 p-3" data-testid={`provider-accounts-${provider.id}`}>
    <p className="text-xs font-medium">{provider.name || provider.id} Key 账户</p>
    {accounts.length ? <div className="flex flex-col gap-1">{accounts.map(account => <div key={account.id} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="min-w-28">{account.name}</span><span className="text-muted">{account.configured ? '已配置' : '未配置'}</span>
      {provider.activeAccountId === account.id ? <span className="text-success">当前使用</span> : <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void run(`${prefix}/${encodeURIComponent(account.id)}/active`, { method: 'PUT', body: JSON.stringify({ modelRevision: config.modelRevision }) })}>启用</Button>}
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void run(`${prefix}/${encodeURIComponent(account.id)}`, { method: 'DELETE', body: JSON.stringify({ modelRevision: config.modelRevision }) })}>删除</Button>
    </div>)}</div> : <p className="text-xs text-muted">暂无已保存 Key，可直接使用服务器环境变量。</p>}
    <div className="flex flex-wrap gap-2">
      <input className="min-w-32 flex-1 rounded border border-foreground/15 bg-transparent px-2 py-1 text-xs" placeholder="账户名称（可选）" value={name} onChange={e => setName(e.target.value)} />
      <input className="min-w-48 flex-[2] rounded border border-foreground/15 bg-transparent px-2 py-1 text-xs" type="password" autoComplete="new-password" placeholder="粘贴新的 OpenCode Go Key" value={apiKey} onChange={e => setApiKey(e.target.value)} />
      <Button size="sm" variant="secondary" isDisabled={busy || !apiKey.trim()} onPress={() => void run(prefix, { method: 'POST', body: JSON.stringify({ name, apiKey, modelRevision: config.modelRevision }) }).then(() => { setName(''); setApiKey(''); })}>添加 Key</Button>
    </div>
    {error && <p className="text-xs text-danger" role="alert">{error}</p>}
  </div>;
}

function CloudModelEditor({ initial, standalone, onDone }: { initial: CloudConfig; standalone: boolean; onDone?: () => void }) {
  const { t } = useTranslation('common');
  const [config, setConfig] = useState(initial);
  const [presets, setPresets] = useState<PresetDraft>(() => ({ modelPresets: initial.modelPresets, modelRoutes: initial.modelRoutes }));
  const [store] = useState(() => createCloudModelDraft(initial, useSettings.getState()));
  const settings = useStore(store);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [focusIssue, setFocusIssue] = useState(0);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [editingConnection, setEditingConnection] = useState(false);
  const [savedPreferences, setSavedPreferences] = useState(() => JSON.stringify(cloudModelPreferences(store.getState())));
  const operation = useRef(false);
  const baseline = useRef(config);
  baseline.current = config;
  const issues = modelReferenceIssues(settings);
  const dirty = editingConnection || cloudModelsDirty(settings, config) || JSON.stringify(presets) !== JSON.stringify({ modelPresets: config.modelPresets, modelRoutes: config.modelRoutes }) || JSON.stringify(cloudModelPreferences(settings)) !== savedPreferences;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    if (standalone) return;
    return registerSettingsLeaveGuard(async () => {
      if (operation.current) return false;
      if (!dirtyRef.current) return true;
      return confirmDialog({ headline: '放弃未保存的模型设置？', description: '离开会丢弃本页未保存的编辑。已保存到服务器的连接不受影响。', confirmText: '放弃修改', danger: true });
    });
  }, [standalone]);
  // A saved key can change without ever being sent back to the browser. Fresh editor/save
  // identities prevent discovery results from a previous credential being reused.
  const [discoveryRevision, setDiscoveryRevision] = useState(() => crypto.randomUUID());
  useEffect(() => store.subscribe(() => { setMessage(''); setError(''); }), [store]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  function savedConfig(saved: CloudConfig) {
    baseline.current = saved;
    setConfig(saved);
    setDiscoveryRevision(crypto.randomUUID());
    applyCloudConfig(saved);
  }
  function showError(error: unknown) {
    setError(modelSettingsError(error));
    if (error instanceof Error && error.message === 'model_settings_conflict') setConflict(true);
  }
  async function saveProvider(provider: Provider) {
    if (operation.current) throw new Error('另一个保存操作正在进行，请稍后重试');
    operation.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const payload = cloudModelConfig({ ...store.getState(), providers: [provider] }, baseline.current).providers[0];
      const saved = await cloudRequest<CloudConfig>(`/providers/${encodeURIComponent(provider.id)}`, {
        method: 'PUT', body: JSON.stringify({ provider: payload, modelRevision: baseline.current.modelRevision }),
      });
      savedConfig(saved);
      // Only the saved connection changes; other connections, defaults and capabilities stay as edited.
      const savedProvider = cloudEditorProviders(saved).find((p) => p.id === provider.id)!;
      const current = store.getState();
      store.setState({ providers: current.providers.some((p) => p.id === provider.id)
        ? current.providers.map((p) => p.id === provider.id ? savedProvider : p) : [...current.providers, savedProvider] });
      setMessage('连接已保存到服务器');
    } catch (error) { showError(error); throw new Error(modelSettingsError(error)); }
    finally { operation.current = false; setBusy(false); }
  }
  async function save(complete = false) {
    if (operation.current) return;
    if (editingConnection) { setError('当前新连接尚未保存，请先保存连接或取消编辑，再保存模型设置。'); return; }
    if (modelReferenceIssues(store.getState()).length) {
      setError('请先修复下方默认模型配置，或清除失效选择后稍后配置。');
      setFocusIssue((value) => value + 1);
      return;
    }
    operation.current = true;
    setBusy(true); setError(''); setMessage('');
    try {
      const draft = store.getState();
      const saved = await cloudRequest<CloudConfig>('/model-settings', { method: 'PUT', body: JSON.stringify({ ...cloudModelUpdate(draft, baseline.current), ...presets }) });
      savedConfig(saved);
      setPresets({ modelPresets: saved.modelPresets, modelRoutes: saved.modelRoutes });
      store.setState({ providers: cloudEditorProviders(saved), llmModel: saved.llmModel, visionModel: saved.visionModel,
        asrModel: saved.asrModel, decisionModel: saved.decisionModel ?? { providerId: '', model: '' } });
      useSettings.getState().update(cloudModelPreferences(draft));
      try { await flushCloud(); }
      catch {
        setMessage('连接与默认模型已保存到服务器');
        setError('模型库偏好同步失败，重试保存可继续同步。');
        return;
      }
      setSavedPreferences(JSON.stringify(cloudModelPreferences(draft)));
      setMessage('模型设置已保存到服务器'); setConflict(false);
      if (complete) onDone?.();
    } catch (e) { showError(e); }
    finally { operation.current = false; setBusy(false); }
  }
  async function reload() {
    if (operation.current) return;
    if (!await confirmDialog({ headline: '重新载入服务器设置？', description: '本页未保存的连接和默认模型编辑将被服务器当前设置替换。', confirmText: '重新载入' })) return;
    operation.current = true; setBusy(true);
    try {
      const saved = await cloudRequest<CloudConfig>('/config');
      const draft = createCloudModelDraft(saved, useSettings.getState()).getState();
      store.setState({ ...draft, update: store.getState().update });
      setSavedPreferences(JSON.stringify(cloudModelPreferences(draft)));
      savedConfig(saved); setConflict(false); setError(''); setMessage('已载入服务器设置');
      setPresets({ modelPresets: saved.modelPresets, modelRoutes: saved.modelRoutes });
      setEditorGeneration((value) => value + 1);
    } catch (error) { showError(error); }
    finally { operation.current = false; setBusy(false); }
  }
  return <div className="flex min-w-0 flex-col gap-5">
    <section aria-label="OpenCode Go" className="flex flex-col gap-2 text-sm">
      <h3 className="font-medium">OpenCode Go</h3>
       <p className="text-xs text-muted">每个 Provider 都支持单 Key 或多个服务端 Key 账户。OpenCode Go 可直接配置服务器 OPENCODE_GO_API_KEY，也可在下方保存并手动切换多个 Key。模型列表通过官方动态发现；目录不代表账号授权。Google native 暂不支持，可选 Chat/Responses 转换或 Anthropic Deployment。</p>
      <p className="text-xs text-muted">allowance 是本请求占用套餐的美元值，不是余额或本地预算。月度、5 小时、周限制及 Extra Usage 由供应商 Console 管理；本页不能查询剩余额度。受限模型、区域、训练和保留策略需确认，未知策略默认不进入 fallback。Go 面向 coding-agent 流量，学习业务需先确认适用范围。</p>
       {!config.providers.some(p => p.id === 'opencode-go') && <Button size="sm" variant="secondary" isDisabled={busy} onPress={() => void saveProvider({ id: 'opencode-go', name: 'OpenCode Go', protocol: 'openai-chat', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKey: '', catalogId: '', serves: ['chat'] }).catch(() => {})}>添加 OpenCode Go（服务端环境密钥）</Button>}
       {config.providers.map(provider => <ProviderAccounts key={provider.id} config={config} provider={provider} onSaved={savedConfig} />)}
    </section>
    {issues.length > 0 && <div className="rounded-xl bg-danger/10 p-3" role="status">
      <p className="text-sm text-danger">有 {issues.length} 项默认模型配置需要修复。你仍可独立保存连接并获取模型列表。</p>
      <Button variant="tertiary" size="sm" onPress={() => setFocusIssue((value) => value + 1)}>定位并修复</Button>
    </div>}
    <ModelSettingsContext.Provider value={store}>
      <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
        <ModelsModule key={editorGeneration} serverManaged standalone={standalone} discoveryProviders={cloudDiscoveryProviders(settings, config, discoveryRevision)} providerNeedsSave={(provider) => cloudProviderDirty(provider, config)} onSaveProvider={saveProvider} onDraftChange={setEditingConnection} issues={issues} focusIssue={focusIssue} />
      </fieldset>
    </ModelSettingsContext.Provider>
    <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0"><ModelPresets value={presets} providers={settings.providers} onChange={setPresets} /></fieldset>
    <ModelGatewayStatus />
    <div className="flex flex-wrap items-center gap-3">
      <LoadingButton loading={busy} onPress={() => void save()} data-testid="cloud-models-save">保存模型设置</LoadingButton>
      <span className="text-xs text-muted" data-testid="cloud-models-dirty">{dirty ? '有未保存修改' : '连接与默认模型已保存'}</span>
      {message && <p role="status" className="text-sm text-success">{message}</p>}
    </div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {conflict && <Button variant="secondary" isDisabled={busy} className="self-start" onPress={() => void reload()}>重新载入服务器设置</Button>}
    {onDone && <div className="ob__actions">
      <LoadingButton className="ob__primary" size="lg" loading={busy} onPress={() => void save(true)} data-testid="onboarding-models-done">
        {busy ? t('onboarding.models.saving') : t('onboarding.models.done')}
      </LoadingButton>
      <Button className="ob__skip" variant="ghost" isDisabled={busy} onPress={onDone}>{t('onboarding.models.skip')}</Button>
    </div>}
  </div>;
}

export default function CloudModels({ standalone = false, onDone }: { standalone?: boolean; onDone?: () => void } = {}) {
  const [config, setConfig] = useState<CloudConfig>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setError('');
    void cloudRequest<CloudConfig>('/config').then((value) => { if (!cancelled) setConfig(value); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [attempt]);
  if (!config) return error
    ? <div><p role="alert" className="text-danger">{error}</p><Button variant="secondary" onPress={() => setAttempt((n) => n + 1)}>重试</Button></div>
    : <p role="status">正在读取模型设置…</p>;
  return <CloudModelEditor initial={config} standalone={standalone} onDone={onDone} />;
}
