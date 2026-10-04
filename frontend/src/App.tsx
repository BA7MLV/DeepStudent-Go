import {
  ActionBarPrimitive,
  AuiIf,
  AssistantRuntimeProvider,
  BranchPickerPrimitive,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useAui,
  useAuiState,
  useLocalRuntime,
  type AttachmentAdapter,
  type ThreadComposerRuntime,
  type ChatModelAdapter,
  type ToolCallMessagePartProps,
  type ToolCallMessagePart,
  AttachmentPrimitive,
} from "@assistant-ui/react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowCounterClockwise,
  BookOpen,
  Brain,
  Bug,
  Cards,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckSquare,
  CheckCircle,
  Check,
  Copy,
  Gear,
  List,
  MagnifyingGlass,
  Microphone,
  PencilSimple,
  Pause,
  Play,
  Plus,
  SidebarSimple,
  Sparkle,
  StackSimple,
  Sun,
  Wrench,
  X,
  type Icon as PhosphorIcon,
  DownloadSimple,
} from "@phosphor-icons/react";
import { HealthService } from "./mygo";
import { createGoRuntimeAdapter } from "./go-runtime";

type ViewId =
  | "chat-v2"
  | "stream-debug"
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
type ChatSession = { id: string; title: string; updatedAt: number; draft: string; unread: number; pinned?: boolean; messages: PersistedMessage[] };
const sessionStorageKey = "dstu-chat-sessions-v1";
function createSession(): ChatSession { return { id: `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, title: "新会话", updatedAt: Date.now(), draft: "", unread: 0, messages: [] }; }
function readSessions(): ChatSession[] {
  try {
    const stored = JSON.parse(window.localStorage.getItem(sessionStorageKey) ?? "null");
    if (Array.isArray(stored) && stored.length > 0) return stored as ChatSession[];
  } catch { /* malformed cache falls back to a new chat */ }
  return [createSession()];
}
function messageText(message: PersistedMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((part): part is { type: "text"; text: string } => Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string")).map((part) => part.text).join(" ").trim();
}
function serializeMessages(messages: readonly unknown[]): PersistedMessage[] {
  return messages.map((message) => {
    const item = message as PersistedMessage;
    const createdAt: unknown = (message as { createdAt?: unknown }).createdAt;
    return { ...item, createdAt: createdAt instanceof Date ? createdAt.toISOString() : typeof createdAt === "string" ? createdAt : undefined };
  });
}
function restoreMessages(messages: PersistedMessage[]): unknown[] { return messages.map((message) => ({ ...message, createdAt: message.createdAt ? new Date(message.createdAt) : undefined })); }

type LearningGoal = "exam" | "course" | "skill";
type LearningMode = "practice" | "notes" | "plan";
type ModelChoice = "local" | "openai" | "compatible";
type RuntimeChoice = "go" | "browser";
type OnboardingConfig = { goal: LearningGoal; mode: LearningMode; model: ModelChoice; runtime: RuntimeChoice; completedAt: string };

const onboardingStorageKey = "dstu-onboarding-config-v1";
const defaultOnboardingConfig: Omit<OnboardingConfig, "completedAt"> = { goal: "course", mode: "practice", model: "local", runtime: "go" };

function readOnboardingConfig(): OnboardingConfig | null {
  const raw = window.localStorage.getItem(onboardingStorageKey);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<OnboardingConfig>;
    if ((parsed.goal === "exam" || parsed.goal === "course" || parsed.goal === "skill") && (parsed.mode === "practice" || parsed.mode === "notes" || parsed.mode === "plan") && (parsed.model === "local" || parsed.model === "openai" || parsed.model === "compatible") && (parsed.runtime === "go" || parsed.runtime === "browser")) {
      return { goal: parsed.goal, mode: parsed.mode, model: parsed.model, runtime: parsed.runtime, completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : new Date().toISOString() };
    }
  } catch { /* invalid local state behaves like a first visit */ }
  return null;
}

const onboardingGoals: Array<{ value: LearningGoal; label: string; description: string }> = [
  { value: "exam", label: "备考与考试", description: "按考试节奏复习" },
  { value: "course", label: "跟上课程", description: "理解课程并完成练习" },
  { value: "skill", label: "长期掌握技能", description: "持续积累可迁移能力" },
];
const onboardingModes: Array<{ value: LearningMode; label: string; description: string }> = [
  { value: "practice", label: "练习优先", description: "先练习，再看反馈" },
  { value: "notes", label: "整理优先", description: "整理资料和笔记" },
  { value: "plan", label: "计划优先", description: "按目标安排行动" },
];
const onboardingModels: Array<{ value: ModelChoice; label: string; description: string }> = [
  { value: "local", label: "DeepStudent Local", description: "本机模型，数据留在当前环境" },
  { value: "openai", label: "OpenAI", description: "使用已配置的模型" },
  { value: "compatible", label: "兼容 OpenAI 的服务", description: "连接兼容接口" },
];

const onboardingRuntimeOptions: Array<{ value: RuntimeChoice; label: string; description: string }> = [
  { value: "go", label: "Go runtime", description: "推荐，适合完整功能" },
  { value: "browser", label: "浏览器运行时", description: "无需本地服务" },
];

function Onboarding({ initial, onComplete }: { initial: OnboardingConfig | null; onComplete: (config: Omit<OnboardingConfig, "completedAt">) => void }) {
  const [draft, setDraft] = useState<Omit<OnboardingConfig, "completedAt">>(() => initial ? { goal: initial.goal, mode: initial.mode, model: initial.model, runtime: initial.runtime } : defaultOnboardingConfig);
  const [step, setStep] = useState(0);
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const select = <K extends keyof typeof draft>(key: K, value: (typeof draft)[K]) => setDraft((current) => ({ ...current, [key]: value }));
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);

  const renderOptions = <K extends keyof typeof draft>(key: K, title: string, options: Array<{ value: (typeof draft)[K]; label: string; description: string }>) => (
    <div key={String(key)} className="ds-onboarding__group">
      <h2>{title}</h2>
      <div className="ds-onboarding__options">
        {options.map((option) => <button key={String(option.value)} type="button" className={`ds-onboarding-option${draft[key] === option.value ? " is-selected" : ""}`} aria-pressed={draft[key] === option.value} onClick={() => select(key, option.value)}><b>{option.label}</b><small>{option.description}</small></button>)}
      </div>
    </div>
  );

  const renderRuntime = () => (
    <div key="runtime" className="ds-onboarding__group ds-onboarding__runtime-group">
      <h2>运行时</h2>
      <div className="ds-onboarding__options">
        {onboardingRuntimeOptions.map((option) => <button key={option.value} type="button" className={`ds-onboarding-option${draft.runtime === option.value ? " is-selected" : ""}`} aria-pressed={draft.runtime === option.value} onClick={() => select("runtime", option.value)}><b>{option.label}</b><small>{option.description}</small></button>)}
      </div>
    </div>
  );

  const steps = [
    renderOptions("goal", "学习目标", onboardingGoals),
    renderOptions("mode", "学习方式", onboardingModes),
    renderOptions("model", "模型", onboardingModels),
    renderRuntime(),
  ];
  const finishOrAdvance = () => {
    if (!isMobile || step === steps.length - 1) onComplete(draft);
    else setStep((current) => current + 1);
  };

  return <div className="ds-onboarding" role="dialog" aria-modal="true" aria-labelledby="ds-onboarding-title">
    <section className="ds-onboarding__card">
      <header className="ds-onboarding__header"><div><span className="ds-onboarding__brand">DeepStudent</span><span className="ds-onboarding__kicker">首次设置</span></div>{isMobile && <span className="ds-onboarding__progress">{step + 1} / {steps.length}</span>}</header>
      <main className="ds-onboarding__body">
        <h1 id="ds-onboarding-title">设置你的学习方式</h1>
        {isMobile ? <div className="ds-onboarding__mobile-step">{steps[step]}</div> : <>{steps}</>}
      </main>
      <footer className="ds-onboarding__footer">
        <button type="button" className="ds-text-button" onClick={() => onComplete(defaultOnboardingConfig)}>使用默认设置</button>
        <div className="ds-onboarding__footer-main">
          {isMobile && step > 0 && <button type="button" className="ds-secondary-button" onClick={() => setStep((current) => current - 1)}>上一步</button>}
          <button type="button" className="ds-primary-button" onClick={finishOrAdvance}>{isMobile && step < steps.length - 1 ? "下一步" : "完成设置"}</button>
        </div>
      </footer>
    </section>
  </div>;
}

type IconName = "sparkle" | "book" | "check" | "sparkle-two" | "cards" | "stack" | "settings" | "plus" | "search" | "sidebar" | "menu" | "chevron-down" | "sun" | "arrow-up" | "microphone" | "x" | "brain" | "bug" | "play" | "pause" | "reset" | "wrench" | "check-circle";

const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "chat-v2", label: "新会话", icon: "sparkle" },
  { id: "stream-debug", label: "调试流式输出", icon: "bug" },
  { id: "learning-hub", label: "学习资源", icon: "book" },
  { id: "todo", label: "待办事项", icon: "check" },
  { id: "skills-management", label: "技能管理", icon: "sparkle-two" },
  { id: "flashcards", label: "闪卡", icon: "stack" },
];

const quickPrompts: Array<{ label: string; icon: IconName }> = [
  { label: "复习今天的课程", icon: "book" },
  { label: "整理一份学习笔记", icon: "book" },
  { label: "解释一个概念", icon: "brain" },
  { label: "生成知识点卡片", icon: "cards" },
  { label: "制定复习计划", icon: "check" },
  { label: "总结这段资料", icon: "stack" },
  { label: "创建学习线程", icon: "sparkle" },
];

const phosphorIcons: Record<IconName, PhosphorIcon> = {
  sparkle: Sparkle,
  book: BookOpen,
  check: CheckSquare,
  "sparkle-two": Sparkle,
  cards: Cards,
  stack: StackSimple,
  settings: Gear,
  plus: Plus,
  search: MagnifyingGlass,
  sidebar: SidebarSimple,
  menu: List,
  "chevron-down": CaretDown,
  sun: Sun,
  "arrow-up": ArrowUp,
  microphone: Microphone,
  x: X,
  brain: Brain,
  bug: Bug,
  play: Play,
  pause: Pause,
  reset: ArrowCounterClockwise,
  wrench: Wrench,
  "check-circle": CheckCircle,
};

function Icon({ name, size = 16, strokeWidth: _strokeWidth = 1.8 }: { name: IconName; size?: number; strokeWidth?: number }) {
  const Glyph = phosphorIcons[name];
  return <Glyph size={size} weight="regular" aria-hidden="true" />;
}

const readTheme = (): Theme => {
  const saved = window.localStorage.getItem("dstu-theme-mode");
  if (saved === "dark" || saved === "light") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
};

const StubAdapter: ChatModelAdapter = {
  async *run({ messages }) {
    const last = messages.at(-1);
    const hasVoiceAttachment = last?.content.some((part) => part.type === "file" && part.mimeType.startsWith("audio/"));
    const text = last?.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join(" ")
      .trim();
    yield {
      content: [
        {
          type: "text",
          text: hasVoiceAttachment
            ? "已收到语音消息，可以继续学习。"
            : text
            ? `收到「${text}」，我们可以从理解、整理和复习开始。`
            : "准备好开始学习。",
        },
      ],
    };
  },
};

/**
 * ChatGPT's example keeps text rendering as a named component so the message
 * primitive can swap in markdown/tool renderers without changing the thread.
 * DeepStudent intentionally keeps the renderer dependency-free and lets the
 * primitive stream text smoothly into a block-level surface.
 */
function MarkdownText() {
  return <MessagePartPrimitive.Text component="div" smooth />;
}

function ChatGPTAttachmentUI() {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  return (
    <AttachmentPrimitive.Root className="ds-chat-attachment">
      <AuiIf condition={(state) => state.attachment.type === "image"}>
        <AttachmentPrimitive.unstable_Thumb className="ds-chat-attachment__thumb ds-chat-attachment__thumb--image" />
      </AuiIf>
      <AuiIf condition={(state) => state.attachment.type !== "image"}>
        <AttachmentPrimitive.unstable_Thumb className="ds-chat-attachment__thumb" />
      </AuiIf>
      <span className="ds-chat-attachment__name"><AttachmentPrimitive.Name /></span>
      {isComposer && <AttachmentPrimitive.Remove className="ds-chat-attachment__remove" aria-label="移除附件"><Icon name="x" size={13} /></AttachmentPrimitive.Remove>}
    </AttachmentPrimitive.Root>
  );
}

function ChatEmptyState() {
  return (
    <div className="ds-chat-center">
      <h2 id="chat-welcome-title">把今天学会的，变成真正掌握的</h2>
    </div>
  );
}

function ChatQuickPrompts() {
  const composer = unstable_useComposerInput();
  const rows = [quickPrompts.slice(0, 3), quickPrompts.slice(3, 5), quickPrompts.slice(5, 7)];
  return <div className="ds-chat-prompts" aria-label="学习场景快捷提示">
    {rows.map((row, index) => <div className={`ds-chat-prompts__row ds-chat-prompts__row--${index + 1}`} key={`prompt-row-${index}`}>
      {row.map((prompt) => <button key={prompt.label} className="ds-chat-prompt" type="button" onClick={() => composer.setText(prompt.label)}><Icon name={prompt.icon} size={15} /><span>{prompt.label}</span></button>)}
    </div>)}
  </div>;
}

function ChatBranchPicker() {
  return (
    <BranchPickerPrimitive.Root hideWhenSingleBranch className="ds-chat-branch-picker">
      <BranchPickerPrimitive.Previous className="ds-chat-action" aria-label="上一分支"><CaretLeft size={14} /></BranchPickerPrimitive.Previous>
      <span><BranchPickerPrimitive.Number />/<BranchPickerPrimitive.Count /></span>
      <BranchPickerPrimitive.Next className="ds-chat-action" aria-label="下一分支"><CaretRight size={14} /></BranchPickerPrimitive.Next>
    </BranchPickerPrimitive.Root>
  );
}

function ChatActionBar({ assistant = false }: { assistant?: boolean }) {
  return (
    <div className="ds-chat-message-actions">
      <ActionBarPrimitive.Root hideWhenRunning autohide="always" autohideFloat="single-branch" className="ds-chat-action-bar">
        <ActionBarPrimitive.Copy className="ds-chat-action" aria-label="复制"><AuiIf condition={(state) => state.message.isCopied}><Check size={14} /></AuiIf><AuiIf condition={(state) => !state.message.isCopied}><Copy size={14} /></AuiIf></ActionBarPrimitive.Copy>
        {!assistant && <ActionBarPrimitive.Edit className="ds-chat-action" aria-label="编辑"><PencilSimple size={14} /></ActionBarPrimitive.Edit>}
        {assistant && <ActionBarPrimitive.Reload className="ds-chat-action" aria-label="重新生成"><ArrowCounterClockwise size={14} /></ActionBarPrimitive.Reload>}
        {assistant && <ActionBarPrimitive.ExportMarkdown className="ds-chat-action" aria-label="导出 Markdown"><DownloadSimple size={14} /></ActionBarPrimitive.ExportMarkdown>}
      </ActionBarPrimitive.Root>
      <ChatBranchPicker />
    </div>
  );
}

function ChatEditComposer() {
  return (
    <ComposerPrimitive.Root className="ds-chat-edit-composer">
      <ComposerPrimitive.Input aria-label="编辑消息" />
      <div className="ds-chat-edit-composer__actions">
        <ComposerPrimitive.Cancel className="ds-secondary-button">取消</ComposerPrimitive.Cancel>
        <ComposerPrimitive.Send className="ds-primary-button">发送</ComposerPrimitive.Send>
      </div>
    </ComposerPrimitive.Root>
  );
}

function ChatToolCallPart({ part }: { part: ToolCallMessagePart }) {
  const completed = part.result !== undefined && !part.isPreliminary;
  const detail = completed ? (typeof part.result === "string" ? part.result : JSON.stringify(part.result)) : (part.argsText || JSON.stringify(part.args));
  return <div className={`ds-chat-tool-call${completed ? " is-complete" : " is-running"}`}>
    <span className="ds-chat-tool-call__icon"><Icon name={completed ? "check-circle" : "wrench"} size={13} /></span>
    <span className="ds-chat-tool-call__copy"><b>{part.toolName}</b><small>{detail}</small></span>
    <em>{completed ? "完成" : "运行中"}</em>
  </div>;
}

function ChatMessage() {
  const isEditing = useAuiState((state) => state.message.composer.isEditing);
  if (isEditing) return <ChatEditComposer />;
  return (
    <MessagePrimitive.Root className="ds-chat-message">
      <MessagePrimitive.If user>
        <div className="ds-chat-message__user">
          <div className="ds-chat-message__attachments"><MessagePrimitive.Attachments components={{ Attachment: ChatGPTAttachmentUI }} /></div>
          <div className="ds-chat-message__bubble"><MessagePrimitive.Parts /></div>
          <ChatActionBar />
        </div>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <div className="ds-chat-message__assistant">
          <div className="ds-chat-message__content">
            <MessagePrimitive.Parts>{({ part }) => {
              if (part.type === "text") return <MarkdownText />;
              if (part.type === "tool-call") return part.toolUI ?? <ChatToolCallPart part={part} />;
              return null;
            }}</MessagePrimitive.Parts>
          </div>
          <ChatActionBar assistant />
        </div>
      </MessagePrimitive.If>
    </MessagePrimitive.Root>
  );
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(reader.error ?? new Error("无法读取录音"));
    reader.readAsDataURL(blob);
  });
}

function normalizeDataUrlMime(dataUrl: string, mimeType: string) {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return dataUrl;
  return `data:${mimeType};base64,${dataUrl.slice(comma + 1)}`;
}

// The local runtime has no server upload endpoint yet. Keep dropped files in
// the assistant-ui pending queue, including the original File object, and
// only materialize a data URL when the message is sent.
const LocalFileAttachmentAdapter: AttachmentAdapter = {
  accept: "*",
  async add({ file }) {
    return {
      id: `local-file-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "file",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  },
  async send(attachment) {
    const contentType = attachment.contentType || attachment.file.type || "application/octet-stream";
    const dataUrl = normalizeDataUrlMime(await blobToDataUrl(attachment.file), contentType);
    return {
      ...attachment,
      contentType,
      content: [{ type: "file", data: dataUrl, mimeType: contentType, filename: attachment.name }],
      status: { type: "complete" },
    };
  },
  async remove() {
    // Local files are only held in the composer until they are sent or removed.
  },
};

