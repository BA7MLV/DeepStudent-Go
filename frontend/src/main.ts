import "./shell.css";
import { HealthService } from "./mygo";

type ViewId = "study" | "library" | "chat" | "review" | "settings";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

const navItems: Array<{ id: ViewId; label: string; icon: string }> = [
  { id: "study", label: "学习空间", icon: "⌂" },
  { id: "library", label: "资料库", icon: "▤" },
  { id: "chat", label: "智能对话", icon: "✦" },
  { id: "review", label: "复习与卡片", icon: "◇" },
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
      <div class="ds-titlebar__nav">
        <span class="ds-titlebar__traffic" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="ds-titlebar__brand">DeepStudent</span>
      </div>
      <div class="ds-titlebar__workspace">
        <button class="ds-menu-button" id="mobile-menu" aria-label="打开导航" aria-expanded="false">☰</button>
        <span class="ds-titlebar__title" id="shell-title">智能对话</span>
        <div class="ds-titlebar__actions">
          <button class="ds-icon-button" id="theme-toggle" aria-label="切换主题" title="切换主题">◐</button>
          <button class="ds-icon-button" id="desktop-sidebar-toggle" aria-label="折叠侧栏" title="折叠侧栏">◧</button>
        </div>
      </div>
    </header>
    <div class="ds-body">
      <aside class="ds-sidebar" data-shell-layer="navigation" aria-label="主导航">
        <div class="ds-sidebar__head">
          <div class="ds-brand">
            <span class="ds-brand__mark"><img src="/deepstudent-logo.svg" alt="" /></span>
            <span class="ds-brand__name">DeepStudent</span>
          </div>
          <button class="ds-icon-button ds-sidebar__collapse" id="sidebar-collapse" aria-label="折叠导航">‹</button>
        </div>
        <div class="ds-sidebar__scroll">
          <div class="ds-nav">
            <div class="ds-nav__section">工作区</div>
            ${navItems.map(({ id, label, icon }) => `<button type="button" data-view="${id}" data-active="${id === "chat"}"><span class="ds-nav__icon" aria-hidden="true">${icon}</span><span class="ds-nav__label">${label}</span></button>`).join("")}
            <div class="ds-nav__section">管理</div>
            <button type="button" data-view="settings"><span class="ds-nav__icon" aria-hidden="true">⚙</span><span class="ds-nav__label">设置</span></button>
          </div>
        </div>
        <div class="ds-sidebar__footer">
          <span class="ds-status" id="runtime-status"><span class="ds-status__dot"></span><span>正在连接 Go runtime…</span></span>
        </div>
      </aside>
      <button class="ds-overlay" id="sidebar-overlay" aria-label="关闭导航"></button>
      <main class="ds-main" data-shell-layer="workspace">
        <header class="ds-main__header">
          <div class="ds-main__heading"><h1 id="view-title">智能对话</h1><p id="view-subtitle">在一个安静的工作区里继续学习</p></div>
          <div class="ds-main__actions">
            <button class="ds-icon-button" id="search-button" aria-label="搜索">⌕</button>
            <button class="ds-icon-button" id="new-button" aria-label="新建">＋</button>
          </div>
        </header>
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

const closeMobileSidebar = () => {
  shell.dataset.sidebarOpen = "false";
  mobileMenu.setAttribute("aria-expanded", "false");
};
const openMobileSidebar = () => {
  shell.dataset.sidebarOpen = "true";
  mobileMenu.setAttribute("aria-expanded", "true");
};

const renderDashboard = () => `
  <div class="ds-dashboard">
    <section class="ds-card ds-dashboard__card"><h2>今日计划</h2><p>把下一步学习任务放在这里，保持清晰的节奏</p></section>
    <section class="ds-card ds-dashboard__card"><h2>最近资料</h2><p>打开过的笔记、PDF 与题库会在这里继续</p></section>
    <section class="ds-card ds-dashboard__card"><h2>复习进度</h2><p>完成 0 个待复习项目，开始建立你的节奏</p></section>
  </div>
  <section class="ds-card ds-empty" style="margin-top:14px"><div><h2>欢迎回到学习空间</h2><p>从侧栏进入资料库、对话或复习，Go runtime 会在后台保持轻量运行</p><span class="ds-status"><span class="ds-status__dot"></span>壳层已就绪</span></div></section>
`;

const renderLibrary = () => `
  <section class="ds-card ds-empty"><div><h2>资料库</h2><p>这里将承载笔记、PDF 与网页资料。先保留稳定的工作区表面，后续接入 DSTU 资源协议。</p><span class="ds-status"><span class="ds-status__dot"></span>等待资源索引</span></div></section>
`;

const renderReview = () => `
  <section class="ds-card ds-empty"><div><h2>复习与卡片</h2><p>把需要强化的知识交给间隔复习，Go 迁移阶段先保持入口和布局稳定。</p><span class="ds-status"><span class="ds-status__dot"></span>尚未开始复习</span></div></section>
`;

const renderSettings = () => `
  <section class="ds-card ds-empty"><div><h2>设置</h2><p>主题、连接和本地运行时选项会在这里集中管理。</p><span class="ds-status"><span class="ds-status__dot"></span>设置入口已就绪</span></div></section>
`;

const renderChat = () => `
  <div class="ds-chat">
    <div class="ds-chat__messages" id="chat-messages">
      <div class="ds-chat__welcome"><h2>今天想学点什么？</h2><p>把问题、资料或一个模糊的想法放进来，DeepStudent 会陪你拆开它</p></div>
    </div>
    <form class="ds-chat__composer" id="chat-form">
      <label class="ds-visually-hidden" for="chat-input">输入消息</label>
      <textarea class="ds-chat__input" id="chat-input" rows="1" placeholder="输入消息，按 Enter 发送，Shift+Enter 换行"></textarea>
      <button class="ds-chat__send" type="submit">发送</button>
    </form>
  </div>
`;

const viewMeta: Record<ViewId, { title: string; subtitle: string; render: () => string }> = {
  study: { title: "学习空间", subtitle: "在一个安静的工作区里继续学习", render: renderDashboard },
  library: { title: "资料库", subtitle: "把资料集中到可检索的学习空间", render: renderLibrary },
  chat: { title: "智能对话", subtitle: "和你的学习助手一起思考", render: renderChat },
  review: { title: "复习与卡片", subtitle: "让记忆在合适的时间被重新唤起", render: renderReview },
  settings: { title: "设置", subtitle: "调整 DeepStudent Go 的工作方式", render: renderSettings },
};

let currentView: ViewId = "chat";
const setView = (view: ViewId) => {
  currentView = view;
  const meta = viewMeta[view];
  viewTitle.textContent = meta.title;
  shellTitle.textContent = meta.title;
  viewSubtitle.textContent = meta.subtitle;
  mainContent.innerHTML = meta.render();
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
    button.dataset.active = String(button.dataset.view === view);
  });
  closeMobileSidebar();
  if (view === "chat") wireChat();
};

