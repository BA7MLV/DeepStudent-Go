import { lazy, Suspense, useState, type ComponentType } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';

const AppearanceModule = lazy(() => import('./AppearanceModule'));
const PlaybackModule = lazy(() => import('./PlaybackModule'));
const ShortcutsModule = lazy(() => import('./ShortcutsModule'));

type ExperienceTab = 'appearance' | 'playback' | 'shortcuts';

function ModuleFallback() {
  return <div className="settings-module-fallback"><Spinner size="sm" color="current" /></div>;
}

/** 合并低频的界面、播放和快捷键偏好；用 Tab 控制页面长度，避免把三屏内容堆在一起。 */
export default function ExperienceModule({ initialTab }: { initialTab?: string }) {
  const { t } = useTranslation('settings');
  const [tab, setTab] = useState<ExperienceTab>(
    initialTab === 'playback' || initialTab === 'shortcuts' ? initialTab : 'appearance',
  );
  const Content: ComponentType = tab === 'appearance' ? AppearanceModule : tab === 'playback' ? PlaybackModule : ShortcutsModule;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('modules.experience')}>
        <Button variant={tab === 'appearance' ? 'primary' : 'tertiary'} aria-pressed={tab === 'appearance'} onPress={() => setTab('appearance')}>
          {t('modules.appearance')}
        </Button>
        <Button variant={tab === 'playback' ? 'primary' : 'tertiary'} aria-pressed={tab === 'playback'} onPress={() => setTab('playback')}>
          {t('modules.playback')}
        </Button>
        <Button variant={tab === 'shortcuts' ? 'primary' : 'tertiary'} aria-pressed={tab === 'shortcuts'} onPress={() => setTab('shortcuts')}>
          {t('modules.shortcuts')}
        </Button>
      </div>
      <Suspense fallback={<ModuleFallback />}><Content /></Suspense>
    </div>
  );
}
