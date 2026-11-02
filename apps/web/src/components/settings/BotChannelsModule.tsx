import { lazy, Suspense, useState, type ComponentType } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';

const BotSettings = lazy(() => import('../../cloud/BotSettings'));
const GatewaySettings = lazy(() => import('../../cloud/GatewaySettings'));

type BotTab = 'bot' | 'gateway';

function ModuleFallback() {
  return <div className="settings-module-fallback"><Spinner size="sm" color="current" /></div>;
}

/** Bot 权限与消息接入是同一套云端服务配置，合并入口但仍保持两个独立页面。 */
export default function BotChannelsModule({ initialTab }: { initialTab?: string }) {
  const { t } = useTranslation('settings');
  const [tab, setTab] = useState<BotTab>(initialTab === 'gateway' ? 'gateway' : 'bot');
  const Content: ComponentType = tab === 'bot' ? BotSettings : GatewaySettings;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('modules.botChannels')}>
        <Button variant={tab === 'bot' ? 'primary' : 'tertiary'} aria-pressed={tab === 'bot'} onPress={() => setTab('bot')}>
          {t('modules.bot')}
        </Button>
        <Button variant={tab === 'gateway' ? 'primary' : 'tertiary'} aria-pressed={tab === 'gateway'} onPress={() => setTab('gateway')}>
          {t('modules.gateway')}
        </Button>
      </div>
      <Suspense fallback={<ModuleFallback />}><Content /></Suspense>
    </div>
  );
}
