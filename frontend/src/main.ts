import "./shell.css";
import { HealthService } from "./mygo";

type ViewId = "study" | "library" | "chat" | "notes" | "flashcards" | "review" | "settings";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

const navGroups: Array<{ label: string; items: Array<{ id: ViewId; label: string; icon: string }> }> = [
  { label: "工作区", items: [
    { id: "study", label: "学习空间", icon: "⌂" },
    { id: "library", label: "资料库", icon: "▤" },
    { id: "chat", label: "智能对话", icon: "✦" },
  ] },
  { label: "学习工具", items: [
    { id: "notes", label: "笔记", icon: "▧" },
    { id: "flashcards", label: "闪卡", icon: "◇" },
    { id: "review", label: "复习", icon: "◷" },
  ] },
];

const readTheme = (): "light" | "dark" => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
const setTheme = (theme: "light" | "dark") => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem("dstu-theme-mode", theme);
};
setTheme(readTheme());

root.innerHTML = `
  <div class="ds-shell" data-sidebar-open="false" data-sidebar-collapsed="false">
    <header class="ds-titlebar" data-shell-layer="window-chrome">
      <div class="ds-titlebar__nav"><span class="ds-titlebar__traffic" aria-hidden="true"><i></i><i></i><i></i></span><span class="ds-titlebar__brand">DeepStudent</span></div>
      <div class="ds-titlebar__workspace">
        <button class="ds-menu-button" id="mobile-menu" aria-label="打开导航" aria-expanded="false">☰</button>
        <span class="ds-titlebar__title" id="shell-title">学习空间</span>
        <div class="ds-titlebar__actions"><button class="ds-icon-button" id="theme-toggle" aria-label="切换主题" title="切换主题">◐</button><button class="ds-icon-button" id="desktop-sidebar-toggle" aria-label="折叠侧栏" title="折叠侧栏">◧</button></div>
      </div>
    </header>
    <div class="ds-body">
      <aside class="ds-sidebar" data-shell-layer="navigation" aria-label="主导航">
        <div class="ds-sidebar__head"><div class="ds-brand"><span class="ds-brand__mark"><img src="/deepstudent-logo.svg" alt="" /></span><span class="ds-brand__name">DeepStudent</span></div><button class="ds-icon-button ds-sidebar__collapse" id="sidebar-collapse" aria-label="折叠导航">‹</button></div>
        <div class="ds-sidebar__scroll"><div class="ds-nav">
          ${navGroups.map((group) => `<div class="ds-nav__section">${group.label}</div>${group.items.map(({ id, label, icon }) => `<button type="button" data-view="${id}" data-active="${id === "study"}"><span class="ds-nav__icon" aria-hidden="true">${icon}</span><span class="ds-nav__label">${label}</span>${id === "review" ? '<span class="ds-nav__badge">12</span>' : ""}</button>`).join("")}`).join("")}
          <div class="ds-nav__section">管理</div><button type="button" data-view="settings"><span class="ds-nav__icon" aria-hidden="true">⚙</span><span class="ds-nav__label">设置</span></button>
        </div></div>
        <div class="ds-sidebar__footer"><span class="ds-status" id="runtime-status"><span class="ds-status__dot"></span><span>正在连接 Go runtime…</span></span><span class="ds-sidebar__version">DeepStudent Go · 0.1</span></div>
      </aside>
      <button class="ds-overlay" id="sidebar-overlay" aria-label="关闭导航"></button>
      <main class="ds-main" data-shell-layer="workspace">
        <header class="ds-main__header"><div class="ds-main__heading"><h1 id="view-title">学习空间</h1><p id="view-subtitle">在一个安静的工作区里继续学习</p></div><div class="ds-main__actions"><button class="ds-icon-button" id="search-button" aria-label="搜索">⌕</button><button class="ds-icon-button" id="new-button" aria-label="新建">＋</button></div></header>
        <div class="ds-main__content" id="main-content"></div>
      </main>
    </div>
  </div>
`;