type ComposerInput = ReturnType<typeof unstable_useComposerInput>;

type ComposerGestureHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
};

type VoiceOverlayState = { recording: boolean; cancelZone: boolean; level: number; elapsed: number };

function formatRecordingElapsed(elapsed: number) {
  const totalSeconds = Math.max(0, Math.floor(elapsed / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function VoiceComposerButton({ composer, input, onRegister, onVoiceStateChange }: { composer: ThreadComposerRuntime; input: ComposerInput; onRegister?: (handlers: ComposerGestureHandlers | null) => void; onVoiceStateChange?: (state: VoiceOverlayState) => void }) {
  const [recording, setRecording] = useState(false);
  const [cancelZone, setCancelZone] = useState(false);
  const [voiceLevel, setVoiceLevel] = useState(0);
  const [recordingElapsed, setRecordingElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const chunksRef = useRef<Blob[]>([]);
  const pressingRef = useRef(false);
  const cancelZoneRef = useRef(false);
  const startYRef = useRef(0);
  const suppressClickRef = useRef(false);
  const longPressTimerRef = useRef<number | null>(null);
  const hasText = input.value.trim().length > 0;

  useEffect(() => {
    onVoiceStateChange?.({ recording, cancelZone, level: voiceLevel, elapsed: recordingElapsed });
  }, [cancelZone, onVoiceStateChange, recording, recordingElapsed, voiceLevel]);

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const stopMeter = () => {
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    analyserRef.current = null;
    const audioContext = audioContextRef.current;
    audioContextRef.current = null;
    if (audioContext) void audioContext.close().catch(() => undefined);
    recordingStartedAtRef.current = 0;
  };

  const resetRecording = () => {
    stopMeter();
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
    pressingRef.current = false;
    cancelZoneRef.current = false;
    clearLongPressTimer();
    setRecording(false);
    setCancelZone(false);
    setVoiceLevel(0);
    setRecordingElapsed(0);
  };

  const sendRecording = async (blob: Blob) => {
    try {
      const dataUrl = await blobToDataUrl(blob);
      const contentType = blob.type || "audio/webm";
      const filename = `voice-${Date.now()}.webm`;
      await composer.addAttachment({
        type: "file",
        name: filename,
        contentType,
        content: [{ type: "file", data: dataUrl, mimeType: contentType, filename }],
      });
      composer.send();
    } catch {
      // Local runtime has no attachment adapter by default. Keep the gesture
      // useful in that configuration while leaving text chat unaffected.
      input.setText("语音消息");
      input.send();
    }
  };

  const stopRecording = (cancel: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder) {
      pressingRef.current = false;
      cancelZoneRef.current = false;
      clearLongPressTimer();
      setCancelZone(false);
      return;
    }
    if (recorder.state !== "inactive") {
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        resetRecording();
        if (!cancel && blob.size > 0) void sendRecording(blob);
      };
      recorder.stop();
    } else {
      resetRecording();
    }
  };

  const startRecording = async () => {
    if (!pressingRef.current || recorderRef.current) return;
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      pressingRef.current = false;
      setError("当前设备不支持录音");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!pressingRef.current || cancelZoneRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];
      recorder.ondataavailable = (chunk) => {
        if (chunk.data.size > 0) chunksRef.current.push(chunk.data);
      };
      recorderRef.current = recorder;
      streamRef.current = stream;
      recorder.start();
      recordingStartedAtRef.current = performance.now();
      setRecording(true);
      suppressClickRef.current = true;

      // Use the microphone signal when available. CSS still animates the
      // overlay by time, so a browser without Web Audio remains expressive.
      try {
        const audioContext = new AudioContext();
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 64;
        const source = audioContext.createMediaStreamSource(stream);
        source.connect(analyser);
        audioContextRef.current = audioContext;
        analyserRef.current = analyser;
        audioSourceRef.current = source;
      } catch {
        audioContextRef.current = null;
        analyserRef.current = null;
        audioSourceRef.current = null;
      }

      const meterData = analyserRef.current ? new Uint8Array(analyserRef.current.fftSize) : null;
      const updateMeter = () => {
        if (!recorderRef.current) return;
        const elapsed = performance.now() - recordingStartedAtRef.current;
        setRecordingElapsed(elapsed);
        const analyser = analyserRef.current;
        if (analyser && meterData) {
          analyser.getByteTimeDomainData(meterData);
          let sum = 0;
          for (const sample of meterData) {
            const normalized = (sample - 128) / 128;
            sum += normalized * normalized;
          }
          setVoiceLevel(Math.min(1, Math.sqrt(sum / meterData.length) * 3.5));
        } else {
          setVoiceLevel(0.2 + (Math.sin(elapsed / 130) + 1) * 0.08);
        }
        meterFrameRef.current = window.requestAnimationFrame(updateMeter);
      };
      meterFrameRef.current = window.requestAnimationFrame(updateMeter);
    } catch {
      pressingRef.current = false;
      setError("无法访问麦克风");
    }
  };

  const handlePointerDown = async (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const isMobile = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
    if (hasText || !isMobile || recording || pressingRef.current) return;
    pressingRef.current = true;
    startYRef.current = event.clientY;
    setError(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    await startRecording();
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!pressingRef.current) return;
    const inCancelZone = startYRef.current - event.clientY > 64;
    cancelZoneRef.current = inCancelZone;
    setCancelZone(inCancelZone);
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    clearLongPressTimer();
    pressingRef.current = false;
    stopRecording(cancelZoneRef.current);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handlePointerCancel = () => {
    clearLongPressTimer();
    pressingRef.current = false;
    stopRecording(true);
  };

  const isGestureArea = (event: React.PointerEvent<HTMLElement>) => {
    if (!(event.target instanceof Element)) return true;
    // The whole empty composer is a press-and-hold recording surface. Keep
    // explicit controls (attachment/remove/send) clickable and let the
    // textarea itself participate in the long-press gesture.
    return !event.target.closest("button, select, a, [data-drop-ignore]");
  };

  const handleAreaPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const isMobile = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
    if (!isMobile || hasText || recording || pressingRef.current || !isGestureArea(event)) return;
    pressingRef.current = true;
    startYRef.current = event.clientY;
    cancelZoneRef.current = false;
    setCancelZone(false);
    setError(null);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    clearLongPressTimer();
    longPressTimerRef.current = window.setTimeout(() => {
      longPressTimerRef.current = null;
      void startRecording();
    }, 320);
  };

  const handleAreaPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (!pressingRef.current || !isGestureArea(event)) return;
    const inCancelZone = startYRef.current - event.clientY > 64;
    cancelZoneRef.current = inCancelZone;
    setCancelZone(inCancelZone);
    if (inCancelZone && !recording) clearLongPressTimer();
    if (recording) event.preventDefault();
  };

  const handleAreaPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    if (!isGestureArea(event)) return;
    const wasRecording = recording || recorderRef.current !== null;
    clearLongPressTimer();
    if (wasRecording) event.preventDefault();
    pressingRef.current = false;
    stopRecording(wasRecording && cancelZoneRef.current);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleAreaPointerCancel = (event: React.PointerEvent<HTMLElement>) => {
    if (!isGestureArea(event)) return;
    clearLongPressTimer();
    pressingRef.current = false;
    stopRecording(true);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  useEffect(() => {
    const handlers: ComposerGestureHandlers = {
      onPointerDown: handleAreaPointerDown,
      onPointerMove: handleAreaPointerMove,
      onPointerUp: handleAreaPointerUp,
      onPointerCancel: handleAreaPointerCancel,
    };
    onRegister?.(handlers);
    return () => onRegister?.(null);
  });

  useEffect(() => () => clearLongPressTimer(), []);

  useEffect(() => () => stopMeter(), []);

  const handleClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (hasText) input.send();
  };

  return <button
    type="button"
    className={`ds-send-button ds-composer-send${hasText ? " is-text-ready" : " is-empty"}${recording ? " is-recording" : ""}${cancelZone ? " is-cancel-zone" : ""}`}
    aria-label={error ?? (hasText ? "发送" : recording ? "上滑取消" : "按住说话")}
    title={error ?? (hasText ? "发送" : recording ? "上滑取消" : "按住说话")}
    onClick={handleClick}
    onPointerDown={handlePointerDown}
    onPointerMove={handlePointerMove}
    onPointerUp={handlePointerUp}
    onPointerCancel={handlePointerCancel}
  >
    <Icon name={hasText ? "arrow-up" : cancelZone ? "x" : "microphone"} size={17} strokeWidth={1.9} />
  </button>;
}

