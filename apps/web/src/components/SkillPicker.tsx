import { useEffect, useId, useRef, useState, type RefObject } from 'react';
import { Button, Checkbox, Dropdown, Label, ListBox, Popover, SearchField, Spinner, Tooltip } from '@heroui/react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Sym } from '../ui';
import { loadEnabledSkillMeta, type SkillMeta } from '../skills/store';
import { intersectSkillMetaIds } from '../skills/scope';
import { BUILTIN_PRESENTATION } from '../skills/presentation';
import McpScope from '../mcp/McpScope';
import { openSettings } from './settingsDialogStore';
import { useMediaQuery } from '../utils/useMobile';
import './skill-picker.css';

interface Props {
  /** undefined = 自动；[] = 不使用；其他集合 = 本次会话可用范围。 */
  value?: number[];
  /** 选满全部启用项时归一化为 undefined，之后新启用的技能也可用。 */
  onChange: (next: number[] | undefined) => void;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTrigger?: boolean;
  anchorRef?: RefObject<HTMLButtonElement | null>;
  mcpValue?: string[];
  onMcpChange?: (ids: string[] | undefined) => Promise<void>;
  turnValue?: number[];
  onTurnChange?: (ids: number[]) => void;
  onInserted?: () => void;
  disabled?: boolean;
}

