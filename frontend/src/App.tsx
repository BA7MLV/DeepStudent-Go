import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
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
  | "task-dashboard"
  | "flashcards"
  | "template-management"
  | "settings";
type Theme = "light" | "dark";

type IconName = "sparkle" | "book" | "check" | "sparkle-two" | "cards" | "stack" | "template" | "settings" | "plus" | "search" | "sliders" | "chevron-down" | "chevron-left" | "sun" | "home" | "folder" | "send" | "paperclip" | "wand" | "brain";

const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "chat-v2", label: "新会话", icon: "sparkle" },
  { id: "learning-hub", label: "学习资源", icon: "book" },
  { id: "todo", label: "待办事项", icon: "check" },
  { id: "skills-management", label: "技能管理", icon: "sparkle-two" },
  { id: "task-dashboard", label: "Anki制卡", icon: "cards" },
  { id: "flashcards", label: "闪卡", icon: "stack" },
  { id: "template-management", label: "模板管理", icon: "template" },
];

const quickPrompts: Array<{ label: string; icon: IconName }> = [
  { label: "复习今天的课程", icon: "book" },
  { label: "整理一份学习笔记", icon: "template" },
  { label: "解释一个概念", icon: "brain" },
  { label: "生成知识点卡片", icon: "cards" },
  { label: "制定复习计划", icon: "check" },
  { label: "总结这段资料", icon: "stack" },
  { label: "创建学习线程", icon: "sparkle" },
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
  const composer = unstable_useComposerInput();

  return (
    <div className="ds-chat-center">
      <h2 id="chat-welcome-title">把今天学会的，变成真正掌握的</h2>
      <p>从一个学习目标开始，理解、整理，再用练习巩固</p>
      <div className="ds-chat-prompts" aria-label="学习场景快捷提示">
        {quickPrompts.map((prompt) => (
          <button
            key={prompt.label}
            className="ds-chat-prompt"
            type="button"
            onClick={() => composer.setText(prompt.label)}
          >
            <Icon name={prompt.icon} size={16} />
            <span>{prompt.label}</span>
          </button>
        ))}
      </div>
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
    <div className="ds-resource-layout"><aside className="ds-resource-tree"><div className="ds-resource-toolbar"><b>资源库</b><button className="ds-icon-button">＋</button></div><label className="ds-search-field">⌕ <input placeholder="搜索资源…" /></label><button className="ds-resource-row is-active">▤ 全部资源 <em>24</em></button><button className="ds-resource-row">▱ 笔记 <em>8</em></button><button className="ds-resource-row">□ 教材 <em>10</em></button><button className="ds-resource-row">◌ 试卷 <em>6</em></button></aside><div className="ds-resource-grid"><ResourceCard icon="PDF" color="blue" title="Calculus — Chapter 3" detail="教材 · 12.4 MB · 2 小时前" /><ResourceCard icon="N" color="purple" title="概率论复习笔记" detail="笔记 · 昨天更新" /><ResourceCard icon="↗" color="green" title="Linear Algebra Visualized" detail="网页 · 3 天前" /><div className="ds-empty-card"><span>＋</span><b>拖入文件或添加资源</b><small>支持 PDF、Markdown、网页和图片</small></div></div></div>
  </WorkspacePage>;
}

function ResourceCard({ icon, color, title, detail }: { icon: string; color: string; title: string; detail: string }) {
  return <article className="ds-resource-card"><span className={`ds-resource-card__icon ds-resource-card__icon--${color}`}>{icon}</span><div><b>{title}</b><p>{detail}</p></div><button className="ds-icon-button">⋯</button></article>;
}

function Todo() { return <WorkspacePage eyebrow="今日行动" title="待办事项" description="把下一步学习行动放在眼前" action="＋ 新建待办"><div className="ds-todo-list ds-panel"><PanelHeading title="今天" meta=" · 3 项任务" /><TodoRow title="完成微积分第三章练习" detail="学习资源 · 今天 18:00" status="待开始" /><TodoRow title="整理概率论复习笔记" detail="笔记 · 今天 20:00" status="进行中" /><TodoRow title="复习英语学术词汇" detail="闪卡 · 今天 21:00" status="待开始" /></div></WorkspacePage>; }
function TodoRow({ title, detail, status }: { title: string; detail: string; status: string }) { return <label className="ds-todo-row"><input type="checkbox" /><span><b>{title}</b><small>{detail}</small></span><em>{status}</em></label>; }
function Skills() { return <WorkspacePage eyebrow="可组合能力" title="技能管理" description="安装、启用和编辑 DeepStudent 的技能" action="＋ 添加技能"><div className="ds-skill-grid"><Skill title="网页搜索" description="搜索并整理公开网页资料" enabled /><Skill title="学习资源" description="从资源库引用上下文" enabled /><Skill title="知识整理" description="生成笔记、提纲和复习卡片" /></div></WorkspacePage>; }
function Skill({ title, description, enabled }: { title: string; description: string; enabled?: boolean }) { return <article className="ds-skill-card"><span className="ds-skill-icon">✧</span><div><b>{title}</b><p>{description}</p></div><span className={`ds-toggle${enabled ? " is-on" : ""}`}></span></article>; }
function Anki() { return <WorkspacePage eyebrow="学习自动化" title="Anki 制卡" description="选择资料和模板，批量生成闪卡" action="＋ 新建制卡任务"><div className="ds-job-card ds-panel"><div className="ds-job-card__icon">▱</div><div><b>还没有制卡任务</b><p>从学习资源中选择一份资料开始</p></div><button className="ds-secondary-button">浏览学习资源</button></div></WorkspacePage>; }
function Flashcards() { return <WorkspacePage eyebrow="主动回忆" title="闪卡" description="用短时练习巩固真正理解的内容" action="＋ 新建卡组"><div className="ds-metric-grid"><Metric label="今日待复习" value="12" suffix="张" note="约 8 分钟" /><Metric label="掌握率" value="78" suffix="%" note="↑ 比上周多 6%" /><Metric label="连续学习" value="8" suffix="天" note="保持节奏" /></div><div className="ds-panel"><PanelHeading title="我的卡组" action="查看全部" /><Deck title="微积分基础" detail="32 张 · 最近复习 2 小时前" status="8 张待复习 →" color="blue" /><Deck title="概率论" detail="48 张 · 最近复习昨天" status="4 张待复习 →" color="purple" /><Deck title="英语学术词汇" detail="120 张 · 最近复习 9 月 28 日" status="已完成" color="green" /></div></WorkspacePage>; }
function Metric({ label, value, suffix, note }: { label: string; value: string; suffix: string; note: string }) { return <div className="ds-metric-card"><span>{label}</span><strong>{value} <small>{suffix}</small></strong><em>{note}</em></div>; }
function Deck({ title, detail, status, color }: { title: string; detail: string; status: string; color: string }) { return <button className="ds-deck-row"><span className={`ds-deck-icon ds-deck-icon--${color}`}>∑</span><span><b>{title}</b><small>{detail}</small></span><em>{status}</em></button>; }
function Templates() { return <WorkspacePage eyebrow="输出偏好" title="模板管理" description="让重复的学习输出保持一致" action="＋ 新建模板"><div className="ds-template-list ds-panel"><Template title="默认学习笔记" detail="Markdown · 最近使用" /><Template title="Anki 基础卡片" detail="正面 / 背面 · 12 个字段" /><Template title="论文阅读摘要" detail="结构化摘要 · 6 个字段" /></div></WorkspacePage>; }
function Template({ title, detail }: { title: string; detail: string }) { return <button className="ds-template-row"><span>▥</span><span><b>{title}</b><small>{detail}</small></span><em>→</em></button>; }
function Settings({ theme, onTheme }: { theme: Theme; onTheme: () => void }) { return <WorkspacePage eyebrow="偏好设置" title="设置" description="让 DeepStudent 更贴合你的学习方式"><div className="ds-settings-layout"><nav className="ds-settings-nav ds-panel"><button className="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div className="ds-settings-content"><section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新会话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存会话" detail="编辑后立即保存更改" checked /></section><section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label></section><section className="ds-panel ds-setting-section"><PanelHeading title="运行时连接" meta="当前 MyGo 桌面壳连接状态" /><div className="ds-runtime-row"><span className="ds-status"><i></i>Go runtime 已连接</span><code>HealthService.Health</code></div></section></div></div></WorkspacePage>; }
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ eyebrow, title, description, action, children }: { eyebrow: string; title: string; description: string; action?: string; children: React.ReactNode }) { return <section className="ds-workspace-page"><div className="ds-page-heading"><div><span className="ds-eyebrow">{eyebrow}</span><h2>{title}</h2><p>{description}</p></div>{action && <button className="ds-primary-button">{action}</button>}</div>{children}</section>; }