const shell = root.querySelector<HTMLElement>(".ds-shell")!;
const mainContent = root.querySelector<HTMLElement>("#main-content")!;
const viewTitle = root.querySelector<HTMLElement>("#view-title")!;
const viewSubtitle = root.querySelector<HTMLElement>("#view-subtitle")!;
const shellTitle = root.querySelector<HTMLElement>("#shell-title")!;
const mobileMenu = root.querySelector<HTMLButtonElement>("#mobile-menu")!;
const themeToggle = root.querySelector<HTMLButtonElement>("#theme-toggle")!;
const desktopSidebarToggle = root.querySelector<HTMLButtonElement>("#desktop-sidebar-toggle")!;
const sidebarCollapse = root.querySelector<HTMLButtonElement>("#sidebar-collapse")!;
const sidebarOverlay = root.querySelector<HTMLButtonElement>("#sidebar-overlay")!;

const closeMobileSidebar = () => { shell.dataset.sidebarOpen = "false"; mobileMenu.setAttribute("aria-expanded", "false"); };
const openMobileSidebar = () => { shell.dataset.sidebarOpen = "true"; mobileMenu.setAttribute("aria-expanded", "true"); };
const statusPill = (text: string, tone = "") => `<span class="ds-status ${tone}"><span class="ds-status__dot"></span>${text}</span>`;

const renderDashboard = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">星期四，10 月 1 日</p><h2>早上好，继续保持节奏</h2><p class="ds-page-intro__copy">今天有 3 个学习目标，预计用时约 45 分钟</p></div><button class="ds-primary-button" data-action="start-focus">开始专注 <span>→</span></button></div>
  <div class="ds-metric-grid"><section class="ds-card ds-metric"><span class="ds-metric__label">今日进度</span><strong>2 <small>/ 5 任务</small></strong><div class="ds-progress"><i style="width:40%"></i></div><span class="ds-muted">还剩约 32 分钟</span></section><section class="ds-card ds-metric"><span class="ds-metric__label">连续学习</span><strong>7 <small>天</small></strong><span class="ds-metric__trend">↑ 比上周多 2 天</span></section><section class="ds-card ds-metric"><span class="ds-metric__label">待复习卡片</span><strong>12 <small>张</small></strong><button class="ds-text-button" data-nav="review">现在复习 →</button></section></div>
  <div class="ds-dashboard-grid"><section class="ds-card ds-panel-card"><div class="ds-section-head"><div><h3>今日计划</h3><p>一步一步完成今天的目标</p></div><button class="ds-icon-button" aria-label="添加任务">＋</button></div><div class="ds-task-list"><label class="ds-task"><input type="checkbox" checked /><span><b>阅读：线性代数基础</b><small>资料库 · 25 分钟</small></span><em>已完成</em></label><label class="ds-task"><input type="checkbox" /><span><b>整理第三章笔记</b><small>笔记 · 15 分钟</small></span><em>待开始</em></label><label class="ds-task"><input type="checkbox" /><span><b>复习今日闪卡</b><small>闪卡 · 5 分钟</small></span><em>待开始</em></label></div></section><section class="ds-card ds-panel-card"><div class="ds-section-head"><div><h3>最近活动</h3><p>从上次离开的位置继续</p></div><button class="ds-text-button" data-nav="library">查看全部</button></div><div class="ds-activity-list"><button class="ds-activity"><span class="ds-file-icon ds-file-icon--blue">PDF</span><span><b>Calculus — Chapter 3</b><small>刚刚 · 资料库</small></span><span>→</span></button><button class="ds-activity"><span class="ds-file-icon ds-file-icon--purple">N</span><span><b>概率论复习笔记</b><small>昨天 · 笔记</small></span><span>→</span></button><button class="ds-activity"><span class="ds-file-icon ds-file-icon--green">✦</span><span><b>AI 学习对话</b><small>昨天 · 智能对话</small></span><span>→</span></button></div></section></div>
