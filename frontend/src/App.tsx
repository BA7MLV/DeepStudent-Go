import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { useEffect, useMemo, useState } from "react";
import { HealthService } from "./mygo";

type ViewId =
  | "chat-v2"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "flashcards"
  | "settings";
type Theme = "light" | "dark";

type IconName = "sparkle" | "book" | "check" | "sparkle-two" | "cards" | "stack" | "template" | "settings" | "plus" | "search" | "sliders" | "chevron-down" | "chevron-left" | "sun" | "home" | "folder" | "send" | "paperclip" | "wand" | "brain";

const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "chat-v2", label: "新会话", icon: "sparkle" },
  { id: "learning-hub", label: "学习资源", icon: "book" },
  { id: "todo", label: "待办事项", icon: "check" },
  { id: "skills-management", label: "技能管理", icon: "sparkle-two" },
  { id: "flashcards", label: "闪卡", icon: "stack" },
];

function Icon({ name, size = 16, strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  const common = { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, ariaHidden: true };
  const paths: Record<IconName, React.ReactNode> = {
    sparkle: <><path d="m12 3-1.15 4.1a3.8 3.8 0 0 1-2.65 2.65L4.1 11 8.2 12.15a3.8 3.8 0 0 1 2.65 2.65L12 18.9l1.15-4.1a3.8 3.8 0 0 1 2.65-2.65L19.9 11l-4.1-1.15a3.8 3.8 0 0 1-2.65-2.65Z"/><path d="m19 16-.42 1.58a2 2 0 0 1-1.42 1.42L15.58 19l1.58.42a2 2 0 0 1 1.42 1.42L19 22l.42-1.16a2 2 0 0 1 1.42-1.42L22 19l-1.16-.42a2 2 0 0 1-1.42-1.42Z"/></>,
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5Z"/><path d="M4 5.5v16M8 7h8M8 11h8"/></>,
    check: <><path d="M5 4h14v16H5z"/><path d="m8 12 2.5 2.5L16 9"/></>,
    "sparkle-two": <><path d="m8 3-.8 3.2a4 4 0 0 1-3 3L1 10l3.2.8a4 4 0 0 1 3 3L8 17l.8-3.2a4 4 0 0 1 3-3L15 10l-3.2-.8a4 4 0 0 1-3-3Z"/><path d="m18 14-.55 2.45A2 2 0 0 1 16 18l-2.45.55L16 19.1a2 2 0 0 1 1.45 1.45L18 23l.55-2.45A2 2 0 0 1 20 19.1l2.45-.55L20 18a2 2 0 0 1-1.45-1.45Z"/></>,
    cards: <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M8 8h8M8 12h5M8 16h3"/></>,
    stack: <><path d="m12 3 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/></>,
    template: <><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/></>,
    settings: <><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="m19.4 15 .1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.8 1.8 0 0 0-3.1 1.3v.2a2 2 0 1 1-4 0v-.2a1.8 1.8 0 0 0-3.1-1.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.8 1.8 0 0 0 2.3 12a1.8 1.8 0 0 0 1.3-3.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.8 1.8 0 0 0 9.5 4.8v-.2a2 2 0 1 1 4 0v.2a1.8 1.8 0 0 0 3.1 1.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.8 1.8 0 0 0 20.7 12a1.8 1.8 0 0 0-1.3 3Z"/></>,
    plus: <><path d="M12 5v14M5 12h14"/></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.5 4.5"/></>,
    sliders: <><path d="M4 6h16M4 12h16M4 18h16"/><circle cx="8" cy="6" r="2" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="11" cy="18" r="2" fill="currentColor" stroke="none"/></>,
    "chevron-down": <path d="m6 9 6 6 6-6"/>,
    "chevron-left": <path d="m15 6-6 6 6 6"/>,
    sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/></>,
    home: <><path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10M9 20v-6h6v6"/></>,
    folder: <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h5l2 2h8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5Z"/>,
    send: <path d="m4 4 17 8-17 8 3-8Z"/>,
    paperclip: <path d="m20.5 11.5-8.7 8.7a5 5 0 0 1-7.1-7.1l8.8-8.8a3.5 3.5 0 0 1 5 5l-8.8 8.8a2 2 0 1 1-2.8-2.8l8.1-8.1"/>,
    wand: <><path d="m15 4 5 5M13 6l5 5M4 20l8-8M5 5l.5 1.5L7 7l-1.5.5L5 9l-.5-1.5L3 7l1.5-.5Z"/><path d="m18 15 .5 1.5L20 17l-1.5.5L18 19l-.5-1.5L16 17l1.5-.5Z"/></>,
    brain: <><path d="M9.5 4.5a3 3 0 0 0-5.5 1.7A3.5 3.5 0 0 0 5 12a3.5 3.5 0 0 0 1.3 6.7A3 3 0 0 0 12 17V7a3 3 0 0 0-2.5-2.5Z"/><path d="M14.5 4.5a3 3 0 0 1 5.5 1.7A3.5 3.5 0 0 1 19 12a3.5 3.5 0 0 1-1.3 6.7A3 3 0 0 1 12 17V7a3 3 0 0 1 2.5-2.5Z"/></>,
  };
  return <svg {...common} aria-hidden="true">{paths[name]}</svg>;
}

const viewMeta: Record<ViewId, { title: string; subtitle: string }> = {
  "chat-v2": { title: "", subtitle: "" },
  "learning-hub": { title: "学习资源", subtitle: "浏览和管理你的学习资料" },
  todo: { title: "待办事项", subtitle: "把下一步学习行动放在眼前" },
  "skills-management": { title: "技能管理", subtitle: "添加和管理 DeepStudent 的技能" },
  flashcards: { title: "闪卡", subtitle: "用主动回忆巩固真正理解的内容" },
  settings: { title: "设置", subtitle: "调整 DeepStudent 的工作方式" },
};

const readTheme = (): Theme => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const StubAdapter: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages.at(-1);
    const text = last?.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
    yield {
      content: [
        {
          type: "text",
          text: text
            ? `收到「${text}」，我们可以从理解、整理和复习开始。`
            : "准备好开始学习。",
        },
      ],
    };
  },
};

