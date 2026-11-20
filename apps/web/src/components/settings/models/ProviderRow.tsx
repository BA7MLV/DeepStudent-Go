import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Chip, Input, ListBox, Select } from '@heroui/react';
import type { ApiProtocol, Provider } from '../../../store/settings';
import { getProviderPresets, matchesProviderPreset } from '../../../store/providerPresets';
import { Field, Sym } from '../../../ui';
import { MotionDisclosure, ms } from '../../motion';
import { ProviderLogo } from '../ProviderPresets';

/**
 * 一家供应商：折叠时一行摘要，展开才编辑凭据。
 *
 * 为什么默认折叠：这是「配一次就长期不动」的配置，四个输入框常驻会让模型选择器
 * （真正需要反复操作的那部分）被推到屏幕外。摘要行已经把要紧的信息全给了 ——
 * 名字、连接状态与模型数量；常用端点无需重复配置地址和协议。
 */
export function ProviderRow({
  provider,
  others,
  note,
  status,
  modelCount,
  open,
  onToggle,
  onChange,
  onRemove,
  removable,
  shaking,
  customConnection = false,
  serverManaged = false,
  accountContent,
  children,
}: {
  provider: Provider;
  others: readonly Provider[];
  note?: string;
  status: 'ready' | 'unconfigured' | 'failed' | 'unchecked' | 'draft';
  modelCount: number | null;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Provider>) => void;
  onRemove: () => void;
  removable: boolean;
  shaking: boolean;
  customConnection?: boolean;
  serverManaged?: boolean;
  accountContent?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const inputRef = useRef<HTMLDivElement>(null);
  const [dupName, setDupName] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showConnection, setShowConnection] = useState(open || !provider.apiKey.trim() || !provider.baseUrl.trim());

  // 与其他家重名时提示：模型选型都按供应商名显示，重名会让设置与面板都对不上是哪一家
  useEffect(() => {
    setDupName(others.some((p) => p.name.trim() === provider.name.trim()));
  }, [provider.name, others]);

  // key 缺失时的抖动。动画通过内联 style 驱动，不依赖 .t-input / .is-shaking 类名。
  useEffect(() => {
    if (!shaking) return;
    setShowConnection(true);
    const el = inputRef.current;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    el.style.animation = `t-input-shake ${shakeMs}ms linear`;
    const t = window.setTimeout(() => {
      if (el) el.style.animation = 'none';
    }, shakeMs + 20);
    return () => clearTimeout(t);
  }, [shaking]);

  const STATUS_HINT: Record<typeof status, 'models.status.draft' | 'models.status.ready' | 'models.status.unchecked' | 'models.status.failed' | 'models.status.unconfigured'> = {
    draft: 'models.status.draft',
    ready: 'models.status.ready',
    unchecked: 'models.status.unchecked',
    failed: 'models.status.failed',
    unconfigured: 'models.status.unconfigured',
  };

  const preset = getProviderPresets().find((p) => matchesProviderPreset(provider, p));
  const showEndpoint = customConnection || !preset;

  const statusColor =
    status === 'ready'
      ? 'text-success'
      : status === 'failed' || status === 'unconfigured'
        ? 'text-danger'
        : 'text-muted';

  return (
    <div
      className={`ui-smooth relative overflow-hidden rounded-panel border border-border/80 bg-background-secondary transition-shadow ${open ? 'border-accent/45 bg-background shadow-md' : 'min-h-[218px] hover:shadow-sm max-[640px]:min-h-[150px]'}`}
      data-testid={`provider-card-${provider.id}`}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className={`box-border flex w-full cursor-pointer flex-col items-stretch gap-5 border-0 bg-transparent p-4 text-left font-[inherit] text-foreground transition-colors duration-200 hover:bg-foreground/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus max-[640px]:gap-3 ${open ? 'min-h-[96px]' : 'min-h-[218px] max-[640px]:min-h-[150px]'}`}
        data-testid={`provider-summary-${provider.id}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="grid size-16 shrink-0 place-items-center rounded-xl bg-background text-3xl text-foreground shadow-sm max-[640px]:size-9 max-[640px]:text-lg" aria-hidden="true">
            {preset ? <ProviderLogo id={preset.id} /> : <Sym name="dns" />}
          </span>
          {status !== 'ready' && <span className={`max-w-full truncate rounded-full px-3 py-1 text-xs font-medium max-[640px]:px-2 max-[640px]:py-1 max-[640px]:text-[9px] ${removable ? 'mr-10 max-[640px]:mr-9' : ''} ${statusColor} ${status === 'failed' || status === 'unconfigured' ? 'bg-danger/12' : 'bg-foreground/8'}`}>
            {t(STATUS_HINT[status])}
          </span>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-end gap-1">
          <span className="flex min-w-0 items-center gap-2 text-lg font-semibold text-foreground max-[640px]:text-xs">
            <span className="truncate">{provider.name.trim() || t('models.unnamedProvider')}</span>
            {status === 'ready' && <span className="inline-flex shrink-0 items-center text-success" title={t(STATUS_HINT[status])} data-testid={`provider-ready-${provider.id}`}>
              <Sym name="check_circle" size={18} />
              <span className="sr-only">{t(STATUS_HINT[status])}</span>
            </span>}
            {dupName && <Chip size="sm" variant="soft" color="danger" className="h-4 px-1 text-[10px]">重名</Chip>}
          </span>
          {showEndpoint && <span className="truncate font-mono text-xs text-muted max-[640px]:text-[9px]" title={provider.baseUrl}>
            {provider.baseUrl.trim() || t('models.baseUrlUnconfigured')}
          </span>}
        </span>
        <span className="flex items-center gap-2 text-sm text-muted max-[640px]:gap-1 max-[640px]:text-[10px]">
          <Sym name="toc" className="max-[640px]:size-3" />
          <span className="tabular-nums">{modelCount ?? 0}</span>
          <span className="max-[640px]:hidden">个模型</span>
          <span className="ml-auto text-xs text-muted max-[640px]:hidden">{open ? t('models.details') : t('models.enter')}</span>
        </span>
      </button>
      {removable && (
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          className="absolute top-4 right-4 text-muted hover:text-danger max-[640px]:top-2 max-[640px]:right-2"
          data-testid={`provider-remove-${provider.id}`}
          onPress={onRemove}
          aria-label={t('models.deleteProvider', { name: provider.name || provider.id })}
        >
          <Sym name="delete" />
        </Button>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/70 px-5 pt-4 pb-5">
          <MotionDisclosure open={showConnection} onOpenChange={setShowConnection}
            title={showEndpoint ? t('models.connectionSettingsFull') : t('models.connectionSettings')} triggerClassName="py-2 text-sm font-medium">
            <div className="flex flex-col gap-3 pt-3">
          <Field label={t('models.name')}>
            <Input
              value={provider.name}
              data-testid={`provider-name-${provider.id}`}
              aria-label={t('models.providerNameAria')}
              placeholder={t('models.providerNamePlaceholder')}
              aria-invalid={dupName || undefined}
              onChange={(e) => onChange({ name: e.target.value })}
              className="w-full"
            />
          </Field>
          {showEndpoint && <>
          <Field label={t('models.apiBaseUrl')} testId={`field-base-url-${provider.id}`}>
            <Input
              value={provider.baseUrl}
              data-testid={`base-url-${provider.id}`}
              aria-label={t('models.apiBaseUrl')}
              placeholder="https://api.example.com/v1"
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
            />
          </Field>
          <Field label={t('models.apiProtocol')} hint={t('models.apiProtocolHint')}>
            <Select
              aria-label={t('models.providerApiProtocol', { name: provider.name || t('models.unnamedProvider') })}
              selectedKey={provider.protocol ?? 'openai-chat'}
              onSelectionChange={(key) => {
                if (key != null) onChange({ protocol: String(key) as ApiProtocol });
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover isNonModal>
                <ListBox>
                  <ListBox.Item id="openai-chat" textValue="OpenAI Chat">OpenAI Chat</ListBox.Item>
                  <ListBox.Item id="openai-responses" textValue="OpenAI Responses">OpenAI Responses</ListBox.Item>
                  <ListBox.Item id="anthropic-messages" textValue="Anthropic Messages">Anthropic Messages</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </Field>
          </>}
          <Field
            label="API Key"
            hint={accountContent ? undefined : serverManaged ? t('models.keyHintServer') : status === 'draft' ? t('models.keyHintDraft') : t('models.keyHintLocal')}
            testId={`field-api-key-${provider.id}`}
          >
            {accountContent ?? <div>
              <div
                ref={inputRef}
                className={`rounded-md border transition-colors duration-150 ${shaking ? 'border-danger' : 'border-border'}`}
                style={{ willChange: 'transform' }}
              >
                <div className="flex flex-nowrap items-center gap-2">
                  <Input
                    data-testid={`api-key-${provider.id}`}
                    aria-label={t('models.providerKey', { name: provider.name })}
                    aria-invalid={shaking || undefined}
                    type={showKey ? 'text' : 'password'}
                    placeholder={serverManaged && provider.configured ? t('models.configuredKeep') : 'sk-...'}
                    autoComplete="new-password"
                    value={provider.apiKey}
                    onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
                    className="flex-1 border-0 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={showKey ? t('models.hideKey', { name: provider.name }) : t('models.showKey', { name: provider.name })}
                    onPress={() => setShowKey((v) => !v)}
                  >
                    <Sym name={showKey ? 'visibility_off' : 'visibility'} />
                  </Button>
                </div>
              </div>
              <p
                className={`mt-1 text-xs text-danger transition-opacity duration-[280ms] ${shaking ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
                data-testid={`key-error-${provider.id}`}
              >
                请先填写这家供应商的 API Key
              </p>
            </div>}
          </Field>
            </div>
          </MotionDisclosure>
          {note && (
            <div role={status === 'failed' ? 'alert' : 'status'} className="text-xs leading-relaxed text-muted" data-testid={`provider-note-${provider.id}`}>
              {note}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
