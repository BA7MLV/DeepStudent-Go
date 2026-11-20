/**
 * 旧版「本地课程表」实现（`LegacyLibrary`）。
 *
 * Library.tsx 的对外入口现在只认服务端资源目录（ResourceLibrary）；但本地数据库模式
 * （`cloud.enabled === false`）与「系统文件 / 旧书签深链接」仍然要落到这套课程表上，
 * 所以整块实现搬到这个文件，由入口在需要时才加载 —— 它带着 IndexedDB 全表刷新、
 * 拖拽移动、封面读取，属于「打开本地库才用得上」的代码。
 *
 * 职责边界：
 *   - 本文件：数据加载、本地写入流水线、导入/文件夹/删除等动作，以及渲染装配；
 *   - `LibraryExplorer.tsx`：访达画布（纯展示 + 事件上抛）；
 *   - `LibraryDialogs.tsx` / `LibraryImport.tsx`：表单弹窗与导入入口；
 *   - `BiliImportDialog.tsx`：B 站导入（RFC 上单独懒加载）；
 *   - `useLibraryItemDrag.ts` / `libraryDrag.ts`：指针拖拽手势与命中检测。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useLibraryNavigation } from '../store/libraryNavigation';
import { db, type FolderRow, type VideoRow } from '../store/db';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { useMarqueeSelection } from '../utils/useMarqueeSelection';
import { useIsMobile } from '../utils/useMobile';
import { useSkeletonGate } from '../ui/skeleton';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { useJobStore } from '../store/jobs';
import { enqueueCover } from '../pipelines/coverQueue';
import { invalidateCoverUrl } from '../store/covers';
import { formatCaughtError } from '../utils/errorText';
import { uuid } from '../utils/uuid';
import { withViewTransition } from '../utils/viewTransition';
import { acquireWakeLock, releaseWakeLock } from '../utils/wakeLock';
import { Banner, HelpTip, PageShell, Sym, alertDialog, confirmDialog, popconfirm, toast, preloadPlayer } from './LibraryShared';
import i18n from '../i18n';
import { captureCourseAccess } from '../client/course-access';
import type { BiliVideoSource } from '../bilibili/source';
import type { SubtitleBundle } from '../bilibili/subtitle';
import { folderAncestors, validFolderDrop, moveLibraryItems, undoLibraryMove } from '../materials/libraryFolders';
import { useProjectLibrary } from '../projects/useProjectLibrary';
import { AGENT_INSTRUCTIONS_ROUTE, systemMaterialId, systemMaterialRoute } from '../materials/systemFiles';
import type { SystemDirectory } from '@wangke/contracts/system';
import type { ResourceFolderColor } from '@wangke/contracts/resources';
import { FOLDER_SPRING_OPEN_MS } from '../ui/interactionTiming';
import {
  UNCAT_KEY,
  filterGroups,
  groupLibrary,
  systemFolderVisible,
  visibleVideos,
  childFolderTiles,
  type LibraryFilter,
} from './libraryModel';
import { DRAG_THRESHOLD_PX, autoScrollDelta, dropTargetAt } from './libraryDrag';
import { useLibraryItemDrag } from './useLibraryItemDrag';
import { ExplorerCanvas } from './LibraryExplorer';
import { ImportDialog, ImportTaskList, type ImportTask } from './LibraryImport';
import { RenameDialog, FolderDialog, MoveDialog, DetailsDialog } from './LibraryDialogs';
import { BiliImportDialog } from './LibraryLazy';
import { VideoRow as VideoRowCard } from './VideoRow';

/**
 * 可导入的视频扩展名。iPadOS 文件选择器按 UTI 过滤 accept，
 * mkv/flv/ts/wmv 等扩展名映射不到系统认识的 UTI 会被置灰选不了，
 * 因此 input 不设 accept，改为选中后在 JS 侧校验。
 */
const VIDEO_EXTS = new Set([
  'mp4', 'mov', 'm4v', 'webm', 'mkv', 'flv', 'ts', 'm2ts', 'wmv', 'avi', 'mpg', 'mpeg', '3gp', 'rmvb', 'rm',
]);

