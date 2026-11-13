import React from 'react';
import ReactDOM from 'react-dom/client';
import CloudGate from './cloud/Gate';
import { serverClient } from './api/serverClient';
import { startCloud, stopCloud } from './cloud/sync';
import { useSettings } from './store/settings';
import { applyAccentColor, applyFontScale, applyTheme } from './ui/theme';
import AppLocaleProvider from './i18n/AppLocaleProvider';
import { startLocaleSync } from './i18n/settings';
import i18n from './i18n';
// MD3 的参考字体是 Roboto。只自托管**拉丁/数字子集**（latin，约 15KB/字重，离线可用）：
// 中文交给系统字体（PingFang SC / 微软雅黑），因为思源黑体全量要好几 MB，中文应用引 Web 字体不划算，
// 且平台自带的中文字形更符合各系统习惯。字重只用 400（正文）+ 500（标题）。
import '@fontsource/roboto/latin-400.css';
import '@fontsource/roboto/latin-500.css';
// HeroUI v3 样式（Tailwind v4 基础层 + 主题令牌 + 组件样式）。
//
// ⚠️ 必须引 `/css` 子路径：`@heroui/styles` 主入口解析到 dist/index.js，
// 那是个纯 JS 模块（只导出 buttonVariants 之类的样式函数），**不含任何 CSS**。
// 症状很有迷惑性：DOM 上 class="button button--md button--secondary" 齐全、
// 组件也渲染出来了，但 computed style 一条都对不上（按钮 56×25、Switch 0×0）。
// 在 theme.css 的同一个 CSS 入口先引入 HeroUI，再覆盖圆角主题令牌。
import './theme.css';
import './transitions.css';
import './ui/sheet-motion.css';
import './handout-doc.css';
// Markdown 内容表格的三线表口径（与讲义 .hd-table 一致）。必须排在 x-markdown
// 自带样式之后：它给 .x-markdown 定的 --td-th-padding 是同等权重，靠顺序取胜。
import './md-table.css';
import { apiUrl } from './api/base';
import { consumeBootstrapLink } from './cloud/bootstrapLink';
import DatabaseNotice from './cloud/DatabaseNotice';
// 不走 `./ui` barrel:barrel 会把 layout.tsx(react-router-dom)与 feedback.tsx(HeroUI)
// 一并拉进入口首屏,这里只需要两件轻量实现。
import { PageLoader } from './ui/page-loader';
import { toast } from './ui/toast';

// Consume once, outside React rendering (including StrictMode), before API calls.
const bootstrapSecret = consumeBootstrapLink(location, history);

// Preserve offline drafts, pending commands and historical source bytes.
navigator.storage?.persist?.().catch(() => {});

// 首帧之前就把主题挂到 <html> 上，避免深色用户先看到一下白底。
// zustand 的 persist 是同步读 localStorage 的，所以这里能直接拿到用户设置。
applyTheme(useSettings.getState().theme);
applyAccentColor(useSettings.getState().accentColor);
applyFontScale(useSettings.getState().fontScale);
const stopLocaleSync = startLocaleSync();
import.meta.hot?.dispose(stopLocaleSync);

const stopSettingsSync = (() => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === 'wangke-settings') void useSettings.persist.rehydrate();
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
})();
import.meta.hot?.dispose(stopSettingsSync);

/**
 * 关闭浏览器自己的滚动恢复。
 *
 * 讲义/材料是自己管阅读位置的（`handout/readingPos.ts`、`videos.lastUnit`），而浏览器的
 * 恢复是**在内容渲染完之后才生效的**，且不由我们控制时机：两者会打架，实测表现为
 * 「明明读到第五节，打开却停在第四节中段」（实测偏差一个段落：期望 s1b3@40、实际 s1b2@74）。
 *
 * 关掉是安全的：本应用里没有一处依赖原生恢复 —— 库页、播放器、聊天都不做滚动恢复，
 * 各视图要么自己落位（讲义/材料），要么每次都从顶部开始。
 */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const root = ReactDOM.createRoot(document.getElementById('root')!);

// CSS 走的是非阻塞调度（见 vite.config.ts 的 cssNonBlockingBoot）,与 JS 并行下载;
// React 首帧渲染前等它就绪,避免正文 FOUC。骨架屏样式内联在 index.html,不受影响。
const bootCss = document.querySelector<HTMLLinkElement>('link[data-wangke-boot-css]');
const cssReady: Promise<void> = bootCss && !bootCss.dataset.wangkeCssDone
  ? new Promise((resolve) => {
    bootCss.addEventListener('load', () => resolve(), { once: true });
    bootCss.addEventListener('error', () => resolve(), { once: true });
    setTimeout(resolve, 3000);
  })
  : Promise.resolve();

/** 同步主题类与 HeroUI 强调色令牌，实际配色由 CSS 变量控制。 */
// 首帧兜底：boot() 要等会话状态接口返回才能决定渲染登录页还是应用，在此之前
// 先渲染与 index.html 内联启动骨架同款的扫光 loading，避免弱网下白屏。
let bootView: React.ReactNode = <PageLoader label="正在启动…" />;
function Root() {
  const theme = useSettings((s) => s.theme);
  const accentColor = useSettings((s) => s.accentColor);
  const fontScale = useSettings((s) => s.fontScale);
  React.useEffect(() => {
    applyTheme(theme);
    if (theme !== 'auto') return;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const sync = () => applyTheme('auto');
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, [theme]);
  React.useEffect(() => {
    applyAccentColor(accentColor);
  }, [accentColor]);
  React.useEffect(() => {
    applyFontScale(fontScale);
  }, [fontScale]);
  return <AppLocaleProvider><DatabaseNotice />{bootView}</AppLocaleProvider>;
}

function render() {
  void cssReady.then(() => root.render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>,
  ));
}

// PWA autoUpdate：新 SW 在后台接管后，老页面仍在跑旧版本。这里给一条轻提示，
// 提供手动刷新入口，不自动打断当前操作；首次安装激活不提示。
if ('serviceWorker' in navigator) {
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }
    hadController = true;
    toast.info(i18n.t('newVersionReady'), {
      timeout: 0,
      actionProps: {
        children: i18n.t('refreshNow'),
        onPress: () => window.location.reload(),
      },
    });
  });
}

// HeroUI 的组件是纯 React 实现（无 Web Components 注册等待），直接渲染首帧。
async function boot() {
  try {
    const response = await fetch(apiUrl('/api/v1/cloud/status'), { cache: 'no-store' });
    const status = await response.json().catch(() => null);
    if (!response.ok || status?.cloud !== true) throw new Error(i18n.t('serverUnavailable'));
    const [bootstrap, session] = await Promise.all([serverClient.bootstrapStatus(), serverClient.session()]);
    if (session.authenticated && session.user) {
      // 已登录的下一帧必然是 App + 默认路由(对话页),与 startCloud 并行拉分包,
      // 别让「同步本地阶段 → 渲染 Gate → 再下载 App → 再下载 CourseChat」串成瀑布。
      void Promise.all([import('./App'), import('./pages/CourseChat')]).catch(() => {});
      await startCloud(session.user.id, { background: true });
    }
    window.addEventListener('cloud-session-expired', stopCloud);
    bootView = <CloudGate initialized={bootstrap.initialized} authenticated={session.authenticated} hasPasskey={bootstrap.hasPasskey} initialSecret={bootstrap.initialized ? '' : bootstrapSecret} />;
  } catch (error) {
    bootView = <CloudGate initialized authenticated={false} error={(error as Error).message} />;
  }
  render();
}
render();
void boot();