type WorkspaceDropState = "idle" | "dragging" | "adding" | "added" | "error";
type WorkspaceDropResult = { added: number; failed: number };
type WorkspaceDropHandler = (files: File[]) => Promise<WorkspaceDropResult>;
type WorkspaceDropContextValue = { registerDropHandler: (handler: WorkspaceDropHandler | null) => () => void };

const WorkspaceDropContext = createContext<WorkspaceDropContextValue | null>(null);

function WorkspaceDropZone({ children }: { children: React.ReactNode }) {
  const [dropState, setDropState] = useState<WorkspaceDropState>("idle");
  const [canDrop, setCanDrop] = useState(false);
  const dropHandlerRef = useRef<WorkspaceDropHandler | null>(null);
  const dragDepthRef = useRef(0);
  const dropFeedbackTimerRef = useRef<number | null>(null);

  const clearDropFeedback = () => {
    if (dropFeedbackTimerRef.current !== null) {
      window.clearTimeout(dropFeedbackTimerRef.current);
      dropFeedbackTimerRef.current = null;
    }
  };
  const showDropFeedback = (state: Exclude<WorkspaceDropState, "idle" | "dragging">) => {
    clearDropFeedback();
    setDropState(state);
    dropFeedbackTimerRef.current = window.setTimeout(() => {
      dropFeedbackTimerRef.current = null;
      setDropState("idle");
    }, 2200);
  };
  const registerDropHandler = (handler: WorkspaceDropHandler | null) => {
    dropHandlerRef.current = handler;
    setCanDrop(handler !== null);
    return () => {
      if (dropHandlerRef.current === handler) {
        dropHandlerRef.current = null;
        setCanDrop(false);
      }
    };
  };
  const hasFiles = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const isExcludedDropTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    return Boolean(target.closest("[data-drop-ignore], button, input, textarea, select, [contenteditable=\"true\"], [role=\"button\"]"));
  };
  const isInsideWorkspace = (event: React.DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    return next instanceof Node && event.currentTarget.contains(next);
  };
  const clearDragStateIfOutside = (event: React.DragEvent<HTMLElement>) => {
    if (isInsideWorkspace(event)) return;
    dragDepthRef.current = 0;
    if (dropState === "dragging") setDropState("idle");
  };
  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    if (isExcludedDropTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      clearDragStateIfOutside(event);
      return;
    }
    event.preventDefault();
    if (isInsideWorkspace(event)) return;
    dragDepthRef.current += 1;
    clearDropFeedback();
    setDropState("dragging");
    event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
  };
  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    if (isExcludedDropTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      clearDragStateIfOutside(event);
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = canDrop ? "copy" : "none";
    if (dropState === "idle") setDropState("dragging");
  };
  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    if (isExcludedDropTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      clearDragStateIfOutside(event);
      return;
    }
    event.preventDefault();
    if (isInsideWorkspace(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0 && dropState === "dragging") setDropState("idle");
  };
  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    if (isExcludedDropTarget(event.target)) {
      event.preventDefault();
      event.stopPropagation();
      dragDepthRef.current = 0;
      if (dropState === "dragging") setDropState("idle");
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    clearDropFeedback();
    const files = Array.from(event.dataTransfer.files);
    const handler = dropHandlerRef.current;
    if (files.length === 0 || handler === null) {
      showDropFeedback("error");
      return;
    }

    setDropState("adding");
    void handler(files).then((result) => {
      showDropFeedback(result.added > 0 ? "added" : "error");
    }).catch(() => {
      showDropFeedback("error");
    });
  };
  useEffect(() => () => clearDropFeedback(), []);

  const contextValue = useMemo<WorkspaceDropContextValue>(() => ({ registerDropHandler }), []);
  return <div
    className="ds-main__content"
    data-drop-state={dropState}
    onDragEnter={handleDragEnter}
    onDragOver={handleDragOver}
    onDragLeave={handleDragLeave}
    onDrop={handleDrop}
  >
    <WorkspaceDropContext.Provider value={contextValue}>{children}</WorkspaceDropContext.Provider>
    {dropState !== "idle" && <div className="ds-workspace-drop-overlay" data-drop-state={dropState} aria-hidden="true"><i className="ds-workspace-drop-overlay__wave ds-workspace-drop-overlay__wave--one" /><i className="ds-workspace-drop-overlay__wave ds-workspace-drop-overlay__wave--two" /><i className="ds-workspace-drop-overlay__wave ds-workspace-drop-overlay__wave--three" /></div>}
  </div>;
}

