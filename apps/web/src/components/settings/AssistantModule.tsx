import { lazy, Suspense, useState, type ComponentType } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';

const AgentModule = lazy(() => import('./AgentModule'));
const SkillsModule = lazy(() => import('./SkillsModule'));

type AssistantTab = 'agent' | 'skills';

function ModuleFallback() {
  return <div className="settings-module-fallback"><Spinner size="sm" color="current" /></div>;
}

/** 统一放置 AI 的行为偏好与可用能力，避免一个很短的 Agent 页面单独占用导航项。 */
export default function AssistantModule({ initialTab }: { initialTab?: string }) {
  const { t } = useTranslation('settings');
  const [tab, setTab] = useState<AssistantTab>(initialTab === 'skills' ? 'skills' : 'agent');
  const Content: ComponentType = tab === 'skills' ? SkillsModule : AgentModule;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('modules.assistant')}>
        <Button variant={tab === 'agent' ? 'primary' : 'tertiary'} aria-pressed={tab === 'agent'} onPress={() => setTab('agent')}>
          {t('modules.agent')}
        </Button>
        <Button variant={tab === 'skills' ? 'primary' : 'tertiary'} aria-pressed={tab === 'skills'} onPress={() => setTab('skills')}>
          {t('modules.skills')}
        </Button>
      </div>
      <Suspense fallback={<ModuleFallback />}><Content /></Suspense>
    </div>
  );
}
