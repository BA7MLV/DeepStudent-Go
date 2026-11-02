import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CloudConfig } from '@wangke/contracts/cloud';
import ModelsModule from '../components/settings/ModelsModule';
import { ModelSettingsContext } from '../components/settings/modelSettingsContext';
import { useSettings, type Provider } from '../store/settings';
import { LoadingButton, confirmDialog, toast } from '../ui';
import { cloudRequest } from './state';
import { applyCloudConfig, flushCloud } from './sync';
import { cloudDiscoveryProviders, cloudEditorProviders, cloudModelConfig, cloudModelPreferences, cloudModelUpdate, cloudModelsDirty, cloudProviderDirty, createCloudModelDraft, modelSettingsError } from './modelSettings';
import { modelReferenceIssues } from '@wangke/contracts/model-settings';
import { registerSettingsLeaveGuard } from '../components/settingsDialogStore';
import ModelPresets from './ModelPresets';
import { routeDraftIssue, type PresetDraft } from './modelRoutes';
import ModelGatewayStatus from './ModelGatewayStatus';
import { SettingsConflictRecovery, SettingsSaveBar } from '../components/settings/SettingsActions';

function ProviderAccounts({ config, provider, onSaved, onReplaceKey, onChangeKey, onDraftChange }: { config: CloudConfig; provider: Provider; onSaved: (value: CloudConfig) => void; onReplaceKey: (provider: Provider) => Promise<void>; onChangeKey: (apiKey: string) => void; onDraftChange: (dirty: boolean) => void }) {
  const [name, setName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [editing, setEditing] = useState<'add' | 'replace' | null>(() => provider.apiKey ? 'replace' : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accounts = provider.accounts ?? [];
  const activeAccount = accounts.find(account => account.id === provider.activeAccountId && account.configured) ?? accounts.find(account => account.configured);
  const environmentKey = provider.id === 'opencode-go';
  const currentKey = editing === 'replace' ? provider.apiKey : apiKey;
  const previousKey = useRef(provider.apiKey);
  useEffect(() => {
    if (previousKey.current && !provider.apiKey && editing === 'replace') setEditing(null);
    previousKey.current = provider.apiKey;
  }, [provider.apiKey, editing]);
  const addingKey = editing === 'add' && Boolean(apiKey || name);
  useEffect(() => {
    onDraftChange(addingKey);
    return () => onDraftChange(false);
  }, [addingKey, onDraftChange]);
  const cancel = () => { setEditing(null); setName(''); setApiKey(''); onChangeKey(''); setError(''); };
  const prefix = `/providers/${encodeURIComponent(provider.id)}/accounts`;
  const run = async (path: string, init: RequestInit) => {
    setBusy(true); setError('');
    try {
      const saved = await cloudRequest<CloudConfig>(path, init);
      onSaved(saved);
      return saved;
    } catch (e) { setError(modelSettingsError(e)); return undefined; }
    finally { setBusy(false); }
  };
  return <div className="flex min-w-0 flex-col gap-3" data-testid={`provider-accounts-${provider.id}`}>
    {(provider.configured || accounts.length > 0) ? <div className="flex flex-col gap-2">
      {provider.configured && <div className="flex flex-wrap items-center gap-2 rounded-lg bg-background-secondary px-3 py-2 text-xs" data-testid={`provider-default-key-${provider.id}`}>
        <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{environmentKey ? '服务器环境 Key' : '默认 Key'} <code className="text-muted" data-testid={`provider-key-hint-${provider.id}`}>{provider.keyHint ?? '••••••••'}</code></span>
        <span className={activeAccount ? 'text-muted' : 'text-success'}>{activeAccount ? '备用' : '当前使用'}</span>
        {!environmentKey && <Button size="sm" variant="tertiary" isDisabled={busy || editing !== null} onPress={() => { setEditing('replace'); setError(''); }}>更换 Key</Button>}
      </div>}
      {accounts.map(account => <div key={account.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-background-secondary px-3 py-2 text-xs">
      <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2"><span className="break-all">{account.name}</span> <code className="text-muted" data-testid={`account-key-hint-${account.id}`}>{account.keyHint ?? '••••••••'}</code></span>
      {activeAccount?.id === account.id ? <span className="text-success">当前使用</span> : <Button size="sm" variant="tertiary" isDisabled={busy} onPress={() => void run(`${prefix}/${encodeURIComponent(account.id)}/active`, { method: 'PUT', body: JSON.stringify({ modelRevision: config.modelRevision }) })}>启用</Button>}
      <Button size="sm" variant="ghost" isDisabled={busy} onPress={() => void run(`${prefix}/${encodeURIComponent(account.id)}`, { method: 'DELETE', body: JSON.stringify({ modelRevision: config.modelRevision }) })}>删除</Button>
    </div>)}</div> : <p className="text-xs text-muted">尚未添加 API Key，本地免密服务可留空。</p>}
    {editing ? <div className="flex min-w-0 flex-col gap-3 rounded-lg border border-border p-3" data-testid={`provider-key-form-${provider.id}`}>
      <p className="text-xs font-medium">{editing === 'replace' ? '更换默认 Key' : '添加 API Key'}</p>
      {editing === 'add' && <input className="min-w-0 rounded border border-foreground/15 bg-transparent px-3 py-2 text-sm" aria-label="Key 名称（可选）" placeholder="名称（可选，用于区分多把 Key）" value={name} onChange={e => setName(e.target.value)} />}
      <input className="min-w-0 rounded border border-foreground/15 bg-transparent px-3 py-2 text-sm" data-testid={`api-key-${provider.id}`} aria-label="API Key" type="password" autoComplete="new-password" placeholder="粘贴 API Key" value={currentKey} onChange={e => editing === 'replace' ? onChangeKey(e.target.value) : setApiKey(e.target.value)} />
      <div className="flex flex-wrap gap-2">
        <LoadingButton size="sm" loading={busy} isDisabled={!currentKey.trim()} onPress={async () => {
          if (editing === 'add') {
            const saved = await run(prefix, { method: 'POST', body: JSON.stringify({ name, apiKey, modelRevision: config.modelRevision }) });
            if (saved) cancel();
          } else {
            setBusy(true); setError('');
            try { await onReplaceKey(provider); cancel(); }
            catch (error) { setError(error instanceof Error ? error.message : String(error)); }
            finally { setBusy(false); }
          }
        }}>保存 Key</LoadingButton>
        <Button size="sm" variant="ghost" isDisabled={busy} onPress={cancel}>取消</Button>
      </div>
    </div> : <Button size="sm" variant="secondary" className="self-start" isDisabled={busy} onPress={() => { setEditing('add'); setError(''); }}>添加 Key</Button>}
    {environmentKey && <p className="break-words text-xs text-muted">也可使用服务器环境变量 <code className="break-all">OPENCODE_GO_API_KEY</code>，无需重复添加。</p>}
    <p className="text-xs text-muted">通过名称和 Key 末 4 位核对；短密钥不显示尾号。完整 Key 加密保存在服务器，保存、启用和删除后立即生效。</p>
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
  const [hideModelPresets, setHideModelPresets] = useState(false);
  const [editingConnection, setEditingConnection] = useState(false);
  const [addingKey, setAddingKey] = useState(false);
  const [savedPreferences, setSavedPreferences] = useState(() => JSON.stringify(cloudModelPreferences(store.getState())));
  const operation = useRef(false);
  const baseline = useRef(config);
  baseline.current = config;
  const issues = modelReferenceIssues(settings);
  const dirty = editingConnection || addingKey || cloudModelsDirty(settings, config) || JSON.stringify(presets) !== JSON.stringify({ modelPresets: config.modelPresets, modelRoutes: config.modelRoutes }) || JSON.stringify(cloudModelPreferences(settings)) !== savedPreferences;
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
  function savedAccounts(saved: CloudConfig) {
    savedConfig(saved);
    const remote = new Map(saved.providers.map(provider => [provider.id, provider]));
    const current = store.getState();
    store.setState({ providers: current.providers.map(provider => {
      const next = remote.get(provider.id);
      return next ? { ...provider, configured: next.configured, keyHint: next.keyHint, accounts: next.accounts, activeAccountId: next.activeAccountId } : provider;
    }) });
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
    if (operation.current || conflict) return;
    if (editingConnection) { setError('当前新连接尚未保存，请先保存连接或取消编辑，再保存模型设置。'); return; }
    if (addingKey) { setError('当前 API Key 尚未保存，请先点击“保存 Key”或取消添加。'); return; }
    if (modelReferenceIssues(store.getState()).length) {
      setError('请先修复下方默认模型配置，或清除失效选择后稍后配置。');
      setFocusIssue((value) => value + 1);
      return;
    }
    const routeIssue = routeDraftIssue(presets, new Set(store.getState().providers.map(provider => provider.id)));
    if (routeIssue) { setError(routeIssue); return; }
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
      if (!standalone) toast.success('模型设置已保存');
      if (complete) onDone?.();
    } catch (e) { showError(e); }
    finally { operation.current = false; setBusy(false); }
  }
  async function reload() {
    if (operation.current) return;
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
  const saveActions = <SettingsSaveBar dirty={dirty} busy={busy} disabled={conflict || (!standalone && !dirty)} error={error || (conflict ? modelSettingsError(new Error('model_settings_conflict')) : '')} message={message}
    saveLabel="保存模型设置" onSave={() => void save()} testId="cloud-models-save-actions" saveTestId="cloud-models-save" statusTestId="cloud-models-dirty">
    {conflict && <SettingsConflictRecovery busy={busy} onReload={reload} />}
  </SettingsSaveBar>;
  return <div className="flex min-w-0 flex-col gap-5">
    {issues.length > 0 && <div className="rounded-xl bg-danger/10 p-3" role="status">
      <p className="text-sm text-danger">有 {issues.length} 项默认模型配置需要修复。你仍可独立保存连接并获取模型列表。</p>
      <Button variant="tertiary" size="sm" onPress={() => setFocusIssue((value) => value + 1)}>定位并修复</Button>
    </div>}
    <ModelSettingsContext.Provider value={store}>
      <fieldset disabled={busy} className="m-0 flex min-w-0 flex-col gap-5 border-0 p-0">
       <ModelsModule key={editorGeneration} serverManaged standalone={standalone} discoveryProviders={cloudDiscoveryProviders(settings, config, discoveryRevision)} providerNeedsSave={(provider) => cloudProviderDirty(provider, config)} onSaveProvider={saveProvider} onDraftChange={setEditingConnection} onProviderViewChange={setHideModelPresets} renderProviderAccounts={provider => <ProviderAccounts config={config} provider={provider} onSaved={savedAccounts} onReplaceKey={saveProvider} onDraftChange={setAddingKey} onChangeKey={apiKey => store.setState(current => ({ providers: current.providers.map(p => p.id === provider.id ? { ...p, apiKey } : p) }))} />} onAddOpenCodeGo={!config.providers.some(p => p.id === 'opencode-go') ? () => void saveProvider({ id: 'opencode-go', name: 'OpenCode Go', protocol: 'openai-chat', baseUrl: 'https://opencode.ai/inference/go/openai/v1', apiKey: '', catalogId: '', serves: ['chat'] }).catch(() => {}) : undefined} addOpenCodeGoDisabled={busy} issues={issues} focusIssue={focusIssue} />
      </fieldset>
    </ModelSettingsContext.Provider>
     {!hideModelPresets && <fieldset disabled={busy} className="m-0 min-w-0 border-0 p-0"><ModelPresets value={presets} settings={settings} providers={cloudModelConfig(settings, config).providers} onChange={value => { setPresets(value); setError(''); setMessage(''); }} /></fieldset>}
    <ModelGatewayStatus />
    {saveActions}
    {onDone && <div className="ob__actions">
      <LoadingButton className="ob__primary" size="lg" loading={busy} isDisabled={conflict} onPress={() => void save(true)} data-testid="onboarding-models-done">
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
