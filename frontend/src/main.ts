import "./shell.css";
import { HealthService } from "./mygo";

type ViewId =
  | "chat-v2"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "task-dashboard"
  | "flashcards"
  | "template-management"
  | "settings";

type Theme = "light" | "dark";
const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

const navItems: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: "chat-v2", label: "新会话", icon: "✦" },
  { id: "learning-hub", label: "学习资源", icon: "▤" },
  { id: "todo", label: "待办事项", icon: "☑" },
  { id: "skills-management", label: "技能管理", icon: "✧" },
  { id: "task-dashboard", label: "Anki制卡", icon: "▱" },
  { id: "flashcards", label: "闪卡", icon: "▦" },
  { id: "template-management", label: "模板管理", icon: "▥" },
];

const viewMeta: Record<ViewId, { title: string; subtitle: string }> = {
  "chat-v2": { title: "", subtitle: "" },
  "learning-hub": { title: "学习资源", subtitle: "浏览和管理你的学习资料" },
  todo: { title: "待办事项", subtitle: "把下一步学习行动放在眼前" },
  "skills-management": { title: "技能管理", subtitle: "配置 DeepStudent 的可用技能" },
  "task-dashboard": { title: "Anki 制卡", subtitle: "从资料生成可复习的卡片" },
  flashcards: { title: "闪卡", subtitle: "用主动回忆巩固真正理解的内容" },
  "template-management": { title: "模板管理", subtitle: "管理笔记、卡片和输出模板" },
  settings: { title: "设置", subtitle: "调整 DeepStudent 的工作方式" },
};

const readTheme = (): Theme => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};
const setTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  window.localStorage.setItem("dstu-theme-mode", theme);
};
setTheme(readTheme());

