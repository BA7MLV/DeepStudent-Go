import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, ListBox, Popover, SearchField, Switch } from '@heroui/react';
import { Header } from 'react-aria-components';
import {
  slotLabel,
  catalogOf,
  modelOverridesOf,
  providersForSlot,
  sameRef,
  type ModelSlot,
  type Provider,
  type Settings,
} from '../../../store/settings';
import { guessContextWindow, isVisionModel, supportsThinking } from '../../../api/modelCaps';
import { getModelMeta, type ModelOverrides } from '../../../api/modelMeta';
import { modelLabel, modelsForSlot } from '../../../store/modelLibrary';
import { providerCatalogId } from '../../../store/providerPresets';
import { formatModelTokens } from '../../../api/modelPresentation';
import type { ModelSettingsIssue } from '@wangke/contracts/model-settings';
import { modelIssueMessage } from '../../../cloud/modelSettings';
import { Sym, toast } from '../../../ui';
import type { ModelFieldName } from '../shared';
import { CapBadges } from './CapBadges';
import { ModelOptionRow } from './ModelOptionRow';
import { DismissOnOutsidePress } from './DismissOnOutsidePress';
import { useModelSettings } from '../modelSettingsContext';

const ASR_MODEL_RE = /asr|whisper|sensevoice|xingchen/i;

/**
 * 各槽位的相关性启发式：相关模型在列表中置顶。**只影响排序**，不决定谁能进这个槽位。
 *
 * 带 catalogId 是因为能力判断必须按供应商查（同一模型 id 在别家可能不支持视觉/思考）。
 */
const SLOT_RELEVANT: Record<ModelSlot, (catalogId: string, id: string, overrides?: ModelOverrides) => boolean> = {
  chat: (cat, id, overrides) => supportsThinking(cat, id, overrides) || isVisionModel(cat, id, overrides),
  vision: (cat, id, overrides) => isVisionModel(cat, id, overrides),
  // ASR 只能靠名字猜 —— models.dev 的 modalities.input 里有 'audio'，但那含 TTS，
  // 而 /audio/transcriptions 只认 ASR 模型，两者在数据上区分不开。这里仍按名字排，
  // 但真正的准入只看具体模型保存的用途，不限制供应商。
  asr: (_cat, id) => ASR_MODEL_RE.test(id),
  decision: (cat, id, overrides) => getModelMeta(cat, id, overrides)?.type === 'decision',
};

/** 槽位 → 图标。三个槽位并排出现时，图标是唯一能一眼分开它们的东西 */
const SLOT_ICON: Record<ModelSlot, ReactNode> = {
  chat: <Sym name="neurology" />,
  vision: <Sym name="visibility" />,
  asr: <Sym name="mic" />,
  decision: <Sym name="account_tree" />,
};

/** 槽位 → 一句话说明它负责什么。放在槽位名下，替代原来分散在各处的长 hint */
const SLOT_HINT_KEY: Record<ModelSlot, 'models.slotHint.chat' | 'models.slotHint.vision' | 'models.slotHint.asr' | 'models.slotHint.decision'> = {
  chat: 'models.slotHint.chat',
  vision: 'models.slotHint.vision',
  asr: 'models.slotHint.asr',
  decision: 'models.slotHint.decision',
};

const SLOT_ORDER: readonly ModelSlot[] = ['chat', 'vision', 'asr', 'decision'];

/**
 * 一个槽位绑定的模型。
 *
 * 形态取自 Pi agent 的模型选择器：一张**整行可点**的大按钮直接显示
 * 「模型名 + 能力 + 窗口」，点开才是检索面板。**为什么不给自由输入框**：
 * 旧版是「输入框 + 选择按钮」两个控件，输入框在前、下拉在后 —— 用户会先看到那个
 * 看起来能随便填的输入框，于是去手抄模型 id，而抄错一个字符要到运行时才报 404。
 * 检索面板把「有哪些」摆在「选哪个」前面，手抄的路径仍然保留（面板底部的
 * 「手动填写」），但不再是默认视线落点。
 */
