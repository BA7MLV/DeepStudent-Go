import { useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { databaseNotice, subscribeDatabaseNotice } from '../store/database-lifecycle';

/** Also mounted while startCloud is waiting for an IndexedDB upgrade. */
export default function DatabaseNotice() {
  const { t } = useTranslation('settings', { keyPrefix: 'recovery' });
  const notice = useSyncExternalStore(subscribeDatabaseNotice, databaseNotice);
  if (!notice) return null;
  return <section role="alert" className="bg-surface p-3">
    <p>{t(notice.state === 'blocked' ? 'blocked' : 'updateRequired')}</p>
    <button type="button" onClick={() => window.location.reload()}>{t('reload')}</button>
  </section>;
}
