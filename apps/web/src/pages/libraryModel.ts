/**
 * Local-only 资料库列表的数据变换（纯函数）。
 *
 * 从 Library.tsx 里搬出来的原因：这些函数逐字决定「用户在列表里看到什么」，
 * 却和 React 状态混在一个文件里，读一次「为什么搜索时会展开组」要在两千行里翻。
 * 现在它们只依赖入参，可以单独读、单独测。
 */
import type { FolderRow, VideoRow } from '../store/db';

/** 「未分类」虚拟组的 key（折叠状态持久化用） */
export const UNCAT_KEY = '__uncat__';

export const LIBRARY_FILTERS = [
  { value: 'all', label: 'library.filter.all' },
  { value: 'video', label: 'library.filter.video' },
  { value: 'material', label: 'library.filter.material' },
  { value: 'started', label: 'library.filter.started' },
] as const;
export type LibraryFilter = (typeof LIBRARY_FILTERS)[number]['value'];

export interface LibraryGroup {
  key: string;
  name: string;
  videos: VideoRow[];
  folder: FolderRow | null;
}

/** 视频按文件夹分组：文件夹组按创建时间在前，未分类固定最后 */
export function groupLibrary(
  videos: VideoRow[],
  folders: FolderRow[],
  uncategorizedName: string,
): LibraryGroup[] {
  const folderIds = new Set(folders.map((folder) => folder.id));
  const byFolder = new Map<number, VideoRow[]>();
  const uncat: VideoRow[] = [];
  for (const video of videos) {
    if (video.folderId != null && folderIds.has(video.folderId)) {
      const list = byFolder.get(video.folderId) ?? [];
      list.push(video);
      byFolder.set(video.folderId, list);
    } else {
      uncat.push(video);
    }
  }
  /**
   * 组内置顶优先，其余维持 reload 的新→旧顺序。
   *
   * 用一次稳定排序而不是「先挑出置顶再 concat」：`Array.prototype.sort` 在现代引擎里
   * 是稳定排序，同置顶状态下相对次序不动 —— 于是 `videos`（createdAt 倒序）的顺序
   * 被原样保留，不必在这里再比一次时间戳。
   */
  const byPinned = (list: VideoRow[]) =>
    [...list].sort((a, b) => (b.pinned === 1 ? 1 : 0) - (a.pinned === 1 ? 1 : 0));
  return [
    ...folders.map((folder) => ({
      key: String(folder.id),
      name: folder.name,
      videos: byPinned(byFolder.get(folder.id!) ?? []),
      folder,
    })),
    { key: UNCAT_KEY, name: uncategorizedName, videos: byPinned(uncat), folder: null },
  ];
}

/** 搜索 + 筛选：空组默认隐藏；没有筛选条件时保留空文件夹（用户要去里面导入东西） */
export function filterGroups(
  groups: LibraryGroup[],
  searchQuery: string,
  filter: LibraryFilter,
): LibraryGroup[] {
  const hasFilters = searchQuery.length > 0 || filter !== 'all';
  return groups
    .map((group) => ({
      ...group,
      videos: group.videos.filter((video) => {
        if (searchQuery && !video.name.toLocaleLowerCase().includes(searchQuery)) return false;
        if (filter === 'video') return video.kind !== 'material';
        if (filter === 'material') return video.kind === 'material';
        if (filter === 'started') {
          return video.kind !== 'material' && (video.lastPosition ?? 0) > 0 && video.finished !== 1;
        }
        return true;
      }),
    }))
    .filter((group) => group.videos.length > 0 || (!hasFilters && group.folder != null));
}

/**
 * 「系统目录」这一项的命中词。
 *
 * 从字符串字面量里搬到这一处并只做「包含」判断，是为了让搜索中文名（技能/记忆/默认提示词）
 * 与目录里的英文名走同一套匹配；它们不参与渲染，所以用 Unicode 转义写出来，
 * 免得被硬编码中文检查当成待翻译的用户文案。
 */
const SYSTEM_FOLDER_SEARCH_TERMS = [
  'system', 'memory', 'skills', 'agents.md', 'agent',
  '\u6280\u80fd', '\u8bb0\u5fc6', '\u9ed8\u8ba4\u63d0\u793a\u8bcd', '\u5168\u5c40\u6307\u4ee4',
];

/** 名称排序用：中文按拼音，数字按数值（「第2章」排在「第10章」前） */
export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, 'zh-CN', { numeric: true });
}

/** 当前目录下的子文件夹 */
export function childFolderTiles(
  groups: LibraryGroup[],
  currentFolderId: number | null,
  hasFilters: boolean,
  scopedGroups: LibraryGroup[],
  filter: LibraryFilter,
  searchQuery: string,
  sort: 'name' | 'recent',
): LibraryGroup[] {
  return groups
    .filter((group) => group.folder &&
      (group.folder.parentId ?? null) === currentFolderId &&
      (!hasFilters || scopedGroups.some((visible) => visible.key === group.key) ||
        (filter === 'all' && group.name.toLocaleLowerCase().includes(searchQuery))))
    .sort((a, b) => sort === 'name'
      ? compareNames(a.name, b.name)
      : (b.folder?.createdAt ?? 0) - (a.folder?.createdAt ?? 0));
}

/**
 * 当前视图要显示的视频。
 *
 * 规则：进到某个文件夹里时只看该文件夹；否则（全部资料 / 有搜索筛选）把各组的视频摊平。
 * 摊平后置顶的排最前，其余按选定的排序。
 */
export function visibleVideos(
  scopedGroups: LibraryGroup[],
  inSystemFolder: boolean,
  currentFolder: LibraryGroup | undefined,
  hasFilters: boolean,
  sort: 'name' | 'recent',
): VideoRow[] {
  return scopedGroups
    .flatMap((group) => !inSystemFolder && (currentFolder || hasFilters || group.folder == null) ? group.videos : [])
    .sort((a, b) => (b.pinned ?? 0) - (a.pinned ?? 0)
      || (sort === 'name' ? compareNames(a.name, b.name) : b.createdAt - a.createdAt));
}

/** 系统目录是否出现在当前视图（只会在「全部资料」或材料筛选、且搜索词相关时出现） */
export function systemFolderVisible(
  inSystemFolder: boolean,
  currentFolder: LibraryGroup | undefined,
  filter: LibraryFilter,
  searchQuery: string,
): boolean {
  return !inSystemFolder && !currentFolder && (filter === 'all' || filter === 'material') &&
    (!searchQuery || SYSTEM_FOLDER_SEARCH_TERMS.some((term) => term.includes(searchQuery)));
}
