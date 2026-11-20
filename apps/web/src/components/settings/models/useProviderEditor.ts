import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSettingsDialog } from '../../settingsDialogStore';
import { toast } from '../../../ui';
import { isModelMetaStale, modelMetaInfo, refreshModelMeta } from '../../../api/modelMeta';
import { providerCatalogId, type ProviderPreset } from '../../../store/providerPresets';
import { createPresetProvider, matchesProviderPreset } from '../../../store/providerPresets';
import { nextProviderId, type Provider, type Settings } from '../../../store/settings';
import { savedModelsOf, modelsForSlot } from '../../../store/modelLibrary';
import { confirmDialog } from '../../../ui';
import { MODEL_FIELDS } from '@wangke/contracts/model-settings';
import type { ModelSettingsIssue } from '@wangke/contracts/model-settings';
import { ALL_SLOTS, type ModelFieldName } from '../shared';
import { useModelSettings, useModelSettingsStore } from '../modelSettingsContext';
import { useProviderModels, type DiscoveryProvider } from '../../../utils/useProviderModels';
import { ms } from '../../motion';

/**
 * 「模型」模块的三块逻辑：能力目录刷新、草稿生命周期、供应商编辑状态。
 *
 * 只放行为，JSX 在 ModelsModule 与 models/ 下 —— 这样改一处校验不用在千行文件里找上下文。
 */

/**
 * 能力数据（models.dev 的上下文窗口 / 是否支持视觉 / 思考）过期时静默刷新。
 *
 * 失败不影响使用：所有读取点都有「按名字猜」的回退。返回值供面板底部的
 * 「上次更新 + 手动刷新」那一条使用。
 */
