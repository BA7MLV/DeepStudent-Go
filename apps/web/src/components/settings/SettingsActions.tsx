import { createContext, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { LoadingButton, confirmDialog } from '../../ui';
import './settings-actions.css';

const ActionsContainer = createContext<HTMLDivElement | null>(null);

/** Only offered after a version conflict; replacing a draft is never automatic. */
export function SettingsConflictRecovery({ busy, onReload }: { busy: boolean; onReload: () => Promise<void> }) {
  const { t } = useTranslation('settings');
  return <Button variant="secondary" isDisabled={busy} onPress={async () => {
    if (await confirmDialog({
      headline: t('saveBar.replaceTitle'),
      description: t('saveBar.replaceDescription'),
      confirmText: t('saveBar.replaceDraft'),
      danger: true,
    })) await onReload();
  }}>{t('saveBar.useServerVersion')}</Button>;
}

/** Keep actions in the dialog's focus scope, but outside its scrolling content. */
export function SettingsActionsScope({ children }: { children: ReactNode }) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  return <ActionsContainer.Provider value={container}>
    {children}
    <div ref={setContainer} className="settings-actions-slot" />
  </ActionsContainer.Provider>;
}

export function SettingsSaveBar({ dirty, busy = false, disabled = false, error, message, saveLabel, onSave, children, testId, saveTestId, statusTestId }: {
  dirty: boolean;
  busy?: boolean;
  disabled?: boolean;
  error?: string;
  message?: string;
  saveLabel: string;
  onSave: () => void;
  children?: ReactNode;
  testId?: string;
  saveTestId?: string;
  statusTestId?: string;
}) {
  const { t } = useTranslation('settings');
  const container = useContext(ActionsContainer);
  const bar = <section className="settings-save-bar" aria-label={t('saveBar.label')} data-testid={testId} aria-busy={busy}>
    <div className="settings-save-bar__row">
      <p className="settings-save-bar__status text-sm text-muted" role="status" data-testid={statusTestId}>
        {busy ? t('saveBar.saving') : dirty ? t('saveBar.unsaved') : message || t('saveBar.saved')}
      </p>
      <div className="settings-save-bar__buttons">
        {children}
        <LoadingButton variant="primary" loading={busy} isDisabled={disabled || !dirty} onPress={onSave} data-testid={saveTestId}>
          {busy ? t('saveBar.saving') : saveLabel}
        </LoadingButton>
      </div>
    </div>
    {!busy && dirty && message && <p className="mt-2 text-sm text-muted" role="status">{message}</p>}
    {error && <p className="settings-save-bar__error text-sm text-danger" role="alert">{error}</p>}
  </section>;
  // Onboarding and other standalone editors retain an in-flow action row.
  return container ? createPortal(bar, container) : bar;
}
