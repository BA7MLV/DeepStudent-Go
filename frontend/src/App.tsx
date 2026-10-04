import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useLocalRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HealthService } from "./mygo";
import { createGoRuntimeAdapter } from "./go-runtime";
import {
  createRuntimeSession,
  getRuntimeSessionMessages,
  listRuntimeSessions,
  type RuntimeMessage,
  type RuntimeSession,
} from "./runtime-api";

type ViewId =
  | "chat-v2"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "flashcards"
  | "settings";
type Theme = "light" | "dark";
type OutboxStatus = "idle" | "sending" | "queued" | "sent" | "failed";

type PersistedMessage = {
  id: string;
  role: string;
  content: unknown;
  createdAt?: string;
  status?: unknown;
  parentId?: string | null;
  sourceId?: string | null;
  metadata?: unknown;
  attachments?: unknown;
};

type ChatSession = {
  id: string;
  title: string;
  updatedAt: number;
  draft: string;
  unread: number;
  pinned?: boolean;
  messages: PersistedMessage[];
};

const SESSION_STORAGE_KEY = "dstu-chat-sessions-v1";

function createSession(): ChatSession {
  return {
    id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    title: "新会话",
    updatedAt: Date.now(),
    draft: "",
    unread: 0,
    messages: [],
  };
}

function readSessions(): ChatSession[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "null");
    if (Array.isArray(stored) && stored.length > 0) return stored as ChatSession[];
  } catch {
    // A malformed local cache should never prevent the chat shell from opening.
  }
  return [createSession()];
}

function messageText(message: PersistedMessage | undefined): string {
  if (!message) return "";
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"))
    .map((part) => part.text)
    .join(" ")
    .trim();
}

function serializeMessages(messages: readonly unknown[]): PersistedMessage[] {
  return messages.map((message) => {
    const item = message as PersistedMessage;
    const createdAt: unknown = (message as { createdAt?: unknown }).createdAt;
    return { ...item, createdAt: createdAt instanceof Date ? createdAt.toISOString() : typeof createdAt === "string" ? createdAt : undefined };
  });
}

function restoreMessages(messages: PersistedMessage[]): unknown[] {
  return messages.map((message) => ({ ...message, createdAt: message.createdAt ? new Date(message.createdAt) : undefined }));
}

function serverTimestamp(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Convert append-only Go messages into the assistant-ui transcript shape. */
function serverMessagesToPersisted(messages: RuntimeMessage[]): PersistedMessage[] {
  const result: PersistedMessage[] = [];
  for (const message of messages) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    const text = typeof message.content === "string" ? message.content : String(message.content ?? "");
    if (!text) continue;
    const previous = result.at(-1);
    const previousRunId = previous?.metadata && typeof previous.metadata === "object" ? (previous.metadata as { runId?: unknown }).runId : undefined;
    // The Go runtime appends each streamed delta as a message. Coalesce one
    // run back into a single assistant bubble during hydration.
    if (message.role === "assistant" && previous?.role === "assistant" && (message.run_id ? previousRunId === message.run_id : true)) {
      previous.content = [{ type: "text", text: `${messageText(previous)}${text}` }];
      if (message.created_at) previous.createdAt = message.created_at;
      continue;
    }
    result.push({
      id: message.id || `server-message-${result.length}`,
      role: message.role,
      content: [{ type: "text", text }],
      createdAt: message.created_at,
      metadata: { sessionId: message.session_id, runId: message.run_id },
    });
  }
  return result;
}

function serverSessionToLocal(session: RuntimeSession, messages: PersistedMessage[] | undefined, local: ChatSession | undefined): ChatSession {
  return {
    id: session.id,
    title: session.title?.trim() || local?.title || "新会话",
    updatedAt: serverTimestamp(session.updated_at, local?.updatedAt ?? Date.now()),
    draft: local?.draft ?? "",
    unread: local?.unread ?? 0,
    pinned: local?.pinned,
    // An empty server transcript is authoritative too. `undefined` means the
    // transcript request failed and is the only case where the local cache is
    // useful as a temporary fallback.
    messages: messages !== undefined ? messages : (local?.messages ?? []),
  };
}

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

