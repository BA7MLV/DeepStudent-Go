import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Drawer, Input, Label, SearchField, TextArea, TextField } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { AgentProfileDto, ProjectDetailDto } from '@wangke/contracts';
import type { ResourceDirectory, ResourceEntry } from '@wangke/contracts/resources';
import { request, serverClient } from '../api/serverClient';
import { followResources, readResources, resourceCommand, RESOURCE_PAGE_SIZE } from '../client/resources';
import { FolderIcon } from '../components/FolderIcon';
import FolderColorMenu from '../components/FolderColorMenu';
import { PluginActions } from '../plugins/PluginActions';
import { ResourceFileIcon } from '../components/ResourceFileIcon';
import { useLibraryNavigation } from '../store/libraryNavigation';
import { captureCourseAccess } from '../client/course-access';
import { MoreMenu, PageShell, Sym, toast, promptDialog, confirmDialog } from '../ui';
import { SkeletonReveal, useSkeletonGate } from '../ui/skeleton';
import { overflowTitleProps } from '../ui/overflowTitle';
import { projectError } from '../projects/errors';
import ProjectSettings from '../projects/ProjectSettings';
import ResourceTrash from '../projects/ResourceTrash';
import ImagePreview from '../components/ImagePreview';
import { markImagePreviewSource } from '../components/imagePreviewSource';
import { formatSize } from '../utils/format';
import { probeDuration } from '../utils/mediaDuration';
import { startTranscription } from '../pipelines/transcribeQueue';
import { enqueueCover } from '../pipelines/coverQueue';
import { useIsMobile } from '../utils/useMobile';
import { useMarqueeSelection } from '../utils/useMarqueeSelection';
import { canDropResourceInto, createFolderSpringLoader, RESOURCE_DRAG_TYPE } from '../utils/resourceDrag';
import BiliImportTasks from '../bilibili/ImportTasks';
import PersistentError from '../components/PersistentError';
import { accountLifecycle } from '../client/account-lifecycle';
import { useResourceFeedback } from '../store/resourceFeedback';
import './library.css';
import '../projects/projects.css';
import './resources.css';