function ChatComposer({ runtime, outboxStatus = "idle" }: { runtime: ReturnType<typeof useLocalRuntime>; outboxStatus?: OutboxStatus }) {
  const composer = unstable_useComposerInput();
  const hasComposerText = composer.value.trim().length > 0;
  const [voiceState, setVoiceState] = useState<VoiceOverlayState>({ recording: false, cancelZone: false, level: 0, elapsed: 0 });
  const gestureRef = useRef<ComposerGestureHandlers | null>(null);
  const workspaceDrop = useContext(WorkspaceDropContext);
  const registerGesture = (handlers: ComposerGestureHandlers | null) => { gestureRef.current = handlers; };
  const handleAreaPointerDown = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerDown(event);
  const handleAreaPointerMove = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerMove(event);
  const handleAreaPointerUp = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerUp(event);
  const handleAreaPointerCancel = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerCancel(event);
  useEffect(() => {
    if (!workspaceDrop) return;
    const addFiles = async (files: File[]): Promise<WorkspaceDropResult> => {
      if (!runtime.thread.getState().capabilities.attachments) return { added: 0, failed: files.length };
      let added = 0;
      let failed = 0;
      for (const file of files) {
        try {
          await runtime.thread.composer.addAttachment(file);
          added += 1;
        } catch {
          failed += 1;
        }
      }
      return { added, failed };
    };
    return workspaceDrop.registerDropHandler(addFiles);
  }, [runtime, workspaceDrop]);
  const overlayStyle = {
    "--ds-voice-level": voiceState.level.toFixed(3),
    "--ds-voice-elapsed": `${voiceState.elapsed}ms`,
  } as React.CSSProperties;
  return <div className="ds-composer-shell" data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} style={overlayStyle}>
    <div className="ds-voice-wave" aria-hidden="true" />
    <ComposerPrimitive.Root className="ds-composer" compact data-composer-empty={!composer.value.trim()} data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} onPointerDown={handleAreaPointerDown} onPointerMove={handleAreaPointerMove} onPointerUp={handleAreaPointerUp} onPointerCancel={handleAreaPointerCancel}>
      <div className="ds-composer__attachments" aria-label="待发送附件">
        <ComposerPrimitive.Attachments>
          {({ attachment }) => <AttachmentPrimitive.Root className="ds-composer-attachment">
            <AttachmentPrimitive.unstable_Thumb className="ds-composer-attachment__thumb" />
            <span className="ds-composer-attachment__name"><AttachmentPrimitive.Name /></span>
            <small>{attachment.status.type === "requires-action" ? "待发送" : attachment.status.type === "complete" ? "已准备" : "处理失败"}</small>
            <AttachmentPrimitive.Remove className="ds-composer-attachment__remove" aria-label={`移除 ${attachment.name}`}><Icon name="x" size={13} /></AttachmentPrimitive.Remove>
          </AttachmentPrimitive.Root>}
        </ComposerPrimitive.Attachments>
      </div>
      <ComposerPrimitive.AddAttachment className={`ds-composer-tool${hasComposerText ? " is-disabled" : ""}`} disabled={hasComposerText} aria-label={hasComposerText ? "有文本时不可添加附件" : "添加附件"}><Icon name="plus" size={16} /></ComposerPrimitive.AddAttachment>
      <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
      <div className="ds-composer__toolbar">
        <VoiceComposerButton composer={runtime.thread.composer} input={composer} onRegister={registerGesture} onVoiceStateChange={setVoiceState} />
        <span className={`ds-outbox-state is-${outboxStatus}`} aria-live="polite">{outboxStatus === "queued" ? "待发送" : outboxStatus === "sending" ? "发送中…" : outboxStatus === "sent" ? "已保存" : outboxStatus === "failed" ? "发送失败" : ""}</span>
      </div>
    </ComposerPrimitive.Root>
    <div className="ds-voice-recording-status" role="status" aria-live="polite" aria-hidden={!voiceState.recording}>
      <time>{formatRecordingElapsed(voiceState.elapsed)}</time>
      <span>{voiceState.cancelZone ? "松开取消" : "上滑取消"}</span>
    </div>
  </div>;
}

