import { useTranslation } from 'react-i18next';

/** Guidance only: never sends a message, changes skill scope or touches drafts. */
export function PluginCreationHint() {
  const { t } = useTranslation('settings');
  return <p className="text-sm text-muted" data-testid="plugin-creation-hint">{t('createMode.hint')}</p>;
}
