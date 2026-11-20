import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import type { Provider } from '../../../store/settings';
import type { DiscoveredModel } from '../../../api/modelDiscoveryData';
import type { ProviderPreset } from '../../../store/providerPresets';
import { LoadingButton, Sym } from '../../../ui';
import ProviderPresets from '../ProviderPresets';
import ModelLibrary from '../ModelLibrary';
import { ProviderRow } from './ProviderRow';

type ProviderStatus = 'ready' | 'unconfigured' | 'failed' | 'unchecked' | 'draft';

/**
 * 供应商卡片的三种形态：新建草稿 / 选中一家 / 总览。
 *
 * 三段共用同一张卡片与同一个「返回列表」动作，所以逐个分支渲染；
 * 卡片本身（`ProviderRow`）只负责摘要行与连接表单，业务判断都在这里。
 */
export function ProviderSection({
  serverManaged,
  draftProvider,
  selectedProvider,
  providers,
  statusOf,
  modelCountOf,
  keyError,
  providerError,
  draftError,
  providerSaving,
  discoveredModels,
  discoveredModelFallback,
  providerNotes,
  checking,
  saveProviderBound,
  onDraftChange,
  onDiscardDraft,
  onSaveDraft,
  onBack,
  onChangeProvider,
  onRemove,
  onSelectPreset,
  onAddCustom,
  onSelectProvider,
  onCheck,
  renderProviderAccounts,
  providerNeedsSave,
  onAddOpenCodeGo,
  addOpenCodeGoDisabled,
}: {
  serverManaged: boolean;
  draftProvider: Provider | null;
  selectedProvider: Provider | null;
  providers: readonly Provider[];
  statusOf: (provider: Provider) => ProviderStatus;
  modelCountOf: (providerId: string) => number;
  keyError: string | null;
  providerError: string;
  draftError: string;
  providerSaving: boolean;
  discoveredModels: Record<string, DiscoveredModel[] | undefined>;
  discoveredModelFallback: Record<string, boolean | undefined>;
  providerNotes: Record<string, string | undefined>;
  checking: boolean;
  saveProviderBound: boolean;
  onDraftChange: (patch: Partial<Provider>) => void;
  onDiscardDraft: () => void;
  onSaveDraft: () => void;
  onBack: () => void;
  onChangeProvider: (provider: Provider, patch: Partial<Provider>) => void;
  onRemove: (provider: Provider) => void;
  onSelectPreset: (preset: ProviderPreset) => void;
  onAddCustom: () => void;
  onSelectProvider: (providerId: string) => void;
  onCheck: (providerId: string) => void;
  renderProviderAccounts?: (provider: Provider) => React.ReactNode;
  providerNeedsSave?: (provider: Provider) => boolean;
  onAddOpenCodeGo?: () => void;
  addOpenCodeGoDisabled: boolean;
}) {
  const { t } = useTranslation('settings');
  return (
    <>
      {!draftProvider && !selectedProvider && onAddOpenCodeGo && <div className="mb-4 flex justify-end">
        <Button size="sm" variant="secondary" isDisabled={addOpenCodeGoDisabled} onPress={onAddOpenCodeGo}>添加 OpenCode Go</Button>
      </div>}
      {draftProvider ? (
        <form className="flex flex-col gap-4" data-testid="provider-draft" onSubmit={(event) => {
          event.preventDefault();
          onSaveDraft();
        }}>
          <Button type="button" variant="tertiary" className="self-start" data-testid="provider-draft-back" onPress={onDiscardDraft}>
            <Sym name="arrow_back" />返回供应商列表
          </Button>
          <ProviderRow
            key={draftProvider.id}
            provider={draftProvider}
            serverManaged={serverManaged}
            others={providers}
            status="draft"
            modelCount={null}
            open
            shaking={false}
            removable={false}
            customConnection={!draftProvider.catalogId}
            onToggle={() => undefined}
            onRemove={() => undefined}
            onChange={onDraftChange}
          >
            <p className="text-xs text-pretty text-muted">{serverManaged ? t('models.saveHintServer') : t('models.saveHintLocal')}</p>
            {draftError && <p role="alert" className="text-sm text-pretty text-danger">{draftError}</p>}
            <div className="flex gap-2">
              <LoadingButton type="submit" loading={providerSaving} data-testid="provider-draft-save">{saveProviderBound ? t('models.saveConnectionAndFetch') : t('models.saveProvider')}</LoadingButton>
              <Button type="submit" variant="ghost" isDisabled={providerSaving} data-testid="provider-draft-cancel" onPress={onDiscardDraft}>取消</Button>
            </div>
          </ProviderRow>
        </form>
      ) : selectedProvider ? (
        <div className="flex flex-col gap-4">
          <Button variant="tertiary" className="self-start" data-testid="provider-back" onPress={onBack}>
            <Sym name="arrow_back" />返回供应商列表
          </Button>
          <ProviderRow
            key={selectedProvider.id}
            provider={selectedProvider}
            serverManaged={serverManaged}
            others={providers.filter((x) => x.id !== selectedProvider.id)}
            status={statusOf(selectedProvider)}
            modelCount={modelCountOf(selectedProvider.id)}
            open
            shaking={keyError === selectedProvider.id}
            removable={serverManaged || providers.length > 1}
            onToggle={() => undefined}
            onChange={(patch) => onChangeProvider(selectedProvider, patch)}
            onRemove={() => onRemove(selectedProvider)}
            accountContent={renderProviderAccounts?.(selectedProvider)}
          >
            {serverManaged && <p className="text-xs text-muted">{providerNeedsSave?.(selectedProvider) ? t('models.needsSaveNote') : t('models.savedNote')}</p>}
            {providerError && <p role="alert" className="text-sm text-danger">{providerError}</p>}
            <ModelLibrary
              key={selectedProvider.id}
              providerId={selectedProvider.id}
              allowDecision
              discovered={discoveredModels[selectedProvider.id]}
              discoveredFromFallback={discoveredModelFallback[selectedProvider.id]}
              checking={checking || providerSaving}
              refreshLabel={serverManaged && providerNeedsSave?.(selectedProvider) ? t('models.saveConnectionAndFetch') : t('models.fetchListLabel')}
              onRefresh={() => onCheck(selectedProvider.id)}
              note={providerNotes[selectedProvider.id]}
            />
          </ProviderRow>
        </div>
      ) : (
        <ProviderPresets
          providers={providers}
          onSelect={onSelectPreset}
          onCustom={onAddCustom}
          renderProvider={p => (
            <ProviderRow
              key={p.id}
              provider={p}
              serverManaged={serverManaged}
              others={providers.filter((x) => x.id !== p.id)}
              note={providerNotes[p.id]}
              status={statusOf(p)}
              modelCount={modelCountOf(p.id)}
              open={false}
              shaking={keyError === p.id}
              removable={serverManaged || providers.length > 1}
              onToggle={() => onSelectProvider(p.id)}
              onChange={(patch) => onChangeProvider(p, patch)}
              onRemove={() => onRemove(p)}
            >
              <ModelLibrary key={p.id} providerId={p.id} allowDecision discoveredFromFallback={discoveredModelFallback[p.id]} checking={checking} onRefresh={() => onCheck(p.id)} />
            </ProviderRow>
          )}
        />
      )}
    </>
  );
}