function ChatWorkspace({ session, onSessionChange }: { session: ChatSession; onSessionChange: (patch: Partial<ChatSession>) => void }) {
  const adapter = useMemo(() => createGoRuntimeAdapter({ sessionId: session.id, fallback: StubAdapter }), [session.id]);
  const runtime = useLocalRuntime(adapter, { adapters: { attachments: LocalFileAttachmentAdapter }, initialMessages: restoreMessages(session.messages) as never });
  const [outboxStatus, setOutboxStatus] = useState<OutboxStatus>("idle");
  const [isOnline, setIsOnline] = useState(() => typeof navigator === "undefined" || navigator.onLine);
  const [unread, setUnread] = useState(session.unread);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [messageCount, setMessageCount] = useState(session.messages.length);
  const viewportRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const persistedCountRef = useRef(session.messages.length);
  const unreadRef = useRef(session.unread);

  useEffect(() => {
    const onOnline = () => { setIsOnline(true); setOutboxStatus("idle"); };
    const onOffline = () => { setIsOnline(false); setOutboxStatus("queued"); };
    window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline);
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
        unreadRef.current = nextUnread; setUnread(nextUnread); onSessionChange({ unread: nextUnread });
      }
      const firstUser = messages.find((item) => item.role === "user");
      onSessionChange({ messages, updatedAt: Date.now(), title: session.title === "新会话" ? (messageText(firstUser) || session.title).slice(0, 36) : session.title });
    };
    persist();
    return runtime.thread.subscribe(persist);
  }, [isOnline, onSessionChange, runtime, session.title]);
  const handleScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const viewport = event.currentTarget;
    const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 28;
    isAtBottomRef.current = atBottom; setIsAtBottom(atBottom);
    if (atBottom) { unreadRef.current = 0; setUnread(0); onSessionChange({ unread: 0 }); }
  };
  const jumpToBottom = () => {
    viewportRef.current?.scrollTo({ top: viewportRef.current.scrollHeight, behavior: "smooth" });
    unreadRef.current = 0; setUnread(0); onSessionChange({ unread: 0 });
  };
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="ds-chat-page ds-chatgpt-page" aria-labelledby="chat-welcome-title">
        <ThreadPrimitive.Root className="ds-chat-thread">
          <AuiIf condition={(state) => state.thread.isEmpty}>
            <ThreadPrimitive.Viewport ref={viewportRef} className="ds-thread-viewport" autoScroll turnAnchor="bottom" onScroll={handleScroll}>
              <ThreadPrimitive.Empty>
                <div className="ds-chat-empty-state">
                  <ChatEmptyState />
                  <ChatQuickPrompts />
                </div>
              </ThreadPrimitive.Empty>
            </ThreadPrimitive.Viewport>
            <div className="ds-composer-dock"><ChatComposer runtime={runtime} outboxStatus={outboxStatus} /></div>
          </AuiIf>
          <AuiIf condition={(state) => !state.thread.isEmpty}>
            <ThreadPrimitive.Viewport ref={viewportRef} className="ds-thread-viewport ds-chatgpt-viewport" autoScroll turnAnchor="bottom" onScroll={handleScroll}>
              <div className="ds-timeline-status" aria-live="polite"><span>{messageCount ? `${messageCount} 条消息` : "新会话"}</span>{!isOnline && <span className="ds-outbox-pill is-queued">离线 · 稍后发送</span>}</div>
              <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
              <ThreadPrimitive.ViewportFooter className="ds-composer-dock ds-chatgpt-footer">
                {(!isAtBottom || unread > 0) && <ThreadPrimitive.ScrollToBottom asChild>
                  <button type="button" className="ds-scroll-bottom" aria-label={unread ? `${unread} 条新消息，跳到底部` : "跳到底部"} title={unread ? `${unread} 条新消息` : "跳到底部"}><Icon name="chevron-down" size={15} /></button>
                </ThreadPrimitive.ScrollToBottom>}
                <ChatComposer runtime={runtime} outboxStatus={outboxStatus} />
                <p className="ds-chatgpt-disclaimer">DeepStudent 可能会出错，请核对重要信息</p>
              </ThreadPrimitive.ViewportFooter>
            </ThreadPrimitive.Viewport>
          </AuiIf>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}

