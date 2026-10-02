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
  | "task-dashboard"
  | "flashcards"
  | "template-management"
  | "settings";
type Theme = "light" | "dark";

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
            ? `已收到「${text}」。DeepStudent Go 的本地对话壳已准备好，接下来会接入 Go runtime 的流式模型。`
            : "DeepStudent Go 本地对话已就绪。",
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

function ChatWorkspace() {
  const runtime = useLocalRuntime(StubAdapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="ds-chat-page" aria-labelledby="chat-welcome-title">
        <ThreadPrimitive.Root className="ds-chat-thread">
          <ThreadPrimitive.Viewport className="ds-thread-viewport" autoScroll>
            <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            <ThreadPrimitive.Empty>
              <div className="ds-chat-center">
                <div className="ds-chat-brand" aria-hidden="true">
                  <img src="./logo-black.svg" alt="" />
                </div>
                <h2 id="chat-welcome-title">欢迎使用 DeepStudent</h2>
                <p>开始新对话，探索学习资料、整理笔记、随时提问</p>
                <div className="ds-chat-actions">
                  <button className="ds-primary-button" type="button">＋ 新对话</button>
                  <button className="ds-secondary-button" type="button">▤ 浏览学习资源</button>
                </div>
                <span className="ds-chat-hint">提示：随时按 ⌘ N 新建对话</span>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.ScrollToBottom className="ds-scroll-bottom">↓</ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="ds-composer" compact>
            <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
            <div className="ds-composer__toolbar">
              <div className="ds-composer__tools">
                <ComposerPrimitive.AddAttachment className="ds-composer-tool" aria-label="添加附件">＋</ComposerPrimitive.AddAttachment>
                <button type="button" className="ds-composer-tool" aria-label="调用工具">✧</button>
                <button type="button" className="ds-composer-tool" aria-label="深度思考">ϟ</button>
              </div>
              <span className="ds-composer__notice">AI 生成的内容可能存在错误，请注意甄别</span>
              <ComposerPrimitive.Send className="ds-send-button" aria-label="发送">↑</ComposerPrimitive.Send>
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
  const meta = viewMeta[view];

  return <div className="ds-shell" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} data-view={view}>
    <header className="ds-titlebar" data-shell-layer="window-chrome"><div className="ds-titlebar__nav"><span className="ds-titlebar__traffic" aria-hidden="true"><i></i><i></i><i></i></span><img className="ds-titlebar__logo" src="./logo-black.svg" alt="" /><span className="ds-titlebar__brand">DeepStudent</span></div><div className="ds-titlebar__workspace"><button className="ds-menu-button" onClick={() => setSidebarOpen((open) => !open)} aria-label="打开导航" aria-expanded={sidebarOpen}>☰</button><div className="ds-titlebar__crumb"><span>{view === "chat-v2" ? "DeepStudent" : meta.title}</span>{view !== "chat-v2" && <span>{meta.subtitle}</span>}</div><div className="ds-titlebar__actions"><button className="ds-titlebar__control" onClick={() => selectView("chat-v2")} aria-label="新建会话">＋</button><button className="ds-titlebar__control" onClick={toggleTheme} aria-label="切换主题">◐</button><button className="ds-titlebar__control" onClick={() => setSidebarCollapsed((collapsed) => !collapsed)} aria-label="收起侧边栏">‹</button></div></div></header>
    <div className="ds-body"><aside className="ds-sidebar" data-shell-layer="navigation" aria-label="DeepStudent 主入口"><div className="ds-sidebar__brand"><span>DeepStudent</span><div className="ds-sidebar__brand-actions"><button className="ds-icon-button" aria-label="筛选">≡</button><button className="ds-icon-button" aria-label="搜索会话">⌕</button></div></div><nav className="ds-primary-nav" aria-label="主入口">{navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => selectView(item.id)} data-active={item.id === view}><span className="ds-nav-icon">{item.icon}</span><span>{item.label}</span></button>)}</nav><div className="ds-sidebar__scroll"><section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action">⌄</button></div><button className="ds-thread-row"><span className="ds-thread-dot ds-thread-dot--accent">✦</span><span>开始一个新对话</span></button></section><section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action">⌄</button><button className="ds-section-action">＋</button></span></div><button className="ds-topic-row"><span className="ds-topic-icon">⌂</span><span>高中生物</span><em>2</em><b>⌄</b></button><button className="ds-thread-row ds-thread-row--nested"><span>智能学习助手介绍</span></button><button className="ds-thread-row ds-thread-row--nested"><span>完善高中生物思维导图</span></button><button className="ds-topic-row"><span className="ds-topic-icon">▣</span><span>高中英语</span><em>1</em><b>⌄</b></button><button className="ds-thread-row ds-thread-row--nested"><span>制作读后续写 Anki 卡片</span></button><button className="ds-topic-row"><span className="ds-topic-icon">□</span><span>LLM研究</span><em>6</em><b>⌄</b></button><button className="ds-thread-row ds-thread-row--nested"><span>最新 LLM 研究论文汇总</span></button><button className="ds-thread-row ds-thread-row--nested"><span>Context7 查询 LLM 文档</span></button></section><section className="ds-sidebar-section"><div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={() => selectView("chat-v2")}>＋</button></div><button className="ds-thread-row ds-thread-row--active"><span className="ds-thread-dot">●</span><span>未命名会话</span><small>刚刚</small></button><button className="ds-thread-row"><span className="ds-thread-dot">●</span><span>复习概率论</span><small>昨天</small></button><button className="ds-thread-row"><span className="ds-thread-dot">●</span><span>帮我读这篇论文</span><small>周一</small></button></section></div><div className="ds-sidebar__footer"><button className="ds-nav-row" onClick={() => selectView("settings")} data-active={view === "settings"}><span className="ds-nav-icon">⚙</span><span>设置</span></button><div className="ds-runtime-status" id="runtime-status"><i></i><span>{runtimeStatus}</span></div><div className="ds-sidebar__version">DeepStudent Go · 0.1</div></div></aside><button className="ds-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"></button><main className="ds-main" data-shell-layer="workspace"><header className="ds-main__header"><div className="ds-main__heading"><h1>{meta.title}</h1><p>{meta.subtitle}</p></div><div className="ds-main__actions"><button className="ds-icon-button" onClick={() => selectView("learning-hub")} aria-label="搜索">⌕</button><button className="ds-icon-button" onClick={() => selectView("chat-v2")} aria-label="新建">＋</button></div></header><div className="ds-main__content">{content}</div></main></div>
  </div>;
}
