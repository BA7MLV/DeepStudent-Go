import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react';
import { flushSync } from 'react-dom';
import { Button, cn, Disclosure, Tabs } from '@heroui/react';
import { Sym } from '../ui';
import { useTranslation } from 'react-i18next';
import { useAssistantPosition } from './useAssistantPosition';
import { ASSISTANT_RESIZE_EDGES } from './assistantGeometry';
import { viewTransitionSupported, withViewTransition } from '../utils/viewTransition';
import './study-assistant.css';

export type StudyPanelKey = 'subs' | 'chat' | 'dm' | 'cards' | 'plugins';
export const STUDY_PANEL_KEYS: readonly StudyPanelKey[] = ['subs', 'chat', 'dm', 'cards', 'plugins'];

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: StudyPanelKey;
  onTabChange: (key: StudyPanelKey) => void;
  panelKeys: readonly StudyPanelKey[];
  panels: Partial<Record<StudyPanelKey, ReactNode>>;
}

/** 非模态的学习工具箱：收起只隐藏，字幕订阅、生成任务和输入草稿继续保留。 */
export default function StudyAssistant({ open, onOpenChange, activeTab, onTabChange, panelKeys, panels }: Props) {
  const { t } = useTranslation('interface');
  const { boundsRef, assistantRef, suppressToggle } = useAssistantPosition(open);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const pendingFocus = useRef<'trigger' | 'panel' | null>(null);
  const [tabDir, setTabDir] = useState<'left' | 'right'>('right');
  const changeOpen = (expanded: boolean) => {
    pendingFocus.current = expanded ? 'panel' : 'trigger';
    if (!viewTransitionSupported()) {
      onOpenChange(expanded);
      return;
    }
    // View Transition 拍新帧时元素必须已在终态：暂时挂掉 t-dropdown 自己的过渡，
    // 面板的开合全部交给共享元素（触发钮 → 面板头部）与短交叉淡化。
    contentRef.current?.classList.add('vt-instant');
    const doc = document as Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };
    const vt = doc.startViewTransition!(() => { flushSync(() => onOpenChange(expanded)); });
    vt.finished.finally(() => contentRef.current?.classList.remove('vt-instant')).catch(() => {});
  };
  useLayoutEffect(() => {
    if (pendingFocus.current === (open ? 'panel' : 'trigger')) {
      (open ? bodyRef : triggerRef).current?.focus({ preventScroll: true });
    }
    pendingFocus.current = null;
  }, [open]);
  return (
    <div ref={boundsRef} className="study-assistant-viewport">
      <Disclosure ref={assistantRef} className="study-assistant" isExpanded={open}
        onExpandedChange={(expanded) => { if (!suppressToggle.current) changeOpen(expanded); }}>
        <Disclosure.Content ref={contentRef as Ref<HTMLDivElement>} className={cn('study-assistant__content t-dropdown', open ? 'is-open' : 'is-closing')}
          inert={!open} data-testid="study-assistant-panel">
          <div ref={bodyRef} className="study-assistant__body" tabIndex={-1}>
            <div className="study-assistant__header" style={{ viewTransitionName: 'study-assistant-head' }}>
              <div className="study-assistant__drag-handle" data-assistant-drag-handle
                data-testid="study-assistant-drag-handle" title={t('assistant.drag')}>
                <Sym name="drag_indicator" />
                <span>{t('assistant.title')}</span>
              </div>
              <Button isIconOnly variant="tertiary" size="sm" data-testid="study-assistant-close"
                aria-label={t('assistant.close')} onPress={() => changeOpen(false)}>
                <Sym name="keyboard_arrow_down" />
              </Button>
            </div>
            <Tabs className="panel-tabs" variant="secondary" align="start" selectedKey={activeTab} data-tab-dir={tabDir}
              onSelectionChange={(key) => {
                if (!panelKeys.includes(key as StudyPanelKey)) return;
                const next = panelKeys.indexOf(key as StudyPanelKey);
                const prev = panelKeys.indexOf(activeTab);
                if (next !== prev) setTabDir(next > prev ? 'right' : 'left');
                onTabChange(key as StudyPanelKey);
              }} data-testid="panel-tabs">
              <Tabs.ListContainer>
                <Tabs.List aria-label={t('assistant.panels')}>
                  {panelKeys.map((key) => (
                    <Tabs.Tab key={key} id={key} data-testid={`panel-tab-${key}`}><Tabs.Indicator />{t(`assistant.${key}`)}</Tabs.Tab>
                  ))}
                </Tabs.List>
              </Tabs.ListContainer>
              {panelKeys.map((key) => (
                <Tabs.Panel key={key} id={key} shouldForceMount hidden={activeTab !== key} data-testid={`panel-slot-${key}`}>
                  {panels[key]}
                </Tabs.Panel>
              ))}
            </Tabs>
          </div>
          {ASSISTANT_RESIZE_EDGES.map((edge) => (
            <Button key={edge} isIconOnly variant="tertiary"
              className="study-assistant__resize-edge" data-assistant-resize-handle={edge}
              data-testid={`study-assistant-resize-${edge}`} excludeFromTabOrder={edge.length > 1}
              aria-label={t('assistant.resize', { edge: t(`assistant.edges.${edge}`) })}
              aria-description={t('assistant.resizeHelp')} />
          ))}
        </Disclosure.Content>
        <Disclosure.Heading className="study-assistant__heading" hidden={open}>
          <Button ref={triggerRef} slot="trigger" variant="primary" className="study-assistant__trigger"
            style={{ viewTransitionName: 'study-assistant-head' }}
            data-assistant-drag-handle aria-description={t('assistant.move')}
            data-testid="study-assistant-toggle" aria-label={t('assistant.open')}>
            <Sym name="neurology" />
            <span className="study-assistant__trigger-label">{t('assistant.title')}</span>
          </Button>
        </Disclosure.Heading>
      </Disclosure>
    </div>
  );
}