/** Explicit activation and automatic availability are independent; search never changes selection. */
export default function SkillPicker({ value, onChange, isOpen, onOpenChange, hideTrigger, anchorRef, mcpValue, onMcpChange, turnValue = [], onTurnChange, onInserted, disabled }: Props) {
  const { t } = useTranslation('settings');
  const touch = useMediaQuery('(pointer: coarse)');
  const id = useId();
  const listRef = useRef<HTMLDivElement>(null);
  const [internalOpen, setInternalOpen] = useState(false);
  const open = isOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const [catalog, setCatalog] = useState<{ status: 'loading' | 'ready' | 'error'; skills: SkillMeta[] }>({ status: 'loading', skills: [] });
  const [retry, setRetry] = useState(0);
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'turn' | 'scope'>(onTurnChange ? 'turn' : 'scope');
  const canInvoke = !!onTurnChange;

  // 每次打开重新读取启停状态；关闭后丢弃未完成的结果，失败不伪装成空列表。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setCatalog({ status: 'loading', skills: [] });
    setQuery('');
    setTab(canInvoke ? 'turn' : 'scope');
    void loadEnabledSkillMeta().then((skills) => {
      if (!cancelled) setCatalog({ status: 'ready', skills });
    }).catch(() => {
      if (!cancelled) setCatalog({ status: 'error', skills: [] });
    });
    return () => { cancelled = true; };
  }, [open, retry, canInvoke]);

  const { skills, status } = catalog;
  const scope = new Set(intersectSkillMetaIds(skills, value));
  const explicit = tab !== 'scope';
  const chosen = turnValue;
  const selected = explicit ? new Set(intersectSkillMetaIds(skills, chosen)) : scope;
  const unavailable = explicit ? chosen.filter(key => !skills.some(skill => skill.id === key || skill.legacyIds?.includes(key))) : [];
  const mode = value === undefined ? 'auto' : value.length === 0 ? 'none' : 'custom';
  const ready = status === 'ready' && !disabled;
  const selectionLabel = mode === 'auto' ? t('skillPicker.auto')
    : mode === 'none' ? t('skillPicker.none') : t('skillPicker.custom');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const items = skills.map((skill) => {
    const builtin = skill.builtin ? BUILTIN_PRESENTATION.find((item) => item.name === skill.name) : undefined;
    return {
      ...skill,
      title: builtin ? t(`skillPicker.builtins.${builtin.key}.title`) : skill.name,
      summary: builtin ? t(`skillPicker.builtins.${builtin.key}.description`) : skill.description,
      brief: builtin ? t(`skillPicker.builtins.${builtin.key}.brief`) : skill.description,
      icon: builtin?.icon ?? 'extension',
      order: builtin ? BUILTIN_PRESENTATION.indexOf(builtin) : BUILTIN_PRESENTATION.length,
    };
  }).sort((a, b) => a.order - b.order);
  const visible = items.filter((skill) => [skill.name, skill.title, skill.summary, skill.description, ...(skill.mcpRequired ?? [])]
    .join(' ').toLocaleLowerCase().includes(normalizedQuery));
  const groups = [
    { key: 'builtin', label: t('skillPicker.builtin'), items: visible.filter((skill) => skill.builtin) },
    { key: 'custom', label: t('skillPicker.yours'), items: visible.filter((skill) => !skill.builtin) },
  ];
  const showGroupLabels = skills.some((skill) => skill.builtin) && skills.some((skill) => !skill.builtin);

  const toggle = (skillId: number, checked: boolean) => {
    if (explicit) {
      const skill = skills.find(item => item.id === skillId);
      const previous = chosen.filter(key => key !== skillId && !skill?.legacyIds?.includes(key));
      const next = checked ? [...previous, skillId] : previous;
      void changeExplicit(next);
      return;
    }
    const next = new Set(selected);
    if (checked) next.add(skillId); else next.delete(skillId);
    // 使用全部候选而非搜索结果，保留隐藏项；空集合绝不能归一化为自动。
    onChange(next.size > 0 && next.size === skills.length ? undefined : skills.map((s) => s.id).filter((key) => next.has(key)));
  };

  const changeExplicit = (next: number[]) => onTurnChange?.(next);
  const insert = (key: string | number) => {
    const skillId = Number(key);
    if (!ready || !scope.has(skillId) || selected.has(skillId)) return;
    // Close and commit before focusing, still within the user's gesture.
    flushSync(() => { changeExplicit([...chosen, skillId]); setOpen(false); });
    onInserted?.();
  };

  const manage = () => {
    setOpen(false);
    openSettings('skills');
  };

  return <Popover isOpen={open} onOpenChange={setOpen}>
    {!hideTrigger && <Tooltip>
      <Tooltip.Trigger>
        <Button isIconOnly variant={value === undefined ? 'tertiary' : 'primary'} size="sm"
          aria-label={t('skillPicker.title')} data-testid="skill-picker" data-limited={value === undefined ? undefined : '1'}
          onPress={() => setOpen(true)}>
          <Sym name="extension" />
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>{t('skillPicker.trigger', { mode: selectionLabel })}</Tooltip.Content>
    </Tooltip>}

    <Popover.Content triggerRef={anchorRef} placement="top start" offset={8} containerPadding={10} className="skill-picker-popover">
          <Popover.Dialog className="skill-picker-dialog" data-compact={explicit || undefined} data-testid="skill-picker-dialog">
            <div className="skill-picker__header">
              <div className="skill-picker__title-row">
                <Popover.Heading className={explicit ? 'sr-only' : 'skill-picker__heading'}>{t(explicit ? 'skillPicker.title' : 'skillPicker.scopeTab')}</Popover.Heading>
                {explicit && <Dropdown>
                  <Button isIconOnly size="sm" variant="tertiary" aria-label={t('skillPicker.options')} data-testid="skill-picker-options"><Sym name="more_horiz" /></Button>
                  <Dropdown.Popover placement="bottom end"><Dropdown.Menu aria-label={t('skillPicker.options')} onAction={key => {
                    if (key === 'scope') { setTab('scope'); setQuery(''); } else manage();
                  }}>
                    <Dropdown.Item id="scope" textValue={t('skillPicker.scopeTab')} data-testid="skill-picker-advanced">{t('skillPicker.scopeTab')}</Dropdown.Item>
                    <Dropdown.Item id="manage" textValue={t('skillPicker.manage')} data-testid="skill-picker-manage">{t('skillPicker.manage')}</Dropdown.Item>
                  </Dropdown.Menu></Dropdown.Popover>
                </Dropdown>}
              </div>
              <p className={explicit ? 'sr-only' : 'skill-picker__notice'}>{t(`skillPicker.${tab}Hint`)}</p>
              {disabled && <p className="skill-picker__notice" role="status">{t('skillPicker.busyHint')}</p>}
              {!explicit && <div className="skill-picker__toolbar">
                <div className="skill-picker__presets">
                  <Button size="sm" variant={mode === 'auto' ? 'secondary' : 'tertiary'} aria-pressed={mode === 'auto'}
                    isDisabled={!ready} data-testid="skill-picker-all" onPress={() => onChange(undefined)}>
                    {t('skillPicker.useAuto')}
                  </Button>
                   <Button size="sm" variant={mode === 'none' ? 'secondary' : 'tertiary'} aria-pressed={mode === 'none'}
                    isDisabled={!ready} data-testid="skill-picker-none" onPress={() => onChange([])}>
                     {t('skillPicker.useNone')}
                   </Button>
                </div>
                {ready && <span className="skill-picker__count" role="status" aria-live="polite" data-testid="skill-picker-status"
                  aria-label={t('skillPicker.countLabel', { count: selected.size, total: skills.length })}>
                  {t('skillPicker.count', { count: selected.size, total: skills.length })}
                </span>}
              </div>}
              {unavailable.length > 0 && <p className="skill-picker__notice" role="alert">{t('skillPicker.explicitUnavailable', { count: unavailable.length })} <Button size="sm" variant="tertiary" isDisabled={!ready} onPress={() => void changeExplicit(chosen.filter(key => !unavailable.includes(key)))}>{t('skillPicker.removeUnavailable')}</Button></p>}
              {ready && !explicit && mode === 'custom' && selected.size === 0 && skills.length > 0 && <p className="skill-picker__notice" role="status">{t('skillPicker.unavailable')}</p>}
              {ready && skills.length > 0 && <SearchField value={query} onChange={setQuery} aria-label={t('skillPicker.search')}
                data-testid="skill-picker-search">
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input autoFocus={explicit && !touch} placeholder={t('skillPicker.searchPlaceholder')}
                    onKeyDown={event => {
                      if (explicit && event.key === 'ArrowDown') {
                        event.preventDefault();
                        listRef.current?.querySelector<HTMLElement>('[role="option"]:not([aria-disabled="true"])')?.focus();
                      }
                    }} />
                  <SearchField.ClearButton aria-label={t('skillPicker.clearSearch')} />
                </SearchField.Group>
              </SearchField>}
            </div>

            <div className="skill-picker__body">
              <div className="skill-picker" aria-busy={status === 'loading'}>
                {status === 'loading' ? <div className="skill-picker__empty" role="status"><Spinner size="sm" /><span>{t('skillPicker.loading')}</span></div>
                  : status === 'error' ? <div className="skill-picker__empty" role="alert">
                    <Sym name="error" /><p>{t('skillPicker.loadError')}</p>
                    <Button size="sm" variant="secondary" onPress={() => setRetry((n) => n + 1)}>{t('skillPicker.retry')}</Button>
                  </div>
                  : skills.length === 0 ? <div className="skill-picker__empty" data-testid="skill-picker-empty">
                    <Sym name="extension" /><strong>{t('skillPicker.empty')}</strong>
                  </div>
                  : visible.length === 0 ? <div className="skill-picker__empty" role="status">
                    <Sym name="search" /><strong>{t('skillPicker.noResults')}</strong>
                    <Button size="sm" variant="secondary" onPress={() => setQuery('')}>{t('skillPicker.clearSearch')}</Button>
                  </div>
                  : explicit ? <ListBox ref={listRef} aria-label={t('skillPicker.title')} selectionMode="none" className="skill-picker__actions" onAction={insert}
                    disabledKeys={visible.filter(skill => !ready || !scope.has(skill.id) || selected.has(skill.id)).map(skill => skill.id)}>
                    {visible.map(skill => <ListBox.Item key={skill.id} id={skill.id} textValue={skill.title}
                      className="skill-picker__action" data-testid="skill-insert-item" data-skill-name={skill.name}>
                      <span className="skill-picker__icon"><Sym name={skill.icon} /></span>
                      <span className="skill-picker__text"><Label className="skill-picker__name">{skill.title}</Label>
                        <span className="skill-picker__dependency skill-picker__summary">{!scope.has(skill.id) ? t('skillPicker.outOfScope') : skill.brief}</span>
                      </span>
                      {selected.has(skill.id) && <span className="skill-picker__added" aria-label={t('skillPicker.pendingLoad')}><Sym name="check" /></span>}
                    </ListBox.Item>)}
                  </ListBox>
                  : groups.filter((group) => group.items.length > 0).map((group) => <section key={group.key} aria-labelledby={`${id}-${group.key}`}>
                    <h3 className={showGroupLabels ? 'skill-picker__group-heading' : 'sr-only'} id={`${id}-${group.key}`}>{group.label}</h3>
                    <div className="skill-picker__list">
                      {group.items.map((skill) => <Checkbox key={skill.id} className="skill-picker__item"
                        isSelected={selected.has(skill.id)} onChange={(checked) => toggle(skill.id, checked)}
                        isDisabled={!ready || (explicit && !scope.has(skill.id) && !selected.has(skill.id))}
                        aria-label={skill.title} aria-describedby={`${id}-desc-${skill.id}`}
                        data-testid="skill-scope-item" data-skill-name={skill.name}>
                        <Checkbox.Content className="skill-picker__content">
                          <span className="skill-picker__icon"><Sym name={skill.icon} /></span>
                          <span className="skill-picker__text" title={skill.summary || undefined}>
                            <Label className="skill-picker__name">{skill.title}</Label>
                            {explicit && !scope.has(skill.id) && <span className="skill-picker__dependency">{t('skillPicker.outOfScope')}</span>}
                            <span className="skill-picker__dependency skill-picker__summary" id={`${id}-desc-${skill.id}`}>{skill.summary}</span>
                            {!!skill.mcpRequired?.length && <span className="skill-picker__dependency">{t('skillPicker.requiresMcp', { names: skill.mcpRequired.join(', ') })}</span>}
                          </span>
                          <Checkbox.Control className="skill-picker__control"><Checkbox.Indicator data-testid="skill-scope-check" /></Checkbox.Control>
                        </Checkbox.Content>
                      </Checkbox>)}
                    </div>
                  </section>)}
              </div>
              {open && !explicit && onMcpChange ? <McpScope value={mcpValue} onChange={onMcpChange} /> : null}
            </div>

            {explicit ? <div className="skill-picker__shortcut">{t('skillPicker.shortcut')}</div> : <div className="skill-picker__footer">
              <Button variant="tertiary" size="sm" isIconOnly={explicit} aria-label={t('skillPicker.manage')} onPress={manage} data-testid="skill-picker-manage"><Sym name="settings" />{!explicit && t('skillPicker.manage')}</Button>
              {onTurnChange && <Button size="sm" variant="tertiary" data-testid="skill-picker-advanced" onPress={() => { setTab(explicit ? 'scope' : 'turn'); setQuery(''); }}>{t(explicit ? 'skillPicker.scopeTab' : 'skillPicker.backToUse')}</Button>}
              <Button variant="primary" size="sm" data-testid="skill-picker-done" onPress={() => setOpen(false)}>{t('skillPicker.done')}</Button>
            </div>}
          </Popover.Dialog>
    </Popover.Content>
  </Popover>;
}