type StreamDebugSettings = {
  provider: "siliconflow" | "deepseek" | "openai" | "custom";
  model: string;
  baseUrl: string;
  streamingMode: "events" | "buffered";
  timeout: number;
  retry: number;
};

const streamSettingsStorageKey = "dstu-stream-settings-v1";
const defaultStreamDebugSettings: StreamDebugSettings = {
  provider: "siliconflow",
  model: "DeepSeek-R1-Distill-Qwen-7B",
  baseUrl: "/api/v1",
  streamingMode: "events",
  timeout: 30,
  retry: 2,
};

function readStreamDebugSettings(): StreamDebugSettings {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(streamSettingsStorageKey) ?? "null") as Partial<StreamDebugSettings> | null;
    if (!parsed) return defaultStreamDebugSettings;
    return {
      ...defaultStreamDebugSettings,
      ...parsed,
      provider: parsed.provider === "siliconflow" || parsed.provider === "deepseek" || parsed.provider === "openai" || parsed.provider === "custom" ? parsed.provider : defaultStreamDebugSettings.provider,
      streamingMode: parsed.streamingMode === "buffered" ? "buffered" : "events",
      timeout: Number.isFinite(parsed.timeout) && Number(parsed.timeout) > 0 ? Number(parsed.timeout) : defaultStreamDebugSettings.timeout,
      retry: Number.isFinite(parsed.retry) && Number(parsed.retry) >= 0 ? Number(parsed.retry) : defaultStreamDebugSettings.retry,
    };
  } catch {
    return defaultStreamDebugSettings;
  }
}

function StreamDebugSettingsModal({ draft, onChange, onClose, onSave }: {
  draft: StreamDebugSettings;
  onChange: (patch: Partial<StreamDebugSettings>) => void;
  onClose: () => void;
  onSave: () => void;
}) {
  return <div className="ds-stream-settings-modal" data-drop-ignore="true" role="dialog" aria-modal="true" aria-labelledby="stream-settings-title">
    <button type="button" className="ds-stream-settings-modal__backdrop" aria-label="关闭设置" onClick={onClose} />
    <form className="ds-stream-settings-modal__card" onSubmit={(event) => { event.preventDefault(); onSave(); }}>
      <div className="ds-stream-settings-modal__header"><div><span className="ds-stream-debug__eyebrow"><Icon name="settings" size={14} />运行时设置</span><h3 id="stream-settings-title">LLM 连接配置</h3><p>这些选项只影响当前 playground 对话</p></div><button type="button" className="ds-icon-button" aria-label="关闭设置" onClick={onClose}><Icon name="x" size={16} /></button></div>
      <div className="ds-stream-settings-modal__body">
        <label className="ds-stream-setting-field"><span>Provider</span><select value={draft.provider} onChange={(event) => onChange({ provider: event.target.value as StreamDebugSettings["provider"] })}><option value="siliconflow">SiliconFlow</option><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option><option value="custom">Custom</option></select></label>
        <label className="ds-stream-setting-field"><span>Model</span><input value={draft.model} onChange={(event) => onChange({ model: event.target.value })} /></label>
        <label className="ds-stream-setting-field"><span>Runtime API</span><input value={draft.baseUrl} onChange={(event) => onChange({ baseUrl: event.target.value })} placeholder="/api/v1" /></label>
        <div className="ds-stream-settings-grid"><label className="ds-stream-setting-field"><span>Timeout (s)</span><input type="number" min={1} max={300} value={draft.timeout} onChange={(event) => onChange({ timeout: Math.max(1, Number(event.target.value) || 1) })} /></label><label className="ds-stream-setting-field"><span>Reconnect attempts</span><input type="number" min={0} max={5} value={draft.retry} onChange={(event) => onChange({ retry: Math.max(0, Number(event.target.value) || 0) })} /></label></div>
        <fieldset className="ds-stream-setting-mode"><legend>Streaming mode</legend><label className={draft.streamingMode === "events" ? "is-selected" : ""}><input type="radio" name="stream-mode" value="events" checked={draft.streamingMode === "events"} onChange={() => onChange({ streamingMode: "events" })} /><span><b>事件流</b><small>每个 delta 到达时立即更新回复</small></span></label><label className={draft.streamingMode === "buffered" ? "is-selected" : ""}><input type="radio" name="stream-mode" value="buffered" checked={draft.streamingMode === "buffered"} onChange={() => onChange({ streamingMode: "buffered" })} /><span><b>缓冲</b><small>运行完成后一次性显示回复</small></span></label></fieldset>
      </div>
      <div className="ds-stream-settings-modal__footer"><button type="button" className="ds-secondary-button" onClick={onClose}>取消</button><button type="submit" className="ds-primary-button">保存设置</button></div>
    </form>
  </div>;
}

