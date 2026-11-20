/**
 * 访达式画布：工具栏（导航 / 视图 / 排序筛选 / 搜索）+ 列表（组头、文件夹、系统目录、视频）
 * + 状态栏与路径栏。
 *
 * 从 Library.tsx 拆出来，是因为这一块几乎全是「把已算好的数据画出来」：
 * 数据分组与筛选在 `libraryModel.ts`，拖拽判定在 `libraryDrag.ts` / `useLibraryItemDrag.ts`，
 * 这里只管事件往上抛、结果往下画。所有派生数据（分组、子文件夹计数、可见项）由调用方算好传进来，
 * 本组件不做任何数据变换 —— 这样「数不对」的时候只需要去查一处。
 *
 * 非拖拽的 HTML5 拖放（桌面 / iPad 从「文件」App 拖入）仍在这条链路上：它是浏览器原生
 * 拖拽，与自定义的指针拖拽（移动/排序）是两条独立通道，别混。
 */
import type { ComponentProps } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Button,
  Dropdown,
  Label,
  ListBox,
  SearchField,
  Select,
  ToggleButton,
  ToggleButtonGroup,
} from '@heroui/react';
import { Banner, EmptyState } from '../ui/layout';
import { SkeletonReveal } from '../ui/skeleton';
import { Sym } from '../ui/icons';
import { withViewTransition } from '../utils/viewTransition';
import type { SystemDirectory } from '@wangke/contracts/system';
import type { ProjectDto } from '@wangke/contracts/projects';
import type { ResourceFolderColor } from '@wangke/contracts/resources';
import type { FolderRow, VideoRow } from '../store/db';
import { systemMaterialId } from '../materials/systemFiles';
import { FOLDER_COLORS, FolderIcon } from '../components/FolderIcon';
import { AgentInstructionsIcon } from '../components/AgentInstructionsIcon';
import { formatSize } from '../utils/format';
import type { useMarqueeSelection } from '../utils/useMarqueeSelection';
import { LIBRARY_FILTERS, type LibraryFilter, type LibraryGroup } from './libraryModel';
import { FinderFileIcon, finderProgressText } from './LibraryThumb';
import { LibrarySkeleton } from './LibraryImport';

/** 拖放事件处理器组：组头、路径栏、画布三处共用 */
export interface DropHandlers {
  onDragOver: (event: React.DragEvent) => void;
  onDragEnter: (event: React.DragEvent) => void;
  onDragLeave: (event: React.DragEvent) => void;
  onDrop: (event: React.DragEvent) => void;
}

interface ExplorerCanvasProps {
  title: string;
  view: 'icons' | 'list';
  sort: 'name' | 'recent';
  filter: LibraryFilter;
  isMobile: boolean;
  mobileManaging: boolean;
  folderTitle: string;
  inSystemFolder: boolean;
  inMemoryFolder: boolean;
  systemPath: string;
  folderKey: string | null;
  folderHistory: { entries: (string | null)[]; index: number };
  currentFolder: LibraryGroup | undefined;
  folderPath: FolderRow[];
  selection: Set<string>;
  selectedVideo: VideoRow | undefined;
  selectedFolder: LibraryGroup | undefined;
  hasFilters: boolean;
  searchQuery: string;
  searchText: string;
  visibleCount: number;
  showSystemFolder: boolean;
  systemPage: SystemDirectory;
  systemLoading: boolean;
  systemError: string;
  systemOffset: number;
  folderTiles: LibraryGroup[];
  renderedFolders: LibraryGroup[];
  renderedVideos: VideoRow[];
  displayedVideos: VideoRow[];
  projectTiles: ProjectDto[];
  projectError: string;
  onRetryProjects: () => void;
  showSkeleton: boolean;
  isFirstLoad: boolean;
  loadState: 'loading' | 'ready' | 'error';
  loadError: string | null;
  onRetryLoad: () => void;
  dropActive: boolean;
  setImportOpen: (open: boolean) => void;
  clearFilters: () => void;
  openFolder: (key: string | null) => void;
  travelFolder: (delta: number) => void;
  openItem: (key: string) => void;
  setSearchText: (value: string) => void;
  setFilter: (filter: LibraryFilter) => void;
  setSort: (sort: 'name' | 'recent') => void;
  setView: (view: 'icons' | 'list') => void;
  setSelection: (selection: Set<string>) => void;
  setMobileManaging: (managing: boolean) => void;
  setSystemOffset: (offset: number) => void;
  setDetails: (video: VideoRow) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  contextAnchor: React.RefObject<HTMLSpanElement | null>;
  contextPoint: { x: number; y: number } | null;
  setContextPoint: (point: { x: number; y: number } | null) => void;
  actionMenuOpen: boolean;
  setActionMenuOpen: (open: boolean) => void;
  dragState: { video: VideoRow; x: number; y: number; overKey: string | null; zone: 'pin' | 'delete' | null } | null;
  // 拖拽（指针通道）与原生拖放（HTML5 通道）的接线
  finderDragging: string[];
  dropFolder: string | null;
  dropHint: string;
  /** 提示语是「不能放这里」时的图标开关（按语义传，不比对本地化文案） */
  dropHintInvalid: boolean;
  /** 组 key → 直属子文件夹数 */
  subfolderCounts: Record<string, number>;
  pinZoneRef: React.RefObject<HTMLDivElement | null>;
  deleteZoneRef: React.RefObject<HTMLDivElement | null>;
  folderDropProps: (target: number | null, spring?: boolean) => DropHandlers;
  pathDropProps: (target: number | null) => ComponentProps<'span'>;
  onCanvasDragOver: (event: React.DragEvent<HTMLDivElement>) => void;
  onCanvasDropCapture: (event: React.DragEvent<HTMLDivElement>) => void;
  onFilesDragOver: (event: React.DragEvent) => void;
  onFilesDragLeave: (event: React.DragEvent) => void;
  onFilesDrop: (event: React.DragEvent) => void;
  onDragStartCapture: (event: React.DragEvent) => void;
  startFinderDrag: (event: { currentTarget: HTMLElement; dataTransfer?: DataTransfer }, key: string) => void;
  endFinderDrag: () => void;
  beginFinderPointer: (event: React.PointerEvent<HTMLDivElement>) => void;
  suppressFinderClick: React.RefObject<boolean>;
  marquee: ReturnType<typeof useMarqueeSelection>;
  onActionMenu: (key: string) => void;
  onOpenFolderModal: (mode: 'create' | 'rename', folder?: FolderRow) => void;
  onDeleteFolder: (folder: FolderRow, count: number) => void;
  onRenameVideo: (video: VideoRow) => void;
  onMoveVideo: (video: VideoRow) => void;
  onTogglePin: (video: VideoRow) => void;
  onDeleteVideo: (video: VideoRow) => void;
  onFolderColor: (folderId: number, color: ResourceFolderColor) => void;
  moveNotice: { text: string; error?: boolean } | null;
  lastMoveLength: number;
  undoingMove: boolean;
  onUndoMove: () => void;
  onDismissMoveNotice: () => void;
}

