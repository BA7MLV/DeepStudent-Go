/**
 * 资料库的懒加载边界。
 *
 * 这一层只有一件事：把「重」的子流程包成 `React.lazy`，让它们各自成为独立分包。
 * 重库本体（B 站解析/转封装、转写管线、云任务提交）都在下面这些模块的传递依赖里，
 * 谁也没在资料库首屏的静态图里 —— `scripts/test-boot-budget.mjs` 守的就是这一点。
 *
 * 注意：不要在这里 `import` 任何东西再转发（那会把被转发模块重新拉回静态图），
 * 这里只允许出现 `lazy()` 的 loader 函数。
 */
import { lazy } from 'react';

/** B 站导入弹窗：解析器 + 字幕抓取 + 转封装（remux）都在它背后 */
export const BiliImportDialog = lazy(() => import('./BiliImportDialog'));

/** 旧版本地课程表：IndexedDB 全表刷新、封面读取、拖拽移动 */
export const LegacyLibrary = lazy(() => import('./LibraryLegacy'));
