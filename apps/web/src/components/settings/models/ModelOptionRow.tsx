import { useTranslation } from 'react-i18next';
import { ListBox } from '@heroui/react';
import { modelOverridesOf, sameRef, type ModelSlot } from '../../../store/settings';
import { getModelMeta, type ModelOverrides } from '../../../api/modelMeta';
import { formatModelTokens } from '../../../api/modelPresentation';
import { IconSwap } from '../../motion';
import { Sym } from '../../../ui';
import { providerCatalogId } from '../../../store/providerPresets';
import { useModelSettings } from '../modelSettingsContext';
import { CapBadges } from './CapBadges';

/**
 * 供应商列表里的一行模型（Pi 的 /model 面板就是这个结构）。
 *
 * 一行 = 一个「供应商 + 模型」组合，所以**供应商名必须印出来**：`Qwen/Qwen3` 在两家
 * 都可能存在，只显示模型 id 没法分辨自己收藏的是哪一家的。右侧再跟上下文窗口，
 * 因为选模型时最关心的就是「它能记多少」。
 */
export function ModelOptionRow({
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
