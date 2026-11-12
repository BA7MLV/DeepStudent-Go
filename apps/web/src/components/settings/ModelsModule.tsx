import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Checkbox,
  Chip,
  Input,
  ListBox,
  Popover,
  SearchField,
  Select,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { Header } from 'react-aria-components';
import {
  slotLabel,
  catalogOf,
  nextProviderId,
  modelOverridesOf,
  providersForSlot,
  sameRef,
  type ApiProtocol,
  type ModelSlot,
  type Provider,
  type Settings,
} from '../../store/settings';
import { useProviderModels, type DiscoveryProvider } from '../../utils/useProviderModels';
import {
  guessContextWindow,
  isVisionModel,
  supportsThinking,
} from '../../api/modelCaps';
import { UNLIMITED_ROUNDS } from '../../harness/loopGuard';
import { getModelMeta, isModelMetaStale, modelMetaInfo, refreshModelMeta, type ModelOverrides } from '../../api/modelMeta';
import { IconSwap, MotionDisclosure, ms } from '../motion';
import { confirmDialog, Field, LoadingButton, SectionCard, Sym, toast } from '../../ui';
import { ALL_SLOTS, refKey, type ModelFieldName } from './shared';
import ContextCompressionCard from './ContextCompressionCard';
import ModelLibrary from './ModelLibrary';
import PromptCacheUsage from './PromptCacheUsage';
import { modelLabel, modelsForSlot, savedModelsOf } from '../../store/modelLibrary';
import { ModelCapabilities } from '../ModelCapabilities';
import { useModelMetaRevision } from '../../utils/useModelMeta';
import { formatModelTokens } from '../../api/modelPresentation';
import { createPresetProvider, getProviderPresets, matchesProviderPreset, providerCatalogId, type ProviderPreset } from '../../store/providerPresets';
import ProviderPresets, { ProviderLogo } from './ProviderPresets';
import { useSettingsDialog } from '../settingsDialogStore';
import { useModelSettings, useModelSettingsStore } from './modelSettingsContext';
import { MODEL_FIELDS, type ModelSettingsIssue } from '@wangke/contracts/model-settings';
import { modelIssueMessage } from '../../cloud/modelSettings';
import './model-settings.css';

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

/** 上下文窗口的紧凑写法：128000 → 128K，1048576 → 1M。列表里每行都要显示，太长会挤掉模型名 */
/** 能力徽标：多模态 / 可思考。模型 id 长的行里这两枚最占地方，所以做成小圆角标签 */
function CapBadges({ catalogId, model, overrides }: { catalogId: string; model: string; overrides?: ModelOverrides }) {
  return <ModelCapabilities catalogId={catalogId} model={model} overrides={overrides} compact />;
}

/**
 * 供应商列表里的一行模型（Pi 的 /model 面板就是这个结构）。
 *
 * 一行 = 一个「供应商 + 模型」组合，所以**供应商名必须印出来**：`Qwen/Qwen3` 在两家
 * 都可能存在，只显示模型 id 没法分辨自己收藏的是哪一家的。右侧再跟上下文窗口，
 * 因为选模型时最关心的就是「它能记多少」。
 */
function ModelOptionRow({
  providerId,
  providerName,
  model,
  catalogId,
  selected,
  favorite,
  label,
  onSelect,
  onToggleFavorite,
  slot,
  idPrefix,
}: {
  /** 供应商 id。写进行 id 而不是只写名字：`id` 是唯一键，两家重名会撞（见上面的说明） */
  providerId: string;
  providerName: string;
  model: string;
  catalogId: string;
  /** false = 没填 models.dev key，上下文窗口只能按名字猜，得标出来 */
  catalogKnown: boolean;
  selected: boolean;
  favorite: boolean;
  label?: string;
  onSelect: () => void;
  onToggleFavorite: () => void;
  slot: ModelSlot;
  /**
   * id 前缀。收藏分组里的项和供应商分组里的项可能是同一个模型（收藏是置顶
   * 而不是搬家），两处 id 撞了 React Aria 会抛 Duplicate key。
   */
  idPrefix?: string;
}) {
  const { t } = useTranslation('settings');
  const favTestId = `fav-${slot}-${providerName}-${model}`;
  const overrides = useModelSettings((s) => modelOverridesOf(s, { providerId, model }));
  // 星标放在 ListBox.Item **内部**：Item 是 React Aria collection 的成员，
  // 在外面另起一个 <div> 会让 collection 遍历到非collection 节点，行为不可预期。
  return (
    <ListBox.Item
      // 用 '::' 而不是 '\0' 分隔：ListBox.Item 的 id 会被 React Aria 直接写进
      // DOM 的 id 属性，而 NUL 是 XML/HTML 明确不允许出现在属性值里的字符 ——
      // 列表一有内容，React 就会在 commit 阶段抛
      // "getOwnerDocumentFromRootContainer(...).createTextNode is not a function"，
      // 整棵树崩掉（空列表时因为没有 Item 所以看不出来）。
      // 模型 id 里不会出现连续两个冒号，用它分隔足够安全。
      //
      // 左半段必须是**供应商 id**（不是名字）：名字允许重名，当唯一键会把两家同名的
      // 候选挤成一条；而且供应商下拉认的是 id，认名字等于指向一家不存在的供应商。
      id={`${idPrefix ?? ''}${providerId}::${model}`}
      textValue={label || model}
      data-testid={`model-option-${model}`}
      className="relative flex flex-1 min-w-0 items-center gap-4 rounded-sm pr-10"
      onAction={onSelect}
    >
      <span className="flex flex-1 min-w-0 items-center gap-2">
        <span className="truncate font-mono text-[13px]" title={model}>{label || model}</span>
        {selected && <Sym name="check" />}
        <CapBadges catalogId={catalogId} model={model} overrides={overrides} />
      </span>
      <span className="flex shrink-0 items-baseline gap-3 text-[11px] text-muted">
        <span className="max-w-[120px] truncate text-right">{providerName}</span>
        <span
          className="min-w-12 text-right tabular-nums"
        >
          {formatModelTokens(getModelMeta(catalogId, model, overrides)?.declaredContext)}
        </span>
      </span>
      <span
        className={`absolute top-1/2 right-2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full border-0 bg-transparent text-base text-muted transition-opacity duration-200 cursor-pointer ${favorite ? 'opacity-100 text-accent' : 'opacity-60 hover:bg-foreground/8'} `}
        data-fav={favorite ? 'true' : 'false'}
        data-testid={favTestId}
        role="button"
        tabIndex={-1}
        aria-label={favorite ? t('models.unfavorite', { model }) : t('models.favorite', { model })}
        onClick={(event) => {
          // 星标在 Item 内部，靠阻止冒泡避免顺手把模型也选中
          event.stopPropagation();
          onToggleFavorite();
        }}
      >
        <IconSwap a={<Sym name="star" />} b={<Sym name="star" filled />} active={favorite ? 'b' : 'a'} />
      </span>
    </ListBox.Item>
  );
}