root.innerHTML = `
  <div class="ds-shell" data-sidebar-open="false" data-sidebar-collapsed="false">
    <header class="ds-titlebar" data-shell-layer="window-chrome">
      <div class="ds-titlebar__nav">
        <span class="ds-titlebar__traffic" aria-hidden="true"><i></i><i></i><i></i></span>
        <img class="ds-titlebar__logo" src="./logo-black.svg" alt="" />
        <span class="ds-titlebar__brand">DeepStudent</span>
      </div>
      <div class="ds-titlebar__workspace">
        <button class="ds-menu-button" id="mobile-menu" aria-label="打开导航" aria-expanded="false">☰</button>
        <div class="ds-titlebar__crumb"><span id="shell-title">DeepStudent</span><span id="shell-meta"></span></div>
        <div class="ds-titlebar__actions">
          <button class="ds-titlebar__control" id="new-session" aria-label="新建会话" title="新建会话">＋</button>
          <button class="ds-titlebar__control" id="theme-toggle" aria-label="切换主题" title="切换主题">◐</button>
          <button class="ds-titlebar__control" id="desktop-sidebar-toggle" aria-label="收起侧边栏" title="收起侧边栏">‹</button>
        </div>
      </div>
    </header>
    <div class="ds-body">
      <aside class="ds-sidebar" data-shell-layer="navigation" aria-label="DeepStudent 主入口">
        <div class="ds-sidebar__brand"><span>DeepStudent</span><div class="ds-sidebar__brand-actions"><button class="ds-icon-button" aria-label="筛选">≡</button><button class="ds-icon-button" id="search-session" aria-label="搜索会话">⌕</button></div></div>
        <nav class="ds-primary-nav" aria-label="主入口">
          ${navItems.map((item) => `<button class="ds-nav-row" data-view="${item.id}" data-active="${item.id === "chat-v2"}"><span class="ds-nav-icon">${item.icon}</span><span>${item.label}</span></button>`).join("")}
        </nav>
        <div class="ds-sidebar__scroll">
          <section class="ds-sidebar-section" data-section="pinned">
            <div class="ds-section-label"><span>置顶</span><button class="ds-section-action" aria-label="展开置顶">⌄</button></div>
            <button class="ds-thread-row"><span class="ds-thread-dot ds-thread-dot--accent">✦</span><span>开始一个新对话</span></button>
          </section>
          <section class="ds-sidebar-section" data-section="topics">
            <div class="ds-section-label"><span>主题</span><span class="ds-section-tools"><button class="ds-section-action" aria-label="展开或收起主题">⌄</button><button class="ds-section-action" aria-label="新建主题">＋</button></span></div>
            <button class="ds-topic-row"><span class="ds-topic-icon">⌂</span><span>高中生物</span><em>2</em><b>⌄</b></button>
            <button class="ds-thread-row ds-thread-row--nested"><span>智能学习助手介绍</span></button>
            <button class="ds-thread-row ds-thread-row--nested"><span>完善高中生物思维导图</span></button>
            <button class="ds-topic-row"><span class="ds-topic-icon">▣</span><span>高中英语</span><em>1</em><b>⌄</b></button>
            <button class="ds-thread-row ds-thread-row--nested"><span>制作读后续写 Anki 卡片</span></button>
            <button class="ds-topic-row"><span class="ds-topic-icon">□</span><span>LLM研究</span><em>6</em><b>⌄</b></button>
            <button class="ds-thread-row ds-thread-row--nested"><span>最新 LLM 研究论文汇总</span></button>
            <button class="ds-thread-row ds-thread-row--nested"><span>Context7 查询 LLM 文档</span></button>
          </section>
          <section class="ds-sidebar-section" data-section="conversations">
            <div class="ds-section-label"><span>对话</span><button class="ds-section-action" id="create-session" aria-label="新建会话">＋</button></div>
            <button class="ds-thread-row ds-thread-row--active"><span class="ds-thread-dot">●</span><span>未命名会话</span><small>刚刚</small></button>
            <button class="ds-thread-row"><span class="ds-thread-dot">●</span><span>复习概率论</span><small>昨天</small></button>
            <button class="ds-thread-row"><span class="ds-thread-dot">●</span><span>帮我读这篇论文</span><small>周一</small></button>
          </section>
        </div>
        <div class="ds-sidebar__footer">
          <button class="ds-nav-row" data-view="settings" data-active="false"><span class="ds-nav-icon">⚙</span><span>设置</span></button>
          <div class="ds-runtime-status" id="runtime-status"><i></i><span>连接 Go runtime…</span></div>
          <div class="ds-sidebar__version">DeepStudent Go · 0.1</div>
        </div>
      </aside>
      <button class="ds-overlay" id="sidebar-overlay" aria-label="关闭导航"></button>
      <main class="ds-main" data-shell-layer="workspace">
        <header class="ds-main__header"><div class="ds-main__heading"><h1 id="view-title"></h1><p id="view-subtitle"></p></div><div class="ds-main__actions"><button class="ds-icon-button" id="main-search" aria-label="搜索">⌕</button><button class="ds-icon-button" id="main-add" aria-label="新建">＋</button></div></header>
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
const shellMeta = root.querySelector<HTMLElement>("#shell-meta")!;
const mobileMenu = root.querySelector<HTMLButtonElement>("#mobile-menu")!;
const sidebarOverlay = root.querySelector<HTMLButtonElement>("#sidebar-overlay")!;

const statusPill = (text: string) => `<span class="ds-status"><i></i>${text}</span>`;

const renderChat = () => `
  <section class="ds-chat-page" aria-labelledby="chat-welcome-title">
    <div class="ds-chat-center">
      <div class="ds-chat-brand" aria-hidden="true"><img src="./logo-black.svg" alt="" /></div>
      <h2 id="chat-welcome-title">欢迎使用 DeepStudent</h2>
      <p>开始新对话，探索学习资料、整理笔记、随时提问</p>
      <div class="ds-chat-actions"><button class="ds-primary-button" data-action="new-session">＋ 新对话</button><button class="ds-secondary-button" data-action="open-learning">▤ 浏览学习资源</button></div>
      <span class="ds-chat-hint">提示：随时按 ⌘ N 新建对话</span>
    </div>
    <form class="ds-composer" id="chat-form">
      <textarea id="chat-input" rows="1" placeholder="问问 DeepStudent…" aria-label="输入消息"></textarea>
      <div class="ds-composer__toolbar"><div class="ds-composer__tools"><button type="button" class="ds-composer-tool" aria-label="添加附件">＋</button><button type="button" class="ds-composer-tool" aria-label="调用工具">✧</button><button type="button" class="ds-composer-tool" aria-label="深度思考">ϟ</button></div><span class="ds-composer__notice">AI 生成的内容可能存在错误，请注意甄别</span><button class="ds-send-button" type="submit" aria-label="发送">↑</button></div>
    </form>
  </section>