const wireChat = () => {
  const form = root.querySelector<HTMLFormElement>("#chat-form");
  const input = root.querySelector<HTMLTextAreaElement>("#chat-input");
  const messages = root.querySelector<HTMLElement>("#chat-messages");
  if (!form || !input || !messages) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = input.value.trim();
    if (!value) return;
    const message = document.createElement("div");
    message.className = "ds-chat__message ds-chat__message--user";
    const text = document.createElement("p");
    text.textContent = value;
    message.append(text);
    messages.append(message);
    input.value = "";
    input.focus();
    messages.scrollTop = messages.scrollHeight;
  });
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
};

root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((button) => {
  button.addEventListener("click", () => setView((button.dataset.view ?? "chat") as ViewId));
});
mobileMenu.addEventListener("click", () => {
  if (shell.dataset.sidebarOpen === "true") closeMobileSidebar(); else openMobileSidebar();
});
sidebarOverlay.addEventListener("click", closeMobileSidebar);
sidebarCollapse.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 767.98px)").matches) closeMobileSidebar();
  else shell.dataset.sidebarCollapsed = shell.dataset.sidebarCollapsed === "true" ? "false" : "true";
});
desktopSidebarToggle.addEventListener("click", () => {
  shell.dataset.sidebarCollapsed = shell.dataset.sidebarCollapsed === "true" ? "false" : "true";
});
themeToggle.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

setView(currentView);

async function bootRuntime() {
  const status = root.querySelector<HTMLElement>("#runtime-status span:last-child");
  try {
    const health = await HealthService.health();
    if (status) status.textContent = `${health.runtime} runtime: ${health.status}`;
  } catch {
    if (status) status.textContent = "runtime bridge unavailable";
  }
}

void bootRuntime();