export function ExplorerCanvas(props: ExplorerCanvasProps) {
  const { t: tr } = useTranslation('projects');
  const {
    isMobile, mobileManaging, selection, setSelection, searchInputRef, canvasRef, marquee,
    finderDragging, dropFolder, folderTiles,
  } = props;

  return (
    <section
      className="finder-window"
      aria-label={tr('library.aria.finder')}
      data-mobile={isMobile || undefined}
      data-managing={(isMobile && mobileManaging) || undefined}
      data-drag-active={finderDragging.length > 0 || undefined}
      onDragOver={props.onFilesDragOver}
      onDragLeave={props.onFilesDragLeave}
      onDrop={props.onFilesDrop}
      data-drop-active={props.dropActive || undefined}
    >
      <header className="finder-toolbar">
        <div className="finder-navigation">
          {isMobile
            ? <Button isIconOnly variant="ghost" aria-label={tr('library.aria.back')} isDisabled={!props.currentFolder && !props.inSystemFolder} onPress={() => props.openFolder(props.currentFolder?.folder?.parentId != null ? String(props.currentFolder.folder.parentId) : null)}><Sym name="chevron_left" /></Button>
            : <>
              <Button isIconOnly variant="ghost" aria-label={tr('library.aria.backNav')} isDisabled={props.folderHistory.index === 0} onPress={() => props.travelFolder(-1)}><Sym name="chevron_left" /></Button>
              <Button isIconOnly variant="ghost" aria-label={tr('library.aria.forward')} isDisabled={props.folderHistory.index === props.folderHistory.entries.length - 1} onPress={() => props.travelFolder(1)}><Sym name="chevron_right" /></Button>
            </>}
        </div>
        <h2 className="finder-title" style={props.currentFolder ? { viewTransitionName: `lib-folder-${props.currentFolder.key}` } : undefined}>{props.folderTitle}</h2>
        {isMobile && <Button className="finder-manage" variant="ghost" isDisabled={props.inSystemFolder} onPress={() => { props.setMobileManaging(!mobileManaging); setSelection(new Set()); props.setActionMenuOpen(false); }}>{mobileManaging ? tr('library.chrome.mobileDone') : tr('library.chrome.mobileManageBtn')}</Button>}
        <div className="finder-tools">
          <ToggleButtonGroup className="finder-view-switch" selectionMode="single" disallowEmptySelection selectedKeys={[props.view]} onSelectionChange={(keys) => { const key = [...keys][0]; if (key === 'icons' || key === 'list') withViewTransition(() => props.setView(key)); }} aria-label={tr('library.aria.view')}>
            <ToggleButton id="icons" aria-label={tr('library.aria.iconsView')}><Sym name="grid_view" /></ToggleButton>
            <ToggleButton id="list" aria-label={tr('library.aria.listView')}><Sym name="list" /></ToggleButton>
          </ToggleButtonGroup>
          {/* 排序与筛选是两个值,不再是点完即走的动作菜单:触发器常驻显示当前值,选项前有对勾。(PR35 值型控件规则) */}
          <Select
            className="w-36 max-w-[40vw]"
            aria-label={tr('library.aria.sort')}
            data-testid="library-sort"
            selectedKey={props.sort}
            onSelectionChange={(key) => { if (key === 'name' || key === 'recent') withViewTransition(() => props.setSort(key)); }}
          >
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  <ListBox.Item id="name" textValue={tr('library.sort.name')}>{tr('library.sort.name')}<ListBox.ItemIndicator /></ListBox.Item>
                  <ListBox.Item id="recent" textValue={tr('library.sort.recent')}>{tr('library.sort.recent')}<ListBox.ItemIndicator /></ListBox.Item>
                </ListBox>
              </Select.Popover>
            </Select>
            <Select
              className="w-32 max-w-[40vw]"
              aria-label={tr('library.aria.filter')}
              data-testid="library-filter"
              selectedKey={props.filter}
              onSelectionChange={(key) => { withViewTransition(() => props.setFilter(key as LibraryFilter)); setSelection(new Set()); }}
            >
              <Select.Trigger><Select.Value /><Select.Indicator /></Select.Trigger>
              <Select.Popover>
                <ListBox>
                  {LIBRARY_FILTERS.map((item) => (
                    <ListBox.Item key={item.value} id={item.value} textValue={tr(item.label)}>{tr(item.label)}<ListBox.ItemIndicator /></ListBox.Item>
                  ))}
                </ListBox>
              </Select.Popover>
            </Select>
          <span className="finder-tool-divider" />
          <Button isIconOnly variant="ghost" data-testid="btn-new-folder" aria-label={tr('library.aria.newFolder')} isDisabled={props.inSystemFolder} onPress={() => props.onOpenFolderModal('create')}><Sym name="create_new_folder" /></Button>
          <Button isIconOnly={!isMobile} className="finder-import" variant="ghost" aria-label={tr('library.aria.import')} isDisabled={props.inSystemFolder} onPress={() => props.setImportOpen(true)}><Sym name="upload" />{isMobile && tr('library.aria.importShort')}</Button>
          <div className="finder-item-actions">
            <Dropdown isOpen={props.actionMenuOpen} onOpenChange={(open) => { props.setActionMenuOpen(open); if (!open) props.setContextPoint(null); }}>
              <Dropdown.Trigger className="finder-tool" aria-label={tr('library.aria.selectedActions')} isDisabled={!props.selectedFolder && !props.selectedVideo}><Sym name="more_horiz" /></Dropdown.Trigger>
              <Dropdown.Popover {...(props.contextPoint ? { triggerRef: props.contextAnchor, placement: 'bottom start' as const } : {})}><Dropdown.Menu aria-label={tr('library.aria.itemActions')} onAction={(key) => props.onActionMenu(String(key))}>
                <Dropdown.Item id="open" textValue={tr('library.chrome.open')}>{tr('library.chrome.open')}</Dropdown.Item>
                <Dropdown.Item id="rename" textValue={tr('library.menu.rename')}>{tr('library.menu.rename')}</Dropdown.Item>
                {props.selectedFolder?.folder && <Dropdown.SubmenuTrigger>
                  <Dropdown.Item id="folder-color" textValue={tr('library.aria.folderColor')}><Label>{tr('library.aria.folderColor')}</Label><Dropdown.SubmenuIndicator /></Dropdown.Item>
                  <Dropdown.Popover><Dropdown.Menu aria-label={tr('library.aria.folderColor')} selectionMode="single" selectedKeys={[props.selectedFolder.folder.color ?? 'blue']} onAction={(key) => {
                    const color = FOLDER_COLORS.find((entry) => entry.id === key)?.id;
                    const folderId = props.selectedFolder?.folder?.id;
                    if (color && folderId != null) props.onFolderColor(folderId, color);
                  }}>
                    {FOLDER_COLORS.map((color) => <Dropdown.Item key={color.id} id={color.id} textValue={color.label}>
                      <span className="size-4 shrink-0 rounded-full border border-black/10" style={{ backgroundColor: color.swatch }} aria-hidden="true" />
                      <Label>{color.label}</Label><Dropdown.ItemIndicator />
                    </Dropdown.Item>)}
                  </Dropdown.Menu></Dropdown.Popover>
                </Dropdown.SubmenuTrigger>}
                {props.selectedVideo && <Dropdown.Item id="move" textValue={tr('library.menu.move')}>{tr('library.menu.move')}</Dropdown.Item>}
                {props.selectedVideo && <Dropdown.Item id="pin" textValue={tr('library.menu.pin')}>{props.selectedVideo.pinned === 1 ? tr('library.menu.unpin') : tr('library.menu.pin')}</Dropdown.Item>}
                {props.selectedVideo && <Dropdown.Item id="details" textValue={tr('library.chrome.details')}>{tr('library.chrome.details')}</Dropdown.Item>}
                <Dropdown.Item id="delete" textValue={tr('library.menu.delete')} className="text-danger">{tr('library.menu.delete')}</Dropdown.Item>
              </Dropdown.Menu></Dropdown.Popover>
            </Dropdown>
          </div>
        </div>
        <SearchField className="finder-search" aria-label={props.currentFolder || props.inSystemFolder ? tr('library.chrome.searchFolder') : tr('library.chrome.searchAll')} value={props.searchText} onChange={(value) => { props.setSearchText(value); setSelection(new Set()); }}>
          <SearchField.Group><SearchField.SearchIcon /><SearchField.Input ref={searchInputRef} data-testid="library-search" placeholder={tr('library.chrome.searchPlaceholder')} /><SearchField.ClearButton /></SearchField.Group>
        </SearchField>
      </header>
      {props.projectError && <Banner variant="error" title={tr('library.t.projectsLoadFailed')} description={props.projectError} action={<Button size="sm" onPress={props.onRetryProjects}>{tr('retry')}</Button>} />}
      {props.hasFilters && <div className="finder-search-scope">
        <span>{tr('library.search.scope', { scope: props.folderTitle })}{props.filter !== 'all' ? ` · ${tr(LIBRARY_FILTERS.find((item) => item.value === props.filter)!.label)}` : ''}</span>
        <Button variant="ghost" size="sm" onPress={props.clearFilters}>{tr('library.search.clearFilters')}</Button>
      </div>}
      <div
        className="finder-canvas"
        data-testid="video-list"
        onClick={(event) => { if (event.target === event.currentTarget) setSelection(new Set()); }}
        ref={canvasRef}
        data-folder-id={props.currentFolder?.folder?.id ?? ''}
        onDragStartCapture={props.onDragStartCapture}
        onDragEnterCapture={props.onCanvasDragOver}
        onDragOverCapture={props.onCanvasDragOver}
        onDropCapture={props.onCanvasDropCapture}
        onPointerDownCapture={isMobile ? undefined : props.beginFinderPointer}
        onPointerDown={isMobile ? undefined : marquee.onPointerDown}
        onClickCapture={(event) => {
          if (props.suppressFinderClick.current) { event.preventDefault(); event.stopPropagation(); props.suppressFinderClick.current = false; }
          else marquee.onClickCapture(event);
        }}
        onContextMenu={(event) => {
          const item = (event.target as HTMLElement).closest<HTMLElement>('[data-video-id], [data-group-key]');
          if (!item) return;
          event.preventDefault();
          const key = item.dataset.videoId ? `file:${item.dataset.videoId}` : `folder:${item.dataset.groupKey}`;
          setSelection(new Set([key]));
          if (isMobile) props.setMobileManaging(true);
          props.setContextPoint(isMobile ? null : { x: event.clientX, y: event.clientY });
          props.setActionMenuOpen(true);
        }}
      >
        <span ref={props.contextAnchor} aria-hidden="true" style={{ position: 'fixed', left: props.contextPoint?.x ?? 0, top: props.contextPoint?.y ?? 0, width: 1, height: 1, pointerEvents: 'none' }} />
        <SkeletonReveal show={props.showSkeleton} skeleton={<LibrarySkeleton count={isMobile ? 3 : 6} />}>
          {/* 只在首屏把内容让给骨架；其余任何时刻（包括将来真给刷新加了 loading 态）
              都要继续渲染手上的列表，不能把已有内容清空 —— 这是「台上至少有一层」那条
              不变量在调用侧的对应写法，与 showSkeleton 的判据保持一致。 */}
          {props.isFirstLoad ? null : props.loadState === 'error' ? (
            <Banner
              variant="error"
              testId="library-load-error"
              icon={<Sym name="error" />}
              title={tr('library.t.libraryLoadFailed')}
              description={props.loadError ?? tr('library.t.libraryLoadFailedDesc')}
              action={
                <Button variant="secondary" data-testid="btn-library-retry" onPress={props.onRetryLoad}>
                  重试
                </Button>
              }
            />
          ) : !props.inSystemFolder && props.renderedVideos.length === 0 && props.folderTiles.length === 0 && !props.projectTiles.length && !props.systemPage.files.length && !(props.systemPage.directories ?? []).length && !props.showSystemFolder && !props.hasFilters ? (
            // 不再给 description：投放区已经把「点哪儿导入 / 从 B 站导入 / 只存本机不上传」说完了。
            <EmptyState testId="empty-state" icon={<Sym name="folder_open" />} title={tr('library.empty.title')} action={<Button variant="secondary" onPress={() => props.setImportOpen(true)}>{tr('library.empty.import')}</Button>} />
          ) : props.hasFilters && props.visibleCount === 0 && !props.systemLoading && !props.systemError ? (
            <EmptyState
              testId="library-no-results"
              icon={<Sym name="search" />}
              title={tr('library.empty.noMatch')}
              description={props.searchQuery ? tr('library.t.noMatchSearchDesc') : tr('library.t.noMatchFilterDesc')}
              action={<Button variant="secondary" onPress={props.clearFilters}>{tr('library.chrome.clearSearchFilters')}</Button>}
            />
          ) : (
            <>
              {props.view === 'list' && <div className="finder-list-heading" aria-hidden="true"><span>{tr('library.chrome.listName')}</span><span>{tr('library.chrome.listSize')}</span><span>{tr('library.chrome.listDate')}</span><span>{tr('library.chrome.listKind')}</span></div>}
              <ListBox
                aria-label={props.folderTitle}
                className={`finder-items finder-items--${props.view}`}
                layout={props.view === 'icons' ? 'grid' : 'stack'}
                selectionMode={isMobile ? mobileManaging ? 'single' : 'none' : 'multiple'}
                selectionBehavior={isMobile ? 'toggle' : 'replace'}
                selectedKeys={selection}
                onSelectionChange={(keys) => setSelection(new Set([...keys].map(String)))}
                onAction={isMobile && mobileManaging ? undefined : (key) => props.openItem(String(key))}
                onClick={(event) => { if (event.target === event.currentTarget) setSelection(new Set()); }}
              >
                {props.showSystemFolder && <ListBox.Item id="system:folder" textValue="system" className="finder-item finder-item--folder" data-testid="system-folder" data-system-folder="true" data-selection-key="system:folder">
                  <span className="finder-item__content">
                    <span className="finder-item__icon"><FolderIcon color="gray" /></span>
                    <span className="finder-item__name" title="/system">system</span>
                    <span className="finder-item__meta">系统配置与 Bot 资源</span>
                    <span className="finder-item__date">应用系统文件</span>
                    <span className="finder-item__kind">{tr('library.chrome.systemFolder')}</span>
                  </span>
                </ListBox.Item>}
                {(props.inSystemFolder && (props.filter === 'all' || props.filter === 'material') ? props.systemPage.directories ?? [] : []).map(directory => {
                  const name = directory.split('/').at(-1)!;
                  const isMemory = directory === '/system/memory';
                  const id = `system:folder:${directory}`;
                  return <ListBox.Item key={directory} id={id} textValue={name} className="finder-item finder-item--folder" data-testid={isMemory ? 'memory-folder' : 'system-skill-folder'} data-system-folder="true" data-selection-key={id}>
                    <span className="finder-item__content">
                      <span className="finder-item__icon"><FolderIcon color="gray" /></span>
                      <span className="finder-item__name" title={directory}>{name}</span>
                      <span className="finder-item__meta">{isMemory ? tr('library.chrome.botMemory') : tr('library.chrome.botInstallable')}</span>
                      <span className="finder-item__date">{isMemory ? tr('library.chrome.botShared') : tr('library.chrome.realFolder')}</span>
                      <span className="finder-item__kind">{tr('library.chrome.systemFolder')}</span>
                    </span>
                  </ListBox.Item>;
                })}
                {(props.inSystemFolder && (props.filter === 'all' || props.filter === 'material') ? props.systemPage.files : []).map(file => {
                  const id = systemMaterialId(file.path)!;
                  const isAgent = file.path === '/system/AGENTS.md';
                  return <ListBox.Item key={file.path} id={id} textValue={file.name} className="finder-item" data-testid={isAgent ? 'agent-instructions-file' : file.kind === 'mcp' ? 'mcp-config-file' : file.kind === 'skill' ? 'skill-file' : 'memory-file'} data-system-file={file.path} data-selection-key={id}>
                    <span className="finder-item__content">
                      <span className="finder-item__icon">{isAgent ? <AgentInstructionsIcon /> : <Sym name="description" className="text-6xl text-accent" />}</span>
                      <span className="finder-item__name" title={file.path}>{file.name}</span>
                      <span className="finder-item__meta" title={`${file.kind ?? 'system'} · r${file.revision} · ${file.sha256 ?? ''} · ${file.source ?? ''}`}>{isAgent ? tr('library.chrome.agentDirective') : file.summary ?? `${file.kind ?? tr('library.chrome.systemFile')} · r${file.revision}`}{file.kind === 'skill' && file.version ? ` · v${file.version}` : ''}</span>
                      <span className="finder-item__date">{file.updatedAt ? new Date(file.updatedAt).toLocaleDateString() : ''}</span>
                      <span className="finder-item__kind">{isAgent ? tr('library.chrome.kindSystemMarkdown') : file.kind === 'board' ? tr('library.chrome.kindBoard') : file.kind === 'mcp' ? tr('library.chrome.kindMcp') : file.kind === 'skill' ? tr('library.chrome.kindSkill') : file.kind === 'diary' ? tr('library.chrome.kindDiary') : file.kind === 'note' ? tr('library.chrome.kindNote') : tr('library.chrome.kindMemory')}</span>
                    </span>
                  </ListBox.Item>;
                })}
                {props.projectTiles.map(project => <ListBox.Item key={`project:${project.id}`} id={`project:${project.id}`} textValue={project.name} className="finder-item finder-item--folder" data-project-folder="true" data-system-folder="true" data-selection-key={`project:${project.id}`}>
                  <span className="finder-item__content">
                    <span className="finder-item__icon"><FolderIcon color="blue" /></span>
                    <span className="finder-item__name" title={project.workspacePath}>{project.name}</span>
                    <span className="finder-item__meta">项目工作区</span>
                    <span className="finder-item__date">{new Date(project.createdAt).toLocaleDateString()}</span>
                    <span className="finder-item__kind">项目文件夹</span>
                  </span>
                </ListBox.Item>)}
                {props.renderedFolders.map((group) => {
                  const hidden = !folderTiles.some((folder) => folder.key === group.key);
                  const draggingThis = finderDragging.includes(`folder:${group.key}`);
                  return <ListBox.Item
                    key={`folder:${group.key}`}
                    id={`folder:${group.key}`}
                    textValue={group.name}
                    className="finder-item"
                    data-testid="group-header"
                    data-group-key={group.key}
                    data-drop-target={dropFolder === group.key || undefined}
                    data-dragging={draggingThis || undefined}
                    hidden={hidden}
                  >
                    <span className="finder-item__content" data-drop-target={dropFolder === group.key || undefined} data-dragging={draggingThis || undefined} data-hidden={hidden || undefined} style={{ viewTransitionName: `lib-folder-${group.key}` }} {...props.folderDropProps(group.folder!.id!, true)} draggable onDragStart={(event) => props.startFinderDrag(event, `folder:${group.key}`)} onDragEnd={props.endFinderDrag}>
                      <span className="finder-item__icon"><FolderIcon color={group.folder?.color} /></span>
                      <span className="finder-item__name" title={group.name}>{group.name}</span>
                      <span className="finder-item__meta">{group.videos.length + (props.subfolderCounts[group.key] ?? 0)} 个项目</span>
                      <span className="finder-item__date">{new Date(group.folder!.createdAt).toLocaleDateString()}</span>
                      <span className="finder-item__kind">文件夹</span>
                    </span>
                  </ListBox.Item>;
                })}
                {props.renderedVideos.map((video) => {
                  const shown = props.displayedVideos.some((row) => row.id === video.id);
                  const draggingThis = finderDragging.includes(`file:${video.id}`);
                  return <ListBox.Item key={`file:${video.id}`} id={`file:${video.id}`} textValue={video.name} className="finder-item" data-testid="video-item" data-video-id={video.id} hidden={!shown} data-dragging={draggingThis || undefined}>
                    <span className="finder-item__content"
                      data-dragging={draggingThis || undefined}
                      data-hidden={!shown || undefined}
                      draggable
                      onDragStart={(event) => props.startFinderDrag(event, `file:${video.id}`)}
                      onDragEnd={props.endFinderDrag}
                    >
                      <span className="finder-item__icon"><FinderFileIcon video={video} /></span>
                      {/* 与列表行共用 `lib-title-${id}`:图标视图打开播放页时标题长成页标题(封面仍是列表行专属,图标帧比例相差太大,不带)。(PR38 转场共享链) */}
                      <span className="finder-item__name" title={video.name} style={{ viewTransitionName: `lib-title-${video.id}` }}>{video.name}{video.kind === 'material' && video.materialFormat && !video.name.toLowerCase().endsWith(`.${video.materialFormat}`) ? `.${video.materialFormat}` : ''}</span>
                      <span className="finder-item__meta" title={formatSize(video.size)}>{finderProgressText(video) ?? formatSize(video.size)}</span>
                      <span className="finder-item__date">{new Date(video.createdAt).toLocaleDateString()}</span>
                      <span className="finder-item__kind">{video.kind === 'material' ? video.materialFormat?.toUpperCase() ?? tr('library.chrome.kindDoc') : tr('library.chrome.kindVideo')}</span>
                    </span>
                  </ListBox.Item>;
                })}
              </ListBox>
              {props.inSystemFolder && props.systemError && <p role="alert" className="text-danger">{tr('library.system.readError', { message: props.systemError })}</p>}
              {props.inSystemFolder && props.systemLoading && !props.systemPage.files.length && !(props.systemPage.directories ?? []).length && <p role="status">{tr('library.system.reading')}</p>}
              {props.inMemoryFolder && !props.systemLoading && !props.systemError && !props.systemPage.files.length && !(props.systemPage.directories ?? []).length && !props.hasFilters && <EmptyState icon={<Sym name="folder_open" />} title={tr('library.empty.botTitle')} description={tr('library.empty.botDescription')} />}
              {props.inSystemFolder && (props.systemOffset > 0 || props.systemPage.nextOffset !== null) && <div className="flex gap-2 p-3">
                <Button variant="secondary" isDisabled={props.systemLoading || props.systemOffset === 0} onPress={() => props.setSystemOffset(Math.max(0, props.systemOffset - 50))}>{tr('library.system.prevPage')}</Button>
                <Button variant="secondary" isDisabled={props.systemLoading || props.systemPage.nextOffset === null} onPress={() => { const next = props.systemPage.nextOffset; if (next !== null) props.setSystemOffset(next); }}>{tr('library.system.nextPage')}</Button>
              </div>}
              {props.currentFolder && props.visibleCount === 0 && <EmptyState icon={<Sym name="folder_open" />} title={tr('library.empty.folderTitle')} description={tr('library.empty.folderDescription')} action={<Button variant="secondary" onPress={() => props.openFolder(null)}>{tr('library.empty.browseAll')}</Button>} />}
            </>
          )}
        </SkeletonReveal>
        {marquee.box && <div className="finder-selection-box" data-testid="selection-box" aria-hidden="true" style={marquee.box} />}
      </div>
      <footer className="finder-footer">
        {isMobile && mobileManaging && <div className="finder-mobile-actions" aria-label={tr('library.aria.mobileManage')}>
          <span role="status">{props.selectedVideo?.name ?? props.selectedFolder?.name ?? tr('library.mobile.manageHint')}</span>
          <div>
            <Button variant="ghost" isDisabled={!props.selectedVideo && !props.selectedFolder} onPress={() => { if (props.selectedVideo) props.onRenameVideo(props.selectedVideo); else if (props.selectedFolder?.folder) props.onOpenFolderModal('rename', props.selectedFolder.folder); }}><Sym name="edit" />{tr('library.menu.rename')}</Button>
            <Button variant="ghost" isDisabled={!props.selectedVideo} onPress={() => { if (props.selectedVideo) props.onMoveVideo(props.selectedVideo); }}><Sym name="folder" />{tr('library.mobile.moveShort')}</Button>
            <Button variant="ghost" className="text-danger" isDisabled={!props.selectedVideo && !props.selectedFolder} onPress={() => { if (props.selectedVideo) props.onDeleteVideo(props.selectedVideo); else if (props.selectedFolder?.folder) props.onDeleteFolder(props.selectedFolder.folder, props.selectedFolder.videos.length); }}><Sym name="delete" />{tr('library.menu.delete')}</Button>
          </div>
        </div>}
        {props.moveNotice && !finderDragging.length && <div className="finder-move-notice" data-error={props.moveNotice.error || undefined} role={props.moveNotice.error ? 'alert' : 'status'}>
          <span>{props.moveNotice.text}</span>
          {props.lastMoveLength > 0 && <Button size="sm" variant="ghost" onPress={props.onUndoMove} isDisabled={props.undoingMove}>{tr('library.mobile.moveUndo')}</Button>}
          <Button size="sm" isIconOnly variant="ghost" aria-label={tr('library.aria.closeMove')} onPress={props.onDismissMoveNotice}>×</Button>
        </div>}
        <nav aria-label={tr('library.aria.path')} className="finder-path">
          <span className="finder-path-target" data-drop-target={dropFolder === 'root' || undefined} {...props.pathDropProps(null)}><Button variant="ghost" size="sm" onPress={() => props.openFolder(null)}><Sym name="folder" />{tr('library.path.allResources')}</Button></span>
          {props.inSystemFolder && props.systemPath.split('/').filter(Boolean).map((part, index, parts) => {
            const key = parts.slice(0, index + 1).join('/');
            return <span key={key}><Sym name="chevron_right" /><Button variant="ghost" size="sm" aria-current={key === props.folderKey ? 'page' : undefined} onPress={() => props.openFolder(key)}>{part}</Button></span>;
          })}
          {props.folderPath.map((folder) => <span key={folder.id} className="finder-path-target" data-folder-id={folder.id} data-drop-target={dropFolder === String(folder.id) || undefined} {...props.pathDropProps(folder.id!)}><Sym name="chevron_right" /><Button variant="ghost" size="sm" aria-current={folder.id === props.currentFolder?.folder?.id ? 'page' : undefined} onPress={() => props.openFolder(String(folder.id))}>{folder.name}</Button></span>)}
          {!finderDragging.length && (props.selectedVideo || props.selectedFolder) && <><Sym name="chevron_right" /><span>{props.selectedVideo?.name ?? props.selectedFolder?.name}</span></>}
        </nav>
        {finderDragging.length > 0 && <div className="finder-drag-status" role="status" data-invalid={props.dropHintInvalid || undefined}><Sym name={props.dropHintInvalid ? 'block' : 'folder_open'} /><span>{props.dropHint}</span><kbd>{tr('library.chrome.escCancel')}</kbd></div>}
        <div className="finder-status">
          <span role="status">{selection.size > 0 ? tr('library.statusBar.selectedCount', { selected: selection.size, total: props.visibleCount }) : tr('library.statusBar.itemCount', { count: props.visibleCount })}</span>
          <span className="finder-interaction-hint">{isMobile ? tr('library.statusBar.tapHint') : tr('library.statusBar.dragHint')}</span>
          {props.selectedVideo && <Button isIconOnly size="sm" variant="ghost" aria-label={tr('library.aria.showIntro')} onPress={() => { if (props.selectedVideo) props.setDetails(props.selectedVideo); }}><Sym name="info" /></Button>}
        </div>
      </footer>
      {props.dropActive && <div className="finder-drop-overlay">松开以导入资料</div>}
      {/* 投放区与悬浮卡片挂在窗口外层：它们是 position: fixed，挂在 section 里会跟着 flex 布局被裁 */}
      <LibraryDragChrome drag={props.dragState} pinZoneRef={props.pinZoneRef} deleteZoneRef={props.deleteZoneRef} />
    </section>
  );
}