`;

const renderLearningHub = () => `
  <section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">学习中心</span><h2>学习资源</h2><p>浏览、搜索并打开你的笔记、教材、试卷和文件</p></div><button class="ds-primary-button">＋ 添加资源</button></div><div class="ds-resource-layout"><aside class="ds-resource-tree"><div class="ds-resource-toolbar"><b>资源库</b><button class="ds-icon-button">＋</button></div><label class="ds-search-field">⌕ <input placeholder="搜索资源…" /></label><button class="ds-resource-row is-active">▤ 全部资源 <em>24</em></button><button class="ds-resource-row">▱ 笔记 <em>8</em></button><button class="ds-resource-row">□ 教材 <em>10</em></button><button class="ds-resource-row">◌ 试卷 <em>6</em></button></aside><div class="ds-resource-grid"><article class="ds-resource-card"><span class="ds-resource-card__icon ds-resource-card__icon--blue">PDF</span><div><b>Calculus — Chapter 3</b><p>教材 · 12.4 MB · 2 小时前</p></div><button class="ds-icon-button">⋯</button></article><article class="ds-resource-card"><span class="ds-resource-card__icon ds-resource-card__icon--purple">N</span><div><b>概率论复习笔记</b><p>笔记 · 昨天更新</p></div><button class="ds-icon-button">⋯</button></article><article class="ds-resource-card"><span class="ds-resource-card__icon ds-resource-card__icon--green">↗</span><div><b>Linear Algebra Visualized</b><p>网页 · 3 天前</p></div><button class="ds-icon-button">⋯</button></article><div class="ds-empty-card"><span>＋</span><b>拖入文件或添加资源</b><small>支持 PDF、Markdown、网页和图片</small></div></div></div></section>
`;

const renderTodo = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">今日行动</span><h2>待办事项</h2><p>把下一步学习行动放在眼前</p></div><button class="ds-primary-button">＋ 新建待办</button></div><div class="ds-todo-list ds-panel"><div class="ds-panel-heading"><div><b>今天</b><span> · 3 项任务</span></div><button class="ds-text-button">筛选</button></div><label class="ds-todo-row"><input type="checkbox" /><span><b>完成微积分第三章练习</b><small>学习资源 · 今天 18:00</small></span><em>待开始</em></label><label class="ds-todo-row"><input type="checkbox" /><span><b>整理概率论复习笔记</b><small>笔记 · 今天 20:00</small></span><em>进行中</em></label><label class="ds-todo-row"><input type="checkbox" /><span><b>复习英语学术词汇</b><small>闪卡 · 今天 21:00</small></span><em>待开始</em></label></div></section>`;

const renderSkills = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">可组合能力</span><h2>技能管理</h2><p>安装、启用和编辑 DeepStudent 的技能</p></div><button class="ds-primary-button">＋ 添加技能</button></div><div class="ds-skill-grid"><article class="ds-skill-card"><span class="ds-skill-icon">✧</span><div><b>网页搜索</b><p>搜索并整理公开网页资料</p></div><span class="ds-toggle is-on"></span></article><article class="ds-skill-card"><span class="ds-skill-icon">▤</span><div><b>学习资源</b><p>从资源库引用上下文</p></div><span class="ds-toggle is-on"></span></article><article class="ds-skill-card"><span class="ds-skill-icon">⌁</span><div><b>知识整理</b><p>生成笔记、提纲和复习卡片</p></div><span class="ds-toggle"></span></article></div></section>`;