export function App() {
  const [view, setView] = useState<ViewId>("chat-v2");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState("连接 Go runtime…");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => {
    let active = true;
    void HealthService.health().then((health) => {
      if (active) setRuntimeStatus(`${health.runtime} runtime · ${health.status}`);
    }).catch(() => {
      if (active) setRuntimeStatus("Go runtime bridge unavailable");
    });
    return () => { active = false; };
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const selectView = (next: ViewId) => { setView(next); setSidebarOpen(false); };
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace />;
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "task-dashboard") return <Anki />;
    if (view === "flashcards") return <Flashcards />;
    if (view === "template-management") return <Templates />;
    return <Settings theme={theme} onTheme={toggleTheme} />;
  }, [theme, view]);
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
          <button className="ds-sidebar-toggle" type="button" onClick={toggleSidebar} aria-label="收起侧边栏">
            <Icon name="chevron-left" size={16} />
          </button>
          <span className="ds-sidebar__brand-name">DeepStudent</span>
          <div className="ds-sidebar__brand-actions">
            <button className="ds-icon-button" aria-label="搜索会话"><Icon name="search" size={15} /></button>
          </div>
        </div>
        <nav className="ds-primary-nav" aria-label="主入口">
          {navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => selectView(item.id)} data-active={item.id === view}><span className="ds-nav-icon"><Icon name={item.icon} size={16} /></span><span>{item.label}</span></button>)}
        </nav>
        <div className="ds-sidebar__scroll">
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action" aria-label="收起置顶"><Icon name="chevron-down" size={14} /></button></div><button className="ds-thread-row"><span className="ds-thread-dot ds-thread-dot--accent"><Icon name="sparkle" size={13} /></span><span>开始一个新对话</span></button></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action" aria-label="收起主题"><Icon name="chevron-down" size={14} /></button><button className="ds-section-action" aria-label="新建主题"><Icon name="plus" size={14} /></button></span></div><button className="ds-topic-row"><span className="ds-topic-icon"><Icon name="home" size={14} /></span><span>高中生物</span><em>2</em><b><Icon name="chevron-down" size={12} /></b></button><button className="ds-thread-row ds-thread-row--nested"><span>智能学习助手介绍</span></button><button className="ds-thread-row ds-thread-row--nested"><span>完善高中生物思维导图</span></button><button className="ds-topic-row"><span className="ds-topic-icon"><Icon name="book" size={14} /></span><span>高中英语</span><em>1</em><b><Icon name="chevron-down" size={12} /></b></button><button className="ds-thread-row ds-thread-row--nested"><span>制作读后续写 Anki 卡片</span></button><button className="ds-topic-row"><span className="ds-topic-icon"><Icon name="folder" size={14} /></span><span>LLM研究</span><em>6</em><b><Icon name="chevron-down" size={12} /></b></button><button className="ds-thread-row ds-thread-row--nested"><span>最新 LLM 研究论文汇总</span></button><button className="ds-thread-row ds-thread-row--nested"><span>Context7 查询 LLM 文档</span></button></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={() => selectView("chat-v2")} aria-label="新建对话"><Icon name="plus" size={14} /></button></div><button className="ds-thread-row ds-thread-row--active"><span className="ds-thread-dot"><Icon name="sparkle" size={12} /></span><span>未命名会话</span><small>刚刚</small></button><button className="ds-thread-row"><span className="ds-thread-dot"><Icon name="sparkle" size={12} /></span><span>复习概率论</span><small>昨天</small></button><button className="ds-thread-row"><span className="ds-thread-dot"><Icon name="sparkle" size={12} /></span><span>帮我读这篇论文</span><small>周一</small></button></section>
        </div>
        <div className="ds-sidebar__footer">
          <button className="ds-nav-row" onClick={() => selectView("settings")} data-active={view === "settings"}><span className="ds-nav-icon"><Icon name="settings" size={16} /></span><span>设置</span></button>
          <div className="ds-runtime-status" id="runtime-status"><i></i><span>{runtimeStatus}</span></div>
          <div className="ds-sidebar__version">DeepStudent Go · 0.1</div>
        </div>
      </aside>
      <button className="ds-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"></button>
      <main className="ds-main" data-shell-layer="workspace" data-view={view}>
        <div className="ds-main__drag-region" aria-hidden="true" />
        <div className="ds-main__floating-actions" aria-label="窗口与工作区操作">
          <button className="ds-sidebar-affordance" type="button" onClick={toggleSidebar} aria-label="打开导航" aria-expanded={sidebarCollapsed || sidebarOpen}>
            <Icon name="sliders" size={17} />
          </button>
          <div className="ds-main__actions">
            <button className="ds-icon-button" onClick={() => selectView("learning-hub")} aria-label="搜索"><Icon name="search" size={16} /></button>
            <button className="ds-icon-button" onClick={() => selectView("chat-v2")} aria-label="新建"><Icon name="plus" size={16} /></button>
            <button className="ds-icon-button" onClick={toggleTheme} aria-label="切换主题"><Icon name="sun" size={16} /></button>
          </div>
        </div>
        <div className="ds-main__content">{content}</div>
      </main>
    </div>
  </div>;
}
