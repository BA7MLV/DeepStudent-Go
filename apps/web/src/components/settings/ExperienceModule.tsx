import { lazy, Suspense, useState, type ComponentType } from 'react';
import { Spinner, Tabs } from '@heroui/react';
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

  /* 子页切换用真正的 Tabs：旧的自绘按钮只有 aria-pressed，键盘模型与其余页面的 Tabs 不一致。 */
  const tabs: ExperienceTab[] = ['appearance', 'playback', 'shortcuts'];
  return (
    <div className="flex flex-col gap-4">
      <Tabs selectedKey={tab} onSelectionChange={(key) => setTab(key as ExperienceTab)}>
        <Tabs.ListContainer>
          <Tabs.List aria-label={t('modules.experience')}>
            {tabs.map((key) => (
              <Tabs.Tab key={key} id={key} data-testid={`experience-tab-${key}`}>
                <Tabs.Indicator />{t(`modules.${key}`)}
              </Tabs.Tab>
            ))}
          </Tabs.List>
        </Tabs.ListContainer>
        {tabs.map((key) => (
          <Tabs.Panel key={key} id={key} shouldForceMount hidden={tab !== key}>
            {tab === key && <Suspense fallback={<ModuleFallback />}><Content /></Suspense>}
          </Tabs.Panel>
        ))}
      </Tabs>
    </div>
  );
}