function ChatMessage() {
  return (
    <MessagePrimitive.Root className="ds-chat-message">
      <MessagePrimitive.Parts components={{ Text: MessageText }} />
    </MessagePrimitive.Root>
  );
}

function MessageText() {
  return <MessagePartPrimitive.Text component="span" smooth />;
}

function ChatEmptyState() {
  return (
    <div className="ds-chat-center">
      <h2 id="chat-welcome-title">从理解开始，让知识成为自己的能力</h2>
    </div>
  );
}

function ChatWorkspace() {
  const runtime = useLocalRuntime(StubAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="ds-chat-page" aria-labelledby="chat-welcome-title">
        <ThreadPrimitive.Root className="ds-chat-thread">
          <ThreadPrimitive.Viewport className="ds-thread-viewport" autoScroll>
            <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            <ThreadPrimitive.Empty>
              <ChatEmptyState />
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.ScrollToBottom className="ds-scroll-bottom">↓</ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="ds-composer" compact>
            <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
            <div className="ds-composer__toolbar">
              <div className="ds-composer__tools">
                <ComposerPrimitive.AddAttachment className="ds-composer-tool" aria-label="添加附件"><Icon name="paperclip" size={16} /></ComposerPrimitive.AddAttachment>
                <button type="button" className="ds-composer-tool" aria-label="调用工具"><Icon name="wand" size={16} /></button>
                <button type="button" className="ds-composer-tool" aria-label="深度思考"><Icon name="brain" size={16} /></button>
              </div>
              <ComposerPrimitive.Send className="ds-send-button" aria-label="发送"><Icon name="send" size={15} strokeWidth={2} /></ComposerPrimitive.Send>
            </div>
          </ComposerPrimitive.Root>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}

function LearningHub() {
  return <WorkspacePage eyebrow="学习中心" title="学习资源" description="浏览、搜索并打开你的笔记、教材、试卷和文件" action="＋ 添加资源">
    <div className="ds-resource-layout"><aside className="ds-resource-tree"><div className="ds-resource-toolbar"><b>资源库</b><button className="ds-icon-button" aria-label="添加资源">＋</button></div><label className="ds-search-field">⌕ <input placeholder="搜索资源…" /></label><p className="ds-sidebar-empty">暂无资源</p></aside><div className="ds-resource-grid"><EmptyState title="还没有学习资源" description="添加 PDF、Markdown、网页或图片，开始整理你的学习资料" /></div></div>
  </WorkspacePage>;
}
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="ds-empty-state"><p><b>{title}</b>，{description}</p></div>; }
function Todo() { return <WorkspacePage eyebrow="今日行动" title="待办事项" description="把下一步学习行动放在眼前" action="＋ 新建待办"><div className="ds-panel"><EmptyState title="还没有待办事项" description="创建一个待办事项，让下一步学习行动清晰可见" /></div></WorkspacePage>; }
function Skills() { return <WorkspacePage title="技能管理" description="添加和管理 DeepStudent 的技能" action="＋ 添加技能"><EmptyState title="还没有可用技能" description="添加技能后，它们会出现在这里" /></WorkspacePage>; }
function Flashcards() { return <WorkspacePage eyebrow="主动回忆" title="闪卡" description="用短时练习巩固真正理解的内容" action="＋ 新建卡组"><EmptyState title="还没有闪卡组" description="创建一个卡组，开始用主动回忆巩固知识" /></WorkspacePage>; }
function Settings({ theme, onTheme }: { theme: Theme; onTheme: () => void }) { return <WorkspacePage eyebrow="偏好设置" title="设置" description="让 DeepStudent 更贴合你的学习方式"><div className="ds-settings-layout"><nav className="ds-settings-nav ds-panel"><button className="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div className="ds-settings-content"><section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新会话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存会话" detail="编辑后立即保存更改" checked /></section><section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label></section></div></div></WorkspacePage>; }
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ action, children }: { eyebrow?: string; title?: string; description?: string; action?: string; children: React.ReactNode }) { return <section className="ds-workspace-page">{action && <div className="ds-workspace-actions"><button className="ds-primary-button">{action}</button></div>}{children}</section>; }