/**
 * 「按下就收起」：面板 / 触发按钮之外的任意一次 pointerdown 都要关掉面板。
 *
 * 为什么需要自己写：模型检索面板打了 `isNonModal`（理由见 SlotModelSelect 里的注释），
 * 而 react-aria 的「点外面关闭」挂在 `isDismissable` 上，`usePopover` 把后者写死成
 * `!isNonModal` —— 也就是说，非模态浮层在这一层上没有任何自动收起。
 * Esc 仍然有效（走 `isKeyboardDismissDisabled`，与 isNonModal 无关）。
 *
 * 为什么用 pointerdown 而不是 click：click 要等 mouseup，按下时目标可能已经变了；
 * 而且按下即关能给用户「点空了」的即时反馈，不用等一次完整的按下-抬起。
 *
 * 挂在冒泡阶段而不是捕获阶段：捕获阶段里把面板从 DOM 里摘掉，中途还在传播的这次
 * 点击有可能落空（尤其当目标正好在被移除的子树里）。
 */
function DismissOnOutsidePress({
  triggerRef,
  onDismiss,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const handle = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // 面板本体（data-model-picker）与触发按钮之外的按下都算「点外面」
      if (target instanceof Element && target.closest('[data-model-picker]')) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [onDismiss, triggerRef]);
  return null;
}

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
function SlotModelSelect({
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
      {slot === 'vision' ? <Checkbox
        className="model-slot__auto"
        aria-label={t('models.autoVision')}
        isSelected={!ref.model}
        onChange={(on) => {
          const first = modelsForSlot(settings, 'vision')[0];
          if (!on && !first) { toast.warning(t('models.addVisionFirst')); return; }
          update({ visionModel: on ? { providerId: '', model: '' } : { providerId: first.providerId, model: first.model } });
        }}
      ><Checkbox.Content><Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>自动：优先主模型，否则使用读图模型</Checkbox.Content></Checkbox>
        : ref.model && <Button variant="tertiary" className="model-slot__clear self-start" onPress={() => update({ [name]: { providerId: '', model: '' } })}>{slot === 'decision' ? t('models.noDecision') : t('models.clearSelection')}</Button>}
      {issue && <p id={`model-error-${name}`} role="alert" className="text-xs text-danger">{modelIssueMessage(issue)}</p>}
    </div>
  );
}

/**
 * 一家供应商：折叠时一行摘要，展开才编辑凭据。
 *
 * 为什么默认折叠：这是「配一次就长期不动」的配置，四个输入框常驻会让模型选择器
 * （真正需要反复操作的那部分）被推到屏幕外。摘要行已经把要紧的信息全给了 ——
 * 名字、连接状态与模型数量；常用端点无需重复配置地址和协议。
 */