export function useModelCapsRefresh(providers: readonly Provider[]) {
  const { t } = useTranslation('settings');
  const catalogs = providers.map(providerCatalogId).filter((c) => c.trim().length > 0);
  const catalogsKey = catalogs.join('\0');
  const [metaInfo, setMetaInfo] = useState(modelMetaInfo);
  const [metaRefreshing, setMetaRefreshing] = useState(false);
  const [metaError, setMetaError] = useState('');

  useEffect(() => {
    if (!isModelMetaStale()) return;
    let cancelled = false;
    refreshModelMeta(catalogs)
      .then(() => {
        if (!cancelled) setMetaInfo(modelMetaInfo());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // catalogs 由 providers 派生；拼成 key 才不会被「每次渲染新建的数组」反复触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogsKey]);

  /** 只刷新目录；不改用户能力覆盖或手动设置的历史预算。 */
  const handleRefreshMeta = async () => {
    setMetaRefreshing(true);
    setMetaError('');
    try {
      const { count } = await refreshModelMeta(catalogs);
      setMetaInfo(modelMetaInfo());
      toast.success(t('models.capsUpdated', { count }));
    } catch (e) {
      setMetaError(t('models.refreshFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setMetaRefreshing(false);
    }
  };

  return { metaInfo, metaRefreshing, metaError, handleRefreshMeta };
}

/**
 * 关闭设置弹窗时立刻丢掉未保存的新连接草稿。
 *
 * 为什么不是「等关闭动画结束再清」：动画期间子树还挂着，快速重新打开会带回上一次的密钥。
 */
export function useDraftLifecycle({ standalone, clear }: {
  standalone: boolean;
  /** 清掉草稿与其报错（两个 setter 由调用方给，顺序与原实现一致） */
  clear: () => void;
}) {
  const { open: settingsOpen } = useSettingsDialog();
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => {
    if (settingsOpen || standalone) return;
    latest.current();
  }, [settingsOpen, standalone]);
}

/**
 * 供应商列表 / 草稿 / 选中项 / 检查状态。
 *
 * 为什么整组放在一起：选中一家会连带触发模型发现（`useProviderModels` 只对选中项拉列表）、
 * 草稿保存后要把新 id 设为选中项、删除后要把选中项清空 —— 三者的状态互相驱动，
 * 拆开只能靠回调接力，更容易漏掉某条路径。
 */
export function useProviderEditor({
  discoveryProviders,
  serverManaged,
  standalone,
  issues,
  focusIssue,
  onSaveProvider,
  providerNeedsSave,
  onDraftChange,
  onProviderViewChange,
}: {
  discoveryProviders?: DiscoveryProvider[];
  serverManaged: boolean;
  standalone: boolean;
  issues: readonly ModelSettingsIssue[];
  focusIssue: number;
  onSaveProvider?: (provider: Provider) => Promise<void>;
  providerNeedsSave?: (provider: Provider) => boolean;
  onDraftChange?: (editing: boolean) => void;
  onProviderViewChange?: (hideModelPresets: boolean) => void;
}) {
  const { t } = useTranslation('settings');
  const settings = useModelSettings();
  const settingsStore = useModelSettingsStore();
  /** 哪一家的 key 缺失（provider id）。null = 都没问题 */
  const [keyError, setKeyError] = useState<string | null>(null);
  /** 当前进入详情页的供应商（provider id）。null = 供应商总览 */
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  /** 新连接只放在组件内存中；明确保存前不进入持久化设置或模型发现。 */
  const [draftProvider, setDraftProvider] = useState<Provider | null>(null);
  const [draftError, setDraftError] = useState('');
  const draftIdentity = useRef<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [pendingDiscovery, setPendingDiscovery] = useState<string | null>(null);
  const { modelOptions, discoveredModels, discoveredModelFallback, providerNotes, checking, refresh: refreshProviderModels } = useProviderModels(discoveryProviders ?? settings.providers, selectedProviderId);
  const revertTimerRef = useRef<number | undefined>(undefined);

  const editingDraft = Boolean(draftProvider);
  useEffect(() => { onDraftChange?.(editingDraft); }, [editingDraft, onDraftChange]);
  useEffect(() => { setProviderError(''); }, [selectedProviderId]);
  useEffect(() => {
    const selected = selectedProviderId ? settings.providers.find((provider) => provider.id === selectedProviderId) : null;
    const hideModelPresets = Boolean(draftProvider && !draftProvider.catalogId.trim())
      || Boolean(selected && !selected.catalogId.trim());
    onProviderViewChange?.(hideModelPresets);
  }, [draftProvider, onProviderViewChange, selectedProviderId, settings.providers]);

  // 默认模型只在总览显示；从供应商详情定位错误时先返回总览。
  useEffect(() => {
    if (!focusIssue) return;
    setSelectedProviderId(null);
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector(`[data-model-field="${issues[0]?.path}"]`);
      element?.scrollIntoView({ block: 'center' });
      element?.querySelector<HTMLButtonElement>('button[data-testid^="model-button-"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusIssue]); // Each explicit request opens and focuses the first invalid field.

  // 等待服务端保存后的身份回到发现 hook，再发起 GET（避免拿旧连接去拉列表）
  useEffect(() => {
    const provider = discoveryProviders?.find((p) => p.id === pendingDiscovery);
    if (!provider) return;
    setPendingDiscovery(null);
    void refreshProviderModels(provider).catch(() => {});
  }, [pendingDiscovery, discoveryProviders, refreshProviderModels]);

  useDraftLifecycle({
    standalone,
    clear: () => { setDraftProvider(null); setDraftError(''); },
  });

  /** error-state-shake：红边 + 消息由 keyError 驱动，hold 后自动回退 */
  const triggerKeyError = (providerId: string) => {
    setKeyError(providerId);
    // 出错的那家必须露出来，否则抖动发生在折叠区里，用户看不到
    setSelectedProviderId(providerId);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    revertTimerRef.current = window.setTimeout(() => {
      revertTimerRef.current = undefined;
      setKeyError(null);
    }, shakeMs + ms('--revert-hold', 3000));
  };

  useEffect(() => () => clearTimeout(revertTimerRef.current), []);

  /**
   * 手动刷新只请求当前供应商的 `/models`，不检查或修改其他连接。
   */
  const handleCheck = async (providerId: string) => {
    const provider = (discoveryProviders ?? settings.providers).find((p) => p.id === providerId);
    const draft = settingsStore.getState().providers.find((p) => p.id === providerId);
    if (onSaveProvider && (!provider || (draft && providerNeedsSave?.(draft)))) {
      if (!draft) return;
      setProviderSaving(true); setProviderError('');
      try {
        await onSaveProvider(draft);
        setPendingDiscovery(providerId);
      } catch (error) { setProviderError(error instanceof Error ? error.message : String(error)); }
      finally { setProviderSaving(false); }
      return;
    }
    if (!provider) return;
    if ((!serverManaged && !provider.apiKey.trim()) || !provider.baseUrl.trim()) {
      triggerKeyError(providerId);
      setProviderError(t('models.fillUrlKeyFirst'));
      return;
    }
    setProviderError('');
    try {
      await refreshProviderModels(provider);
    } catch (error) {
      setProviderError(t('models.fetchFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  /** 一家的连通状态：优先看上次检查的结论，其次看配置是否完整 */
  const statusOf = (p: Provider): 'ready' | 'unconfigured' | 'failed' | 'unchecked' | 'draft' => {
    if (serverManaged && !discoveryProviders?.some((saved) => saved.id === p.id)) return 'draft';
    if ((!serverManaged && !p.apiKey.trim()) || !p.baseUrl.trim()) return 'unconfigured';
    const note = providerNotes[p.id];
    if (note?.startsWith(t('models.fetchFailedShort'))) return 'failed';
    if (note) return 'ready';
    return 'unchecked';
  };

  const addProvider = () => {
    draftIdentity.current = null;
    setDraftProvider({ id: 'draft', name: '', baseUrl: '', apiKey: '', protocol: 'openai-chat', serves: ['chat'], catalogId: '' });
    setDraftError('');
    setSelectedProviderId(null);
  };

  const connectPreset = (preset: ProviderPreset) => {
    draftIdentity.current = null;
    // 已有同端点的连接时直接打开，保留名称、密钥、协议及用户配置。
    const existing = settings.providers.find((p) => matchesProviderPreset(p, preset));
    setDraftError('');
    if (existing) {
      setDraftProvider(null);
      setSelectedProviderId(existing.id);
      return;
    }
    setDraftProvider(createPresetProvider(preset, 'draft'));
    setSelectedProviderId(null);
  };

  const discardDraftProvider = () => {
    draftIdentity.current = null;
    setDraftProvider(null);
    setDraftError('');
  };

  const saveDraftProvider = async () => {
    if (providerSaving) return;
    if (!draftProvider) return;
    if (!draftProvider.name.trim()) { setDraftError(t('models.nameRequired')); return; }
    if (!draftProvider.baseUrl.trim()) { setDraftError(t('models.urlRequired')); return; }
    try {
      const url = new URL(draftProvider.baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid protocol');
    } catch {
      setDraftError(t('models.urlInvalid'));
      return;
    }
    if (draftProvider.name.trim().length > 100) { setDraftError(t('models.nameTooLong')); return; }
    if (draftProvider.apiKey.length > 4096) { setDraftError(t('models.keyTooLong')); return; }
    if (!serverManaged && !draftProvider.apiKey.trim()) { setDraftError(t('models.keyRequired')); return; }
    // 保存时才分配正式 id，并基于最新设置追加，不覆盖同时发生的设置变更。
    const current = settingsStore.getState();
    const provider = { ...draftProvider, id: onSaveProvider ? draftIdentity.current ??= `p-${crypto.randomUUID()}` : nextProviderId(current), name: draftProvider.name.trim() };
    if (onSaveProvider) {
      setProviderSaving(true); setDraftError('');
      try { await onSaveProvider(provider); setPendingDiscovery(provider.id); }
      catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); return; }
      finally { setProviderSaving(false); }
    } else {
      current.update({ providers: [...current.providers, provider] });
    }
    setDraftProvider(null);
    draftIdentity.current = null;
    setDraftError('');
    setSelectedProviderId(provider.id);
  };

  const removeProvider = (p: Provider) => {
    // 删掉一家之后，指向它的槽位与收藏项必须一起处理，否则界面上留着
    // 一个解析不出端点的引用，表现为「所有请求都报供应商已被删除」。
    // 云端不静默切换供应商（可能改变费用和数据去向），清空引用后由用户重新选择。
    const rest = settings.providers.filter((x) => x.id !== p.id);
    const fallback = rest[0]?.id ?? '';
    const patch: Partial<Settings> = { providers: rest, savedModels: savedModelsOf(settings).filter((m) => m.providerId !== p.id) };
    for (const name of ['asrModel', 'llmModel', 'visionModel', 'decisionModel'] as ModelFieldName[]) {
      if (settings[name].providerId === p.id) {
        if (serverManaged) { patch[name] = { providerId: '', model: '' }; continue; }
        const slot = name === 'llmModel' ? 'chat' : name === 'visionModel' ? 'vision' : name === 'decisionModel' ? 'decision' : 'asr';
        if (slot === 'decision') { patch.decisionModel = { providerId: '', model: '' }; continue; }
        const replacement = modelsForSlot(settings, slot).find((m) => m.providerId !== p.id);
        patch[name] = { providerId: replacement?.providerId ?? fallback, model: replacement?.model ?? '' };
      }
    }
    const favs = { ...settings.favorites };
    for (const slot of ALL_SLOTS) {
      const kept = favs[slot].filter((r) => r.providerId !== p.id);
      if (kept.length !== favs[slot].length) favs[slot] = kept;
    }
    patch.favorites = favs;
    settings.update(patch);
    if (selectedProviderId === p.id) setSelectedProviderId(null);
    toast.info(serverManaged ? t('models.draftRemoved', { name: p.name || p.id }) : rest.length ? t('models.removedSwitched', { name: p.name || p.id, rest: rest[0].name || rest[0].id }) : t('models.removedCleared', { name: p.name || p.id }));
  };

  const confirmRemove = async (provider: Provider) => {
    const affected = MODEL_FIELDS.filter((field) => settings[field].providerId === provider.id && settings[field].model)
      .map((field) => ({ llmModel: 'models.fieldChat', visionModel: 'models.fieldVision', asrModel: 'models.fieldAsr', decisionModel: 'models.fieldDecision' } as const)[field]);
    const description = serverManaged
      ? t('models.removeDescServer', { name: provider.name || provider.id, affected: affected.length ? t('models.affectedSuffix', { slots: affected.map((label) => t(label)).join('、') }) : '' })
      : t('models.removeDescLocal', { name: provider.name || provider.id });
    if (await confirmDialog({ headline: t('models.deleteProviderTitle'), description, danger: true, confirmText: t('models.delete') })) removeProvider(provider);
  };

  // 与原始实现一致：详情页的供应商由选中 id 从设置里现算，草稿只在保存后才进 providers
  const selectedProvider = selectedProviderId ? settings.providers.find((p) => p.id === selectedProviderId) ?? null : null;

  /** 详情页里改连接信息：清掉上一处可能残留的报错再整表写回（与原实现逐字一致） */
  const updateProvider = (provider: Provider, patch: Partial<Provider>) => {
    setProviderError('');
    settings.update({ providers: settings.providers.map((x) => (x.id === provider.id ? { ...x, ...patch } : x)) });
  };

  /** 一家已拉到的在架数；没拉过就数本地保存的条数（原实现两处取数合并成一个） */
  const modelCountOf = (providerId: string): number =>
    modelOptions[providerId]?.length ?? savedModelsOf(settings).filter((m) => m.providerId === providerId).length;

  return {
    settings, modelOptions, providers: settings.providers, selectedProvider, draftProvider, draftError,
    keyError, providerError, providerSaving,
    discoveredModels, discoveredModelFallback, providerNotes, checking,
    statusOf, modelCountOf, updateProvider,
    setSelectedProviderId, setDraftProvider, setDraftError, setProviderError,
    handleCheck, addProvider, connectPreset, discardDraftProvider, saveDraftProvider, confirmRemove,
  };
}