const renderAnki = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">学习自动化</span><h2>Anki 制卡</h2><p>选择资料和模板，批量生成闪卡</p></div><button class="ds-primary-button">＋ 新建制卡任务</button></div><div class="ds-job-card ds-panel"><div class="ds-job-card__icon">▱</div><div><b>还没有制卡任务</b><p>从学习资源中选择一份资料开始</p></div><button class="ds-secondary-button">浏览学习资源</button></div></section>`;

const renderFlashcards = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">主动回忆</span><h2>闪卡</h2><p>用短时练习巩固真正理解的内容</p></div><button class="ds-primary-button">＋ 新建卡组</button></div><div class="ds-metric-grid"><div class="ds-metric-card"><span>今日待复习</span><strong>12 <small>张</small></strong><em>约 8 分钟</em></div><div class="ds-metric-card"><span>掌握率</span><strong>78<small>%</small></strong><em>↑ 比上周多 6%</em></div><div class="ds-metric-card"><span>连续学习</span><strong>8 <small>天</small></strong><em>保持节奏</em></div></div><div class="ds-panel"><div class="ds-panel-heading"><b>我的卡组</b><button class="ds-text-button">查看全部</button></div><button class="ds-deck-row"><span class="ds-deck-icon ds-deck-icon--blue">∑</span><span><b>微积分基础</b><small>32 张 · 最近复习 2 小时前</small></span><em>8 张待复习 →</em></button><button class="ds-deck-row"><span class="ds-deck-icon ds-deck-icon--purple">π</span><span><b>概率论</b><small>48 张 · 最近复习昨天</small></span><em>4 张待复习 →</em></button><button class="ds-deck-row"><span class="ds-deck-icon ds-deck-icon--green">A</span><span><b>英语学术词汇</b><small>120 张 · 最近复习 9 月 28 日</small></span><em>已完成</em></button></div></section>`;

const renderTemplates = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">输出偏好</span><h2>模板管理</h2><p>让重复的学习输出保持一致</p></div><button class="ds-primary-button">＋ 新建模板</button></div><div class="ds-template-list ds-panel"><button class="ds-template-row"><span>▥</span><span><b>默认学习笔记</b><small>Markdown · 最近使用</small></span><em>→</em></button><button class="ds-template-row"><span>▥</span><span><b>Anki 基础卡片</b><small>正面 / 背面 · 12 个字段</small></span><em>→</em></button><button class="ds-template-row"><span>▥</span><span><b>论文阅读摘要</b><small>结构化摘要 · 6 个字段</small></span><em>→</em></button></div></section>`;

const renderSettings = () => `<section class="ds-workspace-page"><div class="ds-page-heading"><div><span class="ds-eyebrow">偏好设置</span><h2>设置</h2><p>让 DeepStudent 更贴合你的学习方式</p></div></div><div class="ds-settings-layout"><nav class="ds-settings-nav ds-panel"><button class="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div class="ds-settings-content"><section class="ds-panel ds-setting-section"><div class="ds-panel-heading"><div><b>常规</b><p>管理工作区和学习体验</p></div></div><label class="ds-setting-row"><span><b>启动时打开新会话</b><small>每次打开应用时回到 DeepStudent</small></span><input class="ds-switch" type="checkbox" checked /></label><label class="ds-setting-row"><span><b>自动保存会话</b><small>编辑后立即保存更改</small></span><input class="ds-switch" type="checkbox" checked /></label></section><section class="ds-panel ds-setting-section"><div class="ds-panel-heading"><div><b>外观</b><p>调整界面的显示方式</p></div></div><label class="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input id="settings-theme" class="ds-switch" type="checkbox" /></label></section><section class="ds-panel ds-setting-section"><div class="ds-panel-heading"><div><b>运行时连接</b><p>当前 MyGo 桌面壳连接状态</p></div></div><div class="ds-runtime-row">${statusPill("Go runtime 已连接")}<code>HealthService.Health</code></div></section></div></div></section>`;