`;

const renderLibrary = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">你的学习资料</p><h2>资料库</h2><p class="ds-page-intro__copy">集中管理 PDF、网页和课堂笔记</p></div><button class="ds-primary-button" data-action="upload">＋ 添加资料</button></div>
  <div class="ds-toolbar ds-card"><label class="ds-search-field"><span>⌕</span><input id="library-search" placeholder="搜索资料…" aria-label="搜索资料" /></label><div class="ds-filter-pills"><button class="is-active" data-filter="all">全部 <span>24</span></button><button data-filter="pdf">PDF <span>12</span></button><button data-filter="note">笔记 <span>8</span></button><button data-filter="link">网页 <span>4</span></button></div><button class="ds-icon-button" aria-label="排序">↕</button></div>
  <div class="ds-library-layout"><section class="ds-library-list" id="library-list"><article class="ds-card ds-resource" data-kind="pdf" data-name="Calculus Chapter 3"><span class="ds-file-icon ds-file-icon--blue">PDF</span><div><h3>Calculus — Chapter 3</h3><p>微积分 · 12.4 MB · 2 小时前</p><div class="ds-chip-row"><span>数学</span><span>正在阅读</span></div></div><button class="ds-icon-button" aria-label="更多操作">⋯</button></article><article class="ds-card ds-resource" data-kind="note" data-name="概率论复习笔记"><span class="ds-file-icon ds-file-icon--purple">N</span><div><h3>概率论复习笔记</h3><p>笔记 · 8 个段落 · 昨天</p><div class="ds-chip-row"><span>概率</span><span>已标记</span></div></div><button class="ds-icon-button" aria-label="更多操作">⋯</button></article><article class="ds-card ds-resource" data-kind="link" data-name="Linear Algebra Visualized"><span class="ds-file-icon ds-file-icon--green">↗</span><div><h3>Linear Algebra Visualized</h3><p>网页 · 线性代数 · 3 天前</p><div class="ds-chip-row"><span>收藏</span></div></div><button class="ds-icon-button" aria-label="更多操作">⋯</button></article></section><aside class="ds-card ds-library-aside"><p class="ds-eyebrow">资料概览</p><h3>24 个资料</h3><div class="ds-breakdown"><div><span><i class="ds-dot ds-dot--blue"></i>PDF</span><b>12</b></div><div><span><i class="ds-dot ds-dot--purple"></i>笔记</span><b>8</b></div><div><span><i class="ds-dot ds-dot--green"></i>网页</span><b>4</b></div></div><div class="ds-dropzone"><span>＋</span><p>拖拽文件到这里<br /><small>支持 PDF、Markdown 和网页</small></p></div></aside></div>
`;

const renderChat = () => `
  <div class="ds-chat-shell"><aside class="ds-chat-rail ds-card"><div class="ds-section-head"><h3>对话</h3><button class="ds-icon-button" aria-label="新建对话">＋</button></div><label class="ds-search-field ds-search-field--small"><span>⌕</span><input placeholder="搜索对话" /></label><div class="ds-chat-threads"><button class="is-active"><b>理解梯度下降</b><small>今天 · 3 条消息</small></button><button><b>复习概率论</b><small>昨天 · 8 条消息</small></button><button><b>帮我读这篇论文</b><small>周一 · 12 条消息</small></button></div></aside><section class="ds-chat"><div class="ds-chat__context"><span class="ds-file-icon ds-file-icon--blue">PDF</span><span><b>Calculus — Chapter 3</b><small>已关联资料</small></span><button class="ds-text-button">移除</button></div><div class="ds-chat__messages" id="chat-messages"><div class="ds-chat__welcome"><span class="ds-avatar">✦</span><h2>今天想学点什么？</h2><p>把问题、资料或一个模糊的想法放进来，DeepStudent 会陪你拆开它</p><div class="ds-suggestion-row"><button data-prompt="用三句话解释梯度下降">用三句话解释梯度下降</button><button data-prompt="帮我生成复习提纲">生成复习提纲</button></div></div></div><form class="ds-chat__composer" id="chat-form"><label class="ds-visually-hidden" for="chat-input">输入消息</label><textarea class="ds-chat__input" id="chat-input" rows="1" placeholder="问问 DeepStudent…"></textarea><button class="ds-chat__send" type="submit">↑</button></form></section></div>
`;