export function SlotModelSelect({
  name,
  slot,
  settings,
  options,
  issue,
}: {
  name: ModelFieldName;
  slot: ModelSlot;
  settings: Settings;
  /** 该槽位候选供应商各自拉到的在架模型（key = provider id） */
  options: Record<string, string[]>;
  issue?: ModelSettingsIssue;
}) {
  const { t } = useTranslation('settings');
  const ref = settings[name];
  const update = useModelSettings((s) => s.update);
  const provider = settings.providers.find((p) => p.id === ref.providerId);
  const [kw, setKw] = useState('');
  const [open, setOpen] = useState(false);
  // 面板是 fixed 定位的，React Aria 要靠触发元素的 ref 才能算出「贴在按钮下方」。
  // 之前按钮是 Popover.Trigger（自带 ref），换成自己的 <button> 后必须自己传，
  // 否则面板会停在 (0,0) 且被 clip 掉 —— DOM 里有、屏幕上看不见。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const favs = settings.favorites[slot];
  const catalogId = catalogOf(settings, ref.providerId);

  // 选了模型就顺手关面板：这是「选完即完成」的动作，留着面板挡住下面的运行参数
  useEffect(() => {
    if (open) setOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ref.model, ref.providerId]);

  /**
   * 面板一打开就把光标放进检索框。
   *
   * 模态浮层时这件事是 react-aria 干的（非模态不干，见下面的 isNonModal 注释），
   * 而面板里的 `Popover.Dialog` 是 RAC 的 Dialog —— 它打开时会把焦点接到自己身上
   * （`tabIndex=-1` 的容器），所以光标停在面板边框而不是输入框里。
   * 子组件的 effect 先跑、这个父级 effect 后跑，所以这里 focus 能压过它。
   */
  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector('input')?.focus({ preventScroll: true });
  }, [open]);

  /** 只列已添加该用途模型的供应商；保留当前选择，便于修正旧配置。 */
  const candidates = useMemo(() => {
    const list = providersForSlot(settings, slot);
    if (!list.some((p) => p.id === ref.providerId) && provider) return [provider, ...list];
    return list;
  }, [settings, slot, ref.providerId, provider]);

  const relevant = SLOT_RELEVANT[slot];
  const needle = kw.trim().toLowerCase();
  const isFav = (p: Provider, m: string) => favs.some((x) => x.providerId === p.id && x.model === m);

  /**
   * 选中一个模型：供应商与模型 id 一次性写进同一次 update。
   *
   * ⚠️ 这里**不能**再调一次「切供应商」的回调去做 providerId 的修正 ——
   * 那个回调读的是本次渲染的 `settings` 快照（模型还是旧的），
   * 于是它的 update 会把刚选中的模型又写回旧值：
   * 用户点一条候选，面板关掉了、界面纹丝不动，看起来就是「点了没反应」。
   * （反过来，先改供应商再选模型又是同一个坑的另一头。）
   * 供应商与模型本来就该在一次写入里一起改，所以这里一次写完。
   */
  const setModel = (providerId: string, model: string) => {
    if (!model) return;
    const patch: Partial<Settings> = { [name]: { providerId, model } };
    if (name === 'llmModel') {
      patch.contextWindow = guessContextWindow(catalogOf(settings, providerId), model, modelOverridesOf(settings, { providerId, model }));
    }
    update(patch);
  };

  const toggleFavorite = (providerId: string, model: string) => {
    const entry = { providerId, model };
    const on = isFav({ id: providerId } as Provider, model);
    update({
      favorites: {
        ...settings.favorites,
        [slot]: on
          ? favs.filter((x) => !sameRef(x, entry))
          : [...favs.filter((x) => !sameRef(x, entry)), entry],
      },
    });
  };

  /** 分组：收藏优先置顶（Pi 的 /model 也是收藏先列），其余按供应商分组 */
  const groups = candidates.map((p) => {
    const catalogId = providerCatalogId(p);
    const ids = Array.from(
      new Set(
        modelsForSlot(settings, slot).filter((m) => m.providerId === p.id).map((m) => m.model).filter(
           (id) => !needle || `${id} ${modelLabel(settings, { providerId: p.id, model: id })} ${p.name}`.toLowerCase().includes(needle),
        ),
      ),
    ).sort((a, b) => Number(relevant(catalogId, b, modelOverridesOf(settings, { providerId: p.id, model: b }))) - Number(relevant(catalogId, a, modelOverridesOf(settings, { providerId: p.id, model: a }))));
    return { provider: p, ids };
  });
  const favRows = candidates.flatMap((p) =>
    favs
      .filter((f) => f.providerId === p.id && (!needle || f.model.toLowerCase().includes(needle)))
      .map((f) => ({ provider: p, id: f.model })),
  );
  // 收藏夹里指向已删供应商或已取消模型用途的项仍保留，便于用户处理。
  const orphanFavs = favs.filter(
    (f) => !candidates.some((p) => p.id === f.providerId) && (!needle || f.model.toLowerCase().includes(needle)),
  );

  const totalResults = favRows.length + orphanFavs.length + groups.reduce((n, g) => n + g.ids.length, 0);

  return (
    <div data-model-field={name} className={`model-slot flex min-w-0 flex-col gap-3 rounded-panel bg-background-secondary p-4 ${issue ? 'ring-1 ring-danger' : ''}`}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-background text-[17px] text-muted" aria-hidden="true">
          {SLOT_ICON[slot]}
        </span>
        <div className="flex-1 min-w-0">
          <div id={`model-label-${name}`} className="text-sm font-semibold leading-tight text-foreground">{slotLabel(slot)}</div>
          <div id={`model-hint-${name}`} className="mt-1 text-xs leading-relaxed text-muted">{t(SLOT_HINT_KEY[slot])}</div>
        </div>
      </div>

      {slot === 'vision' && !ref.model ? <p className="text-xs text-muted">主模型无图片输入能力或能力未知时，自动使用已添加且已配置凭据的图片理解模型。请先添加读图模型并勾选「图片理解」用途；不会按模型名称猜测能力，也不会静默忽略图片。</p> : <>
      {(
        // 受控用法（isOpen + onOpenChange），不用 Popover.Trigger。
        //
        // 为什么绕开 Trigger：HeroUI v3 的 Popover.Trigger 渲染成
        // <Pressable><div role="button" /></Pressable>，而 Pressable 自己调 usePress
        // 把 press 事件合到 children 上；DialogTrigger 注入的 onPress 则走 props，
        // 两者互相覆盖，结果 onPress 永远不触发 —— 点这个按钮面板弹不出来
        // （控制台会刷 "A PressResponder was rendered without a pressable child"）。
        // Select.Trigger 没这问题，因为它渲染的是真正的 <button>。
        //
        // 所以这里自己画一个原生 <button>，点击行为由 DOM 保证，稳。
        //
        // ⚠️ `isNonModal` 不是可选项：RAC 的浮层默认是**模态**的，展开时会给
        // 「它之外的一切」打 `inert`（react-aria 的 ariaHideOutside，shouldUseInert）。
        // 这个面板就开在设置弹窗里，于是被打中 inert 的正好是整块 `.react-aria-ModalOverlay`
        // —— 表现是：面板弹出来了，但设置面板（含左侧模块列）整块点不动，
        // 键盘也过不去，只能刷新页面。这正是「设置页面根本点不动」的成因。
        //
        // 打上 isNonModal 后走 react-aria 的 keepVisible 分支，一个 inert 都不加；
        // Esc 仍然能关（isKeyboardDismissDisabled 与 isNonModal 无关）。
        // 代价是「点外面自动收起」不再由 react-aria 代劳 —— 那是 isDismissable 管的，
        // 而 usePopover 把 isDismissable 写死成 `!isNonModal`。
        // 所以补一个 DismissOnOutsidePress 把这件事接回来，检索框也改为自己拿焦点
        // （模态时是 react-aria 把焦点丢给面板首帧，非模态下它不再管这件事）。
        <Popover isOpen={open} onOpenChange={setOpen}>
          <button
            ref={triggerRef}
            type="button"
             className="model-slot__trigger box-border flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl border border-border bg-background px-3 py-2 text-left font-[inherit] text-foreground hover:border-accent/45 focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-2 aria-expanded:border-accent/55"
            data-testid={`model-button-${name}`}
            aria-label={t('models.pickSlot', { slot: slotLabel(slot), model: ref.model || t('models.unset') })}
            aria-expanded={open}
             aria-haspopup="dialog"
             aria-invalid={Boolean(issue) || undefined}
             aria-describedby={`model-hint-${name}${issue ? ` model-error-${name}` : ''}`}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="flex flex-1 min-w-0 flex-col items-start gap-1">
              {ref.model ? (
                <>
                  <span className="w-full truncate text-sm font-medium" title={ref.model}>{modelLabel(settings, ref)}</span>
                  <span className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                    <span className="min-w-0 max-w-full truncate">{provider?.name ?? t('models.providerGone')}</span>
                    <CapBadges catalogId={catalogId} model={ref.model} overrides={modelOverridesOf(settings, ref)} />
                  </span>
                </>
              ) : (
                <span className="truncate text-[13px] text-muted">选择供应商与模型…</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-2 text-[13px] text-muted">
              <span className="text-xs tabular-nums text-muted">
                {ref.model ? formatModelTokens(getModelMeta(catalogId, ref.model, modelOverridesOf(settings, ref))?.declaredContext) : ''}
              </span>
              <Sym name="keyboard_arrow_down" />
            </span>
          </button>
          {/* 非模态浮层不再自带「点外面收起」，这里接回来。
              pointerdown 比 click 早：按下那一刻就知道该关，不用等 mouseup。 */}
          {open && <DismissOnOutsidePress triggerRef={triggerRef} onDismiss={() => setOpen(false)} />}
          <Popover.Content
            className="model-picker-popover overflow-hidden rounded-xl border border-border bg-overlay p-0 text-foreground shadow-xl"
            placement="bottom start"
            triggerRef={triggerRef}
            isNonModal
            // DismissOnOutsidePress 靠这个属性认出「面板本体」，
            // 比按 HeroUI 的 .popover 类名匹配稳（类名会随版本改）。
            data-model-picker={name}
            ref={panelRef}
            style={{
              width: 'min(34rem, calc(100vw - 3rem))',
            }}
          >
            {/**
             * 高度上限挂在 **Dialog** 上，不挂在浮层上。
             *
             * RAC 的 `Popover` 会把「可用空间」算好、以**行内** `max-height` 写回浮层元素，
             * 于是 `Popover.Content` 的 `style.maxHeight` 会被它静默覆盖（实测传给它的
             * `min(28rem, calc(100dvh - 8rem))` 被换成了 589px）。行内样式压不过，
             * 只能换个元素挂。
             *
             * `overflow-hidden` + `flex-col` + ListBox 的 `min-h-0` 三者缺一不可：
             * 少了 `overflow-hidden` 面板就不会裁剪，列表会**整条溢出到浮层外面**
             * （40 个模型时列表高 1467px、浮层只有 589px），那内容是滚不到的 ——
             * 这正是「选择模型这里没有办法滚动」的成因。
             */}
            <Popover.Dialog
              className="flex min-h-0 flex-col gap-0 overflow-hidden"
              style={{ maxHeight: 'min(28rem, calc(100dvh - 8rem))' }}
            >
              <SearchField
                aria-label={t('models.filterSlot', { slot: slotLabel(slot) })}
                data-testid={`model-search-${name}`}
                value={kw}
                onChange={(v) => setKw(v)}
              >
                <SearchField.Group className="px-3 py-3 pb-2">
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder={t('models.searchProviders', { count: candidates.length })} />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>

              <ListBox
                className="min-h-0 overflow-y-auto overscroll-contain px-0 py-0"
                aria-label={t('models.slotCandidates', { slot: slotLabel(slot) })}
                selectionMode="none"
                // 这里**刻意不挂** onAction：选中逻辑在每个 ModelOptionRow 上（它手里
                // 已经有 provider 对象，直接就能拿到 id 与名字）。
                // 从 key 反解是走不通的 —— 收藏分组的 id 带 `fav::` 前缀，
                // 按第一个 `::` 切会把「fav」当成供应商 id；而两段都挂着时
                // 反解那次会晚于行内那次执行，把刚选中的模型又覆盖回旧值。
              >
                {favRows.length > 0 && (
                  <ListBox.Section>
                    {/* 分组头必须是 react-aria-components 的 Header，不能用普通 div。
                        ListBoxSection 靠遍历 children 建collection 树，遇到非 collection
                        节点就走错分支，React 会在 commit 阶段抛
                        "getOwnerDocumentFromRootContainer(...).createTextNode is not a function"，
                        整棵树崩掉 —— 面板打不开、截图全白，只有列表为空时才看不出问题。 */}
                    <Header className="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-2 pb-1 text-[11px] font-semibold tracking-wide text-muted" data-testid={`fav-group-${slot}`}>
                      <Sym name="star" filled />
                      收藏
                    </Header>
                    {favRows.map(({ provider, id }) => (
                      <ModelOptionRow
                        key={`fav::${provider.id}::${id}`}
                        slot={slot}
                        providerId={provider.id}
                        providerName={provider.name}
                        model={id}
                        catalogId={providerCatalogId(provider)}
                        catalogKnown={providerCatalogId(provider).trim().length > 0}
                        selected={sameRef({ providerId: provider.id, model: id }, ref)}
                        favorite={true}
                        label={modelLabel(settings, { providerId: provider.id, model: id })}
                        onSelect={() => setModel(provider.id, id)}
                        onToggleFavorite={() => toggleFavorite(provider.id, id)}
                        idPrefix="fav::"
                      />
                    ))}
                  </ListBox.Section>
                )}

                {orphanFavs.length > 0 && (
                  <ListBox.Section>
                    <Header className="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-2 pb-1 text-[11px] font-semibold tracking-wide text-danger" data-testid={`orphan-group-${slot}`}>
                      <Sym name="warning" />
                      收藏里指向已不可用的供应商
                    </Header>
                    {orphanFavs.map((f) => (
                      <ModelOptionRow
                        key={`orphan::${f.providerId}::${f.model}`}
                        slot={slot}
                        providerId={f.providerId}
                        providerName={
                          t('models.favoriteUnavailable', { provider: settings.providers.find((p) => p.id === f.providerId)?.name ?? f.providerId })
                        }
                        model={f.model}
                        catalogId=""
                        catalogKnown={false}
                        selected={sameRef(f, ref)}
                        favorite={true}
                        onSelect={() => toast.warning(t('models.restoreProviderFirst'))}
                        onToggleFavorite={() => toggleFavorite(f.providerId, f.model)}
                        idPrefix="orphan::"
                      />
                    ))}
                  </ListBox.Section>
                )}

                {groups.map(({ provider, ids }) =>
                  ids.length > 0 ? (
                    <ListBox.Section key={provider.id}>
                      <Header className="sticky top-0 z-[1] flex items-center gap-2 bg-surface px-3 py-2 pb-1 text-[11px] font-semibold tracking-wide text-muted">
                        {provider.name}
                        <span className="font-normal tabular-nums opacity-75">{ids.length}</span>
                      </Header>
                      {ids.map((id) => (
                        <ModelOptionRow
                          key={`${provider.id}::${id}`}
                          slot={slot}
                          providerId={provider.id}
                          providerName={provider.name}
                          model={id}
                          catalogId={providerCatalogId(provider)}
                          catalogKnown={providerCatalogId(provider).trim().length > 0}
                          selected={sameRef({ providerId: provider.id, model: id }, ref)}
                          favorite={isFav(provider, id)}
                          label={modelLabel(settings, { providerId: provider.id, model: id })}
                          onSelect={() => setModel(provider.id, id)}
                          onToggleFavorite={() => toggleFavorite(provider.id, id)}
                        />
                      ))}
                    </ListBox.Section>
                  ) : null,
                )}
              </ListBox>

              <div className="flex items-center justify-between gap-2 border-t border-border/70 px-3 py-3">
                {totalResults === 0 ? (
                  <span className="min-w-0 truncate text-xs text-muted">
                    {Object.keys(options).length === 0
                      ? t('models.enterProviderFirst')
                      : t('models.noMatchModels')}
                  </span>
                ) : (
                  <span className="min-w-0 truncate text-xs text-muted">{totalResults} 个模型</span>
                )}
                {totalResults > 0 && <span className="text-xs text-muted">在供应商详情中添加和编辑</span>}
              </div>
            </Popover.Dialog>
          </Popover.Content>
        </Popover>
      )}
      </>}
      {slot === 'vision' ? <Switch
        className="model-slot__auto"
        aria-label={t('models.autoVision')}
        isSelected={!ref.model}
        onChange={(on) => {
          const first = modelsForSlot(settings, 'vision')[0];
          if (!on && !first) { toast.warning(t('models.addVisionFirst')); return; }
          update({ visionModel: on ? { providerId: '', model: '' } : { providerId: first.providerId, model: first.model } });
        }}
      ><Switch.Content><span>{t('models.autoVision')}</span><Switch.Control><Switch.Thumb /></Switch.Control></Switch.Content></Switch>
        : ref.model && <Button variant="tertiary" className="model-slot__clear self-start" onPress={() => update({ [name]: { providerId: '', model: '' } })}>{slot === 'decision' ? t('models.noDecision') : t('models.clearSelection')}</Button>}
      {issue && <p id={`model-error-${name}`} role="alert" className="text-xs text-danger">{modelIssueMessage(issue)}</p>}
    </div>
  );
}
