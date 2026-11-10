import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { LoadingButton, SectionCard, toast } from '../../ui';
import { cloud, cloudRequest } from '../../cloud/state';
import { accountLifetime } from '../../client/account-lifecycle';
import { useSettings } from '../../store/settings';
import BiliBridgeStatus from '../../bilibili/BridgeStatus';
import { biliLocalRequest } from '../../bilibili/bridge';
import { probeBiliLogin } from '@wangke/study-core/bilibili/api';

export default function SourcesModule() {
  const { t } = useTranslation('projects');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function checkLogin() {
    const lifetime = accountLifetime(cloud.userId);
    setBusy(true);
    try {
      const login = await probeBiliLogin({ request: biliLocalRequest() });
      if (!lifetime.current()) return;
      setMessage(login?.isLogin ? t('biliLocal.loggedIn', { name: login.uname ? `: ${login.uname}` : '' }) : t(login ? 'biliLocal.loggedOut' : 'biliLocal.loginUnknown'));
    } finally { setBusy(false); }
  }

  async function clearOldCookie() {
    const lifetime = accountLifetime(cloud.userId);
    setBusy(true);
    try {
      await cloudRequest('/bilibili/credentials', { method: 'PUT', body: JSON.stringify({ cookie: '' }) });
      if (!lifetime.current()) return;
      useSettings.getState().update({ bilibiliCookie: '' });
      toast.success(t('biliLocal.cookieCleared'));
    } catch (error) { if (lifetime.current()) setMessage(error instanceof Error ? error.message : t('biliLocal.clearFailed')); }
    finally { setBusy(false); }
  }

  return <SectionCard title={t('biliLocal.settingsTitle')} testId="card-bilibili">
    <BiliBridgeStatus />
    <p className="text-sm text-muted">{t('biliLocal.settingsHint')}</p>
    <div className="flex flex-wrap gap-2">
      <LoadingButton variant="secondary" loading={busy} onPress={() => void checkLogin()}>{t('biliLocal.checkLogin')}</LoadingButton>
      <Button variant="ghost" isDisabled={busy} onPress={() => void clearOldCookie()}>{t('biliLocal.clearCookie')}</Button>
    </div>
    {message ? <p role="status" className="text-sm text-muted">{message}</p> : null}
  </SectionCard>;
}