function ProviderRow({
  provider,
  others,
  note,
  status,
  modelCount,
  open,
  onToggle,
  onChange,
  onRemove,
  removable,
  shaking,
  customConnection = false,
  serverManaged = false,
  accountContent,
  children,
}: {
  provider: Provider;
  others: readonly Provider[];
  note?: string;
  status: 'ready' | 'unconfigured' | 'failed' | 'unchecked' | 'draft';
  modelCount: number | null;
  open: boolean;
  onToggle: () => void;
  onChange: (patch: Partial<Provider>) => void;
  onRemove: () => void;
  removable: boolean;
  shaking: boolean;
  customConnection?: boolean;
  serverManaged?: boolean;
  accountContent?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation('settings');
  const inputRef = useRef<HTMLDivElement>(null);
  const [dupName, setDupName] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showConnection, setShowConnection] = useState(open || !provider.apiKey.trim() || !provider.baseUrl.trim());

  // 与其他家重名时提示：模型选型都按供应商名显示，重名会让设置与面板都对不上是哪一家
  useEffect(() => {
    setDupName(others.some((p) => p.name.trim() === provider.name.trim()));
  }, [provider.name, others]);

  // key 缺失时的抖动。动画通过内联 style 驱动，不依赖 .t-input / .is-shaking 类名。
  useEffect(() => {
    if (!shaking) return;
    setShowConnection(true);
    const el = inputRef.current;
    if (!el) return;
    el.style.animation = 'none';
    void el.offsetWidth;
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    el.style.animation = `t-input-shake ${shakeMs}ms linear`;
    const t = window.setTimeout(() => {
      if (el) el.style.animation = 'none';
    }, shakeMs + 20);
    return () => clearTimeout(t);
  }, [shaking]);

  const STATUS_HINT: Record<typeof status, 'models.status.draft' | 'models.status.ready' | 'models.status.unchecked' | 'models.status.failed' | 'models.status.unconfigured'> = {
    draft: 'models.status.draft',
    ready: 'models.status.ready',
    unchecked: 'models.status.unchecked',
    failed: 'models.status.failed',
    unconfigured: 'models.status.unconfigured',
  };

  const preset = getProviderPresets().find((p) => matchesProviderPreset(provider, p));
  const showEndpoint = customConnection || !preset;

  const statusColor =
    status === 'ready'
      ? 'text-success'
      : status === 'failed' || status === 'unconfigured'
        ? 'text-danger'
        : 'text-muted';

  return (
    <div
      className={`ui-smooth relative overflow-hidden rounded-panel border border-border/80 bg-background-secondary transition-shadow ${open ? 'border-accent/45 bg-background shadow-md' : 'min-h-[218px] hover:shadow-sm max-[640px]:min-h-[150px]'}`}
      data-testid={`provider-card-${provider.id}`}
      data-open={open ? 'true' : undefined}
    >
      <button
        type="button"
        className={`box-border flex w-full cursor-pointer flex-col items-stretch gap-5 border-0 bg-transparent p-4 text-left font-[inherit] text-foreground transition-colors duration-200 hover:bg-foreground/4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus max-[640px]:gap-3 ${open ? 'min-h-[96px]' : 'min-h-[218px] max-[640px]:min-h-[150px]'}`}
        data-testid={`provider-summary-${provider.id}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="grid size-16 shrink-0 place-items-center rounded-xl bg-background text-3xl text-foreground shadow-sm max-[640px]:size-9 max-[640px]:text-lg" aria-hidden="true">
            {preset ? <ProviderLogo id={preset.id} /> : <Sym name="dns" />}
          </span>
          {status !== 'ready' && <span className={`max-w-full truncate rounded-full px-3 py-1 text-xs font-medium max-[640px]:px-2 max-[640px]:py-1 max-[640px]:text-[9px] ${removable ? 'mr-10 max-[640px]:mr-9' : ''} ${statusColor} ${status === 'failed' || status === 'unconfigured' ? 'bg-danger/12' : 'bg-foreground/8'}`}>
            {t(STATUS_HINT[status])}
          </span>}
        </span>
        <span className="flex min-w-0 flex-1 flex-col justify-end gap-1">
          <span className="flex min-w-0 items-center gap-2 text-lg font-semibold text-foreground max-[640px]:text-xs">
            <span className="truncate">{provider.name.trim() || t('models.unnamedProvider')}</span>
            {status === 'ready' && <span className="inline-flex shrink-0 items-center text-success" title={t(STATUS_HINT[status])} data-testid={`provider-ready-${provider.id}`}>
              <Sym name="check_circle" size={18} />
              <span className="sr-only">{t(STATUS_HINT[status])}</span>
            </span>}
            {dupName && <Chip size="sm" variant="soft" color="danger" className="h-4 px-1 text-[10px]">重名</Chip>}
          </span>
          {showEndpoint && <span className="truncate font-mono text-xs text-muted max-[640px]:text-[9px]" title={provider.baseUrl}>
            {provider.baseUrl.trim() || t('models.baseUrlUnconfigured')}
          </span>}
        </span>
        <span className="flex items-center gap-2 text-sm text-muted max-[640px]:gap-1 max-[640px]:text-[10px]">
          <Sym name="toc" className="max-[640px]:size-3" />
          <span className="tabular-nums">{modelCount ?? 0}</span>
          <span className="max-[640px]:hidden">个模型</span>
          <span className="ml-auto text-xs text-muted max-[640px]:hidden">{open ? t('models.details') : t('models.enter')}</span>
        </span>
      </button>
      {removable && (
        <Button
          variant="ghost"
          isIconOnly
          size="sm"
          className="absolute top-4 right-4 text-muted hover:text-danger max-[640px]:top-2 max-[640px]:right-2"
          data-testid={`provider-remove-${provider.id}`}
          onPress={onRemove}
          aria-label={t('models.deleteProvider', { name: provider.name || provider.id })}
        >
          <Sym name="delete" />
        </Button>
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-border/70 px-5 pt-4 pb-5">
          <MotionDisclosure open={showConnection} onOpenChange={setShowConnection}
            title={showEndpoint ? t('models.connectionSettingsFull') : t('models.connectionSettings')} triggerClassName="py-2 text-sm font-medium">
            <div className="flex flex-col gap-3 pt-3">
          <Field label={t('models.name')}>
            <Input
              value={provider.name}
              data-testid={`provider-name-${provider.id}`}
              aria-label={t('models.providerNameAria')}
              placeholder={t('models.providerNamePlaceholder')}
              aria-invalid={dupName || undefined}
              onChange={(e) => onChange({ name: e.target.value })}
              className="w-full"
            />
          </Field>
          {showEndpoint && <>
          <Field label={t('models.apiBaseUrl')} testId={`field-base-url-${provider.id}`}>
            <Input
              value={provider.baseUrl}
              data-testid={`base-url-${provider.id}`}
              aria-label={t('models.apiBaseUrl')}
              placeholder="https://api.example.com/v1"
              onChange={(e) => onChange({ baseUrl: e.target.value.trim() })}
            />
          </Field>
          <Field label={t('models.apiProtocol')} hint={t('models.apiProtocolHint')}>
            <Select
              aria-label={t('models.providerApiProtocol', { name: provider.name || t('models.unnamedProvider') })}
              selectedKey={provider.protocol ?? 'openai-chat'}
              onSelectionChange={(key) => {
                if (key != null) onChange({ protocol: String(key) as ApiProtocol });
              }}
            >
              <Select.Trigger>
                <Select.Value />
                <Select.Indicator />
              </Select.Trigger>
              <Select.Popover isNonModal>
                <ListBox>
                  <ListBox.Item id="openai-chat" textValue="OpenAI Chat">OpenAI Chat</ListBox.Item>
                  <ListBox.Item id="openai-responses" textValue="OpenAI Responses">OpenAI Responses</ListBox.Item>
                  <ListBox.Item id="anthropic-messages" textValue="Anthropic Messages">Anthropic Messages</ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
          </Field>
          </>}
          <Field
            label="API Key"
            hint={accountContent ? undefined : serverManaged ? t('models.keyHintServer') : status === 'draft' ? t('models.keyHintDraft') : t('models.keyHintLocal')}
            testId={`field-api-key-${provider.id}`}
          >
            {accountContent ?? <div>
              <div
                ref={inputRef}
                className={`rounded-md border transition-colors duration-150 ${shaking ? 'border-danger' : 'border-border'}`}
                style={{ willChange: 'transform' }}
              >
                <div className="flex flex-nowrap items-center gap-2">
                  <Input
                    data-testid={`api-key-${provider.id}`}
                    aria-label={t('models.providerKey', { name: provider.name })}
                    aria-invalid={shaking || undefined}
                    type={showKey ? 'text' : 'password'}
                    placeholder={serverManaged && provider.configured ? t('models.configuredKeep') : 'sk-...'}
                    autoComplete="new-password"
                    value={provider.apiKey}
                    onChange={(e) => onChange({ apiKey: e.target.value.trim() })}
                    className="flex-1 border-0 shadow-none focus-visible:ring-0"
                  />
                  <Button
                    isIconOnly
                    variant="ghost"
                    size="sm"
                    aria-label={showKey ? t('models.hideKey', { name: provider.name }) : t('models.showKey', { name: provider.name })}
                    onPress={() => setShowKey((v) => !v)}
                  >
                    <Sym name={showKey ? 'visibility_off' : 'visibility'} />
                  </Button>
                </div>
              </div>
              <p
                className={`mt-1 text-xs text-danger transition-opacity duration-[280ms] ${shaking ? 'opacity-100 visible' : 'opacity-0 invisible'}`}
                data-testid={`key-error-${provider.id}`}
              >
                请先填写这家供应商的 API Key
              </p>
            </div>}
          </Field>
            </div>
          </MotionDisclosure>
          {note && (
            <div role={status === 'failed' ? 'alert' : 'status'} className="text-xs leading-relaxed text-muted" data-testid={`provider-note-${provider.id}`}>
              {note}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * 「模型」模块。
 *
 * 供应商优先：展开一家后管理连接及其模型，再设置各用途的默认模型和运行参数。
 */
export default function ModelsModule({ serverManaged = false, discoveryProviders, standalone = false, onSaveProvider, providerNeedsSave, onDraftChange, onProviderViewChange, renderProviderAccounts, onAddOpenCodeGo, addOpenCodeGoDisabled = false, issues = [], focusIssue = 0 }: {
  serverManaged?: boolean;
  discoveryProviders?: DiscoveryProvider[];
  standalone?: boolean;
  onSaveProvider?: (provider: Provider) => Promise<void>;
  providerNeedsSave?: (provider: Provider) => boolean;
  onDraftChange?: (editing: boolean) => void;
  /** Tells the cloud editor when a custom provider detail view is active. */
  onProviderViewChange?: (hideModelPresets: boolean) => void;
  renderProviderAccounts?: (provider: Provider) => ReactNode;
  onAddOpenCodeGo?: () => void;
  addOpenCodeGoDisabled?: boolean;
  issues?: ModelSettingsIssue[];
  focusIssue?: number;
} = {}) {
  const { t } = useTranslation('settings');
  const settings = useModelSettings();
  const settingsStore = useModelSettingsStore();
  useModelMetaRevision();
  /** 哪一家的 key 缺失（provider id）。null = 都没问题 */
  const [keyError, setKeyError] = useState<string | null>(null);
  /** 当前进入详情页的供应商（provider id）。null = 供应商总览 */
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  /** 新连接只放在组件内存中；明确保存前不进入持久化设置或模型发现。 */
  const [draftProvider, setDraftProvider] = useState<Provider | null>(null);
  const [draftError, setDraftError] = useState('');
  const draftIdentity = useRef<string | null>(null);
  const [providerSaving, setProviderSaving] = useState(false);
  const [providerError, setProviderError] = useState('');
  const [pendingDiscovery, setPendingDiscovery] = useState<string | null>(null);
  const { open: settingsOpen } = useSettingsDialog();
  const { modelOptions, discoveredModels, discoveredModelFallback, providerNotes, checking, refresh: refreshProviderModels } = useProviderModels(discoveryProviders ?? settings.providers, selectedProviderId);
  const [metaInfo, setMetaInfo] = useState(modelMetaInfo);
  const [metaRefreshing, setMetaRefreshing] = useState(false);
  const [metaError, setMetaError] = useState('');
  const revertTimerRef = useRef<number | undefined>(undefined);

  const editingDraft = Boolean(draftProvider);
  useEffect(() => { onDraftChange?.(editingDraft); }, [editingDraft, onDraftChange]);
  useEffect(() => { setProviderError(''); }, [selectedProviderId]);
  useEffect(() => {
    const selected = selectedProviderId ? settings.providers.find((provider) => provider.id === selectedProviderId) : null;
    const hideModelPresets = Boolean(draftProvider && !draftProvider.catalogId.trim())
      || Boolean(selected && !selected.catalogId.trim());
    onProviderViewChange?.(hideModelPresets);
  }, [draftProvider, onProviderViewChange, selectedProviderId, settings.providers]);

  useEffect(() => {
    if (!focusIssue) return;
    // 默认模型只在总览显示；从供应商详情定位错误时先返回总览。
    setSelectedProviderId(null);
    const frame = requestAnimationFrame(() => {
      const element = document.querySelector(`[data-model-field="${issues[0]?.path}"]`);
      element?.scrollIntoView({ block: 'center' });
      element?.querySelector<HTMLButtonElement>('button[data-testid^="model-button-"]')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusIssue]); // Each explicit request opens and focuses the first invalid field.

  // Wait until the saved server identity reaches the discovery hook before starting GET.
  useEffect(() => {
    const provider = discoveryProviders?.find((p) => p.id === pendingDiscovery);
    if (!provider) return;
    setPendingDiscovery(null);
    void refreshProviderModels(provider).catch(() => {});
  }, [pendingDiscovery, discoveryProviders, refreshProviderModels]);

  // 关闭动画可能暂时保留子树；立即清空草稿，快速重新打开也不能带回未保存的密钥。
  useEffect(() => {
    if (settingsOpen || standalone) return;
    setDraftProvider(null);
    setDraftError('');
  }, [settingsOpen, standalone]);

  /** 供应商 key 仅用于消除同名歧义；未填写也能刷新和使用能力目录。 */
  const catalogs = useMemo(
    () => settings.providers.map(providerCatalogId).filter((c) => c.trim().length > 0),
    [settings.providers],
  );
  const catalogsKey = catalogs.join('\0');

  // 能力数据过期则静默刷新（离线/失败不影响使用，回退启发式）
  useEffect(() => {
    if (!isModelMetaStale()) return;
    let cancelled = false;
    refreshModelMeta(catalogs)
      .then(() => {
        if (!cancelled) setMetaInfo(modelMetaInfo());
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [catalogsKey]);

  /** 只刷新目录；不改用户能力覆盖或手动设置的历史预算。 */
  const handleRefreshMeta = async () => {
    setMetaRefreshing(true);
    setMetaError('');
    try {
      const { count } = await refreshModelMeta(catalogs);
      setMetaInfo(modelMetaInfo());
      toast.success(t('models.capsUpdated', { count }));
    } catch (e) {
      setMetaError(t('models.refreshFailed', { message: e instanceof Error ? e.message : String(e) }));
    } finally {
      setMetaRefreshing(false);
    }
  };

  /** error-state-shake：红边 + 消息由 keyError 驱动，hold 后自动回退 */
  const triggerKeyError = (providerId: string) => {
    setKeyError(providerId);
    // 出错的那家必须露出来，否则抖动发生在折叠区里，用户看不到
    setSelectedProviderId(providerId);
    if (revertTimerRef.current) clearTimeout(revertTimerRef.current);
    const shakeMs = ms('--shake-dur-a', 80) * 2 + ms('--shake-dur-b', 60) * 2;
    revertTimerRef.current = window.setTimeout(() => {
      revertTimerRef.current = undefined;
      setKeyError(null);
    }, shakeMs + ms('--revert-hold', 3000));
  };

  useEffect(() => () => clearTimeout(revertTimerRef.current), []);

  /**
   * 手动刷新只请求当前供应商的 `/models`，不检查或修改其他连接。
   */
  const handleCheck = async (providerId: string) => {
    const provider = (discoveryProviders ?? settings.providers).find((p) => p.id === providerId);
    const draft = settingsStore.getState().providers.find((p) => p.id === providerId);
    if (onSaveProvider && (!provider || (draft && providerNeedsSave?.(draft)))) {
      if (!draft) return;
      setProviderSaving(true); setProviderError('');
      try {
        await onSaveProvider(draft);
        setPendingDiscovery(providerId);
      } catch (error) { setProviderError(error instanceof Error ? error.message : String(error)); }
      finally { setProviderSaving(false); }
      return;
    }
    if (!provider) return;
    if ((!serverManaged && !provider.apiKey.trim()) || !provider.baseUrl.trim()) {
      triggerKeyError(providerId);
      setProviderError(t('models.fillUrlKeyFirst'));
      return;
    }
    setProviderError('');
    try {
      await refreshProviderModels(provider);
    } catch (error) {
      setProviderError(t('models.fetchFailed', { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  /** 一家的连通状态：优先看上次检查的结论，其次看配置是否完整 */
  const statusOf = (p: Provider): 'ready' | 'unconfigured' | 'failed' | 'unchecked' | 'draft' => {
    if (serverManaged && !discoveryProviders?.some((saved) => saved.id === p.id)) return 'draft';
    if ((!serverManaged && !p.apiKey.trim()) || !p.baseUrl.trim()) return 'unconfigured';
    const note = providerNotes[p.id];
    if (note?.startsWith(t('models.fetchFailedShort'))) return 'failed';
    if (note) return 'ready';
    return 'unchecked';
  };

  const addProvider = () => {
    draftIdentity.current = null;
    setDraftProvider({ id: 'draft', name: '', baseUrl: '', apiKey: '', protocol: 'openai-chat', serves: ['chat'], catalogId: '' });
    setDraftError('');
    setSelectedProviderId(null);
  };

  const connectPreset = (preset: ProviderPreset) => {
    draftIdentity.current = null;
    // 已有同端点的连接时直接打开，保留名称、密钥、协议及用户配置。
    const existing = settings.providers.find((p) => matchesProviderPreset(p, preset));
    setDraftError('');
    if (existing) {
      setDraftProvider(null);
      setSelectedProviderId(existing.id);
      return;
    }
    setDraftProvider(createPresetProvider(preset, 'draft'));
    setSelectedProviderId(null);
  };

  const discardDraftProvider = () => {
    draftIdentity.current = null;
    setDraftProvider(null);
    setDraftError('');
  };

  const saveDraftProvider = async () => {
    if (providerSaving) return;
    if (!draftProvider) return;
    if (!draftProvider.name.trim()) { setDraftError(t('models.nameRequired')); return; }
    if (!draftProvider.baseUrl.trim()) { setDraftError(t('models.urlRequired')); return; }
    try {
      const url = new URL(draftProvider.baseUrl);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('invalid protocol');
    } catch {
      setDraftError(t('models.urlInvalid'));
      return;
    }
    if (draftProvider.name.trim().length > 100) { setDraftError(t('models.nameTooLong')); return; }
    if (draftProvider.apiKey.length > 4096) { setDraftError(t('models.keyTooLong')); return; }
    if (!serverManaged && !draftProvider.apiKey.trim()) { setDraftError(t('models.keyRequired')); return; }
    // 保存时才分配正式 id，并基于最新设置追加，不覆盖同时发生的设置变更。
    const current = settingsStore.getState();
    const provider = { ...draftProvider, id: onSaveProvider ? draftIdentity.current ??= `p-${crypto.randomUUID()}` : nextProviderId(current), name: draftProvider.name.trim() };
    if (onSaveProvider) {
      setProviderSaving(true); setDraftError('');
      try { await onSaveProvider(provider); setPendingDiscovery(provider.id); }
      catch (error) { setDraftError(error instanceof Error ? error.message : String(error)); return; }
      finally { setProviderSaving(false); }
    } else {
      current.update({ providers: [...current.providers, provider] });
    }
    setDraftProvider(null);
    draftIdentity.current = null;
    setDraftError('');
    setSelectedProviderId(provider.id);
  };

  const removeProvider = (p: Provider) => {
    // 删掉一家之后，指向它的槽位与收藏项必须一起处理，否则界面上留着
    // 一个解析不出端点的引用，表现为「所有请求都报供应商已被删除」。
    // 云端不静默切换供应商（可能改变费用和数据去向），清空引用后由用户重新选择。
    const rest = settings.providers.filter((x) => x.id !== p.id);
    const fallback = rest[0]?.id ?? '';
    const patch: Partial<Settings> = { providers: rest, savedModels: savedModelsOf(settings).filter((m) => m.providerId !== p.id) };
    for (const name of ['asrModel', 'llmModel', 'visionModel', 'decisionModel'] as ModelFieldName[]) {
      if (settings[name].providerId === p.id) {
        if (serverManaged) { patch[name] = { providerId: '', model: '' }; continue; }
        const slot = name === 'llmModel' ? 'chat' : name === 'visionModel' ? 'vision' : name === 'decisionModel' ? 'decision' : 'asr';
        if (slot === 'decision') { patch.decisionModel = { providerId: '', model: '' }; continue; }
        const replacement = modelsForSlot(settings, slot).find((m) => m.providerId !== p.id);
        patch[name] = { providerId: replacement?.providerId ?? fallback, model: replacement?.model ?? '' };
      }
    }
    const favs = { ...settings.favorites };
    for (const slot of ALL_SLOTS) {
      const kept = favs[slot].filter((r) => r.providerId !== p.id);
      if (kept.length !== favs[slot].length) favs[slot] = kept;
    }
    patch.favorites = favs;
    settings.update(patch);
    if (selectedProviderId === p.id) setSelectedProviderId(null);
    toast.info(serverManaged ? t('models.draftRemoved', { name: p.name || p.id }) : rest.length ? t('models.removedSwitched', { name: p.name || p.id, rest: rest[0].name || rest[0].id }) : t('models.removedCleared', { name: p.name || p.id }));
  };

  const confirmRemove = async (provider: Provider) => {
    const affected = MODEL_FIELDS.filter((field) => settings[field].providerId === provider.id && settings[field].model)
      .map((field) => ({ llmModel: 'models.fieldChat', visionModel: 'models.fieldVision', asrModel: 'models.fieldAsr', decisionModel: 'models.fieldDecision' } as const)[field]);
    const description = serverManaged
      ? t('models.removeDescServer', { name: provider.name || provider.id, affected: affected.length ? t('models.affectedSuffix', { slots: affected.map((label) => t(label)).join('、') }) : '' })
      : t('models.removeDescLocal', { name: provider.name || provider.id });
    if (await confirmDialog({ headline: t('models.deleteProviderTitle'), description, danger: true, confirmText: t('models.delete') })) removeProvider(provider);
  };

  const selectedProvider = selectedProviderId
    ? settings.providers.find((p) => p.id === selectedProviderId) ?? null
    : null;

  return (
    <>
      <SectionCard
        title={draftProvider ? (draftProvider.name.trim() || t('models.customProvider')) : selectedProvider ? (selectedProvider.name.trim() || t('models.unnamedProvider')) : t('models.modelProviders')}
        testId="card-api"
      >
        {!draftProvider && !selectedProvider && onAddOpenCodeGo && <div className="mb-4 flex justify-end">
          <Button size="sm" variant="secondary" isDisabled={addOpenCodeGoDisabled} onPress={onAddOpenCodeGo}>添加 OpenCode Go</Button>
        </div>}
        {draftProvider ? (
          <form className="flex flex-col gap-4" data-testid="provider-draft" onSubmit={(event) => {
            event.preventDefault();
            void saveDraftProvider();
          }}>
            <Button type="button" variant="tertiary" className="self-start" data-testid="provider-draft-back" onPress={discardDraftProvider}>
              <Sym name="arrow_back" />返回供应商列表
            </Button>
            <ProviderRow
              key={draftProvider.id}
              provider={draftProvider}
              serverManaged={serverManaged}
              others={settings.providers}
              status="draft"
              modelCount={null}
              open
              shaking={false}
              removable={false}
              customConnection={!draftProvider.catalogId}
              onToggle={() => undefined}
              onRemove={() => undefined}
              onChange={(patch) => {
                setDraftProvider((current) => current ? { ...current, ...patch } : null);
                setDraftError('');
              }}
            >
              <p className="text-xs text-pretty text-muted">{serverManaged ? t('models.saveHintServer') : t('models.saveHintLocal')}</p>
              {draftError && <p role="alert" className="text-sm text-pretty text-danger">{draftError}</p>}
              <div className="flex gap-2">
                <LoadingButton type="submit" loading={providerSaving} data-testid="provider-draft-save">{onSaveProvider ? t('models.saveConnectionAndFetch') : t('models.saveProvider')}</LoadingButton>
                <Button type="button" variant="ghost" isDisabled={providerSaving} data-testid="provider-draft-cancel" onPress={discardDraftProvider}>取消</Button>
              </div>
            </ProviderRow>
          </form>
        ) : selectedProvider ? (
          <div className="flex flex-col gap-4">
            <Button
              variant="tertiary"
              className="self-start"
              data-testid="provider-back"
              onPress={() => setSelectedProviderId(null)}
            >
              <Sym name="arrow_back" />返回供应商列表
            </Button>
            <ProviderRow
              key={selectedProvider.id}
              provider={selectedProvider}
              serverManaged={serverManaged}
              others={settings.providers.filter((x) => x.id !== selectedProvider.id)}
              status={statusOf(selectedProvider)}
              modelCount={modelOptions[selectedProvider.id]?.length ?? savedModelsOf(settings).filter((m) => m.providerId === selectedProvider.id).length}
              open
              shaking={keyError === selectedProvider.id}
              removable={serverManaged || settings.providers.length > 1}
              onToggle={() => undefined}
              onChange={(patch) => {
                setProviderError('');
                settings.update({ providers: settings.providers.map((x) => (x.id === selectedProvider.id ? { ...x, ...patch } : x)) });
              }}
              onRemove={() => void confirmRemove(selectedProvider)}
              accountContent={renderProviderAccounts?.(selectedProvider)}
            >
              {serverManaged && <p className="text-xs text-muted">{providerNeedsSave?.(selectedProvider) ? t('models.needsSaveNote') : t('models.savedNote')}</p>}
              {providerError && <p role="alert" className="text-sm text-danger">{providerError}</p>}
              <ModelLibrary
                key={selectedProvider.id}
                providerId={selectedProvider.id}
                allowDecision
                discovered={discoveredModels[selectedProvider.id]}
                discoveredFromFallback={discoveredModelFallback[selectedProvider.id]}
                checking={checking || providerSaving}
                refreshLabel={serverManaged && providerNeedsSave?.(selectedProvider) ? t('models.saveConnectionAndFetch') : t('models.fetchListLabel')}
                onRefresh={() => void handleCheck(selectedProvider.id)}
                note={providerNotes[selectedProvider.id]}
              />
            </ProviderRow>
          </div>
        ) : (
          <ProviderPresets
            providers={settings.providers}
            onSelect={connectPreset}
            onCustom={addProvider}
            renderProvider={p => (
              <ProviderRow
                key={p.id}
                provider={p}
                serverManaged={serverManaged}
                others={settings.providers.filter((x) => x.id !== p.id)}
                note={providerNotes[p.id]}
                status={statusOf(p)}
                modelCount={modelOptions[p.id]?.length ?? savedModelsOf(settings).filter((m) => m.providerId === p.id).length}
                open={false}
                shaking={keyError === p.id}
                removable={serverManaged || settings.providers.length > 1}
                onToggle={() => setSelectedProviderId(p.id)}
                onChange={(patch) => {
                  settings.update({ providers: settings.providers.map((x) => (x.id === p.id ? { ...x, ...patch } : x)) });
                }}
                onRemove={() => void confirmRemove(p)}
              >
                <ModelLibrary key={p.id} providerId={p.id} allowDecision discoveredFromFallback={discoveredModelFallback[p.id]} checking={checking} onRefresh={() => void handleCheck(p.id)} />
              </ProviderRow>
            )}
          />
        )}
        <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted">
          <span>能力数据由 <a href="https://models.dev" target="_blank" rel="noreferrer" className="underline underline-offset-2">models.dev</a> 提供。</span>
          <LoadingButton
            variant="ghost"
            size="sm"
            isIconOnly
            className="size-7 min-w-7 text-muted"
            loading={metaRefreshing}
            data-testid="btn-refresh-meta"
            aria-label={metaRefreshing ? t('models.refreshingCaps') : t('models.refreshCaps')}
            onPress={() => void handleRefreshMeta()}
          ><Sym name="refresh" /></LoadingButton>
          <span className="tabular-nums" data-testid="model-meta-updated-at" aria-live="polite">
            {metaInfo ? <time dateTime={new Date(metaInfo.updatedAt).toISOString()} title={t('models.metaUpdatedTitle')}>{t('models.updatedAt')} {new Date(metaInfo.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} BJT</time> : t('models.notUpdated')}
          </span>
        </div>
        {metaError && <p role="alert" className="mt-1 text-xs text-pretty text-danger">{metaError}</p>}
      </SectionCard>
      {!selectedProvider && !draftProvider && <>
      <SectionCard
        title={t('models.pickModel')}
        testId="card-models"
      >
        <div className="flex flex-col gap-3">
          {SLOT_ORDER.map((slot) => {
            const name = (
              { chat: 'llmModel', vision: 'visionModel', asr: 'asrModel', decision: 'decisionModel' } as const
            )[slot];
            return (
              <SlotModelSelect
                key={slot}
                name={name}
                slot={slot}
                settings={settings}
                options={modelOptions}
                issue={issues.find((issue) => issue.path === name)}
              />
            );
          })}
        </div>
       </SectionCard>

       <SectionCard
        title={t('models.runtimeParams')}
        testId="card-tuning"
      >
        <Field
          label={t('models.retrievalRounds')}
          hint={t('models.retrievalRoundsHint')}
          testId="field-agent-rounds"
        >
          <ToggleButtonGroup
            data-testid="agent-rounds"
            aria-label={t('models.retrievalRounds')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[String(settings.agentRounds)]}
            onSelectionChange={(keys) => {
              // ⚠️ 不能写 `Number(next) || 12`：「不限」这一档的值是 0（UNLIMITED_ROUNDS 哨兵），
              // `0 || 12` 会把它悄悄改回 12 —— 那个选项就永远存不下来
              const n = Number([...keys][0]);
              settings.update({ agentRounds: Number.isFinite(n) ? n : 12 });
            }}
          >
            {[3, 6, 12, 20].map((n) => (
              <ToggleButton key={n} id={String(n)}>
                {n}
              </ToggleButton>
            ))}
            {/* 0 = 不限（agent.ts 的 UNLIMITED_ROUNDS 哨兵）。用哨兵而不是再加一个布尔字段：
                两个字段迟早会漂移，「轮数」和「有没有上限」必须是同一个量的两种取值 */}
            <ToggleButton id={String(UNLIMITED_ROUNDS)}>不限</ToggleButton>
          </ToggleButtonGroup>
        </Field>
        <Field
          label={t('models.asrConcurrency', { count: settings.asrConcurrency })}
          hint={t('models.asrConcurrencyHint')}
          layout="block"
          testId="field-asr-concurrency"
        >
          <Slider
            data-testid="asr-concurrency"
            aria-label={t('models.asrConcurrencyLabel')}
            minValue={1}
            maxValue={12}
            step={1}
            value={settings.asrConcurrency}
            onChange={(v) => settings.update({ asrConcurrency: typeof v === 'number' ? v : v[0] })}
          >
            <Slider.Track>
              <Slider.Fill />
              <Slider.Thumb />
            </Slider.Track>
          </Slider>
        </Field>
      </SectionCard>

       {!standalone && <PromptCacheUsage serverManaged={serverManaged} />}
        <ContextCompressionCard />
       </>}
    </>
  );
}
