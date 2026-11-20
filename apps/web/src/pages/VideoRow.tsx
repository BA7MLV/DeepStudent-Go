/**
 * 列表 / 简介弹窗里的单张视频卡片。
 *
 * 抽成组件是为了让 ⋯ 菜单 / 开关这类「每行一份」的元素各自持有自己的 ref，
 * 而不必在父级维护一张 ref 表（阶段 1 的 SkillRow 同一模式）。
 *
 * 行结构自建（不用通用列表项组件）：一行里有拖拽手柄 + 标题/元信息 + 标签 + 最多 3 个按钮，
 * 通用列表项的 custom 插槽是覆盖式的，塞不下（详见 library.css 的注释）。
 */
import { useTranslation } from 'react-i18next';
import { Button, Card, Chip, Dropdown, ProgressBar, buttonVariants } from '@heroui/react';
import { Sym } from '../ui/icons';
import type { VideoRow } from '../store/db';
import { preloadChunk } from '../utils/viewTransition';
import { formatSize } from '../utils/format';
import { progressRatio } from '../utils/videoProgress';
import { isJobActive, libraryJobCopy, useTranscribeJob } from '../store/jobs';
import { useCardDragGesture } from './useLibraryItemDrag';
import { useThumb } from './LibraryThumb';

export const CARD_CLS = 'video-row group relative gap-0 p-2 pb-2 select-none [-webkit-touch-callout:none] [-webkit-user-select:none]';
export const THUMB_CLS =
  'video-row__thumb relative block aspect-video w-full cursor-pointer overflow-hidden rounded-2xl bg-default-soft';
export const MAIN_CLS = 'video-row__main mt-2 min-w-0 px-1';
export const NAME_CLS = 'video-row__name line-clamp-2 text-[15px] font-medium leading-snug text-foreground';
export const META_CLS = 'video-row__meta mt-0.5 truncate text-xs text-muted';
export const TAGS_CLS = 'video-row__tags mt-1.5 flex items-center gap-2 px-1';
export const ACTIONS_CLS = 'video-row__actions mt-1.5 flex items-center justify-end gap-1 px-1 [&>[data-slot=button]:first-child]:mr-auto';

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 转写状态标记。
 *
 * 按状态分别上色，用 Chip 的静态语义色变体表达，不再依赖页面专属 tag 样式。
 */
type StatusTagKey = 'library.status.new' | 'library.status.transcribing' | 'library.status.transcribed' | 'library.status.error';
const STATUS_TAG: Record<VideoRow['status'], { variant: '' | 'primary' | 'error'; text: StatusTagKey }> = {
  new: { variant: '', text: 'library.status.new' },
  transcribing: { variant: 'primary', text: 'library.status.transcribing' },
  transcribed: { variant: 'primary', text: 'library.status.transcribed' },
  error: { variant: 'error', text: 'library.status.error' },
};