const renderNotes = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">知识整理</p><h2>笔记</h2><p class="ds-page-intro__copy">把理解留下来，之后更容易找到</p></div><button class="ds-primary-button" data-action="new-note">＋ 新建笔记</button></div><div class="ds-notes-layout"><aside class="ds-card ds-note-list"><label class="ds-search-field ds-search-field--small"><span>⌕</span><input placeholder="搜索笔记" /></label><div class="ds-note-list__items"><button class="is-active"><b>概率论复习笔记</b><small>今天 09:42 · 8 个段落</small></button><button><b>梯度下降直觉</b><small>昨天 · 5 个段落</small></button><button><b>线性代数：特征值</b><small>9 月 28 日 · 11 个段落</small></button><button><b>待整理的课堂摘录</b><small>9 月 26 日 · 草稿</small></button></div></aside><article class="ds-card ds-note-editor"><div class="ds-note-editor__bar"><span class="ds-muted">最后编辑于今天 09:42</span><div><button class="ds-icon-button" aria-label="分享">⌁</button><button class="ds-icon-button" aria-label="更多">⋯</button></div></div><div class="ds-note-editor__body"><span class="ds-chip">概率</span><h3>概率论复习笔记</h3><p class="ds-muted">从条件概率到贝叶斯定理的核心概念</p><hr /><h4>条件概率</h4><p>当我们已经知道事件 B 发生时，事件 A 发生的概率可以写成 P(A|B)。它帮助我们在新信息出现后更新判断。</p><div class="ds-callout"><span>✦</span><p><b>AI 摘要</b><br />这份笔记梳理了条件概率、独立性和贝叶斯定理之间的关系。</p></div><p class="ds-editor-placeholder">继续输入，或按 ⌘K 呼叫 AI…</p></div></article></div>
`;

const renderFlashcards = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">主动回忆</p><h2>闪卡</h2><p class="ds-page-intro__copy">用短时练习巩固真正理解的内容</p></div><button class="ds-primary-button" data-action="new-deck">＋ 新建卡组</button></div><div class="ds-metric-grid ds-metric-grid--compact"><section class="ds-card ds-metric"><span class="ds-metric__label">今日待复习</span><strong>12 <small>张</small></strong><span class="ds-muted">约 8 分钟</span></section><section class="ds-card ds-metric"><span class="ds-metric__label">掌握率</span><strong>78<small>%</small></strong><span class="ds-metric__trend">↑ 比上周多 6%</span></section><section class="ds-card ds-metric"><span class="ds-metric__label">卡组总数</span><strong>4 <small>个</small></strong><button class="ds-text-button">管理卡组 →</button></section></div><section class="ds-card ds-deck-panel"><div class="ds-section-head"><div><h3>我的卡组</h3><p>按最近复习时间排序</p></div><button class="ds-text-button">查看全部</button></div><div class="ds-deck-list"><button class="ds-deck"><span class="ds-deck__icon ds-deck__icon--blue">∑</span><span><b>微积分基础</b><small>32 张 · 最近复习 2 小时前</small></span><span class="ds-deck__count">8 <small>待复习</small> →</span></button><button class="ds-deck"><span class="ds-deck__icon ds-deck__icon--purple">π</span><span><b>概率论</b><small>48 张 · 最近复习昨天</small></span><span class="ds-deck__count">4 <small>待复习</small> →</span></button><button class="ds-deck"><span class="ds-deck__icon ds-deck__icon--green">A</span><span><b>英语学术词汇</b><small>120 张 · 最近复习 9 月 28 日</small></span><span class="ds-deck__count">0 <small>待复习</small> →</span></button></div></section>
`;

