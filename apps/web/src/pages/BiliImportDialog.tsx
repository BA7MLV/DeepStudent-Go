import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Modal,
  Tag,
  TagGroup,
  TextArea,
  TextField,
} from '@heroui/react';
import { Banner, LoadingButton, MODAL_CONTAINER_CLASS, Sym, confirmDialog, toast } from '../ui';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { formatCaughtError } from '../utils/errorText';
import type { BiliSubtitleItem } from '../bilibili/dmview';
import BiliBridgeStatus from '../bilibili/BridgeStatus';
import {
  defaultSelectedLangs,
  extractBiliInput,
  formatTotalDuration,
  pageLabel,
  resolveSelectedPages,
  selectedDuration,
  type BiliLangItem,
  type BiliTarget,
  type BiliVideoSource,
  type SubtitleBundle,
} from './libraryBili';

/** 已保存一集后通知父组件登记导入任务行并落库；返回是否成功 */
export type SaveBiliPage = (file: File, subtitles: SubtitleBundle, source: BiliVideoSource) => Promise<boolean>;

function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * 竞态计数器：递增后旧请求的回包自己作废（切分 P、改链接时用）。
 */
function useRequestSequence() {
  const ref = useRef(0);
  return {
    current: () => ref.current,
    next: () => {
      ref.current += 1;
      return ref.current;
    },
  };
}

/**
 * B 站导入弹窗（两步：解析 → 勾语言 → 下载）。
 *
 * 整个组件只在用户点「从 B 站导入」时才被 `React.lazy` 加载：它背后是 B 站解析器、
 * 字幕抓取与转封装代码，没打算导入 B 站视频的人不该为它付下载代价。
 *
 * 状态全部留在组件内部：弹窗关闭即卸载，草稿自然丢弃 —— 这正是原来 `resetBiliDraft`
 * 手工逐项清空十几个 state 想达到的效果，现在由卸载本身保证，少一类「漏清某一项」的 bug。
 */