export function App() {
  const [view, setView] = useState<ViewId>("chat-v2");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => {
    void HealthService.health().catch(() => undefined);
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const selectView = (next: ViewId) => { setView(next); setSidebarOpen(false); };
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace />;
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <Settings theme={theme} onTheme={toggleTheme} />;
  }, [theme, view]);
  const meta = viewMeta[view];
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  return <div className="ds-shell" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} data-view={view}>
    <div className="ds-body">
      <aside className="ds-sidebar" data-shell-layer="navigation" aria-label="DeepStudent 主入口">
        <div className="ds-sidebar__brand">
          <span className="ds-sidebar__brand-name">DeepStudent</span>
        </div>
        <nav className="ds-primary-nav" aria-label="主入口">
          {navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => selectView(item.id)} data-active={item.id === view}><span className="ds-nav-icon"><Icon name={item.icon} size={16} /></span><span>{item.label}</span></button>)}
        </nav>
        <div className="ds-sidebar__scroll">
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action" aria-label="收起置顶"><Icon name="chevron-down" size={14} /></button></div><p className="ds-sidebar-empty">暂无置顶会话</p></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action" aria-label="收起主题"><Icon name="chevron-down" size={14} /></button><button className="ds-section-action" aria-label="新建主题"><Icon name="plus" size={14} /></button></span></div><p className="ds-sidebar-empty">暂无主题</p></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={() => selectView("chat-v2")} aria-label="新建对话"><Icon name="plus" size={14} /></button></div><p className="ds-sidebar-empty">暂无对话</p></section>
        </div>
        <div className="ds-sidebar__footer">
          <button className="ds-nav-row" onClick={() => selectView("settings")} data-active={view === "settings"}><span className="ds-nav-icon"><Icon name="settings" size={16} /></span><span>设置</span></button>
        </div>
      </aside>
      <button className="ds-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"></button>
      <main className="ds-main" data-shell-layer="workspace" data-view={view}>
        <header className="ds-main__header">
          <div className="ds-main__leading">
            <button className="ds-sidebar-toggle ds-sidebar-toggle--header" type="button" onClick={toggleSidebar} aria-label="切换边栏" aria-expanded={sidebarCollapsed || sidebarOpen}>
              <Icon name="sliders" size={16} />
            </button>
            <button className="ds-icon-button ds-header-search" type="button" onClick={() => selectView("learning-hub")} aria-label="搜索学习资源">
              <Icon name="search" size={16} />
            </button>
            <span className="ds-main__brand">DeepStudent</span>
          </div>
          <div className={`ds-main__heading${meta.title ? "" : " is-empty"}`}>
            {meta.title && <div className="ds-main__heading-copy"><h1>{meta.title}</h1><p>{meta.subtitle}</p></div>}
          </div>
        </header>
        <div className="ds-main__content">{content}</div>
      </main>
    </div>
  </div>;
}