function StreamDebugPage() {
  const [settings, setSettings] = useState<StreamDebugSettings>(() => readStreamDebugSettings());
  const [settingsDraft, setSettingsDraft] = useState<StreamDebugSettings>(() => readStreamDebugSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sessionIdRef = useRef(`playground-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const adapter = useMemo(() => createGoRuntimeAdapter({
    sessionId: sessionIdRef.current,
    baseUrl: settings.baseUrl,
    provider: settings.provider,
    model: settings.model,
    streamingMode: settings.streamingMode,
    timeoutMs: settings.timeout * 1000,
    reconnectAttempts: settings.retry,
    fallback: StubAdapter,
  }), [settings]);
  const runtime = useLocalRuntime(adapter);
  const openSettings = () => { setSettingsDraft(settings); setSettingsOpen(true); };
  const saveSettings = () => {
    setSettings(settingsDraft);
    window.localStorage.setItem(streamSettingsStorageKey, JSON.stringify(settingsDraft));
    setSettingsOpen(false);
  };

  return <section className="ds-chat-page ds-chatgpt-page ds-playground-page" aria-label="DeepStudent playground">
    <div className="ds-playground-toolbar" role="toolbar" aria-label="对话设置">
      <span className="ds-playground-model">{settings.provider} · {settings.model}</span>
      <button type="button" className="ds-icon-button" onClick={openSettings} aria-label="打开模型设置" title="模型设置"><Icon name="settings" size={16} /></button>
    </div>
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="ds-chat-thread">
        <AuiIf condition={(state) => state.thread.isEmpty}>
          <ThreadPrimitive.Viewport className="ds-thread-viewport" autoScroll turnAnchor="bottom">
            <ThreadPrimitive.Empty><div className="ds-chat-empty-state"><ChatEmptyState /><ChatQuickPrompts /></div></ThreadPrimitive.Empty>
          </ThreadPrimitive.Viewport>
          <div className="ds-composer-dock"><ChatComposer runtime={runtime} /></div>
        </AuiIf>
        <AuiIf condition={(state) => !state.thread.isEmpty}>
          <ThreadPrimitive.Viewport className="ds-thread-viewport ds-chatgpt-viewport" autoScroll turnAnchor="bottom">
            <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            <ThreadPrimitive.ViewportFooter className="ds-composer-dock ds-chatgpt-footer"><ChatComposer runtime={runtime} /><p className="ds-chatgpt-disclaimer">DeepStudent 可能会出错，请核对重要信息</p></ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </AuiIf>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
    {settingsOpen && <StreamDebugSettingsModal draft={settingsDraft} onChange={(patch) => setSettingsDraft((current) => ({ ...current, ...patch }))} onClose={() => setSettingsOpen(false)} onSave={saveSettings} />}
  </section>;
}

function LearningHub() {
  return <WorkspacePage action={<><Icon name="plus" size={14} />添加资源</>}>
    <div className="ds-resource-layout"><aside className="ds-resource-tree"><div className="ds-resource-toolbar"><b>资源库</b><button className="ds-icon-button" aria-label="添加资源">＋</button></div><label className="ds-search-field"><Icon name="search" size={14} /><input placeholder="搜索资源…" /></label><p className="ds-sidebar-empty">暂无资源</p></aside><div className="ds-resource-grid"><EmptyState title="还没有学习资源" description="添加 PDF、Markdown、网页或图片，开始整理你的学习资料" /></div></div>
  </WorkspacePage>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="ds-empty-state"><p><b>{title}</b>，{description}</p></div>;
}

function Todo() { return <WorkspacePage action={<><Icon name="plus" size={14} />新建待办</>}><div className="ds-panel"><EmptyState title="还没有待办事项" description="创建一个待办事项，让下一步学习行动清晰可见" /></div></WorkspacePage>; }
function Skills() { return <WorkspacePage action={<><Icon name="plus" size={14} />添加技能</>}><EmptyState title="还没有可用技能" description="添加技能后，它们会出现在这里" /></WorkspacePage>; }
function Flashcards() { return <WorkspacePage action={<><Icon name="plus" size={14} />新建卡组</>}><EmptyState title="还没有闪卡组" description="创建一个卡组，开始用主动回忆巩固知识" /></WorkspacePage>; }
function Settings({ theme, onTheme, onOpenOnboarding, onClose }: { theme: Theme; onTheme: () => void; onOpenOnboarding: () => void; onClose: () => void }) {
  const [section, setSection] = useState<"general" | "appearance">("general");
  return <div className="ds-settings-modal" data-drop-ignore="true" role="dialog" aria-modal="true" aria-labelledby="settings-title">
    <button type="button" className="ds-settings-modal__backdrop" aria-label="关闭设置" onClick={onClose} />
    <section className="ds-settings-modal__card">
      <header className="ds-settings-modal__header"><div><h2 id="settings-title">设置</h2></div><button type="button" className="ds-icon-button" aria-label="关闭设置" onClick={onClose}><Icon name="x" size={16} /></button></header>
      <div className="ds-settings-modal__body">
        <nav className="ds-settings-nav" aria-label="设置分类">
          <button type="button" className={section === "general" ? "is-active" : ""} onClick={() => setSection("general")}>常规</button>
          <button type="button" className={section === "appearance" ? "is-active" : ""} onClick={() => setSection("appearance")}>外观</button>
          <button type="button" disabled>AI 助手</button><button type="button" disabled>快捷键</button><button type="button" disabled>关于</button>
        </nav>
        <div className="ds-settings-content">
          {section === "general" && <section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新会话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存会话" detail="编辑后立即保存更改" checked /><div className="ds-setting-row ds-setting-row--action"><span><b>学习配置向导</b><small>重新选择学习目标、方式、模型和运行时</small></span><button type="button" className="ds-secondary-button" onClick={onOpenOnboarding}>重新打开</button></div></section>}
          {section === "appearance" && <section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label></section>}
        </div>
      </div>
    </section>
  </div>;
}
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) { return <section className="ds-workspace-page">{action && <div className="ds-page-actions"><button className="ds-primary-button">{action}</button></div>}{children}</section>; }

export function App() {
  const [view, setView] = useState<ViewId>("chat-v2");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [isMobile, setIsMobile] = useState(() => typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboardingConfig, setOnboardingConfig] = useState<OnboardingConfig | null>(() => readOnboardingConfig());
  const [onboardingOpen, setOnboardingOpen] = useState(() => onboardingConfig === null);
  const [sessions, setSessions] = useState<ChatSession[]>(() => readSessions());
  const [activeSessionId, setActiveSessionId] = useState("");
  const [sessionSearch, setSessionSearch] = useState("");

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => {
    const query = window.matchMedia("(max-width: 767px)");
    const onChange = () => setIsMobile(query.matches);
    onChange();
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  useEffect(() => { window.localStorage.setItem(sessionStorageKey, JSON.stringify(sessions)); }, [sessions]);
  useEffect(() => { if (!sessions.some((session) => session.id === activeSessionId) && sessions[0]) setActiveSessionId(sessions[0].id); }, [activeSessionId, sessions]);
  useEffect(() => {
    void HealthService.health().catch(() => undefined);
  }, []);

  const toggleTheme = () => setTheme((current) => current === "dark" ? "light" : "dark");
  const completeOnboarding = (config: Omit<OnboardingConfig, "completedAt">) => {
    const saved = { ...config, completedAt: new Date().toISOString() };
    window.localStorage.setItem(onboardingStorageKey, JSON.stringify(saved));
    setOnboardingConfig(saved);
    setOnboardingOpen(false);
  };
  const openOnboarding = () => setOnboardingOpen(true);
  const selectView = (next: ViewId) => {
    if (next === "settings") {
      setSettingsOpen(true);
      setSidebarOpen(false);
      return;
    }
    setView(next);
    setSettingsOpen(false);
    setSidebarOpen(false);
  };
  const activeSession = sessions.find((session) => session.id === activeSessionId) ?? sessions[0] ?? createSession();
  const updateSession = useCallback((patch: Partial<ChatSession>) => setSessions((current) => current.map((session) => session.id === activeSession.id ? { ...session, ...patch } : session)), [activeSession.id]);
  const newSession = () => { const session = createSession(); setSessions((current) => [session, ...current]); setActiveSessionId(session.id); setView("chat-v2"); setSettingsOpen(false); setSidebarOpen(false); };
  const deleteSession = (sessionId: string) => {
    const remaining = sessions.filter((session) => session.id !== sessionId);
    if (remaining.length === 0) {
      const replacement = createSession();
      setSessions([replacement]);
      setActiveSessionId(replacement.id);
      setView("chat-v2");
      return;
    }
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(remaining[0].id);
      setView("chat-v2");
    }
  };
  const visibleSessions = sessions.filter((session) => !sessionSearch.trim() || session.title.toLocaleLowerCase().includes(sessionSearch.trim().toLocaleLowerCase())).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || b.updatedAt - a.updatedAt);
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace key={activeSession.id} session={activeSession} onSessionChange={updateSession} />;
    if (view === "stream-debug") return <StreamDebugPage />;
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <ChatWorkspace key={activeSession.id} session={activeSession} onSessionChange={updateSession} />;
  }, [activeSession, theme, updateSession, view]);
  const toggleSidebar = () => {
    if (isMobile) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  return <div className="ds-shell" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} data-view={view}>
    <div className="ds-body">
      <aside className="ds-sidebar" data-shell-layer="navigation" data-drop-ignore="true" aria-label="DeepStudent 主入口">
        <div className="ds-sidebar__brand">
          {((isMobile && sidebarOpen) || (!isMobile && !sidebarCollapsed)) && <button className="ds-sidebar-toggle" type="button" onClick={toggleSidebar} aria-label={isMobile ? "关闭导航" : "收起导航"} aria-expanded={isMobile ? sidebarOpen : !sidebarCollapsed}><Icon name="menu" size={16} /></button>}
          <span className="ds-sidebar__brand-name">DeepStudent</span>
          <div className="ds-sidebar__brand-actions">
            <button className="ds-icon-button" type="button" onClick={() => selectView("learning-hub")} aria-label="搜索学习资源"><Icon name="search" size={15} /></button>
          </div>
        </div>
        <nav className="ds-primary-nav" aria-label="主入口">
          {navItems.map((item) => <button key={item.id} className="ds-nav-row" onClick={() => item.id === "chat-v2" ? newSession() : selectView(item.id)} data-active={item.id === view}><span className="ds-nav-icon"><Icon name={item.icon} size={16} /></span><span>{item.label}</span></button>)}
        </nav>
        <div className="ds-sidebar__scroll">
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>置顶</span><button className="ds-section-action" aria-label="收起置顶"><Icon name="chevron-down" size={14} /></button></div><p className="ds-sidebar-empty">暂无置顶会话</p></section>
          <section className="ds-sidebar-section"><div className="ds-section-label"><span>主题</span><span className="ds-section-tools"><button className="ds-section-action" aria-label="收起主题"><Icon name="chevron-down" size={14} /></button><button className="ds-section-action" aria-label="新建主题"><Icon name="plus" size={14} /></button></span></div><p className="ds-sidebar-empty">暂无主题</p></section>
          <section className="ds-sidebar-section ds-conversation-section"><div className="ds-section-label"><span>对话</span><button className="ds-section-action" onClick={newSession} aria-label="新建对话"><Icon name="plus" size={14} /></button></div><label className="ds-conversation-search"><MagnifyingGlass size={13} /><input value={sessionSearch} onChange={(event) => setSessionSearch(event.target.value)} placeholder="搜索会话…" aria-label="搜索会话" /></label>{visibleSessions.length === 0 ? <p className="ds-sidebar-empty">没有匹配的会话</p> : visibleSessions.map((session) => <div key={session.id} className="ds-thread-row" data-active={session.id === activeSession.id}><button type="button" className="ds-thread-row__main" onClick={() => { setActiveSessionId(session.id); setView("chat-v2"); setSidebarOpen(false); setSessions((current) => current.map((item) => item.id === session.id ? { ...item, unread: 0 } : item)); }}><span className={`ds-thread-dot ${session.unread ? "ds-thread-dot--accent" : ""}`}>{session.unread ? "●" : "○"}</span><span>{session.title}</span>{session.unread > 0 && <small>{session.unread}</small>}</button><button type="button" className="ds-thread-row__delete" onClick={() => deleteSession(session.id)} aria-label={`删除会话 ${session.title}`} title="删除会话"><Icon name="x" size={13} /></button></div>)}</section>
        </div>
        <div className="ds-sidebar__footer">
          <button className="ds-nav-row" onClick={() => selectView("settings")} data-active={view === "settings" || settingsOpen}><span className="ds-nav-icon"><Icon name="settings" size={16} /></span><span>设置</span></button>
        </div>
      </aside>
      <button className="ds-overlay" onClick={() => setSidebarOpen(false)} aria-label="关闭导航"></button>
      <main className="ds-main" data-shell-layer="workspace" data-view={view}>
        <div className="ds-main__drag-region" aria-hidden="true" />
        {((isMobile && !sidebarOpen) || (!isMobile && sidebarCollapsed)) && <div className="ds-main__floating-actions" aria-label="工作区导航">
          <button className="ds-sidebar-affordance" type="button" onClick={toggleSidebar} aria-label="打开导航" aria-expanded={isMobile ? sidebarOpen : !sidebarCollapsed}>
            <Icon name="menu" size={17} />
          </button>
        </div>}
        <div className="ds-main__actions" aria-label="窗口操作">
          <button className="ds-icon-button" type="button" onClick={toggleTheme} aria-label="切换主题"><Icon name="sun" size={16} /></button>
        </div>
        <WorkspaceDropZone>{content}</WorkspaceDropZone>
      </main>
    </div>
    {settingsOpen && <Settings theme={theme} onTheme={toggleTheme} onOpenOnboarding={openOnboarding} onClose={() => setSettingsOpen(false)} />}
    {onboardingOpen && <Onboarding initial={onboardingConfig} onComplete={completeOnboarding} />}
  </div>;
}