export default function BiliImportDialog({
  open,
  onOpenChange,
  onImported,
  savePage,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 至少成功导入一集后通知父组件刷新列表 */
  onImported: () => void;
  savePage: SaveBiliPage;
}) {
  const { t: tr } = useTranslation('projects');
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState<BiliTarget | null>(null);
  const [resolving, setResolving] = useState(false);
  const [langs, setLangs] = useState<string[]>([]);
  const [langItems, setLangItems] = useState<BiliLangItem[]>([]);
  const [langPage, setLangPage] = useState<number | null>(null);
  const [subtitleError, setSubtitleError] = useState<string | null>(null);
  const [subtitleLoading, setSubtitleLoading] = useState(false);
  const [pagesSel, setPagesSel] = useState<number[]>([]);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const langReq = useRequestSequence();
  const resolveReq = useRequestSequence();
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => { abortRef.current?.abort(); }, []);
  // 导入中关页会丢掉正在下载的整集，先拦住
  useEffect(() => {
    if (!importing) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [importing]);

  /** 选中的分 P 里最靠前的那个（字幕语言按它刷新） */
  const firstSelectedPage = (value: BiliTarget, selected: number[]): number | null => {
    const hit = resolveSelectedPages(value.pages, selected)[0];
    return hit ? hit.page : null;
  };

  /**
   * 切分 P 后刷新字幕语言列表：每个分 P 的 cid 不同，字幕语言也可能不同
   * （同理「这集没字幕」也要如实告诉用户）。保留用户已勾、且新列表里仍存在的语言。
   */
  async function refreshLangsForPage(value: BiliTarget, page: number) {
    const seq = langReq.next();
    setSubtitleLoading(true);
    setSubtitleError(null);
    let subtitleFailure: string | null = null;
    const { fetchPageSubtitles } = await import('../bilibili');
    const items = await fetchPageSubtitles(value, page, (message) => {
      subtitleFailure = message;
    });
    if (seq !== langReq.current()) return; // 又有新的切换，丢弃这次结果
    setSubtitleError(subtitleFailure);
    setSubtitleLoading(false);
    setLangItems(items);
    setLangPage(page);
    setLangs((prev) => {
      const keep = prev.filter((lan) => items.some((item) => item.lan === lan));
      return keep.length > 0 ? keep : defaultSelectedLangs(items as BiliSubtitleItem[]);
    });
  }

  const selectPages = (keys: Iterable<string>) => {
    if (!target || importing) return;
    const next = [...keys].map(Number).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    setPagesSel(next);
    const first = firstSelectedPage(target, next);
    if (first != null && first !== langPage) void refreshLangsForPage(target, first);
  };

  const selectAllPages = (all: boolean) => {
    if (!target || importing) return;
    if (!all) {
      setPagesSel([]);
      return;
    }
    setPagesSel(target.pages.map((p) => p.page));
    const first = target.pages[0]?.page ?? null;
    if (first != null && first !== langPage) void refreshLangsForPage(target, first);
  };

  /**
   * 第一步：解析链接，拿到标题/时长与「自带字幕」语言列表。
   * 真正下载放到第二步，因为选哪几路字幕要用户先拍板。
   */
  const resolve = async (value = url) => {
    const raw = value.trim();
    if (!raw) {
      toast.warning(tr('library.t.biliPasteUrl'));
      return;
    }
    const seq = resolveReq.next();
    langReq.next();
    setTarget(null);
    setSubtitleError(null);
    setSubtitleLoading(false);
    setProgress('');
    setResolving(true);
    setError(null);
    try {
      const { resolveBiliTarget } = await import('../bilibili');
      const resolved = await resolveBiliTarget(raw);
      if (seq !== resolveReq.current()) return;
      setTarget(resolved);
      setSubtitleError(resolved.subtitleError ?? null);
      setPagesSel(resolved.defaultPages);
      setLangItems(resolved.subtitles);
      setLangPage(resolved.defaultPages[0] ?? null);
      setLangs(defaultSelectedLangs(resolved.subtitles));
      if (resolved.subtitles.length === 0 && !resolved.subtitleError) {
        toast.info(tr('library.t.biliNoSubs'));
      }
    } catch (e) {
      if (seq !== resolveReq.current()) return;
      setError(formatCaughtError(e));
    } finally {
      if (seq === resolveReq.current()) setResolving(false);
    }
  };

  /** 第二步：下载、转封装、落库；中途可分 P 取消。 */
  const startImport = async () => {
    if (!target || abortRef.current) return;
    const selected = resolveSelectedPages(target.pages, pagesSel);
    if (selected.length === 0) {
      toast.warning(tr('library.t.biliPickOne'));
      return;
    }
    const totalSec = selectedDuration(target.pages, pagesSel);
    // 防手滑：一门课几十 P 几十小时，误点「全选」会很惨
    if (selected.length > 10 || totalSec > 6 * 3600) {
      const ok = await confirmDialog({
        headline: tr('library.t.biliConfirmDownload', { count: selected.length, unit: tr(target.kind === 'season' ? 'library.t.biliUnitSeason' : 'library.t.biliUnitPart') }),
        description: tr('library.t.biliConfirmDescription', { duration: formatTotalDuration(totalSec) }),
        confirmText: tr('library.t.startDownload'),
      });
      if (!ok) return;
    }

    setImporting(true);
    setError(null);
    const controller = new AbortController();
    const lifetime = accountLifetime(cloud.userId);
    const release = lifetime.own(() => controller.abort());
    abortRef.current = controller;
    await acquireWakeLock();
    try {
      const { importBiliPages } = await import('../bilibili');
      const warnings = await importBiliPages(target, {
        langs, pages: pagesSel, signal: controller.signal,
        progress: setProgress,
        save: async (file, subtitles, source) => {
          lifetime.assertCurrent();
          const saved = await savePage(file, subtitles, source);
          if (!saved) throw new Error(tr('biliLocal.saveFailed'));
        },
        // 已保存的分 P 立即从勾选里摘掉，中途失败时用户能直接接着导入剩下的
        imported: page => setPagesSel(previous => previous.filter(value => value !== page)),
      });
      for (const warning of warnings) toast.warning(warning);
      toast.success(tr('biliLocal.saved'));
      onImported();
      onOpenChange(false);
    } catch (e) {
      setError(controller.signal.aborted ? tr('biliLocal.stopped') : formatCaughtError(e));
    } finally {
      release();
      abortRef.current = null;
      setImporting(false);
      await releaseWakeLock();
    }
  };

  const multiPage = (target?.pages.length ?? 0) > 1;
  const selectedSec = target ? selectedDuration(target.pages, pagesSel) : 0;

  /**
   * 导入中不允许 Esc / 点遮罩关闭：isDismissable 管遮罩，isKeyboardDismissDisabled 管 Esc。
   * 关闭即卸载，草稿（链接、解析结果、勾选）随之丢弃，不需要额外的清理动作。
   */
  return (
    <Modal.Root isOpen={open} onOpenChange={(value) => { if (!value && !importing) onOpenChange(false); }}>
      <Modal.Backdrop isDismissable={!importing} isKeyboardDismissDisabled={importing}>
        <Modal.Container placement="center" size="md" className={MODAL_CONTAINER_CLASS}>
          <Modal.Dialog data-testid="bili-dialog">
            <Modal.Header>
              <Modal.Heading>导入哔哩哔哩视频</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <BiliBridgeStatus />
              {/* TextArea 没有 isDisabled，用原生 disabled。 */}
              <TextField fullWidth>
                <TextArea
                  data-testid="bili-url"
                  rows={2}
                  value={url}
                  placeholder={tr('library.chrome.biliPlaceholder')}
                  aria-label={tr('library.chrome.biliLinkLabel')}
                  disabled={importing || resolving}
                  onPaste={(e) => {
                    const input = extractBiliInput(e.clipboardData.getData('text/plain'));
                    if (!input) return; // 普通文本保留默认粘贴行为。
                    e.preventDefault();
                    setUrl(input);
                    void resolve(input);
                  }}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    resolveReq.next();
                    setTarget(null); // 改链接后旧的解析结果（含字幕列表）作废
                    setError(null);
                    setProgress('');
                    langReq.next();
                    setSubtitleError(null);
                    setSubtitleLoading(false);
                  }}
                />
              </TextField>
              <div className="text-secondary" style={{ marginTop: 8, fontSize: 12 }}>
                {tr('biliLocal.importHint')}
              </div>
              {target && (
                <div style={{ marginTop: 12 }} data-testid="bili-target">
                  <div className="row row--nowrap" style={{ alignItems: 'baseline', gap: 8 }}>
                    <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {target.title}
                    </strong>
                    <span className="text-secondary" style={{ fontSize: 12 }} data-testid="bili-summary">
                      {multiPage
                        ? tr('library.chrome.biliSummary', { count: target.pages.length, unit: tr(target.kind === 'season' ? 'library.chrome.biliUnitSeason' : 'library.chrome.biliUnitPart'), selected: pagesSel.length, duration: formatTotalDuration(selectedSec) })
                        : formatTotalDuration(selectedSec)}
                    </span>
                  </div>
                  {multiPage && (
                    <>
                      <div className="row row--nowrap" style={{ gap: 8, marginTop: 10 }}>
                        <span className="text-secondary" style={{ flex: 1, fontSize: 12 }}>
                          {target.kind === 'season' ? tr('library.chrome.biliSeasonHint') : tr('library.chrome.biliPartHint')}
                        </span>
                        <Button variant="tertiary" data-testid="bili-pages-all" isDisabled={importing} onPress={() => selectAllPages(true)}>
                          {tr('library.chrome.biliSelectAll')}
                        </Button>
                        <Button variant="tertiary" data-testid="bili-pages-none" isDisabled={importing || pagesSel.length === 0} onPress={() => selectAllPages(false)}>
                          清空
                        </Button>
                      </div>
                      {/* TagGroup/Tag 是多选标签；选中集受控，回调直接给新的完整集合。 */}
                      <TagGroup
                        selectionMode="multiple"
                        disabledKeys={importing ? target.pages.map(page => String(page.page)) : []}
                        selectedKeys={pagesSel.map(String)}
                        onSelectionChange={(keys) => selectPages([...keys].map(String))}
                        aria-label={target.kind === 'season' ? tr('library.chrome.biliSeasonLabel') : tr('library.chrome.biliPartLabel')}
                      >
                        <TagGroup.List
                          className="row"
                          style={{ flexWrap: 'wrap', gap: 8, marginTop: 6, maxHeight: 168, overflowY: 'auto' }}
                          data-testid="bili-pages"
                        >
                          {target.pages.map((p) => (
                            <Tag
                              key={p.page}
                              id={String(p.page)}
                              textValue={pageLabel(p)}
                              /* 原 title 提示（分 P 名 + 时长）改由 aria-label 承载：
                                 RAC 的 filterDOMProps 不放行 title 属性。 */
                              aria-label={`${pageLabel(p)} · ${formatDuration(p.duration)}`}
                              data-page={String(p.page)}
                              data-testid="bili-page"
                            >
                              {pageLabel(p)}
                            </Tag>
                          ))}
                        </TagGroup.List>
                      </TagGroup>
                    </>
                  )}
                  {subtitleLoading ? (
                    <p className="text-secondary mt-2 text-sm" role="status">正在读取字幕…</p>
                  ) : subtitleError ? (
                    <div className="mt-2 flex flex-col gap-2" data-testid="bili-subtitle-error">
                      <Banner variant="warning" title={tr('library.chrome.biliSubtitleWarn')} description={subtitleError} />
                      <Button variant="tertiary" isDisabled={importing} onPress={() => {
                        const page = firstSelectedPage(target, pagesSel);
                        if (page != null) void refreshLangsForPage(target, page);
                      }}>重试读取字幕</Button>
                    </div>
                  ) : langItems.length > 0 ? (
                    <>
                      <div className="text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
                        {multiPage ? tr('library.chrome.biliLangTitleMulti', { scope: target.kind === 'season' ? tr('library.chrome.biliLangScopeSeason', { page: langPage ?? '' }) : tr('library.chrome.biliLangScopePart', { page: langPage ?? '' }) }) : tr('library.chrome.biliLangTitle')}
                        {tr('biliLocal.languagesHint')}
                      </div>
                      <TagGroup
                        selectionMode="multiple"
                        disabledKeys={importing ? langItems.map(item => item.lan) : []}
                        selectedKeys={langs}
                        onSelectionChange={(keys) => { if (!importing) setLangs([...keys].map(String)); }}
                        aria-label={tr('library.aria.subtitleLang')}
                      >
                        <TagGroup.List className="row" style={{ flexWrap: 'wrap', gap: 8, marginTop: 8 }} data-testid="bili-langs">
                          {langItems.map((s) => (
                            <Tag key={s.lan} id={s.lan} textValue={s.lanDoc || s.lan} data-lang={s.lan} data-testid="bili-lang">
                              {s.lanDoc || s.lan}
                            </Tag>
                          ))}
                        </TagGroup.List>
                      </TagGroup>
                    </>
                  ) : (
                    <div className="text-secondary" style={{ fontSize: 12, marginTop: 10 }}>
                      {tr('biliLocal.noSubtitles')}
                    </div>
                  )}
                </div>
              )}
              {importing && (
                <div className="mt-3 flex flex-col gap-2" data-testid="bili-download-status">
                  <p className="text-secondary text-sm" role="status">{progress || tr('biliLocal.preparing')}</p>
                  <Button variant="tertiary" onPress={() => abortRef.current?.abort()}>{tr('biliLocal.stop')}</Button>
                </div>
              )}
              {error && (
                <Banner
                  variant="error"
                  testId="bili-error"
                  icon={<Sym name="error" />}
                  title={tr('library.t.importFailedTitle')}
                  description={error}
                />
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="tertiary" data-testid="bili-cancel" isDisabled={importing} onPress={() => onOpenChange(false)}>
                {tr('cancel')}
              </Button>
              {target ? (
                <LoadingButton
                  variant="primary"
                  data-testid="bili-confirm"
                  loading={importing}
                  isDisabled={!pagesSel.length}
                  onPress={() => void startImport()}
                >
                  开始导入
                </LoadingButton>
              ) : (
                <LoadingButton
                  variant="primary"
                  data-testid="bili-confirm"
                  loading={resolving}
                  onPress={() => void resolve()}
                >
                  解析
                </LoadingButton>
              )}
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal.Root>
  );
}
