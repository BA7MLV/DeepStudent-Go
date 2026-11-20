/**
 * 资料库页的对外入口。
 *
 * ## 路由分派
 *
 * 资料库有两个「表面」，历史原因共存：
 *
 * - **服务端资源目录**（`ResourceLibrary`）：当前实现，`?folder=` 以及系统文件深链接都走它；
 * - **本地课程表**（`LibraryLegacy`）：本地数据库模式与旧书签仍要落到这里。
 *
 * 还有一条兼容路径：`ResourceLibrary` 的「导入」按钮要能打开本地课程表的导入弹窗，
 * 所以本地课程表会以 `importing` 参数被单独挂载成一个覆盖层。
 *
 * ## 懒加载
 *
 * 这个文件是 `/library` 路由的分包入口（`App.tsx` 里 `lazy(() => import('./pages/Library'))`）。
 * 它自己只留「判断走哪个表面」这点逻辑；本地课程表那套 IndexedDB/拖拽实现在
 * `LibraryLazy.ts` 里按需加载，于是不会陪服务端目录一起下载。
 */
import { Suspense, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { useLibraryNavigation } from '../store/libraryNavigation';
import { PageLoader } from '../ui/page-loader';
import ResourceLibrary from './ResourceLibrary';
import { LegacyLibrary } from './LibraryLazy';

export default function Library() {
  const [search] = useSearchParams();
  const { t } = useTranslation('projects');
  const [importing, setImporting] = useState<{ folderId?: number } | null>(null);
  const systemFolder = useLibraryNavigation(s => s.folderHistory.entries[s.folderHistory.index]?.startsWith('system'));
  const file = search.get('file') ?? '';
  const systemFile = file === 'AGENTS.md' || file === '/system/AGENTS.md' || file === '/system/mcp.json' || /^\/system\/(memory|skills|board)\//.test(file);
  // Old arbitrary ?file= values must not expose the static table editor in
  // server mode. System links retain their existing reader redirects.
  if (search.has('folder') || (!systemFolder && !systemFile)) return <>
    <ResourceLibrary onImport={folderId => setImporting({ folderId })} />
    {importing && <Suspense fallback={null}><LegacyLibrary importing={{ ...importing, onClose: () => setImporting(null) }} /></Suspense>}
  </>;
  // 本地课程表的分包比服务端目录大得多，单独给一个整页加载态。
  return <Suspense fallback={<PageLoader label={t('library.chrome.pageLoading')} />}><LegacyLibrary /></Suspense>;
}