function isVideoFile(file: File): boolean {
  if (file.type.startsWith('video/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return VIDEO_EXTS.has(ext);
}

/**
 * 可导入的文件 = 视频 或 阅读材料（PDF / Word / Markdown / HTML）。
 *
 * `.doc`（旧版二进制）也算「可导入」—— 但不是在导入时静默忽略，而是在
 * `importOne` 里**明确报错并给出「另存为 .docx」的提示**。
 * 让用户知道「这个格式我认识但处理不了」比让他猜「为什么文件选不上」强得多。
 */
function isImportable(file: File): boolean {
  return isVideoFile(file) || MATERIAL_NAME.test(file.name);
}

/** 材料的文件名扩展名（只看名字：选文件时 type 经常为空） */
const MATERIAL_NAME = /\.(pdf|docx|doc|md|markdown|html?)$/i;

/** iOS/iPadOS 检测（含 iPadOS 13+ 伪装成 MacIntel 的情况） */
function isIOS(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

/** 是否已作为 PWA 添加到主屏幕运行 */
function isStandalone(): boolean {
  return (
    (navigator as Navigator & { standalone?: boolean }).standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches
  );
}

// iOS 普通 Safari 标签页受 ITP 限制：7 天无交互可能清除 OPFS/IndexedDB，
// 主屏幕 PWA 豁免。只需在 iOS 非独立模式下提示一次。
const SHOW_PWA_HINT = isIOS() && !isStandalone();

function LibraryFrame({ bare, ...props }: ComponentProps<typeof PageShell> & { bare: boolean }) {
  return bare ? <>{props.children}</> : <PageShell {...props} />;
}

export default function LegacyLibrary({ importing }: { importing?: { folderId?: number; onClose: () => void } }) {
  const [courseAccess] = useState(() => captureCourseAccess());
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { t: tr } = useTranslation('projects');
  // 设置与历史聊天中的深链接也进入普通 Markdown 阅读页。
  const agentFileRequested = ['/system/AGENTS.md', 'AGENTS.md'].includes(searchParams.get('file') ?? '');
  const memoryFileRequested = searchParams.get('file')?.startsWith('/system/memory/') ? searchParams.get('file')! : '';
  const skillFileRequested = searchParams.get('file')?.startsWith('/system/skills/') ? searchParams.get('file')! : '';
  const mcpFileRequested = searchParams.get('file') === '/system/mcp.json' ? '/system/mcp.json' : '';
  const boardFileRequested = searchParams.get('file')?.startsWith('/system/board/') ? searchParams.get('file')! : '';
  const isMobile = useIsMobile();
  const [videos, setVideos] = useState<VideoRow[]>([]);
  const [folders, setFolders] = useState<FolderRow[]>([]);
  /**
   * 列表的加载状态。
   *
   * ⚠️ 为什么不能拿 `videos.length === 0 && folders.length === 0` 兼表「空库」：
   * 首帧这两个数组**必然是空的**（reload 是异步 IndexedDB 读），于是「还没加载出来」
   * 和「库里确实没东西」被混成了同一个状态 —— 有数据的库冷启动时，空态会先闪现
   * 64–94ms 再被列表顶掉（实测见 `scripts/probe-loading-latency.mjs` 的 B 组）。
   *
   * 三态分开之后，空态只在 `ready` 且数组真的为空时才出现。
   * 同一套规矩在 `store/courseChat.ts` 已经是这么写的（`loaded` / `error` 各自独立）。
   */
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  /** 首次读库是否已经落定（成功或失败都算）—— 决定后续刷新失败时是「换错误页」还是「只弹 toast」 */
  const initialLoadSettled = useRef(false);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState<LibraryFilter>('all');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const folderHistory = useLibraryNavigation((s) => s.folderHistory);
  const setFolderHistory = useLibraryNavigation((s) => s.setFolderHistory);
  const folderKey = folderHistory.entries[folderHistory.index];
  const inMemoryFolder = folderKey === 'system/memory';
  const inSystemFolder = typeof folderKey === 'string' && folderKey.startsWith('system');
  const systemPath = inSystemFolder ? `/${folderKey}` : '';
  const projectLibrary = useProjectLibrary(!inSystemFolder && !agentFileRequested && !memoryFileRequested && !skillFileRequested && !mcpFileRequested && !boardFileRequested && !importing);
  const [systemPage, setSystemPage] = useState<SystemDirectory>({ files: [], directories: [], nextOffset: null });
  const [systemOffset, setSystemOffset] = useState(0);
  const [systemLoading, setSystemLoading] = useState(false);
  const [systemError, setSystemError] = useState('');
  useEffect(() => {
    if (!inSystemFolder) return;
    let stopped = false;
    let off: (() => void) | undefined;
    setSystemLoading(true);
    void import('../client/resources').then(({ followDocument }) => {
      if (stopped) return;
      off = followDocument<SystemDirectory>({ kind: 'systemDirectory', path: systemPath, offset: systemOffset, query: searchText.trim() }, page => {
        setSystemPage(page); setSystemError(''); setSystemLoading(false);
      }, error => { setSystemError(error instanceof Error ? error.message : tr('library.t.readSystemFailed')); setSystemLoading(false); });
    });
    return () => { stopped = true; off?.(); };
  }, [inSystemFolder, systemPath, systemOffset, searchText]);
  useEffect(() => { setSystemOffset(0); }, [searchText, folderKey]);
  useEffect(() => {
    if (!agentFileRequested) return;
    setFolderHistory((history) => history.entries[history.index] === 'system' ? history :
      { entries: [...history.entries.slice(0, history.index + 1), 'system'], index: history.index + 1 });
    navigate(AGENT_INSTRUCTIONS_ROUTE, { replace: true });
  }, [agentFileRequested, navigate, setFolderHistory]);
  useEffect(() => {
    const file = memoryFileRequested || skillFileRequested || mcpFileRequested || boardFileRequested;
    if (!file || !systemMaterialId(file)) return;
    const parent = file.slice(1, file.lastIndexOf('/')) || 'system';
    setFolderHistory(history => ({ entries: [...history.entries.slice(0, history.index + 1), parent], index: history.index + 1 }));
    navigate(systemMaterialRoute(file), { replace: true });
  }, [memoryFileRequested, skillFileRequested, mcpFileRequested, boardFileRequested, navigate, setFolderHistory]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [mobileManaging, setMobileManaging] = useState(false);
  const marquee = useMarqueeSelection(selection, setSelection);
  const [view, setView] = useState<'icons' | 'list'>('icons');
  const [sort, setSort] = useState<'name' | 'recent'>('name');
  const [importOpen, setImportOpen] = useState(Boolean(importing));
  const [details, setDetails] = useState<VideoRow | null>(null);
  const [dropFolder, setDropFolder] = useState<string | null>(null);
  const finderDragKeys = useRef<string[]>([]);
  const finderPressSelection = useRef<string[]>([]);
  const [finderDragging, setFinderDragging] = useState<string[]>([]);
  const [dropHint, setDropHint] = useState('');
  const [dropHintInvalid, setDropHintInvalid] = useState(false);
  const [lastMove, setLastMove] = useState<Awaited<ReturnType<typeof moveLibraryItems>>>([]);
  const [moveNotice, setMoveNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [undoingMove, setUndoingMove] = useState(false);
  const springTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const springTarget = useRef<string | null>(null);
  const dragOrigin = useRef<string | null>(null);
  const springOpened = useRef(false);
  const finderDropCommitted = useRef(false);
  const dragImage = useRef<HTMLElement | null>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const clearSpring = () => {
    if (springTimer.current) clearTimeout(springTimer.current);
    springTimer.current = null;
    springTarget.current = null;
  };
  useEffect(() => () => { clearSpring(); dragImage.current?.remove(); }, []);
  const [actionMenuOpen, setActionMenuOpen] = useState(false);
  const [contextPoint, setContextPoint] = useState<{ x: number; y: number } | null>(null);
  const contextAnchor = useRef<HTMLSpanElement>(null);
  const [tasks, setTasks] = useState<ImportTask[]>([]);
  // 重命名视频弹窗状态：renaming 为 null 时弹窗关闭
  const [renaming, setRenaming] = useState<VideoRow | null>(null);
  // 文件夹弹窗：create=新建，rename=重命名；为 null 时关闭
  const [folderModal, setFolderModal] = useState<{ mode: 'create' } | { mode: 'rename'; folder: FolderRow } | null>(null);
  // 移动到文件夹弹窗：moving 为 null 时关闭
  const [moving, setMoving] = useState<VideoRow | null>(null);
  /**
   * 拖拽移动（Pointer Events 实现，iPad Safari 不支持 HTML5 DnD）：
   * 按住视频行的拖拽手柄（立即）或整张卡片长按（约 400ms）→ 悬浮卡片跟随 →
   * 拖到组头上松手移入该文件夹、拖到顶栏左侧松手置顶、拖到顶栏右侧松手删除。
   */
  const headerRefs = useRef(new Map<string, HTMLDivElement>());
  /** 顶栏两个投放区的 DOM，命中检测时现量矩形（拖拽期间才挂载） */
  const pinZoneRef = useRef<HTMLDivElement>(null);
  const deleteZoneRef = useRef<HTMLDivElement>(null);
  // 顺序导入链：多个文件排队逐个写入，避免并发写存储互相拖慢
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const importBatch = useRef({ pending: 0, succeeded: 0 });
  const nativeInputRef = useRef<HTMLInputElement>(null);
  // HTML5 拖放（桌面/iPad 从「文件」App 拖入）的悬停高亮
  const [dropActive, setDropActive] = useState(false);
  // 哔哩哔哩导入弹窗（两步：解析 → 勾语言 → 下载）
  const [biliOpen, setBiliOpen] = useState(false);

  /* ───────────────────────────── 读取与刷新 ───────────────────────────── */

  const reload = useCallback(async () => {
    // Server listings are ResourceLibrary. This mounted adapter only hosts
    // imports/system links: it must not invisibly scan every cached course and
    // folder behind those surfaces. Local-only mode retains its old table UI.
    if (cloud.enabled) {
      setLoadError(null); initialLoadSettled.current = true; setLoadState('ready');
      return;
    }
    try {
      const { readVideoLibrary } = await import('./libraryLocal');
      const [rows, folderRows] = await readVideoLibrary();
      setVideos(rows);
      setFolders(folderRows);
      setLoadError(null);
      initialLoadSettled.current = true;
      setLoadState('ready');
    } catch (e) {
      const message = formatCaughtError(e);
      setLoadError(message);
      /**
       * 只有**首次**加载失败才把整页切成错误页。
       *
       * 后续的刷新（revision 变化、后台任务收尾）失败时换掉整页是错的 ——
       * 用户手里已经有一份能看的列表，一次后台重读失败不该把它抽走：
       * 内容还在、只是可能不是最新，这比「突然什么都没有了」好得多。
       * 这种情形留一条 toast 就够。
       */
      if (initialLoadSettled.current) {
        toast.error(tr('library.t.refreshFailed', { message }));
      } else {
        setLoadState('error');
      }
    }
  }, []);

  useEffect(() => {
    void import('./libraryLocal')
      .then((local) => local.ensureWrongbookMaterialIfPresent())
      .catch((error) => toast.error(tr('library.t.wrongbookMigrateFailed', { message: formatCaughtError(error) })))
      .then(() => reload());
  }, []);

  /**
   * 助手在**别的页面**整理了目录（课程助手页的方案卡确认后会建文件夹、改 folderId），
   * 这里要立刻看到归位结果。靠重新挂载是不行的：用户在库页时助手可能在聊天页确认了
   * 方案，回来时组件已经挂着了，什么都不会变。信号只带一个计数器，本组件只管「变了就重读」。
   */
  const libraryRevision = useLibraryRevision((s) => s.revision);
  useEffect(() => {
    if (libraryRevision > 0) void reload();
  }, [libraryRevision]);

  /**
   * 任务跑到终态时刷新列表：材料的解析/建索引是**后台任务**，会回写
   * `videos.unitCount` / `scanned`，但列表数据是导入那一刻读出来的快照。
   * `settledJobs` 记住已处理过的 id，避免每次渲染重复 reload。
   */
  const jobs = useJobStore((s) => s.jobs);
  const settledJobs = useRef(new Set<string>());
  useEffect(() => {
    let needReload = false;
    for (const [id, job] of Object.entries(jobs)) {
      const settled = job.phase === 'done' || job.phase === 'error';
      if (!settled) {
        settledJobs.current.delete(id);
        continue;
      }
      if (!settledJobs.current.has(id)) {
        settledJobs.current.add(id);
        needReload = true;
      }
    }
    if (needReload) void reload();
  }, [jobs]);

  // ---------- 派生数据 ----------

  const groups = useMemo(
    () => groupLibrary(videos, folders, tr('library.t.uncategorized')),
    [videos, folders, tr],
  );
  const searchQuery = searchText.trim().toLocaleLowerCase();
  const hasFilters = searchQuery.length > 0 || filter !== 'all';
  // 搜索时展开命中的组；清除筛选后恢复用户原本的折叠状态，不写入新的折叠偏好。
  const visibleGroups = useMemo(
    () => filterGroups(groups, searchQuery, filter),
    [groups, searchQuery, filter],
  );
  const currentFolder = inSystemFolder ? undefined : groups.find((group) => group.key === folderKey && group.folder != null);
  const folderTitle = inSystemFolder ? (folderKey?.split('/').at(-1) ?? 'system') : currentFolder?.name ?? tr('library.path.allResources');
  const scopedGroups = currentFolder ? visibleGroups.filter((group) => group.key === currentFolder.key) : visibleGroups;
  const folderTiles = childFolderTiles(groups, currentFolder?.folder?.id ?? null, hasFilters, scopedGroups, filter, searchQuery, sort);
  // 组头上的「N 个项目」= 组内视频 + 直属子文件夹；拖拽悬停打开的目录也要算进去
  const subfolderCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const group of groups) {
      for (const child of groups) {
        if (child.folder?.parentId === group.folder?.id && child.folder) counts[group.key] = (counts[group.key] ?? 0) + 1;
      }
    }
    return counts;
  }, [groups]);
  const displayedVideos = visibleVideos(scopedGroups, inSystemFolder, currentFolder, hasFilters, sort);
  // 系统文件使用服务端实体 Markdown，不入课程表，不参与课程统计或移动。
  const showSystemFolder = systemFolderVisible(inSystemFolder, currentFolder, filter, searchQuery);
  const systemFiles = inSystemFolder && (filter === 'all' || filter === 'material') ? systemPage.files : [];
  const systemDirectories = inSystemFolder && (filter === 'all' || filter === 'material') ? (systemPage.directories ?? []) : [];
  const projectTiles = !currentFolder && !inSystemFolder && filter === 'all' ? projectLibrary.projects.filter(p => !searchQuery || p.name.toLocaleLowerCase().includes(searchQuery)) : [];
  const visibleCount = displayedVideos.length + folderTiles.length + projectTiles.length + systemFiles.length + systemDirectories.length + (showSystemFolder ? 1 : 0);
  const folderPath = folderAncestors(folders, currentFolder?.folder?.id ?? null);
  // Keep the native drag source mounted while spring-loading another directory.
  const renderedFolders = finderDragging.length
    ? [...folderTiles, ...groups.filter((group) => group.folder && !folderTiles.some((visible) => visible.key === group.key))]
    : folderTiles;
  const renderedVideos = finderDragging.length
    ? [...displayedVideos, ...videos.filter((video) => !displayedVideos.some((visible) => visible.id === video.id))]
    : displayedVideos;
  const selectedKey = selection.size === 1 ? [...selection][0] : undefined;
  const selectedFolder = folderTiles.find((group) => `folder:${group.key}` === selectedKey);
  const selectedVideo = displayedVideos.find((video) => `file:${video.id}` === selectedKey);

  /**
   * 首次读库要不要出骨架。
   *
   * 实测本机 IndexedDB 全表读回 p50 是 0.3ms，所以**绝大多数情况下这里一直是 false**
   * —— 列表直接就位，连一帧骨架都不会出现，这正是想要的结果。
   * ⚠️ 判据写成「加载中 **且手上还没有任何东西可显示**」，而不是只看 `loadState === 'loading'`：
   * 骨架的正确用法是填「还什么都没有」的那个空档，一旦手里有内容可显示，就不该拿骨架盖住它。
   */
  const isFirstLoad = loadState === 'loading' && videos.length === 0 && folders.length === 0;
  const showSkeleton = useSkeletonGate(isFirstLoad);

  /* ───────────────────────────── 导航与选择 ───────────────────────────── */

  const resetViewState = () => {
    setMobileManaging(false);
    setSelection(new Set());
    setSearchText('');
    setFilter('all');
  };

  const clearFilters = useCallback(() => {
    withViewTransition(() => {
      setSearchText('');
      setFilter('all');
    });
    searchInputRef.current?.focus();
  }, []);

  const openFolder = useCallback((key: string | null) => {
    withViewTransition(() => {
      setFolderHistory((history) => ({ entries: [...history.entries.slice(0, history.index + 1), key], index: history.index + 1 }));
      resetViewState();
    });
  }, []);
  const travelFolder = useCallback((delta: number) => {
    withViewTransition(() => {
      setFolderHistory((history) => ({ ...history, index: Math.max(0, Math.min(history.entries.length - 1, history.index + delta)) }));
      resetViewState();
    });
  }, []);
  const openPlayer = useCallback((id: string) => {
    preloadPlayer();
    withViewTransition(() => navigate(`/player/${id}`));
  }, []);
  const openItem = useCallback((key: string) => {
    if (key.startsWith('project:')) navigate(`/projects/${key.slice(8)}/files`);
    else if (key === 'system:agent-instructions') navigate(AGENT_INSTRUCTIONS_ROUTE);
    else if (key === 'system:folder') openFolder('system');
    else if (key === 'system:memory-folder') openFolder('system/memory');
    else if (key.startsWith('system:folder:')) openFolder(key.slice('system:folder:'.length).replace(/^\//, ''));
    else if (key.startsWith('system:memory:')) openPlayer(encodeURIComponent(key));
    else if (key.startsWith('system:file:')) openPlayer(encodeURIComponent(key));
    else if (key.startsWith('folder:')) openFolder(key.slice(7));
    else if (key.startsWith('file:')) openPlayer(key.slice(5));
  }, []);

  /* ───────────────────────────── 本地写入流水线 ───────────────────────────── */

  const patchTask = useCallback((key: string, patch: Partial<ImportTask>) => {
    setTasks((prev) => prev.map((t) => (t.key === key ? { ...t, ...patch } : t)));
  }, []);

  /** 报错详情：页面内提示没法承载长文本，仍旧弹窗，但保留「一键复制详情」 */
  const showError = useCallback((headline: string, text: string) => {
    void alertDialog({ headline, description: text, copyText: text });
  }, []);

  const importOne = useCallback(async (file: File, key: string, subtitles?: SubtitleBundle, biliSource?: BiliVideoSource) => {
    if (!courseAccess.current()) return false;
    const lifetime = accountLifetime(cloud.userId);
    const local = await import('./libraryLocal');
    // 大视频拷入 OPFS 要数分钟，持 Wake Lock 防熄屏后 tab 被挂起中断导入
    if (!biliSource) await acquireWakeLock();
    try {
      if (await local.isLegacyDocFileNow(file)) throw new Error(tr('library.t.legacyDoc'));
      {
        const { readResourceFolder, uploadResource, resourceCommand, readResources, recordMediaDuration } = await import('../client/resources');
        patchTask(key, { status: 'writing', percent: 0 });
        lifetime.assertCurrent();
        const directory = await readResourceFolder(importing ? importing.folderId : currentFolder?.folder?.id);
        lifetime.assertCurrent();
        const projectId = directory.project?.id ?? directory.rootId;
        const path = directory.path ? `${directory.path}/${file.name}` : file.name;
        await uploadResource(projectId, path, file);
        lifetime.assertCurrent();
        const fresh = await readResources(projectId, directory.path);
        lifetime.assertCurrent();
        const entry = fresh.entries.find(entry => entry.path === path);
        if (!entry?.courseId) throw new Error(tr('library.t.uploadIndexPending'));
        const id = entry.courseId;
        await courseAccess.read(id);
        lifetime.assertCurrent();
        if (await local.isMaterialFileNow(file)) {
          const format = await local.detectMaterialFormatNow(file);
          void local.startMaterialJobNow(id, format).catch(error => toast.error(tr('library.t.parseFailed', { message: formatCaughtError(error) })));
        } else {
          const duration = await local.probeDurationNow(file);
          lifetime.assertCurrent();
          if (duration) await recordMediaDuration(id, duration);
          lifetime.assertCurrent();
          if (biliSource) await resourceCommand({ kind: 'setVideoSource', courseId: id, source: biliSource });
          lifetime.assertCurrent();
          if (subtitles) await local.saveImportedSubtitlesNow(id, subtitles);
          lifetime.assertCurrent();
          if (!subtitles?.primary?.cues.length) {
            if (biliSource) await local.submitCloudTranscriptionNow(id);
            else local.startTranscriptionNow(id);
          }
        }
        lifetime.assertCurrent();
        enqueueCover(id);
        const { flushResourceCommands } = await import('../client/resource-commands');
        lifetime.assertCurrent();
        await flushResourceCommands();
        lifetime.assertCurrent();
        setTasks(previous => previous.filter(task => task.key !== key));
        return true;
      }
    } catch (e) {
      if (!lifetime.current()) return false;
      const text = formatCaughtError(e);
      patchTask(key, { status: 'error', error: text });
      showError(tr('library.t.importFailed', { name: file.name }), text);
      return false;
    } finally {
      if (!biliSource) await releaseWakeLock();
    }
  }, []);

  const enqueue = useCallback((file: File, subtitles?: SubtitleBundle, biliSource?: BiliVideoSource) => {
    const key = uuid();
    importBatch.current.pending++;
    setTasks((prev) => [...prev, { key, name: file.name, status: 'queued', percent: 0 }]);
    chainRef.current = chainRef.current.then(async () => {
      if (await importOne(file, key, subtitles, biliSource)) importBatch.current.succeeded++;
      if (--importBatch.current.pending === 0) {
        const count = importBatch.current.succeeded;
        importBatch.current.succeeded = 0;
        if (count && courseAccess.current()) toast.success(i18n.t('interface:feedback.uploaded', { count }));
      }
    });
  }, []);

  /**
   * 原生文件选择器入口（兼诊断）：iPad PWA 里若投放区选完没反应，
   * 用这个可以确认系统到底有没有把文件交给页面。
   */
  const handleNativePick = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (inSystemFolder) { toast.warning(tr('library.t.systemOnly')); return; }
    if (files.length === 0) {
      toast.warning(tr('library.t.safariFiles'));
      return;
    }
    const accepted = files.filter(isImportable);
    const skipped = files.filter((f) => !isImportable(f));
    if (skipped.length > 0) toast.warning(tr('library.t.skippedUnsupported', { count: skipped.length }));
    if (accepted.length > 0) setImportOpen(false);
    for (const f of accepted) enqueue(f);
  }, []);

  /** HTML5 拖放（桌面 / iPad 从「文件」App 拖入） */
  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDropActive(false);
    if (inSystemFolder || (e.target as Element).closest('[data-system-folder]')) {
      toast.warning(tr('library.t.systemOnly'));
      return;
    }
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length === 0) return;
    setImportOpen(false);
    const accepted = files.filter(isImportable);
    const skipped = files.length - accepted.length;
    if (skipped) toast.warning(tr('library.t.skippedUnsupported', { count: skipped }));
    for (const f of accepted) enqueue(f);
  }, []);

  /* ───────────────────────────── 单条操作 ───────────────────────────── */

  const confirmRename = useCallback(async (name: string) => {
    if (!renaming) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.warning(tr('library.t.titleEmpty'));
      return;
    }
    if (trimmed !== renaming.name) {
      const { readResourceFolder, resourceCommand } = await import('../client/resources');
      const directory = await readResourceFolder(renaming.folderId);
      const entry = directory.entries.find(entry => entry.courseId === renaming.id);
      if (!entry?.revision) throw new Error(tr('library.t.resourceChanged'));
      const parent = entry.path.split('/').slice(0, -1).join('/');
      await resourceCommand({ kind: 'move', projectId: entry.projectId, path: entry.path, targetProjectId: entry.projectId, target: parent ? `${parent}/${trimmed}` : trimmed, revision: entry.revision });
      toast.success(tr('library.t.titleRenamed'));
    }
    setRenaming(null);
    await reload();
  }, []);

  /** 删除资源文件及其记录、字幕、讲义、问答等全部内容 */
  const handleDelete = useCallback(async (row: VideoRow) => {
    // 记录都没了，后台还在转它就没意义了（队列里也要摘掉，否则会给已删除的视频写段）
    const local = await import('./libraryLocal');
    local.cancelTranscriptionNow(row.id);
    useJobStore.getState().drop(row.id);
    const { readResourceFolder, resourceCommand } = await import('../client/resources');
    const directory = await readResourceFolder(row.folderId);
    const entry = directory.entries.find(entry => entry.courseId === row.id);
    if (!entry?.revision) throw new Error(tr('library.t.resourceChanged'));
    await resourceCommand({ kind: 'remove', projectId: entry.projectId, path: entry.path, revision: entry.revision });
    invalidateCoverUrl(row.id);
    toast.success(tr('library.t.deleted'));
    await reload();
  }, []);

  /** 重新解析材料（换索引、修解析失败）：清掉旧块与旧向量再走一遍完整流水线 */
  const reparseMaterial = useCallback(async (row: VideoRow) => {
    const format = row.materialFormat ?? 'pdf';
    useJobStore.getState().drop(row.id);
    toast.info(tr('library.t.reparseStart', { name: row.name }));
    const { startMaterialJobNow } = await import('./libraryLocal');
    void startMaterialJobNow(row.id, format)
      .then(async (res) => {
        toast.success(
          res.scanned
            ? tr('library.t.reparseScanned', { name: row.name })
            : res.empty
              ? tr('library.t.reparseNoText', { name: row.name })
              : tr('library.t.reparseDone', { name: row.name, count: res.parsed }),
        );
        await reload();
      })
      .catch((e) => {
        const text = formatCaughtError(e);
        showError(tr('library.t.reparseFailed', { name: row.name }), text);
      });
  }, []);

  /**
   * 删除确认：桌面端原本是行内 Popconfirm、手机端是 ⋯ 菜单里的 modal.confirm，
   * 合并成同一个 confirmDialog —— 两条路径的文案与结果完全一致，没必要维护两份。
   */
  const askDeleteVideo = useCallback((v: VideoRow) => {
    void confirmDialog({
      headline: tr('library.t.deleteVideoTitle'),
      description: tr('library.t.deleteVideoDescription'),
      confirmText: tr('library.menu.delete'),
      danger: true,
    }).then((ok) => {
      if (ok) void handleDelete(v);
    });
  }, []);

  /**
   * 置顶 / 取消置顶。入口有两处：行内菜单（键盘与触屏可达）与长按拖拽到顶栏左侧。
   * 语义是**组内**排最前（见 groupLibrary 的 byPinned），不是全库独立置顶区。
   */
  const togglePin = useCallback(async (v: VideoRow) => {
    const next = v.pinned === 1 ? 0 : 1;
    await (await import('../client/resources')).resourceCommand({ kind: 'setCoursePinned', courseId: v.id, pinned: next === 1 });
    toast.success(tr(next === 1 ? 'library.t.pinnedToast' : 'library.t.unpinnedToast', { name: v.name }));
    await reload();
  }, []);

  /* ───────────────────────────── 文件夹操作 ───────────────────────────── */

  const openFolderModal = useCallback((mode: 'create' | 'rename', folder?: FolderRow) => {
    setFolderModal(folder ? { mode: 'rename', folder } : { mode: 'create' });
  }, []);

  const confirmFolderModal = useCallback(async (name: string) => {
    if (!folderModal) return;
    const trimmed = name.trim();
    if (!trimmed) {
      toast.warning(tr('library.t.folderNameEmpty'));
      return;
    }
    if (folderModal.mode === 'create') {
      const { readResourceFolder, resourceCommand } = await import('../client/resources');
      if (currentFolder?.folder?.id != null) {
        const directory = await readResourceFolder(currentFolder.folder.id);
        await resourceCommand({ kind: 'createDirectory', projectId: directory.project?.id ?? directory.rootId, path: directory.path ? `${directory.path}/${trimmed}` : trimmed });
      } else await resourceCommand({ kind: 'createFolder', name: trimmed });
      toast.success(tr('library.t.folderCreated', { name: trimmed }));
    } else if (trimmed !== folderModal.folder.name) {
      const { readResourceFolder, resourceCommand } = await import('../client/resources');
      const directory = await readResourceFolder(folderModal.folder.id!);
      if (!directory.project) throw new Error(tr('library.t.dirGone'));
      if (!directory.path) await resourceCommand({ kind: 'renameFolder', projectId: directory.project.id, name: trimmed });
      else {
        const parent = await readResourceFolder(folderModal.folder.parentId);
        const entry = parent.entries.find(entry => entry.folderId === folderModal.folder.id);
        if (!entry?.revision) throw new Error(tr('library.t.dirChanged'));
        const prefix = entry.path.split('/').slice(0, -1).join('/');
        await resourceCommand({ kind: 'move', projectId: entry.projectId, path: entry.path, targetProjectId: entry.projectId, target: prefix ? `${prefix}/${trimmed}` : trimmed, revision: entry.revision });
      }
      toast.success(tr('library.t.folderRenamed'));
    }
    setFolderModal(null);
    await reload();
  }, []);

  /** 删除文件夹：组内视频移回未分类，视频本体与内容不动 */
  const handleDeleteFolder = useCallback(async (folder: FolderRow) => {
    const { readResourceFolder, resourceCommand } = await import('../client/resources');
    const directory = await readResourceFolder(folder.id);
    if (!directory.project) throw new Error(tr('library.t.dirGone'));
    if (!directory.path) await resourceCommand({ kind: 'trash', projectId: directory.project.id });
    else {
      const parent = await readResourceFolder(folder.parentId);
      const entry = parent.entries.find(entry => entry.folderId === folder.id);
      if (!entry?.revision) throw new Error(tr('library.t.dirChanged'));
      await resourceCommand({ kind: 'remove', projectId: entry.projectId, path: entry.path, revision: entry.revision });
    }
    toast.success(tr('library.t.folderRemoved'));
    await reload();
  }, []);

  const confirmDeleteFolder = useCallback((folder: FolderRow, _count: number) => {
    const row = document.querySelector<HTMLElement>(`[data-group-key="folder:${CSS.escape(String(folder.id))}"]`);
    void popconfirm({
      headline: tr('library.t.deleteFolderTitle', { name: folder.name }),
      description: tr('library.t.deleteFolderDescription'),
      confirmText: tr('library.menu.delete'),
      danger: true,
      testId: 'folder-delete-popconfirm',
    }, row).then((ok) => {
      if (ok) void handleDeleteFolder(folder);
    });
  }, []);

  const setVideoFolder = useCallback(async (videoId: string, folderId: number | null) => {
    await db.videos
      .where('id')
      .equals(videoId)
      .modify((v) => {
        if (folderId == null) delete v.folderId;
        else v.folderId = folderId;
      });
  }, []);

  const confirmMove = useCallback(async (folderId: number | null) => {
    if (!moving) return;
    await setVideoFolder(moving.id, folderId);
    toast.success(tr('library.t.moved'));
    setMoving(null);
    await reload();
  }, []);

  /** 移动弹窗内当场新建文件夹并选中 */
  const createFolderInMove = useCallback(async (name: string) => {
    const project = await (await import('../client/resources')).resourceCommand({ kind: 'createFolder', name }) as unknown as { folderId: number };
    await reload();
    return project.folderId;
  }, []);

  const applyFolderColor = useCallback(async (folderId: number, color: ResourceFolderColor) => {
    try {
      const { readResourceFolder, resourceCommand } = await import('../client/resources');
      const directory = await readResourceFolder(folderId);
      await resourceCommand({ kind: 'folderColor', projectId: directory.project?.id ?? directory.rootId, path: directory.path, color });
      await reload();
    } catch (error) {
      toast.error(tr('library.t.folderColorFailed', { message: formatCaughtError(error) }));
    }
  }, []);

  /* ───────────────────────────── 访达拖放（HTML5 通道） ───────────────────────────── */

  const moveFinderItems = useCallback(async (keys: string[], target: number | null) => {
    try {
      const placements = await moveLibraryItems(keys, target);
      setLastMove(placements);
      const targetName = target == null ? tr('library.path.allResources') : folders.find((folder) => folder.id === target)?.name;
      setMoveNotice({ text: placements.length ? tr('library.t.moveCountToast', { count: keys.length, name: targetName }) : tr('library.t.alreadyHere') });
      setSelection(new Set(target === (currentFolder?.folder?.id ?? null) ? keys : target != null ? [`folder:${target}`] : []));
      await reload();
    } catch (error) {
      setMoveNotice({ text: tr('library.t.moveFailed', { message: formatCaughtError(error) }), error: true });
    }
  }, []);

  const undoFinderMove = useCallback(async () => {
    if (undoingMove) return;
    setUndoingMove(true);
    try {
      await undoLibraryMove(lastMove);
      setLastMove([]);
      setMoveNotice({ text: tr('library.t.moveUndone') });
      setSelection(new Set());
      await reload();
    } catch (error) {
      setMoveNotice({ text: tr('library.t.undoFailed', { message: formatCaughtError(error) }), error: true });
    } finally { setUndoingMove(false); }
  }, []);

  const startFinderDrag = useCallback((event: { currentTarget: HTMLElement; dataTransfer?: DataTransfer }, key: string) => {
    const keys = (finderPressSelection.current.includes(key) ? finderPressSelection.current : selection.has(key) ? [...selection] : [key])
      .filter((item) => item.startsWith('file:') || item.startsWith('folder:'));
    finderDragKeys.current = keys;
    setFinderDragging(keys);
    dragOrigin.current = folderKey;
    springOpened.current = false;
    finderDropCommitted.current = false;
    setDropHint(tr('library.t.dragHintIdle'));
    setDropHintInvalid(false);
    dragImage.current?.remove();
    const preview = document.createElement('div');
    preview.className = 'finder-drag-preview';
    const icon = event.currentTarget.querySelector('.finder-item__icon')?.cloneNode(true);
    if (icon) preview.append(icon);
    const label = document.createElement('span');
    label.className = 'finder-drag-preview__name';
    label.textContent = event.currentTarget.querySelector('.finder-item__name')?.textContent ?? tr('library.t.ghostFallback');
    preview.append(label);
    if (keys.length > 1) {
      preview.dataset.multiple = 'true';
      const badge = document.createElement('span');
      badge.className = 'finder-drag-preview__badge';
      badge.textContent = String(keys.length);
      preview.append(badge);
    }
    document.body.append(preview);
    dragImage.current = preview;
    if (event.dataTransfer) {
      event.dataTransfer.setDragImage(preview, 34, 34);
      event.dataTransfer.setData('application/x-library-items', JSON.stringify(keys));
      event.dataTransfer.effectAllowed = 'move';
    }
    setSelection(new Set(keys));
  }, []);

  const endFinderDrag = useCallback(() => {
    clearSpring();
    if (springOpened.current && !finderDropCommitted.current) {
      setFolderHistory((history) => ({ ...history, entries: [...history.entries.slice(0, history.index), dragOrigin.current] }));
    }
    finderDragKeys.current = [];
    setFinderDragging([]);
    setDropFolder(null);
    setDropHint('');
    setDropHintInvalid(false);
    dragImage.current?.remove();
    dragImage.current = null;
  }, []);

  const updateFinderDrop = useCallback((target: number | null, spring = false) => {
    const valid = validFolderDrop(folders, finderDragKeys.current, target);
    const targetKey = String(target ?? 'root');
    const sameFolder = finderDragKeys.current.every((key) => key.startsWith('folder:')
      ? (folders.find((folder) => folder.id === Number(key.slice(7)))?.parentId ?? null) === target
      : (videos.find((video) => video.id === key.slice(5))?.folderId ?? null) === target);
    setDropFolder(valid ? targetKey : null);
    setDropHintInvalid(!valid);
    const name = target == null ? tr('library.path.allResources') : folders.find((folder) => folder.id === target)?.name;
    setDropHint(!valid ? tr('library.drag.cannot') : sameFolder ? tr('library.drag.alreadyIn', { name }) : spring ? tr('library.drag.willMoveSpring', { count: finderDragKeys.current.length, name }) : tr('library.drag.willMove', { count: finderDragKeys.current.length, name }));
    if (spring && valid && targetKey !== String(currentFolder?.folder?.id ?? 'root')) {
      if (springTarget.current !== targetKey) {
        clearSpring();
        springTarget.current = targetKey;
        springTimer.current = setTimeout(() => {
          springOpened.current = true;
          setFolderHistory((history) => ({ ...history, entries: [...history.entries.slice(0, history.index), target == null ? null : String(target)] }));
          setSelection(new Set(finderDragKeys.current));
          setSearchText('');
          setFilter('all');
          setDropFolder(null);
          setDropHint(tr('library.drag.opened', { name }));
          if (canvasRef.current) canvasRef.current.scrollTop = 0;
          clearSpring();
        }, FOLDER_SPRING_OPEN_MS);
      }
    } else clearSpring();
    return valid;
  }, []);

  const commitFinderDrop = useCallback((target: number | null) => {
    const keys = finderDragKeys.current;
    if (validFolderDrop(folders, keys, target)) {
      finderDropCommitted.current = true;
      void moveFinderItems(keys, target);
    }
    endFinderDrag();
  }, []);

  const folderDropProps = useCallback((target: number | null, spring = false) => {
    const handlers = {
      onDragOver: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('application/x-library-items')) return;
        event.preventDefault();
        event.stopPropagation();
        if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) {
          event.dataTransfer.dropEffect = 'none';
          clearSpring();
          setDropFolder(null);
          return;
        }
        event.dataTransfer.dropEffect = updateFinderDrop(target, spring) ? 'move' : 'none';
      },
      onDragLeave: (event: React.DragEvent) => {
        // Child-to-padding transitions fire dragleave after the new target's
        // dragenter. Do not erase that new highlight; the canvas resolves it.
        const window = event.currentTarget.closest('.finder-window');
        if (!window?.contains(event.relatedTarget as Node | null)) { clearSpring(); setDropFolder(null); setDropHint(tr('library.t.dragHintIdle')); }
      },
      onDrop: (event: React.DragEvent) => {
        if (!event.dataTransfer.types.includes('application/x-library-items')) return;
        event.preventDefault();
        event.stopPropagation();
        if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) return;
        setDropFolder(null);
        clearSpring();
        commitFinderDrop(target);
      },
    };
    return { ...handlers, onDragEnter: handlers.onDragOver };
  }, []);

  const pathDropProps = useCallback((target: number | null) => {
    const props = folderDropProps(target, true);
    return { onDragEnterCapture: props.onDragOver, onDragOverCapture: props.onDragOver, onDropCapture: props.onDrop, onDragLeave: props.onDragLeave };
  }, []);

  // Resolve the entire option at the canvas boundary, before React Aria's
  // item/press handlers can swallow native drag events on its descendants.
  const finderCanvasDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('application/x-library-items')) return;
    const folder = (event.target as Element).closest<HTMLElement>('[data-group-key]');
    folderDropProps(folder ? Number(folder.dataset.groupKey) : currentFolder?.folder?.id ?? null, !!folder).onDragOver(event);
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientY < rect.top + 40) event.currentTarget.scrollBy(0, -16);
    else if (event.clientY > rect.bottom - 40) event.currentTarget.scrollBy(0, 16);
  }, []);

  /* ───────────────────────────── 指针拖拽（自定义通道） ───────────────────────────── */

  // Internal moves use pointer events, not the host WebView's HTML drag session.
  // Native file imports remain on the existing HTML drag-and-drop path.
  const pointerDragActions = useRef({ startFinderDrag, updateFinderDrop, commitFinderDrop, endFinderDrag });
  pointerDragActions.current = { startFinderDrag, updateFinderDrop, commitFinderDrop, endFinderDrag };
  const pointerDragCleanup = useRef<(() => void) | null>(null);
  const suppressFinderClick = useRef(false);
  useEffect(() => () => pointerDragCleanup.current?.(), []);

  const beginFinderPointer = (event: React.PointerEvent<HTMLDivElement>) => {
    finderPressSelection.current = [...selection];
    if (event.button !== 0 || event.pointerType === 'touch') return;
    const item = (event.target as Element).closest<HTMLElement>('.finder-item');
    if (item?.dataset.systemFile || item?.dataset.systemFolder) return;
    const content = item?.querySelector<HTMLElement>('.finder-item__content');
    if (!item || !content) return;
    const key = item.dataset.groupKey ? `folder:${item.dataset.groupKey}` : `file:${item.dataset.videoId}`;
    pointerDragCleanup.current?.();
    suppressFinderClick.current = false;
    const startX = event.clientX;
    const startY = event.clientY;
    const pointerId = event.pointerId;
    let active = false;
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!active) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
        active = true;
        suppressFinderClick.current = true;
        pointerDragActions.current.startFinderDrag({ currentTarget: content }, key);
        window.getSelection()?.removeAllRanges();
      }
      e.preventDefault();
      if (dragImage.current) {
        dragImage.current.style.left = '0';
        dragImage.current.style.transform = `translate(${e.clientX + 16}px, ${e.clientY + 16}px)`;
      }
      const destination = dropTargetAt(e.clientX, e.clientY);
      if (destination) pointerDragActions.current.updateFinderDrop(destination.target, destination.spring);
      else { clearSpring(); setDropFolder(null); setDropHint(tr('library.drag.idleEsc')); setDropHintInvalid(false); }
      const canvas = canvasRef.current;
      if (canvas) {
        const step = autoScrollDelta(canvas.getBoundingClientRect(), e.clientX, e.clientY);
        if (step) canvas.scrollBy(0, step);
      }
    };
    const finish = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (active) {
        const destination = dropTargetAt(e.clientX, e.clientY);
        if (destination) pointerDragActions.current.commitFinderDrop(destination.target);
        else pointerDragActions.current.endFinderDrag();
      }
      pointerDragCleanup.current?.();
    };
    const cancel = () => { if (active) pointerDragActions.current.endFinderDrag(); pointerDragCleanup.current?.(); };
    const keydown = (e: KeyboardEvent) => { if (e.key === 'Escape' && active) { e.preventDefault(); e.stopPropagation(); cancel(); } };
    window.addEventListener('pointermove', move, { passive: false, capture: true });
    window.addEventListener('pointerup', finish, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', keydown, true);
    pointerDragCleanup.current = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', finish, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', keydown, true);
      pointerDragCleanup.current = null;
    };
  };

  /* ───────────────────────────── 单卡拖拽（置顶 / 删除 / 移入） ───────────────────────────── */

  const itemDrag = useLibraryItemDrag({
    headers: headerRefs,
    pinZone: pinZoneRef,
    deleteZone: deleteZoneRef,
    onPin: (video) => togglePin(video),
    onDelete: (video) => askDeleteVideo(video),
    onMoveTo: async (video, target) => {
      await setVideoFolder(video.id, target);
      const name = target == null ? tr('library.t.uncategorized') : folders.find((f) => f.id === target)?.name;
      toast.success(tr('library.t.movedInto', { name }));
      await reload();
    },
  });

  /* ───────────────────────────── 渲染 ───────────────────────────── */

  const detailsVideo = details ? videos.find((video) => video.id === details.id) ?? details : null;

  return (
    <>
      <LibraryFrame bare={Boolean(importing)}
        title={tr('library.chrome.page')}
        wide
        fill
        rootClassName="page-library"
        /* 顶栏右上角那颗设置图标撤掉（2026-10-15，与 AI 助手页同一口径）：
           设置入口统一收在侧栏底部的 `railFooter`（窄屏在抽屉里）——
           同一个入口在一条顶栏里露两次没有必要。 */
      >
        {!importing && SHOW_PWA_HINT && (
          // 标题留结论（该做什么），「为什么」收进问号——那段解释在手机上要占四行，
          // 而它只在 iOS 非独立模式下出现，正好是最缺横向空间的那一档。
          <Banner
            variant="warning"
            testId="pwa-hint"
            icon={<Sym name="warning" />}
            title={tr('library.chrome.pwaTitle')}
            help={
              <HelpTip headline={tr('library.chrome.pwaHelp')} label={tr('library.chrome.pwaHelpLabel')} testId="pwa-hint-help">
                <p>
                  在普通标签页中，若连续 7 天未打开，系统可能自动清除已导入的视频和字幕；
                  从主屏幕打开则不会被清理。
                </p>
              </HelpTip>
            }
          />
        )}

        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          dropActive={dropActive}
          onDropActiveChange={setDropActive}
          onDropFiles={(files) => {
            const accepted = files.filter(isImportable);
            const skipped = files.length - accepted.length;
            if (skipped) toast.warning(tr('library.t.skippedUnsupported', { count: skipped }));
            if (accepted.length) setImportOpen(false);
            for (const file of accepted) enqueue(file);
          }}
          onPickFile={() => nativeInputRef.current?.click()}
          onOpenBili={() => { setImportOpen(false); setBiliOpen(true); }}
        />
        <input ref={nativeInputRef} data-testid="import-input" type="file" multiple tabIndex={-1} aria-label={tr('library.aria.pickFile')} onChange={handleNativePick} style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden' }} />

        <ImportTaskList tasks={tasks} onDismiss={(key) => setTasks((prev) => prev.filter((x) => x.key !== key))} />

        {!importing && <ExplorerCanvas
          title={tr('library.chrome.page')}
          view={view}
          sort={sort}
          filter={filter}
          isMobile={isMobile}
          mobileManaging={mobileManaging}
          folderTitle={folderTitle}
          inSystemFolder={inSystemFolder}
          inMemoryFolder={inMemoryFolder}
          systemPath={systemPath}
          folderKey={folderKey ?? null}
          folderHistory={folderHistory}
          currentFolder={currentFolder}
          folderPath={folderPath}
          selection={selection}
          selectedVideo={selectedVideo}
          selectedFolder={selectedFolder}
          hasFilters={hasFilters}
          searchQuery={searchQuery}
          searchText={searchText}
          visibleCount={visibleCount}
          showSystemFolder={showSystemFolder}
          systemPage={systemPage}
          systemLoading={systemLoading}
          systemError={systemError}
          systemOffset={systemOffset}
          folderTiles={folderTiles}
          renderedFolders={renderedFolders}
          renderedVideos={renderedVideos}
          displayedVideos={displayedVideos}
          projectTiles={projectTiles}
          projectError={projectLibrary.error}
          onRetryProjects={projectLibrary.retry}
          showSkeleton={showSkeleton}
          isFirstLoad={isFirstLoad}
          loadState={loadState}
          loadError={loadError}
          onRetryLoad={() => { setLoadState('loading'); setLoadError(null); void reload(); }}
          dropActive={dropActive}
          setImportOpen={setImportOpen}
          clearFilters={clearFilters}
          openFolder={openFolder}
          travelFolder={travelFolder}
          openItem={openItem}
          setSearchText={setSearchText}
          setFilter={setFilter}
          setSort={setSort}
          setView={setView}
          setSelection={setSelection}
          setMobileManaging={setMobileManaging}
          setSystemOffset={setSystemOffset}
          setDetails={setDetails}
          searchInputRef={searchInputRef}
          canvasRef={canvasRef}
          contextAnchor={contextAnchor}
          contextPoint={contextPoint}
          setContextPoint={setContextPoint}
          actionMenuOpen={actionMenuOpen}
          setActionMenuOpen={setActionMenuOpen}
          dragState={itemDrag.drag}
          pinZoneRef={pinZoneRef}
          deleteZoneRef={deleteZoneRef}
          finderDragging={finderDragging}
          dropFolder={dropFolder}
          dropHint={dropHint}
          dropHintInvalid={dropHintInvalid}
          subfolderCounts={subfolderCounts}
          folderDropProps={folderDropProps}
          pathDropProps={pathDropProps}
          onCanvasDragOver={finderCanvasDragOver}
          onCanvasDropCapture={(event) => {
            if ((event.target as Element).closest('[data-project-folder]')) { event.preventDefault(); event.stopPropagation(); return; }
            const folder = (event.target as Element).closest<HTMLElement>('[data-group-key]');
            folderDropProps(folder ? Number(folder.dataset.groupKey) : currentFolder?.folder?.id ?? null).onDrop(event);
          }}
          onFilesDragOver={(event) => {
            if (inSystemFolder || (event.target as Element).closest('[data-system-folder]')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'none';
              setDropActive(false);
              return;
            }
            if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); setDropActive(true); }
            else folderDropProps(currentFolder?.folder?.id ?? null).onDragOver(event);
          }}
          onFilesDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }}
          onFilesDrop={(event) => {
            if (event.dataTransfer.types.includes('application/x-library-items')) folderDropProps(currentFolder?.folder?.id ?? null).onDrop(event);
            else handleDrop(event);
          }}
          onDragStartCapture={(event) => { if ((event.target as Element).closest('.finder-item')) event.preventDefault(); }}
          startFinderDrag={startFinderDrag}
          endFinderDrag={endFinderDrag}
          beginFinderPointer={beginFinderPointer}
          suppressFinderClick={suppressFinderClick}
          marquee={marquee}
          onActionMenu={(key) => {
            if (key === 'open' && selectedKey) openItem(selectedKey);
            if (selectedFolder?.folder) {
              if (key === 'rename') openFolderModal('rename', selectedFolder.folder);
              if (key === 'delete') void confirmDeleteFolder(selectedFolder.folder, selectedFolder.videos.length);
            }
            if (selectedVideo) {
              if (key === 'rename') setRenaming(selectedVideo);
              if (key === 'move') setMoving(selectedVideo);
              if (key === 'pin') void togglePin(selectedVideo);
              if (key === 'details') setDetails(selectedVideo);
              if (key === 'delete') askDeleteVideo(selectedVideo);
            }
          }}
          onOpenFolderModal={openFolderModal}
          onDeleteFolder={confirmDeleteFolder}
          onRenameVideo={setRenaming}
          onMoveVideo={setMoving}
          onTogglePin={togglePin}
          onDeleteVideo={askDeleteVideo}
          onFolderColor={applyFolderColor}
          moveNotice={moveNotice}
          lastMoveLength={lastMove.length}
          undoingMove={undoingMove}
          onUndoMove={() => void undoFinderMove()}
          onDismissMoveNotice={() => setMoveNotice(null)}
        />}

        <DetailsDialog video={details} onClose={() => setDetails(null)}>
          {detailsVideo && <VideoRowCard
            video={detailsVideo}
            isMobile={isMobile}
            dragging={itemDrag.drag?.video.id === detailsVideo.id}
            onPlay={() => openPlayer(detailsVideo.id)}
            onRename={() => setRenaming(detailsVideo)}
            onMove={() => setMoving(detailsVideo)}
            onTogglePin={() => void togglePin(detailsVideo)}
            onDelete={() => askDeleteVideo(detailsVideo)}
            onReparse={detailsVideo.kind === 'material' ? () => void reparseMaterial(detailsVideo) : undefined}
            onBeginDrag={(el, pointerId, x, y) => itemDrag.beginDrag(el, pointerId, detailsVideo, x, y)}
            onDragMove={itemDrag.moveDrag}
            onDragEnd={() => void itemDrag.endDrag()}
            onDragCancel={itemDrag.cancelDrag}
          />}
        </DetailsDialog>

        <RenameDialog video={renaming} onClose={() => setRenaming(null)} onConfirm={(name) => void confirmRename(name)} />        <FolderDialog
          mode={folderModal?.mode ?? null}
          folder={folderModal?.mode === 'rename' ? folderModal.folder : null}
          onClose={() => setFolderModal(null)}
          onConfirm={(name) => void confirmFolderModal(name)}
        />
        <MoveDialog
          video={moving}
          folders={folders}
          onClose={() => setMoving(null)}
          onConfirm={(folderId) => void confirmMove(folderId)}
          onCreateFolder={createFolderInMove}
        />
      </LibraryFrame>

      {/* B 站导入：只有用户点了「从 B 站导入」才会加载它所在的分包 */}
      {biliOpen && <BiliImportDialog
        open={biliOpen}
        onOpenChange={setBiliOpen}
        onImported={() => void reload()}
        savePage={async (file, subtitles, source) => {
          const key = uuid();
          setTasks((previous) => [...previous, { key, name: file.name, status: 'queued', percent: 0 }]);
          return importOne(file, key, subtitles, source);
        }}
      />}
    </>
  );
}