const renderReview = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">间隔重复</p><h2>复习</h2><p class="ds-page-intro__copy">现在投入几分钟，让知识留得更久</p></div><button class="ds-primary-button" data-action="start-review">开始复习 <span>→</span></button></div><section class="ds-card ds-review-hero"><div><span class="ds-chip ds-chip--accent">准备好了</span><h3>今天有 12 张卡片等你</h3><p>预计 8 分钟完成，完成后连续学习将达到 8 天</p><button class="ds-primary-button" data-action="start-review">从第一张开始</button></div><div class="ds-review-ring"><strong>12</strong><span>张卡片</span></div></section><div class="ds-review-grid"><section class="ds-card ds-panel-card"><div class="ds-section-head"><div><h3>复习队列</h3><p>根据记忆强度安排</p></div></div><div class="ds-queue"><div><span class="ds-queue__dot ds-queue__dot--red"></span><span><b>需要巩固</b><small>今天到期</small></span><strong>5</strong></div><div><span class="ds-queue__dot ds-queue__dot--yellow"></span><span><b>正在熟悉</b><small>今天到期</small></span><strong>4</strong></div><div><span class="ds-queue__dot ds-queue__dot--green"></span><span><b>保持记忆</b><small>今天到期</small></span><strong>3</strong></div></div></section><section class="ds-card ds-panel-card"><div class="ds-section-head"><div><h3>学习统计</h3><p>过去 7 天</p></div></div><div class="ds-bars"><i style="height:42%"></i><i style="height:64%"></i><i style="height:34%"></i><i style="height:82%"></i><i style="height:52%"></i><i style="height:74%"></i><i style="height:92%"></i></div><div class="ds-bars__labels"><span>五</span><span>六</span><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span></div></section></div>
`;

const renderSettings = () => `
  <div class="ds-page-intro"><div><p class="ds-eyebrow">偏好设置</p><h2>设置</h2><p class="ds-page-intro__copy">让 DeepStudent 更贴合你的学习方式</p></div></div><div class="ds-settings-layout"><nav class="ds-card ds-settings-nav"><button class="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><section class="ds-settings-content"><section class="ds-card ds-setting-section"><div class="ds-setting-heading"><h3>常规</h3><p>管理工作区和学习体验</p></div><label class="ds-setting-row"><span><b>启动时打开学习空间</b><small>每次打开应用时回到 dashboard</small></span><input class="ds-switch" type="checkbox" checked /></label><label class="ds-setting-row"><span><b>自动保存笔记</b><small>编辑后立即在本地保存更改</small></span><input class="ds-switch" type="checkbox" checked /></label></section><section class="ds-card ds-setting-section"><div class="ds-setting-heading"><h3>外观</h3><p>调整界面的显示方式</p></div><label class="ds-setting-row"><span><b>主题</b><small>跟随系统偏好，也可以手动切换</small></span><select id="settings-theme"><option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option></select></label><label class="ds-setting-row"><span><b>紧凑布局</b><small>减少列表和卡片之间的留白</small></span><input class="ds-switch" type="checkbox" /></label></section><section class="ds-card ds-setting-section"><div class="ds-setting-heading"><h3>运行时连接</h3><p>当前 MyGo 桌面壳连接状态</p></div><div class="ds-runtime-row">${statusPill("Go runtime 已连接", "ds-status--online")}<code>HealthService.Health</code></div></section></section></div>