/**
 * 拖拽进行中的两块「屏幕外」装饰：跟随指针的悬浮卡片，以及顶栏两个卡片级投放区。
 * 都在 body 坐标下（position: fixed），所以放在 section 外面渲染。
 */
export function LibraryDragChrome({
  drag,
  pinZoneRef,
  deleteZoneRef,
}: {
  drag: { video: VideoRow; x: number; y: number; overKey: string | null; zone: 'pin' | 'delete' | null } | null;
  pinZoneRef: React.RefObject<HTMLDivElement | null>;
  deleteZoneRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t: tr } = useTranslation('projects');
  if (!drag) return null;
  return <>
    <div className="drag-ghost pointer-events-none fixed z-50 flex w-56 max-w-[70vw] flex-col gap-2 rounded-2xl border border-accent bg-surface p-4 text-sm text-foreground shadow-lg -translate-x-1/2" style={{ left: drag.x, top: drag.y + 20 }} aria-hidden="true">
      <Sym name={drag.zone === 'delete' ? 'delete' : 'drag_indicator'} className={`text-2xl ${drag.zone === 'delete' ? 'text-danger' : 'text-accent'}`} />
      <span className="line-clamp-2 font-medium">{drag.video.name}</span>
      <span className="text-xs text-muted">{drag.zone === 'delete' ? tr('library.chrome.zoneDeleteConfirm') : drag.zone === 'pin' ? tr('library.chrome.zonePin') : drag.overKey ? tr('library.chrome.zoneMove') : tr('library.chrome.zoneIdle')}</span>
    </div>
    {/* 左侧「置顶」（已置顶的卡片显示为「取消置顶」），右侧「删除」。
        pointerEvents:none —— 命中检测走 getBoundingClientRect，不需要它们接事件。 */}
    <div className="drag-zones pointer-events-none fixed top-0 right-0 left-0 z-50 flex justify-between gap-4 p-3" role="status" aria-live="polite" aria-atomic="true">
      <div
        ref={pinZoneRef}
        className={`drag-zone flex min-h-24 w-56 max-w-[45%] items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-surface p-4 text-sm font-medium shadow-lg ${drag.zone === 'pin' ? 'border-solid border-accent bg-accent-soft text-accent-soft-foreground' : 'border-border-secondary text-foreground'}`}
        data-testid="drag-zone-pin"
      >
        <Sym name={drag.video.pinned === 1 ? 'pin_off' : 'pin'} className="drag-zone__icon" />
        <span>{drag.zone === 'pin' ? tr('library.chrome.dropHere') : tr('library.chrome.dragHere')}{drag.video.pinned === 1 ? tr('library.menu.unpin') : tr('library.menu.pin')}</span>
      </div>
      <div
        ref={deleteZoneRef}
        className={`drag-zone flex min-h-24 w-56 max-w-[45%] items-center justify-center gap-2 rounded-2xl border-2 border-dashed bg-surface p-4 text-sm font-medium shadow-lg ${drag.zone === 'delete' ? 'border-solid border-danger bg-danger-soft text-danger-soft-foreground' : 'border-border-secondary text-foreground'}`}
        data-testid="drag-zone-delete"
      >
        <Sym name="delete" className="drag-zone__icon" />
        <span className="flex flex-col gap-1"><span>{drag.zone === 'delete' ? tr('library.chrome.zoneDelete') : tr('library.chrome.zoneDeleteHint')}</span><span className="text-xs font-normal">{tr('library.chrome.releaseConfirm')}</span></span>
      </div>
    </div>
  </>;
}
