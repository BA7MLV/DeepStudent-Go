/**
 * 资料库内部共用的 UI 与导航交互。
 *
 * 这里放两件东西：
 *
 * 1. **重导出**：Banner / EmptyState / PageShell / Sym 等来自 `../ui` 的组件。
 *    集中一处是为了让「资料库到底用了哪些 UI 小件」只有一个答案，子组件不必各自
 *    再从聚合入口挑几样，读代码时也不用在十来个文件之间核对导入清单。
 *
 * 2. 导航动作（进出文件夹 / 前进后退 / 打开条目）：它们是 `withViewTransition` +
 *    store 写入的组合，属于「资料库的导航语义」，而不是某一个组件的视觉细节。
 */
import { useNavigate } from 'react-router-dom';
import { useLibraryNavigation } from '../store/libraryNavigation';
import { preloadChunk } from '../utils/viewTransition';
import { AGENT_INSTRUCTIONS_ROUTE } from '../materials/systemFiles';

export { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
export { withViewTransition } from '../utils/viewTransition';
export { Banner, EmptyState, HelpTip, PageShell } from '../ui/layout';
export { SkeletonReveal } from '../ui/skeleton';
export { Sym } from '../ui/icons';
export { LoadingButton } from '../ui/loading-button';
export { alertDialog, confirmDialog, popconfirm } from '../ui/feedback';
export { toast } from '../ui/toast';

/** 打开播放页前先预取它的分包（等路由再取会多一次网络往返） */
export function preloadPlayer(): void {
  preloadChunk(() => import('./Player'));
}

/**
 * 资料库导航：进出文件夹、前进/后退、打开条目。
 * 选中集与搜索条件在换目录时一律清空 —— 跨目录保留选中会让「删除/移动」误伤看不见的项。
 */
export function useLibraryExplorerNavigation({
  onResetView,
}: {
  /** 换目录时把搜索/筛选/多选管理态一起复位 */
  onResetView: () => void;
}) {
  const navigate = useNavigate();
  const setFolderHistory = useLibraryNavigation((state) => state.setFolderHistory);

  const openFolder = (key: string | null) => {
    setFolderHistory((history) => ({ entries: [...history.entries.slice(0, history.index + 1), key], index: history.index + 1 }));
    onResetView();
  };

  /** 替换当前目录（拖拽悬停打开文件夹时用：不留历史，松手后「后退」原路返回） */
  const springToFolder = (key: string | null) => {
    setFolderHistory((history) => ({ entries: [...history.entries.slice(0, history.index), key], index: history.index }));
  };

  /** 前进 / 后退：一律按位置移动，不改写历史 */
  const travelFolder = (delta: number) => {
    setFolderHistory((history) => ({ ...history, index: Math.max(0, Math.min(history.entries.length - 1, history.index + delta)) }));
    onResetView();
  };

  const openPlayer = (id: string) => {
    preloadPlayer();
    navigate(`/player/${id}`);
  };

  /** 条目 key → 目标：项目 / 系统目录 / 文件夹 / 视频 */
  const openItem = (key: string) => {
    if (key.startsWith('project:')) navigate(`/projects/${key.slice(8)}/files`);
    else if (key === 'system:agent-instructions') navigate(AGENT_INSTRUCTIONS_ROUTE);
    else if (key === 'system:folder') openFolder('system');
    else if (key === 'system:memory-folder') openFolder('system/memory');
    else if (key.startsWith('system:folder:')) openFolder(key.slice('system:folder:'.length).replace(/^\//, ''));
    else if (key.startsWith('system:memory:')) openPlayer(encodeURIComponent(key));
    else if (key.startsWith('system:file:')) openPlayer(encodeURIComponent(key));
    else if (key.startsWith('folder:')) openFolder(key.slice(7));
    else if (key.startsWith('file:')) openPlayer(key.slice(5));
  };

  return { openFolder, springToFolder, travelFolder, openPlayer, openItem, navigate };
}