const readTheme = (): Theme => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

function makeChatAdapter(statusRef: { current: (status: OutboxStatus) => void }): ChatModelAdapter {
  return {
    async *run({ messages }) {
      const last = messages.at(-1);
      const text = last?.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join(" ")
        .trim();
      const offline = typeof navigator !== "undefined" && !navigator.onLine;
      statusRef.current(offline ? "queued" : "sending");
      // Keep the local prototype useful offline while surfacing the outbox state.
      await new Promise((resolve) => window.setTimeout(resolve, 220));
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
      statusRef.current(offline ? "queued" : "sent");
      if (!offline) window.setTimeout(() => statusRef.current("idle"), 1200);
    },
  };
}

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
      <h2 id="chat-welcome-title">把今天学会的，变成真正掌握的</h2>
    </div>
  );
}

function ChatWorkspace({ session, onSessionChange }: { session: ChatSession; onSessionChange: (patch: Partial<ChatSession>) => void }) {
  const statusRef = useRef<(status: OutboxStatus) => void>(() => undefined);
  const [outboxStatus, setOutboxStatus] = useState<OutboxStatus>("idle");
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [unread, setUnread] = useState(session.unread);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [messageCount, setMessageCount] = useState(session.messages.length);
  const isAtBottomRef = useRef(true);
  const persistedCountRef = useRef(session.messages.length);
  const unreadRef = useRef(session.unread);
  const viewportRef = useRef<HTMLDivElement>(null);
  statusRef.current = setOutboxStatus;
  const adapter = useMemo(() => createGoRuntimeAdapter({
    sessionId: session.id,
    // Keep the prototype usable on static previews and while the local Go
    // service is starting. The adapter only selects this fallback for an
    // unavailable runtime; API/application errors remain visible.
    fallback: makeChatAdapter(statusRef),
  }), [session.id]);
  const runtime = useLocalRuntime(adapter, { initialMessages: restoreMessages(session.messages) as never });

  useEffect(() => {
    const onOnline = () => { setIsOnline(true); setOutboxStatus("idle"); };
    const onOffline = () => { setIsOnline(false); };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  useEffect(() => {
    runtime.thread.composer.setText(session.draft);
    const saveDraft = () => onSessionChange({ draft: runtime.thread.composer.getState().text, updatedAt: Date.now() });
    saveDraft();
    return runtime.thread.composer.subscribe(saveDraft);
  }, [onSessionChange, runtime]);

  useEffect(() => {
    const persist = () => {
      const state = runtime.thread.getState();
      const messages = serializeMessages(state.messages);
      const previousCount = persistedCountRef.current;
      setMessageCount(messages.length);
      persistedCountRef.current = messages.length;
      if (state.isRunning) setOutboxStatus(isOnline ? "sending" : "queued");
      else if (messages.length > previousCount && isOnline) {
        setOutboxStatus("sent");
        window.setTimeout(() => setOutboxStatus("idle"), 1000);
      }
      if (messages.length > previousCount && !isAtBottomRef.current) {
        const nextUnread = unreadRef.current + messages.length - previousCount;
        unreadRef.current = nextUnread;
        setUnread(nextUnread);
        onSessionChange({ unread: nextUnread });
      }
      onSessionChange({
        messages,
        updatedAt: Date.now(),
        title: session.title === "新会话" ? (messageText(messages.find((item) => item.role === "user")!) || session.title).slice(0, 36) : session.title,
      });
    };
    persist();
    return runtime.thread.subscribe(persist);
    }, [isOnline, onSessionChange, runtime, session.title]);

  const handleScroll = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 28;
    isAtBottomRef.current = atBottom;
    setIsAtBottom(atBottom);
    if (atBottom) {
      unreadRef.current = 0;
      setUnread(0);
      onSessionChange({ unread: 0 });
    }
  }, [onSessionChange]);

  const jumpToBottom = () => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
    unreadRef.current = 0;
    setUnread(0);
    onSessionChange({ unread: 0 });
  };

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="ds-chat-page" aria-labelledby="chat-welcome-title">
        <ThreadPrimitive.Root className="ds-chat-thread">
          <ThreadPrimitive.Viewport ref={viewportRef} className="ds-thread-viewport" autoScroll turnAnchor="bottom" onScroll={handleScroll}>
            <div className="ds-timeline-status" aria-live="polite">
              <span>{messageCount ? `${messageCount} 条消息` : "新会话"}</span>
              {!isOnline && <span className="ds-outbox-pill is-queued">离线 · 稍后发送</span>}
              {outboxStatus === "sending" && <span className="ds-outbox-pill">发送中…</span>}
              {outboxStatus === "sent" && <span className="ds-outbox-pill is-sent">已保存</span>}
            </div>
            <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            <ThreadPrimitive.Empty>
              <ChatEmptyState />
            </ThreadPrimitive.Empty>
            {!isAtBottom && <button type="button" className="ds-scroll-bottom" onClick={jumpToBottom} aria-label="跳到底部">{unread ? `${unread} 条新消息 ↓` : "跳到底部 ↓"}</button>}
          </ThreadPrimitive.Viewport>
          <ComposerPrimitive.Root className="ds-composer" compact>
            <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
            <div className="ds-composer__toolbar">
              <div className="ds-composer__tools">
                <ComposerPrimitive.AddAttachment className="ds-composer-tool" aria-label="添加附件"><Icon name="paperclip" size={16} /></ComposerPrimitive.AddAttachment>
                <button type="button" className="ds-composer-tool ds-composer-tool--secondary" aria-label="调用工具"><Icon name="wand" size={16} /></button>
                <button type="button" className="ds-composer-tool ds-composer-tool--secondary" aria-label="深度思考"><Icon name="brain" size={16} /></button>
              </div>
              <span className={`ds-outbox-state is-${outboxStatus}`} aria-live="polite">{outboxStatus === "queued" ? "待发送" : outboxStatus === "failed" ? "发送失败" : ""}</span>
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
function EmptyState({ title, description }: { title: string; description: string }) { return <div className="ds-empty-state"><b>{title}</b><p>{description}</p></div>; }
function Todo() { return <WorkspacePage eyebrow="今日行动" title="待办事项" description="把下一步学习行动放在眼前" action="＋ 新建待办"><div className="ds-panel"><EmptyState title="还没有待办事项" description="创建一个待办事项，让下一步学习行动清晰可见" /></div></WorkspacePage>; }
function Skills() { return <WorkspacePage eyebrow="可组合能力" title="技能管理" description="安装、启用和编辑 DeepStudent 的技能" action="＋ 添加技能"><EmptyState title="还没有可用技能" description="添加技能后，它们会出现在这里" /></WorkspacePage>; }
function Flashcards() { return <WorkspacePage eyebrow="主动回忆" title="闪卡" description="用短时练习巩固真正理解的内容" action="＋ 新建卡组"><EmptyState title="还没有闪卡组" description="创建一个卡组，开始用主动回忆巩固知识" /></WorkspacePage>; }
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
  const [sessions, setSessions] = useState<ChatSession[]>(() => readSessions());
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");
  // Bump this after a server transcript arrives so assistant-ui receives the
  // hydrated initial messages without changing the existing shell layout.
  const [sessionHydrationVersion, setSessionHydrationVersion] = useState(0);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(sessions));
  }, [sessions]);
  useEffect(() => {
    if (!sessions.some((session) => session.id === activeSessionId) && sessions[0]) setActiveSessionId(sessions[0].id);
  }, [activeSessionId, sessions]);
  useEffect(() => {
    let active = true;
    void HealthService.health().then((health) => {
      if (active) setRuntimeStatus(`${health.runtime} runtime · ${health.status}`);
    }).catch(() => {
      if (active) setRuntimeStatus("Go runtime bridge unavailable");
    });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const hydrate = async () => {
      try {
        const remoteSessions = await listRuntimeSessions();
        if (cancelled) return;
        // Keep the transcript result separate from the local cache until the
        // final state update. A user can create a new chat or send a message
        // while this startup request is in flight; reading `sessions` from
        // the effect closure would otherwise overwrite that newer state.
        const hydrated = await Promise.all(remoteSessions.map(async (remote) => {
          try {
            const messages = await getRuntimeSessionMessages(remote.id);
            return { remote, messages: serverMessagesToPersisted(messages) };
          } catch {
            // A session transcript can be temporarily unavailable; keep its
            // local cache while still showing the server session entry.
            return { remote, messages: undefined };
          }
        }));
        if (cancelled) return;
        setSessions((current) => {
          const localById = new Map(current.map((session) => [session.id, session]));
          const remote = hydrated.map(({ remote: serverSession, messages }) => serverSessionToLocal(serverSession, messages, localById.get(serverSession.id)));
          const remoteIds = new Set(remote.map((session) => session.id));
          // Preserve local-only conversations for static/offline previews until
          // their first successful send creates them on the server.
          return [...remote, ...current.filter((session) => !remoteIds.has(session.id))];
        });
        if (hydrated.length > 0) {
          setSessionHydrationVersion((version) => version + 1);
        }
      } catch {
        // No Go HTTP service is expected in a static preview. LocalStorage is
        // deliberately left untouched in this case.
      }
    };
    void hydrate();
    return () => { cancelled = true; };
    // Hydrate once on startup. ChatWorkspace persists subsequent changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const selectView = (next: ViewId) => { setView(next); setSidebarOpen(false); };
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? createSession();
  const updateSession = useCallback((patch: Partial<ChatSession>) => {
    setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, ...patch } : session));
  }, [activeSession.id]);
  const newSession = () => {
    const session = createSession();
    setSessions((current) => [session, ...current]);
    setActiveSessionId(session.id);
    setView("chat-v2");
    setSidebarOpen(false);
    void createRuntimeSession(session).catch(() => undefined);
  };
  const visibleSessions = sessions
    .filter((session) => !sessionSearch.trim() || session.title.toLocaleLowerCase().includes(sessionSearch.trim().toLocaleLowerCase()))
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace key={`${activeSession.id}:${sessionHydrationVersion}`} session={activeSession} onSessionChange={updateSession} />;
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <Settings theme={theme} onTheme={toggleTheme} />;
  }, [activeSession, sessionHydrationVersion, theme, updateSession, view]);
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
          {navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => item.id === "chat-v2" ? newSession() : selectView(item.id)} data-active={item.id === view}><span className="ds-nav-icon"><Icon name={item.icon} size={16} /></span><span>{item.label}</span></button>)}
        </nav>
        <div className="ds-sidebar__scroll">
          <section className="ds-sidebar-section ds-conversation-section">
            <div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={newSession} aria-label="新建对话"><Icon name="plus" size={14} /></button></div>
            <label className="ds-conversation-search"><Icon name="search" size={13} /><input value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="搜索会话…" aria-label="搜索会话" /></label>
            {visibleSessions.length === 0 ? <p className="ds-sidebar-empty">没有匹配的会话</p> : visibleSessions.map((session) => <button type="button" key={session.id} className="ds-thread-row" data-active={session.id === activeSession.id} onClick={() => { setActiveSessionId(session.id); setView("chat-v2"); setSidebarOpen(false); setSessions((current) => current.map((item) => item.id === session.id ? { ...item, unread: 0 } : item)); }}><span className={`ds-thread-dot ${session.unread ? "ds-thread-dot--accent" : ""}`}>{session.unread ? "●" : "○"}</span><span>{session.title}</span>{session.unread > 0 && <small>{session.unread}</small>}</button>)}
          </section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action" aria-label="收起置顶"><Icon name="chevron-down" size={14} /></button></div><p className="ds-sidebar-empty">将重要会话置顶，方便快速返回</p></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action" aria-label="收起主题"><Icon name="chevron-down" size={14} /></button><button className="ds-section-action" aria-label="新建主题"><Icon name="plus" size={14} /></button></span></div><p className="ds-sidebar-empty">暂无主题</p></section>
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
        <div className="ds-main__floating-actions">
          <button className="ds-sidebar-affordance" type="button" onClick={toggleSidebar} aria-label="打开导航" aria-expanded={sidebarCollapsed || sidebarOpen}>
            <Icon name="sliders" size={17} />
          </button>
        </div>
        <div className="ds-main__content">{content}</div>
      </main>
    </div>
  </div>;
}