const renderView = (view: ViewId) => {
  if (view === "chat-v2") return renderChat();
  if (view === "learning-hub") return renderLearningHub();
  if (view === "todo") return renderTodo();
  if (view === "skills-management") return renderSkills();
  if (view === "task-dashboard") return renderAnki();
  if (view === "flashcards") return renderFlashcards();
  if (view === "template-management") return renderTemplates();
  return renderSettings();
};

let currentView: ViewId = "chat-v2";
const closeMobileSidebar = () => { shell.dataset.sidebarOpen = "false"; mobileMenu.setAttribute("aria-expanded", "false"); };
const openMobileSidebar = () => { shell.dataset.sidebarOpen = "true"; mobileMenu.setAttribute("aria-expanded", "true"); };
const setView = (view: ViewId) => {
  currentView = view;
  const meta = viewMeta[view];
  shell.dataset.view = view;
  viewTitle.textContent = meta.title;
  viewSubtitle.textContent = meta.subtitle;
  shellTitle.textContent = view === "chat-v2" ? "DeepStudent" : meta.title;
  shellMeta.textContent = view === "chat-v2" ? "" : "DeepStudent";
  mainContent.innerHTML = renderView(view);
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.dataset.active = String(button.dataset.view === view || (view === "chat-v2" && button.dataset.view === "chat-v2"));
  });
  closeMobileSidebar();
  wireView();
};

const sendChatMessage = (event: Event) => {
  event.preventDefault();
  const input = root.querySelector<HTMLTextAreaElement>("#chat-input");
  const form = root.querySelector<HTMLFormElement>("#chat-form");
  if (!input || !form || !input.value.trim()) return;
  const message = document.createElement("div");
  message.className = "ds-chat-message";
  message.textContent = input.value.trim();
  form.before(message);
  input.value = "";
};
const wireView = () => {
  root.querySelector<HTMLFormElement>("#chat-form")?.addEventListener("submit", sendChatMessage);
  root.querySelector<HTMLTextAreaElement>("#chat-input")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); root.querySelector<HTMLFormElement>("#chat-form")?.requestSubmit(); }
  });
  const settingsTheme = root.querySelector<HTMLInputElement>("#settings-theme");
  if (settingsTheme) { settingsTheme.checked = document.documentElement.dataset.theme === "dark"; settingsTheme.addEventListener("change", () => setTheme(settingsTheme.checked ? "dark" : "light")); }
};

root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => button.addEventListener("click", () => setView(button.dataset.view as ViewId)));
root.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const view = target.closest<HTMLElement>("[data-view]")?.dataset.view;
  if (view) { setView(view as ViewId); return; }
  const action = target.closest<HTMLElement>("[data-action]")?.dataset.action;
  if (action === "new-session" || target.closest("#new-session") || target.closest("#create-session")) setView("chat-v2");
  if (action === "open-learning") setView("learning-hub");
});
mobileMenu.addEventListener("click", () => shell.dataset.sidebarOpen === "true" ? closeMobileSidebar() : openMobileSidebar());
sidebarOverlay.addEventListener("click", closeMobileSidebar);
root.querySelector<HTMLButtonElement>("#desktop-sidebar-toggle")?.addEventListener("click", () => { shell.dataset.sidebarCollapsed = shell.dataset.sidebarCollapsed === "true" ? "false" : "true"; });
root.querySelector<HTMLButtonElement>("#theme-toggle")?.addEventListener("click", () => setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
root.querySelector<HTMLButtonElement>("#main-add")?.addEventListener("click", () => setView("chat-v2"));
root.querySelector<HTMLButtonElement>("#main-search")?.addEventListener("click", () => setView("learning-hub"));
root.querySelector<HTMLButtonElement>("#search-session")?.addEventListener("click", () => root.querySelector<HTMLInputElement>(".ds-search-field input")?.focus());

setView(currentView);

async function bootRuntime() {
  const status = root?.querySelector<HTMLElement>("#runtime-status span");
  try {
    const health = await HealthService.health();
    if (status) status.textContent = `${health.runtime} runtime · ${health.status}`;
  } catch {
    if (status) status.textContent = "Go runtime bridge unavailable";
  }
}
void bootRuntime();