const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const keyOf = (entry: ResourceEntry) => `${entry.projectId}:${entry.path}:${entry.courseId ?? ''}`;
const isImage = (name: string) => /\.(png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
const validName = (value: string) => !value.trim() || value === '.' || value === '..' || /[\\/\u0000-\u001f\u007f]/.test(value) || new TextEncoder().encode(value).length > 255;
type ResourceDragPayload = { entries: ResourceEntry[] };

function ResourceSkeleton({ view, count }: { view: 'icons' | 'list'; count: number }) {
  return <ul className="resource-grid resource-skeleton" data-view={view} data-testid="resource-skeleton" aria-hidden="true">
    {Array.from({ length: count }, (_, index) => <li className="resource-tile" key={index}>
      <div className="resource-open">
        <span className="resource-file-icon"><span className="resource-skeleton__icon skel-breathe rounded-lg bg-background-tertiary" /></span>
        <span className="skel-breathe block h-4 w-20 rounded bg-background-tertiary" />
        <small className="skel-breathe block h-3 w-12 rounded bg-background-tertiary" />
      </div>
    </li>)}
  </ul>;
}

/** Paged find-by-name: a directory larger than one page must not silently
 * miss the just-uploaded file when post-upload facts (courseId) are needed. */
async function findEntryByName(projectId: string, path: string, name: string): Promise<ResourceEntry | undefined> {
  let cursor: string | undefined;
  do {
    const page = await readResources(projectId, path, true, cursor, RESOURCE_PAGE_SIZE);
    const hit = page.entries.find(entry => entry.name === name);
    if (hit) return hit;
    cursor = page.next;
  } while (cursor);
  return undefined;
}

/** The server filesystem is the browser's directory listing, not a second library. */
export default function ResourceLibrary({ onImport }: { onImport: (folderId?: number) => void }) {
  const { t } = useTranslation('projects');
  const { t: text } = useTranslation('interface');
  const navigate = useNavigate();
  const [courseAccess] = useState(() => captureCourseAccess());
  const mobile = useIsMobile();
  const [search, setSearch] = useSearchParams();
  const projectId = search.get('folder') ?? undefined;
  const directory = search.get('path') ?? '';
  const [data, setData] = useState<ResourceDirectory | null>(null);
  /** Accumulated later pages of a large directory. The projection owns page one
   * and replaces it wholesale on change; accumulated pages reset with it. */
  const [appended, setAppended] = useState<ResourceEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const cursorRef = useRef<string | undefined>(undefined);
  const searchGeneration = useRef(0);
  const [error, setError] = useState('');
  const operationError = useResourceFeedback(state => state.error);
  const setOperationError = useResourceFeedback(state => state.setError);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const showSkeleton = useSkeletonGate(loading);
  const [busy, setBusy] = useState(false);
  const operationLock = useRef(false);
  const [query, setQuery] = useState('');
  const [trashOpen, setTrashOpen] = useState(false);
  const [view, setView] = useState<'icons' | 'list'>('icons');
  const [settings, setSettings] = useState<{ project: ProjectDetailDto; agents: AgentProfileDto[] } | null>(null);
  const [editor, setEditor] = useState<{ projectId: string; path: string; text: string; revision: string | null } | null>(null);
  const [editorBaseline, setEditorBaseline] = useState('');
  const editorDirty = editor !== null && JSON.stringify({ path: editor.path, text: editor.text }) !== editorBaseline;
  const [image, setImage] = useState<ResourceEntry | null>(null);
  const [draggedEntries, setDraggedEntries] = useState<ResourceEntry[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [springLoader] = useState(createFolderSpringLoader);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const marquee = useMarqueeSelection(selection, setSelection, { itemSelector: '.resource-tile' });
  const dragSession = useRef<{ entries: ResourceEntry[]; search: string; query: string; opened: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const locationKey = `${projectId ?? ''}:${directory}`;
  const loadedLocation = useRef('');
  const refresh = () => setRevision(n => n + 1);
  const closeEditor = async () => {
    if (busy) return;
    if (editorDirty && !await confirmDialog({
      headline: text('resources.discardTitle'),
      description: text('resources.discardDescription'),
      confirmText: text('resources.discard'), danger: true,
    })) return;
    setEditor(null);
  };
  useEffect(() => { setSelection(new Set()); }, [locationKey, query]);
  useEffect(() => {
    setAppended([]);
    cursorRef.current = data?.next;
    setNextCursor(data?.next);
  }, [data, locationKey]);
  useEffect(() => {
    const available = new Set((data?.entries ?? []).map(keyOf));
    setSelection(current => {
      const next = new Set([...current].filter(key => available.has(key)));
      return next.size === current.size && [...next].every(key => current.has(key)) ? current : next;
    });
  }, [data]);
  useEffect(() => {
    if (projectId) useLibraryNavigation.getState().setFolderHistory(h => h.entries[h.index]?.startsWith('system') ? { entries: [null], index: 0 } : h);
  }, [projectId]);
  useEffect(() => {
    if (loadedLocation.current !== locationKey) { setLoading(true); setData(null); }
    return followResources(projectId, directory, result => {
      setData(result); setError(''); loadedLocation.current = locationKey; setLoading(false);
    }, error => { setError(projectError(error)); setLoading(false); }, RESOURCE_PAGE_SIZE);
  }, [projectId, directory, revision, locationKey]);
  const openDirectory = (id?: string, path = '') => {
    springLoader.cancel();
    setDropTarget(null);
    setQuery('');
    setSearch(id ? { folder: id, ...(path ? { path } : {}) } : {});
  };
  const finishResourceDrag = (committed = false) => {
    const session = dragSession.current;
    if (!session) return;
    springLoader.cancel();
    setDropTarget(null);
    dragSession.current = null;
    setDraggedEntries([]);
    if (session.opened && !committed) {
      setQuery(session.query);
      setSearch(new URLSearchParams(session.search), { replace: true });
    }
  };
  const finishDragRef = useRef(finishResourceDrag);
  finishDragRef.current = finishResourceDrag;
  useEffect(() => {
    const finish = () => finishDragRef.current();
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') finish(); };
    window.addEventListener('dragend', finish);
    window.addEventListener('drop', finish);
    window.addEventListener('keydown', escape);
    return () => {
      springLoader.cancel();
      window.removeEventListener('dragend', finish);
      window.removeEventListener('drop', finish);
      window.removeEventListener('keydown', escape);
    };
  }, [springLoader]);
  useEffect(() => {
    springLoader.cancel();
    setDropTarget(null);
  }, [locationKey, busy, loading, data?.project?.archived, springLoader]);
  const perform = async (action: () => Promise<unknown>, context = '') => {
    if (operationLock.current) return;
    operationLock.current = true;
    const lifetime = accountLifecycle.current();
    setBusy(true);
    setOperationError(null);
    try { await action(); refresh(); }
    catch (error) { if (!lifetime || lifetime.current()) { setOperationError(`${context ? `${context}：` : ''}${projectError(error)} ${text('feedback.checkBeforeRetry')}`); refresh(); } }
    finally { operationLock.current = false; setBusy(false); }
  };
  const offerUndo = (message: string, undo: () => Promise<unknown>) => {
    const lifetime = accountLifecycle.current();
    let used = false;
    const id = toast.success(message, { timeout: 8000, actionProps: { children: text('feedback.undo'), onPress: () => {
      if (used || operationLock.current) return;
      used = true; toast.close(id);
      void perform(async () => { lifetime?.assertCurrent(); await undo(); }, text('feedback.undo'));
    } } });
  };
  const moveEntry = async (entry: ResourceEntry, targetProjectId: string, target: string) => {
    const result = await resourceCommand({ kind: 'move', projectId: entry.projectId, path: entry.path, targetProjectId, target, revision: entry.revision });
    // Only the command receipt can authorize the reverse CAS. A subsequent
    // directory lookup could accidentally adopt somebody else's newer edit.
    if (entry.kind === 'file' && result && typeof result === 'object' && 'revision' in result && typeof result.revision === 'string') {
      const revision = result.revision;
      return () => resourceCommand({ kind: 'move', projectId: targetProjectId, path: target, targetProjectId: entry.projectId, target: entry.path, revision });
    }
  };
  const createFolder = async () => {
    const name = await promptDialog({ headline: t('newFolder'), confirmText: t('save'), cancelText: t('cancel'), validate: value => validName(value) ? t('errors.invalid_project_path') : null });
    if (!name) return;
    await perform(async () => {
      if (projectId) await resourceCommand({ kind: 'createDirectory', projectId, path: join(directory, name.trim()) });
      else await resourceCommand({ kind: 'createFolder', name: name.trim() });
    });
  };
  const uploadFiles = async (files: File[]) => {
    if (!data || !files.length) return;
    await perform(async () => {
      const errors: string[] = [];
      let uploaded = 0;
      for (const file of files) {
        try {
          const id = projectId ?? data.rootId;
          await serverClient.uploadProjectFile(id, join(directory, file.name), file);
          uploaded++;
          if (file.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|flv|ts|m2ts|mpeg|mpg|wmv|3gp|rmvb|rm)$/i.test(file.name)) {
            const entry = await findEntryByName(id, directory, file.name);
            if (entry?.courseId) {
              const duration = await probeDuration(file);
              await courseAccess.read(entry.courseId);
              if (duration) await (await import('../client/resources')).recordMediaDuration(entry.courseId, duration);
              enqueueCover(entry.courseId);
              startTranscription(entry.courseId);
            }
          }
        }
        catch (error) { errors.push(`${file.name}: ${projectError(error)}`); }
      }
      if (errors.length) setOperationError(`${errors.join('\n')}\n${text('feedback.checkBeforeRetry')}`);
      if (uploaded) toast.success(text('feedback.uploaded', { count: uploaded }));
    });
  };
  const upload = (event: ChangeEvent<HTMLInputElement>) => { const files = [...(event.target.files ?? [])]; event.target.value = ''; void uploadFiles(files); };
  const download = (entry: ResourceEntry) => { const link = document.createElement('a'); link.href = serverClient.projectDownloadUrl(entry.projectId, entry.path); link.download = entry.name; link.click(); };
  const open = async (entry: ResourceEntry) => {
    if (entry.kind === 'directory') { openDirectory(entry.projectId, entry.path); return; }
    if (!entry.missing && isImage(entry.name)) { setImage(entry); return; }
    if (!entry.courseId && !/\.(txt|md|markdown|json|csv|tsv|yaml|yml|xml|log|srt|vtt|js|ts|css|py|sh)$/i.test(entry.name)) { download(entry); return; }
    await perform(async () => {
      if (entry.courseId) {
        const course = await courseAccess.read(entry.courseId);
        if (course?.kind === 'material' && course.status === 'new' && course.materialFormat && !entry.missing) {
          const { startMaterialJob } = await import('../pipelines/materialJob');
          void startMaterialJob(course.id, course.materialFormat).catch(error => toast.error(projectError(error)));
        }
        navigate(`/player/${encodeURIComponent(entry.courseId)}`, { state: { libraryReturn: `/library${search.size ? `?${search}` : ''}` } });
      } else {
        const file = await serverClient.projectText(entry.projectId, entry.path);
        setEditorBaseline(JSON.stringify({ path: file.path, text: file.text }));
        setEditor({ ...file, projectId: entry.projectId });
      }
    });
  };
  const editSettings = async (id: string) => perform(async () => {
    const [project, { agents }] = await Promise.all([serverClient.project(id), serverClient.agents()]);
    setSettings({ project, agents: agents.filter(a => a.enabled) });
  });
  const rename = async (entry: ResourceEntry) => {
    const name = await promptDialog({ headline: t('rename'), defaultValue: entry.name, confirmText: t('save'), cancelText: t('cancel'), validate: value => validName(value) ? t('errors.invalid_project_path') : null });
    if (!name || name === entry.name) return;
    await perform(async () => {
      if (entry.scope) await resourceCommand({ kind: 'renameFolder', projectId: entry.projectId, name });
      else {
        const undo = await moveEntry(entry, entry.projectId, join(directory, name));
        if (undo) offerUndo(`${t('rename')} · ${name}`, undo);
      }
    }, entry.name);
  };
  const remove = async (entry: ResourceEntry) => {
    if (entry.scope) {
      await perform(async () => {
        const result = await resourceCommand({ kind: 'trash', projectId: entry.projectId });
        if (result && typeof result === 'object' && 'deletedAt' in result && typeof result.deletedAt === 'string') {
          const expectedDeletedAt = result.deletedAt;
          offerUndo(t('movedToTrash'), () => resourceCommand({ kind: 'restore', projectId: entry.projectId, expectedDeletedAt }));
        } else toast.success(t('movedToTrash'));
      }, entry.name);
      return;
    }
    if (!await confirmDialog({ headline: t('deleteConfirm', { name: entry.name }), description: t('removeHint'), confirmText: t('delete'), cancelText: t('cancel'), danger: true })) return;
    await perform(() => entry.courseId
      ? serverClient.deleteResourceFile(entry.projectId, entry.path, entry.revision)
      : serverClient.deleteProjectFile(entry.projectId, entry.path, entry.revision), entry.name);
  };
  const moveInto = (event: React.DragEvent, id: string, path: string) => {
    event.preventDefault(); event.stopPropagation();
    springLoader.cancel();
    if (event.dataTransfer.files.length) { if (id === (projectId ?? data?.rootId) && path === directory) void uploadFiles([...event.dataTransfer.files]); return; }
    try {
      const raw = JSON.parse(event.dataTransfer.getData(RESOURCE_DRAG_TYPE)) as ResourceEntry | ResourceDragPayload;
      const entries = Array.isArray(raw) ? raw : 'entries' in raw ? raw.entries : [raw];
      if (!entries.length || entries.some(entry => !canDropResourceInto(entry, id, path))) { finishResourceDrag(); return; }
      finishResourceDrag(true);
      void perform(async () => {
        const undos: Array<() => Promise<unknown>> = [];
        try {
          for (const entry of entries) {
            const undo = await moveEntry(entry, id, join(path, entry.name));
            if (undo) undos.push(undo);
          }
        } finally {
          if (undos.length) offerUndo(text('feedback.moved', { count: undos.length }), async () => {
            // Each reverse move has its own frozen revision; stop at the first
            // conflict, rather than overwriting or replaying the original batch.
            for (const undo of undos.reverse()) await undo();
          });
        }
      }, entries.map(entry => entry.name).join('、'));
    } catch { /* Unrelated drag payload. */ }
  };
  const entries = [...(data?.entries ?? []), ...appended].filter(entry => entry.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())).sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const entryCount = entries.length;
  const loadMore = async () => {
    const cursor = cursorRef.current;
    if (cursor === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await readResources(projectId, directory, true, cursor, RESOURCE_PAGE_SIZE);
      setAppended(previous => [...previous, ...page.entries]);
      cursorRef.current = page.next;
      setNextCursor(page.next);
    } catch (error) { setOperationError(projectError(error)); }
    finally { setLoadingMore(false); }
  };
  /**
   * 筛选必须覆盖完整目录：只过滤已加载页会静默漏掉未加载条目。输入搜索词时
   * 自动补齐剩余页；搜索词变化时作废上一轮，已加载内容保留。
   */
  useEffect(() => {
    if (!query || cursorRef.current === undefined) return;
    const generation = ++searchGeneration.current;
    let next: string | undefined = cursorRef.current;
    void (async () => {
      try {
        while (next !== undefined) {
          const page = await readResources(projectId, directory, true, next, RESOURCE_PAGE_SIZE);
          if (generation !== searchGeneration.current) return;
          setAppended(previous => [...previous, ...page.entries]);
          next = page.next;
          cursorRef.current = page.next;
          setNextCursor(page.next);
        }
      } catch { /* 保留已加载页；手动入口仍可用 */ }
    })();
  }, [query, locationKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const breadcrumbs = directory.split('/').filter(Boolean);
  const readOnly = Boolean(data?.project?.archived);
  const dragOverFolder = (event: React.DragEvent, entry: ResourceEntry) => {
    // Do not change native file-import behavior: spring loading is for internal moves.
    if (entry.kind !== 'directory' || !event.dataTransfer.types.includes(RESOURCE_DRAG_TYPE)) return;
    event.preventDefault(); event.stopPropagation();
    const session = dragSession.current;
    if (!session || busy || loading || readOnly || entry.scope?.archived || session.entries.some(source => !canDropResourceInto(source, entry.projectId, entry.path))) {
      springLoader.cancel(); setDropTarget(null); event.dataTransfer.dropEffect = 'none'; return;
    }
    event.dataTransfer.dropEffect = 'move';
    const key = keyOf(entry);
    setDropTarget(key);
    springLoader.schedule(key, () => {
      if (dragSession.current !== session) return;
      session.opened = true;
      springLoader.cancel();
      setDropTarget(null);
      setQuery('');
      // Spring navigation is temporary, not a new browser-history entry per level.
      setSearch({ folder: entry.projectId, ...(entry.path ? { path: entry.path } : {}) }, { replace: true });
    });
  };
  // Keep the actual native drag source mounted across directory loads. Removing it
  // ends the browser's drag session before the user can descend to another level.
  const visibleEntries = loading || showSkeleton ? [] : entries;
  const retainedKeys = new Set(draggedEntries.filter(entry => !visibleEntries.some(visible => keyOf(visible) === keyOf(entry))).map(keyOf));
  const renderedEntries = [...visibleEntries, ...draggedEntries.filter(entry => retainedKeys.has(keyOf(entry)))];
  return <PageShell title={t('resources')} fill rootClassName="page-library">
    <BiliImportTasks />
    {trashOpen && <ResourceTrash onClose={() => setTrashOpen(false)} onChange={refresh} />}
    <ImagePreview isOpen={Boolean(image)} onOpenChange={open => { if (!open) setImage(null); }} title={image?.name ?? ''} content={image ? { kind: 'image', src: serverClient.projectDownloadUrl(image.projectId, image.path) } : undefined} onDownload={image ? () => download(image) : undefined} downloadLabel={t('download')} />
    <section className="finder-window resource-window" data-mobile={mobile || undefined} aria-label={t('resources')}
      onDragOver={e => { springLoader.cancel(); setDropTarget(null); if (!busy && !loading && !readOnly) e.preventDefault(); }}
      onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) { springLoader.cancel(); setDropTarget(null); } }}
      onDrop={e => { if (data && !busy && !loading && !readOnly) moveInto(e, projectId ?? data.rootId, directory); }}>
      <header className="finder-toolbar">
        <div className="finder-navigation"><Button isIconOnly variant="ghost" aria-label={t('back')} isDisabled={!projectId} onPress={() => openDirectory(directory ? projectId : undefined, breadcrumbs.slice(0, -1).join('/'))}><Sym name="chevron_left" /></Button></div>
        <h2 className="finder-title">{breadcrumbs.at(-1) ?? data?.project?.name ?? t('resources')}</h2>
        <div className="finder-tools">
          <Button isIconOnly variant="ghost" aria-label={t('changeView')} onPress={() => setView(v => v === 'icons' ? 'list' : 'icons')}><Sym name={view === 'icons' ? 'list' : 'grid_view'} /></Button>
          <Button isIconOnly variant="ghost" data-testid="btn-new-folder" aria-label={t('newFolder')} isDisabled={busy || readOnly || loading} onPress={() => void createFolder()}><Sym name="create_new_folder" /></Button>
          <Button isIconOnly variant="ghost" aria-label={t('upload')} isDisabled={busy || readOnly || loading} onPress={() => input.current?.click()}><Sym name="upload" /></Button>
          <MoreMenu label={t('more')} actions={[
            { key: 'import', label: t('importMaterials'), icon: <Sym name="link" />, disabled: busy || readOnly || !data, onAction: () => onImport(data?.folderId) },
            { key: 'new', label: t('newFile'), icon: <Sym name="edit" />, disabled: busy || readOnly || !data, onAction: () => { setEditorBaseline(JSON.stringify({ path: '', text: '' })); setEditor({ projectId: projectId ?? data!.rootId, path: '', text: '', revision: null }); } },
            { key: 'refresh', label: t('refresh'), icon: <Sym name="refresh" />, onAction: refresh },
            { key: 'trash', label: text('resources.trash'), icon: <Sym name="restore_from_trash" />, onAction: () => setTrashOpen(true) },
            { key: 'system', label: text('resources.system'), icon: <Sym name="settings" />, onAction: () => useLibraryNavigation.getState().setFolderHistory(h => ({ entries: [...h.entries.slice(0, h.index + 1), 'system'], index: h.index + 1 })) },
            ...(projectId ? [
              { key: 'chat', label: t('botChat'), icon: <Sym name="chat" />, onAction: () => navigate(`/library/folders/${projectId}/chat`) },
              { key: 'settings', label: t('settings'), icon: <Sym name="tune" />, onAction: () => void editSettings(projectId) },
            ] : []),
          ]} />
        </div>
        <SearchField className="finder-search" aria-label={t('searchFolder')} value={query} onChange={setQuery}><SearchField.Group><SearchField.SearchIcon /><SearchField.Input placeholder={t('searchFolder')} /><SearchField.ClearButton /></SearchField.Group></SearchField>
        <input ref={input} type="file" multiple hidden onChange={upload} />
      </header>
      {error && <div role="alert" className="project-error resource-notice">{error}<Button size="sm" onPress={refresh}>{t('retry')}</Button></div>}
      {!editor && operationError && <div className="resource-notice">
        <PersistentError title={text('feedback.actionFailed')} text={operationError} onClose={() => setOperationError(null)} />
        <Button size="sm" variant="tertiary" onPress={refresh}>{t('refresh')}</Button>
      </div>}
      {readOnly && <p className="resource-notice">{t('readOnly')}</p>}
      <div className="finder-canvas" data-testid="resource-list" aria-busy={loading || busy}
        onPointerDown={mobile ? undefined : marquee.onPointerDown}
        onClickCapture={marquee.onClickCapture}
        onClick={event => { if (event.target === event.currentTarget) setSelection(new Set()); }}>
        <SkeletonReveal show={showSkeleton && !draggedEntries.length} skeleton={<ResourceSkeleton view={view} count={mobile ? 3 : 6} />}>
        <>
          <ul className="resource-grid" data-view={view}>
            {renderedEntries.map(entry => <li key={keyOf(entry)} className="resource-tile" data-kind={entry.kind} data-testid="resource-entry"
              data-selection-key={keyOf(entry)} data-selected={selection.has(keyOf(entry)) || undefined}
              data-drag-retained={retainedKeys.has(keyOf(entry)) || undefined} aria-hidden={retainedKeys.has(keyOf(entry)) || undefined}
              data-drop-target={dropTarget === keyOf(entry) || undefined}
              draggable={!entry.scope && !entry.missing && !busy && !readOnly} onDragStart={e => {
                const dragEntries = selection.has(keyOf(entry))
                  ? renderedEntries.filter(candidate => selection.has(keyOf(candidate)) && !candidate.scope && !candidate.missing)
                  : [entry];
                const entries = dragEntries.length ? dragEntries : [entry];
                dragSession.current = { entries, search: search.toString(), query, opened: false };
                setDraggedEntries(entries);
                if (!selection.has(keyOf(entry))) setSelection(new Set([keyOf(entry)]));
                e.dataTransfer.setData(RESOURCE_DRAG_TYPE, JSON.stringify({ entries } satisfies ResourceDragPayload)); e.dataTransfer.effectAllowed = 'move';
              }}
              onDragEnter={e => dragOverFolder(e, entry)} onDragOver={e => dragOverFolder(e, entry)}
              onDragLeave={e => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                const key = keyOf(entry);
                springLoader.cancel(key);
                setDropTarget(current => current === key ? null : current);
              }}
              onDrop={e => {
                if (entry.kind !== 'directory') return;
                e.preventDefault(); e.stopPropagation();
                if (!busy && !loading && !readOnly && !entry.scope?.archived) moveInto(e, entry.projectId, entry.path);
                else finishResourceDrag();
              }}>
              <button className="resource-open" disabled={busy} onClick={event => {
                if (event.ctrlKey || event.metaKey) {
                  event.preventDefault();
                  setSelection(current => { const next = new Set(current); const key = keyOf(entry); if (next.has(key)) next.delete(key); else next.add(key); return next; });
                  return;
                }
                if (!entry.missing && isImage(entry.name)) markImagePreviewSource(event.currentTarget);
                void open(entry);
              }} title={entry.scope?.workspacePath ?? entry.path}>
                {entry.kind === 'directory' ? <FolderIcon color={entry.color} /> : <ResourceFileIcon entry={entry} />}
                <span {...overflowTitleProps}>{entry.name}</span><small>{entry.scope?.archived ? t('archived') : entry.kind === 'directory' ? t('folder') : entry.missing ? t('learningRecord') : formatSize(entry.size)}</small>
              </button>
              <MoreMenu className="resource-more" label={`${t('more')} · ${entry.name}`} actions={[
                ...(!entry.missing ? [{ key: 'rename', label: t('rename'), icon: <Sym name="edit" />, disabled: busy || readOnly, onAction: () => void rename(entry) }] : []),
                ...(entry.scope ? [
                  { key: 'chat', label: t('botChat'), icon: <Sym name="chat" />, onAction: () => navigate(`/library/folders/${entry.projectId}/chat`) },
                  { key: 'settings', label: t('settings'), icon: <Sym name="tune" />, onAction: () => void editSettings(entry.projectId) },
                ] : entry.kind === 'file' && !entry.missing ? [{ key: 'download', label: t('download'), icon: <Sym name="download" />, onAction: () => download(entry) }] : []),
                ...(!entry.missing ? [{ key: 'remove', label: t(entry.scope ? 'moveToTrash' : 'delete'), icon: <Sym name="delete" />, danger: true, disabled: busy || readOnly, onAction: () => void remove(entry) }] : []),
              ]}>
                {entry.kind === 'directory' && <FolderColorMenu color={entry.color} disabled={busy || readOnly || !!entry.scope?.archived}
                  onChange={color => void perform(() => resourceCommand({ kind: 'folderColor', projectId: entry.projectId, path: entry.path, color }))} />}
              </MoreMenu>
              {entry.kind === 'file' && entry.courseId ? <PluginActions surface="resource.actions" materialId={entry.courseId} /> : null}
            </li>)}
          </ul>
          {!loading && !showSkeleton && nextCursor !== undefined && <div className="resource-pages" data-testid="resource-load-more">
            <Button variant="secondary" size="sm" isDisabled={loadingMore} onPress={() => void loadMore()}>{loadingMore ? t('working') : t('loadMore')}</Button>
          </div>}
          {!loading && !showSkeleton && !entryCount && !error && <div className="project-empty">{query ? t('noResults') : t('folderEmpty')}</div>}
        </>
        </SkeletonReveal>
      </div>
      <footer className="finder-footer"><nav className="finder-path" aria-label={t('workspace')}><Button variant="ghost" size="sm" onPress={() => openDirectory()}>{t('resources')}</Button>
        {projectId && <><Sym name="chevron_right" /><Button variant="ghost" size="sm" onPress={() => openDirectory(projectId)}>{data?.project?.name}</Button></>}
        {breadcrumbs.map((part, i) => <span key={i}><Sym name="chevron_right" /><Button variant="ghost" size="sm" onPress={() => openDirectory(projectId, breadcrumbs.slice(0, i + 1).join('/'))}>{part}</Button></span>)}
      </nav><div className="finder-status"><span className="resource-count">{busy ? t('working') : selection.size ? t('selectionCount', { selected: selection.size, count: entryCount }) : t('itemCount', { count: entryCount })}</span><span className="finder-interaction-hint">{mobile ? t('selectionMobileHint') : t('selectionHint')}</span>{data?.project && <code>{data.project.workspacePath}{directory ? `/${directory}` : ''}</code>}</div></footer>
    </section>
    {settings && <ProjectSettings project={settings.project} agents={settings.agents} onClose={() => setSettings(null)} onChange={project => { setSettings(s => s && ({ ...s, project })); refresh(); }} />}
    {editor && <Drawer.Root isOpen onOpenChange={open => { if (!open) void closeEditor(); }}>
      <Drawer.Backdrop variant="opaque">
        <Drawer.Content placement={mobile ? 'bottom' : 'right'} className={mobile ? 'max-h-[88vh]' : 'w-[min(36rem,100vw)]'}>
          <Drawer.Dialog className="project-editor" data-testid="resource-file-editor">
            <Drawer.Header><Drawer.Heading>{editor.revision === null ? t('newFile') : editor.path}</Drawer.Heading><Drawer.CloseTrigger aria-label={t('cancel')} /></Drawer.Header>
            <Drawer.Body><div className="project-form">
              <PersistentError title={text('feedback.actionFailed')} text={operationError} onClose={() => setOperationError(null)} />
              {editor.revision === null && <TextField><Label>{t('filename')}</Label><Input value={editor.path} onChange={e => setEditor({ ...editor, path: e.target.value })} placeholder="notes.md" /></TextField>}
              <TextField><Label>{t('content')}</Label><TextArea className="project-text-editor" rows={15} value={editor.text} readOnly={readOnly} onChange={e => setEditor({ ...editor, text: e.target.value })} /></TextField>
            </div></Drawer.Body>
            <Drawer.Footer><Button variant="tertiary" isDisabled={busy} onPress={() => setEditor(null)}>{t('cancel')}</Button><Button variant="primary" isDisabled={busy || readOnly || !editor.path.trim() || (editor.revision === null && validName(editor.path))} onPress={() => void perform(async () => {
              await serverClient.writeProjectText(editor.projectId, editor.revision === null ? join(directory, editor.path.trim()) : editor.path, editor.text, editor.revision); setEditor(null);
            })}>{t('save')}</Button></Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer.Root>}
  </PageShell>;
}
