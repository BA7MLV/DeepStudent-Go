import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BILI_SCRIPT_URL, hasBiliBridge } from './bridge';

/** Poll only while this small installation/status panel is mounted. */
export default function BiliBridgeStatus() {
  const { t } = useTranslation('projects');
  const [ready, setReady] = useState(hasBiliBridge);
  useEffect(() => {
    const timer = window.setInterval(() => setReady(hasBiliBridge()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <div className="mb-3 flex flex-col gap-2 text-sm" data-testid="bili-bridge-status" data-ready={ready}>
    <span>{t(ready ? 'biliLocal.connected' : 'biliLocal.notDetected')}</span>
    <div className="flex flex-wrap gap-3">
      <a href={BILI_SCRIPT_URL} target="_blank" rel="noopener noreferrer" className="underline">{t('biliLocal.installScript')}</a>
      <a href="https://www.tampermonkey.net/" target="_blank" rel="noopener noreferrer" className="underline">{t('biliLocal.installExtension')}</a>
      <a href="https://www.bilibili.com/" target="_blank" rel="noopener noreferrer" className="underline">{t('biliLocal.loginBrowser')}</a>
    </div>
    <p className="text-muted">{t('biliLocal.permissions')}</p>
  </div>;
}