`;

const viewMeta: Record<ViewId, { title: string; subtitle: string; render: () => string }> = {
  study: { title: "学习空间", subtitle: "在一个安静的工作区里继续学习", render: renderDashboard },
  library: { title: "资料库", subtitle: "把资料集中到可检索的学习空间", render: renderLibrary },
  chat: { title: "智能对话", subtitle: "和你的学习助手一起思考", render: renderChat },
  notes: { title: "笔记", subtitle: "把理解留下来，之后更容易找到", render: renderNotes },
  flashcards: { title: "闪卡", subtitle: "用主动回忆巩固真正理解的内容", render: renderFlashcards },
  review: { title: "复习", subtitle: "让记忆在合适的时间被重新唤起", render: renderReview },
  settings: { title: "设置", subtitle: "调整 DeepStudent Go 的工作方式", render: renderSettings },
};

const wireChat = () => {
  const form = root.querySelector<HTMLFormElement>("#chat-form");
  const input = root.querySelector<HTMLTextAreaElement>("#chat-input");
  const messages = root.querySelector<HTMLElement>("#chat-messages");
  if (!form || !input || !messages) return;
  root.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => { input.value = button.dataset.prompt ?? ""; input.focus(); }));
  form.addEventListener("submit", (event) => { event.preventDefault(); const value = input.value.trim(); if (!value) return; const message = document.createElement("div"); message.className = "ds-chat__message ds-chat__message--user"; const text = document.createElement("p"); text.textContent = value; message.append(text); messages.append(message); input.value = ""; input.focus(); messages.scrollTop = messages.scrollHeight; });
  input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
};
const wireLibrary = () => {
  const search = root.querySelector<HTMLInputElement>("#library-search"); const list = root.querySelector<HTMLElement>("#library-list"); if (!search || !list) return;
  const filter = (kind = "all") => { list.querySelectorAll<HTMLElement>(".ds-resource").forEach((card) => { const matchesKind = kind === "all" || card.dataset.kind === kind; const matchesSearch = !search.value.trim() || (card.dataset.name ?? "").toLowerCase().includes(search.value.toLowerCase()); card.hidden = !(matchesKind && matchesSearch); }); };
  search.addEventListener("input", () => filter(root.querySelector<HTMLButtonElement>(".ds-filter-pills .is-active")?.dataset.filter ?? "all"));
  root.querySelectorAll<HTMLButtonElement>("[data-filter]").forEach((button) => button.addEventListener("click", () => { root.querySelectorAll("[data-filter]").forEach((item) => item.classList.remove("is-active")); button.classList.add("is-active"); filter(button.dataset.filter); }));
};
const wireSettings = () => { const select = root.querySelector<HTMLSelectElement>("#settings-theme"); if (select) { select.value = document.documentElement.dataset.theme ?? "system"; select.addEventListener("change", () => { if (select.value === "light" || select.value === "dark") setTheme(select.value); }); } };

let currentView: ViewId = "study";
const setView = (view: ViewId) => { currentView = view; const meta = viewMeta[view]; viewTitle.textContent = meta.title; shellTitle.textContent = meta.title; viewSubtitle.textContent = meta.subtitle; mainContent.innerHTML = meta.render(); root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => { button.dataset.active = String(button.dataset.view === view); }); closeMobileSidebar(); if (view === "chat") wireChat(); if (view === "library") wireLibrary(); if (view === "settings") wireSettings(); };

root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView((button.dataset.view ?? "study") as ViewId)));
root.addEventListener("click", (event) => { const target = event.target as HTMLElement; const nav = target.closest<HTMLElement>("[data-nav]"); if (nav?.dataset.nav) setView(nav.dataset.nav as ViewId); const action = target.closest<HTMLElement>("[data-action]")?.dataset.action; if (action === "start-focus") setView("chat"); if (action === "start-review") setView("review"); if (action === "new-note") setView("notes"); });
mobileMenu.addEventListener("click", () => { if (shell.dataset.sidebarOpen === "true") closeMobileSidebar(); else openMobileSidebar(); });
sidebarOverlay.addEventListener("click", closeMobileSidebar);
sidebarCollapse.addEventListener("click", () => { if (window.matchMedia("(max-width: 767.98px)").matches) closeMobileSidebar(); else shell.dataset.sidebarCollapsed = shell.dataset.sidebarCollapsed === "true" ? "false" : "true"; });
desktopSidebarToggle.addEventListener("click", () => { shell.dataset.sidebarCollapsed = shell.dataset.sidebarCollapsed === "true" ? "false" : "true"; });
themeToggle.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
root.querySelector<HTMLButtonElement>("#search-button")?.addEventListener("click", () => {
  setView("library");
  window.setTimeout(() => root.querySelector<HTMLInputElement>("#library-search")?.focus(), 0);
});
root.querySelector<HTMLButtonElement>("#new-button")?.addEventListener("click", () => setView("notes"));
setView(currentView);

async function bootRuntime() { const status = root.querySelector<HTMLElement>("#runtime-status span:last-child"); try { const health = await HealthService.health(); if (status) status.textContent = `${health.runtime} runtime: ${health.status}`; } catch { if (status) status.textContent = "runtime bridge unavailable"; } }
void bootRuntime();
