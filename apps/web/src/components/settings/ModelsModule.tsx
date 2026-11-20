import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { useModelMetaRevision } from '../../utils/useModelMeta';
import type { Provider } from '../../store/settings';
import type { DiscoveryProvider } from '../../utils/useProviderModels';
import type { ModelSettingsIssue } from '@wangke/contracts/model-settings';
import { SectionCard } from '../../ui';
import { ModelSlotSection } from './models/ModelSlotSection';
import { ProviderSection } from './models/ProviderSection';
import { useModelCapsRefresh, useProviderEditor } from './models/useProviderEditor';
import { ModelMetaFooter } from './models/ModelMetaFooter';
import PromptCacheUsage from './PromptCacheUsage';
import ContextCompressionCard from './ContextCompressionCard';

/**
 * 「模型」模块。
 *
 * 供应商优先：展开一家后管理连接及其模型，再设置各用途的默认模型和运行参数。
 *
 * 这里只做编排：连接与草稿的状态在 `useProviderEditor`，能力目录的刷新在
 * `useModelCapsRefresh`，两段 UI（供应商卡片 / 槽位与运行参数）在 `models/` 下。
 * 之所以不再整体做成「状态 + JSX 一个文件」：改一处校验就要在一个千行文件里找上下文。
 */
export default function ModelsModule({ serverManaged = false, discoveryProviders, standalone = false, onSaveProvider, providerNeedsSave, onDraftChange, onProviderViewChange, renderProviderAccounts, onAddOpenCodeGo, addOpenCodeGoDisabled = false, issues = [], focusIssue = 0 }: {
  serverManaged?: boolean;
  discoveryProviders?: DiscoveryProvider[];
  standalone?: boolean;
  onSaveProvider?: (provider: Provider) => Promise<void>;
  providerNeedsSave?: (provider: Provider) => boolean;
  onDraftChange?: (editing: boolean) => void;
  /** Tells the cloud editor when a custom provider detail view is active. */
  onProviderViewChange?: (hideModelPresets: boolean) => void;
  renderProviderAccounts?: (provider: Provider) => ReactNode;
  onAddOpenCodeGo?: () => void;
  addOpenCodeGoDisabled?: boolean;
  issues?: ModelSettingsIssue[];
  focusIssue?: number;
} = {}) {
  const { t } = useTranslation('settings');
  useModelMetaRevision();
  const provider = useProviderEditor({
    serverManaged, discoveryProviders, standalone, onSaveProvider, providerNeedsSave,
    onDraftChange, onProviderViewChange, issues, focusIssue,
  });
  const meta = useModelCapsRefresh(provider.providers);

  return (
    <>
      <SectionCard
        title={provider.draftProvider ? (provider.draftProvider.name.trim() || t('models.customProvider')) : provider.selectedProvider ? (provider.selectedProvider.name.trim() || t('models.unnamedProvider')) : t('models.modelProviders')}
        testId="card-api"
      >
        <ProviderSection
          serverManaged={serverManaged}
          draftProvider={provider.draftProvider}
          selectedProvider={provider.selectedProvider}
          providers={provider.providers}
          statusOf={provider.statusOf}
          modelCountOf={provider.modelCountOf}
          keyError={provider.keyError}
          providerError={provider.providerError}
          draftError={provider.draftError}
          providerSaving={provider.providerSaving}
          discoveredModels={provider.discoveredModels}
          discoveredModelFallback={provider.discoveredModelFallback}
          providerNotes={provider.providerNotes}
          checking={provider.checking}
          saveProviderBound={Boolean(onSaveProvider)}
          onDraftChange={(patch) => {
            provider.setDraftProvider((current) => current ? { ...current, ...patch } : null);
            provider.setDraftError('');
          }}
          onDiscardDraft={provider.discardDraftProvider}
          onSaveDraft={provider.saveDraftProvider}
          onBack={() => provider.setSelectedProviderId(null)}
          onChangeProvider={provider.updateProvider}
          onRemove={(p) => void provider.confirmRemove(p)}
          onSelectPreset={provider.connectPreset}
          onAddCustom={provider.addProvider}
          onSelectProvider={(id) => provider.setSelectedProviderId(id)}
          onCheck={(id) => void provider.handleCheck(id)}
          renderProviderAccounts={renderProviderAccounts}
          providerNeedsSave={providerNeedsSave}
          onAddOpenCodeGo={onAddOpenCodeGo}
          addOpenCodeGoDisabled={addOpenCodeGoDisabled}
        />
        <ModelMetaFooter
          updatedAt={meta.metaInfo ? meta.metaInfo.updatedAt : null}
          refreshing={meta.metaRefreshing}
          error={meta.metaError}
          onRefresh={() => void meta.handleRefreshMeta()}
        />
      </SectionCard>
      {/* 总览页（没选中供应商、也没有草稿）才出现槽位与运行参数 —— 与「配连接」不同屏 */}
      {!provider.selectedProvider && !provider.draftProvider && (
        <ModelSlotSection settings={provider.settings} modelOptions={provider.modelOptions} issues={issues} onUpdate={provider.settings.update} />
      )}

      {!standalone && <PromptCacheUsage serverManaged={serverManaged} />}
      <ContextCompressionCard />
    </>
  );
}