export function VideoRow({
  video: v,
  isMobile,
  dragging,
  onPlay,
  onRename,
  onMove,
  onTogglePin,
  onDelete,
  onReparse,
  onBeginDrag,
  onDragMove,
  onDragEnd,
  onDragCancel,
}: {
  video: VideoRow;
  isMobile: boolean;
  dragging: boolean;
  onPlay: () => void;
  onRename: () => void;
  onMove: () => void;
  onTogglePin: () => void;
  onDelete: () => void;
  /** 只有阅读材料有：重新解析 + 重建索引 */
  onReparse?: () => void;
  /** 整卡长按到点：以卡片元素为指针捕获目标开始拖拽 */
  onBeginDrag: (el: HTMLElement, pointerId: number, x: number, y: number) => void;
  onDragMove: (e: React.PointerEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragCancel: () => void;
}) {
  const { t: tr } = useTranslation('projects');
  const isMaterial = v.kind === 'material';
  const matKind: 'page' | 'para' = v.materialFormat === 'pdf' || !v.materialFormat ? 'page' : 'para';
  const noun = tr(matKind === 'page' ? 'library.material.pageNoun' : 'library.material.paraNoun');
  const unitText = v.unitCount
    ? `${v.unitCount} ${noun}`
    : v.empty === 1
      ? tr('library.material.noText')
      : tr('library.material.unparsed');
  /**
   * 材料的状态标签与视频不是一套语义：
   * 已解析 / 待解析 / 扫描件（不可检索）/ 无正文（不可检索）/ 文件已删。
   * 「扫描件」与「无正文」都用 error 色的理由：它们不是失败，但**功能确实受限**，必须显眼。
   * 两者必须分开：扫描件是「有页面但取不到字」（只可能是 PDF），无正文是「压根没内容」。
   */
  const status = isMaterial
    ? v.scanned === 1
      ? { variant: 'error' as const, text: tr('library.material.scanned') }
      : v.empty === 1
        ? { variant: 'error' as const, text: tr('library.material.empty') }
        : v.unitCount
          ? { variant: 'primary' as const, text: tr('library.material.parsed', { count: v.unitCount, noun }) }
          : { variant: '' as const, text: tr('library.material.pending') }
    : { ...STATUS_TAG[v.status], text: tr(STATUS_TAG[v.status].text) };
  const meta = `${isMaterial ? unitText : formatDuration(v.duration)} · ${formatSize(v.size)} · ${new Date(v.createdAt).toLocaleDateString()}`;
  const cover = useThumb(v.id);
  /**
   * 播放进度条的比例。`null` = 不该画这根条 —— 渲染条件就是它，而不是画一条 0 宽度的
   * （否则「看了 2 秒」和「没看过」在页面上长得一样）。规则全在纯函数里，
   * 见 utils/videoProgress.ts 与 docs/plans/2026-09-18-home-progress-bar-design.md。
   *
   * 数据不用额外查：列表页的 reload() 本来就把 videos 整行读进内存了。
   */
  const ratio = progressRatio(v);
  // 转写是全局队列里的后台任务：在播放页、在别处、刷新后续跑的，列表上都要看得到
  const job = useTranscribeJob(v.id);
  const activeJob = isJobActive(job) ? job : undefined;
  const jobCopy = activeJob ? libraryJobCopy(activeJob) : undefined;

  /**
   * 整卡长按起拖。
   *
   * 为什么要长按而不是「按下即拖」：整张卡片在触屏上还要能**滚动列表**、点缩略图进播放页，
   * 若按下就进入拖拽这两件事都会被抢走。长按（按住不动约 400ms）是触屏里表达「拿起」的
   * 通用手势，且与「点一下 = 进入」互不冲突。鼠标按住移动超过阈值即可起拖，不需要等长按。
   */
  const gesture = useCardDragGesture({ dragging, onBeginDrag, onDragMove, onDragEnd, onDragCancel });

  return (
    <Card.Root<'article'>
      ref={gesture.articleRef}
      className={`${CARD_CLS} ${dragging ? 'video-row--dragging opacity-40' : ''}`}
      data-testid="video-item"
      data-video-id={v.id}
      data-kind={isMaterial ? 'material' : 'video'}
      data-pinned={v.pinned === 1 ? '1' : undefined}
      aria-describedby={`library-drag-hint-${v.id}`}
      aria-labelledby={`library-title-${v.id}`}
      onPointerDown={gesture.onPointerDown}
      onPointerMove={gesture.onPointerMove}
      onPointerUp={gesture.onPointerUp}
      onPointerCancel={gesture.onPointerCancel}
      onPointerLeave={gesture.onPointerLeave}
      onClickCapture={gesture.onClickCapture}
      onContextMenu={(e) => {
        // 长按期间抑制系统菜单（桌面右键 / 触屏长按呼出）
        if (gesture.pressing()) e.preventDefault();
      }}
    >
      {/* 缩略图：16:9 通栏，右下角压时长徽标。点缩略图直接进播放页，与卡片式的「整张可点」一致 */}
      <button
        type="button"
        className={`${THUMB_CLS} mb-2 overflow-hidden transition-shadow hover:shadow-md`}
        style={{ viewTransitionName: `lib-cover-${v.id}` }}
        onPointerDown={() => preloadChunk(() => import('./Player'))}
        data-testid="video-thumb"
        aria-label={`${isMaterial ? tr('library.chrome.read') : tr('library.chrome.study')} ${v.name}${ratio == null ? '' : v.finished === 1 ? tr('library.chrome.ariaFinishedSuffix') : tr('library.chrome.ariaWatchedSuffix', { percent: Math.round(ratio * 100) })}`}
        onClick={onPlay}
        onDragStart={(e) => e.preventDefault()}
      >
        {cover ? (
          // 视频与 PDF 共用同一条封面链路，所以这里不再按类型分叉
          <img className="block h-full w-full object-cover transition-transform duration-300 ease-out group-hover:scale-[1.03] motion-reduce:transition-none" src={cover} alt="" loading="lazy" decoding="async" />
        ) : (
          // 没有画面时：先用主色铺底（LQIP），连主色都没有才落到主题色底
          <span
            className="video-row__thumb-empty flex h-full w-full items-center justify-center text-[44px] text-accent opacity-50"
            style={v.dominantColor ? { background: v.dominantColor } : undefined}
          >
            {isMaterial ? (
              v.materialFormat === 'pdf' ? <Sym name="picture_as_pdf" /> : <Sym name="description" />
            ) : (
              <Sym name="play_circle" />
            )}
          </span>
        )}
        <span className="video-row__duration absolute right-1.5 bottom-1.5 rounded-md bg-black/80 px-2 py-1 text-xs font-medium tabular-nums text-white">
          {isMaterial ? (v.unitCount ? `${v.unitCount} ${noun}` : '—') : formatDuration(v.duration)}
        </span>
        {/* 置顶徽标：压在缩略图右上角。标签行里也有一条「已置顶」，
            但缩略图是卡片最显眼的位置，一眼就能看出哪些排在了前面。 */}
        {v.pinned === 1 && (
          <span className="video-row__pin absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-accent text-accent-foreground shadow-sm" data-testid="video-pin" aria-hidden="true">
            <Sym name="pin" filled />
          </span>
        )}
        {/* 播放进度条：贴缩略图底边。与时长徽标、主区的 .video-row__job 都不冲突，
            那是转写/建索引的**后台任务**进度，位置和颜色都不同，别混。 */}
        {ratio != null && (
          <span
            className="video-row__progress absolute right-0 bottom-0 left-0 h-1 bg-black/30"
            data-testid="video-progress"
            data-ratio={ratio.toFixed(3)}
            data-finished={v.finished === 1 ? '1' : undefined}
            aria-hidden="true"
          >
            <span
              className="video-row__progress-fill block h-full bg-accent"
              data-testid="video-progress-fill"
              style={{ width: `${ratio * 100}%` }}
            />
          </span>
        )}
      </button>
      <div className={MAIN_CLS}>
        <h3 className={NAME_CLS} id={`library-title-${v.id}`} style={{ viewTransitionName: `lib-title-${v.id}` }} title={v.name}>
          {v.name}
        </h3>
        <div className={META_CLS} title={meta}>
          {meta}
        </div>
        {activeJob && (
          <div className="video-row__job mt-1.5 flex items-center gap-2 text-xs text-accent" data-testid="video-job">
            {/* 与导入进度条同一套映射：算得出百分比就定量显示，算不出走不确定态。 */}
            <ProgressBar
              maxValue={100}
              aria-label={jobCopy?.detail ?? tr('library.t.jobProgressAria')}
              value={
                // 只有「按份数推进」的任务才有确定百分比：转写（按段）与材料解析（按页/段）。
                // 其余（排队/抽取/VAD）走不确定态。
                activeJob.phase === 'asr'
                  ? Math.round((activeJob.done / Math.max(1, activeJob.total)) * 100)
                  : activeJob.phase === 'parse' && activeJob.total > 1
                    ? Math.round((activeJob.done / Math.max(1, activeJob.total)) * 100)
                    : 0
              }
              isIndeterminate={
                !(activeJob.phase === 'asr' || (activeJob.phase === 'parse' && activeJob.total > 1))
              }
            />
            <span>{jobCopy?.detail}</span>
          </div>
        )}
      </div>
      <div className={TAGS_CLS}>
        {v.pinned === 1 && <Chip size="sm" color="accent" variant="soft">{tr('library.aria.pinned')}</Chip>}
        {v.fileDeleted === 1 && <Chip size="sm" color="default" variant="soft">{tr('library.material.deleted')}</Chip>}
        <Chip size="sm" color={status.variant === 'error' ? 'danger' : status.variant ? 'accent' : 'default'} variant="soft">
          {jobCopy ? jobCopy.tag : status.text}
        </Chip>
      </div>
      <p id={`library-drag-hint-${v.id}`} className="sr-only" data-testid="card-drag-hint">按住整张卡片拖动 · 触屏长按</p>
      <div className={ACTIONS_CLS}>
        <Button data-testid="btn-play" variant="secondary" onPress={onPlay}>
          <Sym name="play_circle" />
          {isMaterial ? tr('library.chrome.read') : tr('library.chrome.study')}
        </Button>
        {isMobile ? (
          // 手机端：图标按钮 + Dropdown 菜单（菜单项用 id + onAction 分发）
          <Dropdown>
            <Dropdown.Trigger
              className={buttonVariants({ isIconOnly: true, variant: 'tertiary', size: 'sm' })}
              data-testid="btn-more"
              aria-label={tr('library.aria.more')}
            >
              <Sym name="more_vert" />
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end">
              <Dropdown.Menu
                aria-label={tr('library.aria.more')}
                onAction={(key) => {
                  if (key === 'rename') onRename();
                  else if (key === 'move') onMove();
                  else if (key === 'pin') onTogglePin();
                  else if (key === 'reparse') onReparse?.();
                  else if (key === 'delete') onDelete();
                }}
              >
                <Dropdown.Item id="rename" textValue={tr('library.menu.rename')} data-testid="menu-rename">
                  <Sym name="edit" />
                  {tr('library.menu.rename')}
                </Dropdown.Item>
                <Dropdown.Item id="move" textValue={tr('library.menu.move')} data-testid="menu-move">
                  <Sym name="folder_open" />
                  {tr('library.menu.move')}
                </Dropdown.Item>
                <Dropdown.Item
                  id="pin"
                  textValue={tr(v.pinned === 1 ? 'library.menu.unpin' : 'library.menu.pin')}
                  data-testid="menu-pin"
                >
                  <Sym name={v.pinned === 1 ? 'pin_off' : 'pin'} />
                  {tr(v.pinned === 1 ? 'library.menu.unpin' : 'library.menu.pin')}
                </Dropdown.Item>
                {/* 解析失败/想换索引重来时用得上；参数化重试比隐式后台扫描可控 */}
                {isMaterial && onReparse && (
                  <Dropdown.Item id="reparse" textValue={tr('library.menu.reparse')} data-testid="menu-reparse">
                    <Sym name="refresh" />
                    {tr('library.menu.reparse')}
                  </Dropdown.Item>
                )}
                <Dropdown.Item
                  id="delete"
                  textValue={tr('library.menu.delete')}
                  data-testid="menu-delete"
                >
                  <Sym name="delete" />
                  {tr('library.menu.delete')}
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : (
          <>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-rename"
              aria-label={tr('library.aria.rename')}
              onPress={onRename}
            >
              <Sym name="edit" />
            </Button>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-move"
              aria-label={tr('library.aria.moveTarget')}
              onPress={onMove}
            >
              <Sym name="folder_open" />
            </Button>
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-pin"
              aria-label={v.pinned === 1 ? tr('library.menu.unpin') : tr('library.menu.pin')}
              onPress={onTogglePin}
            >
              <Sym name={v.pinned === 1 ? 'pin_off' : 'pin'} />
            </Button>
            {isMaterial && onReparse && (
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                data-testid="btn-reparse"
                aria-label={tr('library.aria.reparse')}
                onPress={onReparse}
              >
                <Sym name="refresh" />
              </Button>
            )}
            <Button
              isIconOnly
              variant="tertiary"
              size="sm"
              data-testid="btn-delete"
              aria-label={tr('library.aria.delete')}
              onPress={onDelete}
            >
              <Sym name="delete" />
            </Button>
          </>
        )}
      </div>
    </Card.Root>
  );
}
