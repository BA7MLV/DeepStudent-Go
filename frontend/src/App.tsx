import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useLocalRuntime,
  type AttachmentAdapter,
  type ThreadComposerRuntime,
  type ChatModelAdapter,
  type ToolCallMessagePartProps,
  type ToolCallMessagePart,
  AttachmentPrimitive,
} from "@assistant-ui/react";
import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowCounterClockwise,
  BookOpen,
  Brain,
  Bug,
  Cards,
  CaretDown,
  CheckSquare,
  CheckCircle,
  Gear,
  List,
  MagnifyingGlass,
  Microphone,
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
} from "@phosphor-icons/react";
import { HealthService } from "./mygo";

type ViewId =
  | "chat-v2"
  | "stream-debug"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "flashcards"
  | "settings";
type Theme = "light" | "dark";
type ThemeColor = string;

const themeColorStorageKey = "dstu-theme-color";
const defaultThemeColor: ThemeColor = "#2563eb";
const themeColorPresets: Array<{ value: ThemeColor; label: string }> = [
  { value: "#2563eb", label: "靛蓝" },
  { value: "#0f766e", label: "青绿" },
  { value: "#7c3aed", label: "紫罗兰" },
  { value: "#ea580c", label: "橙色" },
  { value: "#db2777", label: "玫红" },
  { value: "#16a34a", label: "翠绿" },
];

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

const isThemeColor = (value: string): boolean => /^#[0-9a-f]{6}$/i.test(value);

const readThemeColor = (): ThemeColor => {
  const saved = window.localStorage.getItem(themeColorStorageKey);
  return saved && isThemeColor(saved) ? saved : defaultThemeColor;
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

function ChatQuickPrompts() {
  const composer = unstable_useComposerInput();
  const rows = [quickPrompts.slice(0, 3), quickPrompts.slice(3, 5), quickPrompts.slice(5, 7)];
  return <div className="ds-chat-prompts" aria-label="学习场景快捷提示">
    {rows.map((row, index) => <div className={`ds-chat-prompts__row ds-chat-prompts__row--${index + 1}`} key={`prompt-row-${index}`}>
      {row.map((prompt) => <button key={prompt.label} className="ds-chat-prompt" type="button" onClick={() => composer.setText(prompt.label)}><Icon name={prompt.icon} size={15} /><span>{prompt.label}</span></button>)}
    </div>)}
  </div>;
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
    // Keep actionable controls clickable. The textarea and the rest of the
    // composer are intentional long-press recording targets when empty.
    return !event.target.closest("button, input, select, a");
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
    aria-label={error ?? (hasText ? "发送" : cancelZone ? "松开取消录音" : recording ? "松开结束录音" : "按住说话")}
    title={error ?? (hasText ? "发送" : cancelZone ? "松开取消" : recording ? "松开结束" : "按住说话")}
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

  const dropStateLabel: Record<Exclude<WorkspaceDropState, "idle">, string> = {
    dragging: canDrop ? "松开以添加附件" : "当前页面不支持附件",
    adding: "正在加入附件…",
    added: "附件已加入待发送",
    error: "附件未能加入",
  };
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
    {dropState !== "idle" && <div className="ds-workspace-drop-overlay" data-drop-state={dropState} role="status" aria-live="polite"><div className="ds-workspace-drop-overlay__card"><Icon name="stack" size={22} /><b>{dropStateLabel[dropState]}</b><small>{dropState === "dragging" && canDrop ? "文件会保留在当前会话的待发送队列中" : dropState === "adding" ? "正在使用当前附件适配器处理文件" : dropState === "added" ? "发送消息时才会读取文件内容" : "请在支持附件的聊天会话中重试"}</small></div></div>}
  </div>;
}

function ChatComposer({ runtime }: { runtime: ReturnType<typeof useLocalRuntime> }) {
  const composer = unstable_useComposerInput();
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
  return <ComposerPrimitive.Root className="ds-composer" compact data-composer-empty={!composer.value.trim()} data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} onPointerDown={handleAreaPointerDown} onPointerMove={handleAreaPointerMove} onPointerUp={handleAreaPointerUp} onPointerCancel={handleAreaPointerCancel}>
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
    <ComposerPrimitive.AddAttachment className="ds-composer-tool" aria-label="添加附件"><Icon name="plus" size={16} /></ComposerPrimitive.AddAttachment>
    <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
    <div className="ds-composer__toolbar">
      <VoiceComposerButton composer={runtime.thread.composer} input={composer} onRegister={registerGesture} onVoiceStateChange={setVoiceState} />
    </div>
    <div className="ds-voice-overlay" aria-hidden="true" style={overlayStyle}>
      <div className="ds-voice-overlay__wash" />
      <div className="ds-voice-overlay__aurora" />
      <i className="ds-voice-overlay__ripple ds-voice-overlay__ripple--one" />
      <i className="ds-voice-overlay__ripple ds-voice-overlay__ripple--two" />
      <i className="ds-voice-overlay__ripple ds-voice-overlay__ripple--three" />
    </div>
    {voiceState.recording && <div className="ds-voice-recording-status" role="status" aria-live="polite">
      <strong>{voiceState.cancelZone ? "松开取消录音" : "正在录音"}</strong>
      <span>{voiceState.cancelZone ? "上移手指放开以取消" : "松开结束 · 上滑取消"}</span>
      <time aria-hidden="true">{formatRecordingElapsed(voiceState.elapsed)}</time>
    </div>}
  </ComposerPrimitive.Root>;
}

function ChatWorkspace() {
  const runtime = useLocalRuntime(StubAdapter, { adapters: { attachments: LocalFileAttachmentAdapter } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <section className="ds-chat-page" aria-labelledby="chat-welcome-title">
        <ThreadPrimitive.Root className="ds-chat-thread">
          <ThreadPrimitive.Viewport className="ds-thread-viewport" autoScroll>
            <ThreadPrimitive.Messages components={{ Message: ChatMessage }} />
            <ThreadPrimitive.Empty>
              <div className="ds-chat-empty-state">
                <ChatEmptyState />
                <ChatQuickPrompts />
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.ScrollToBottom className="ds-scroll-bottom">↓</ThreadPrimitive.ScrollToBottom>
          </ThreadPrimitive.Viewport>
          <div className="ds-composer-dock"><ChatComposer runtime={runtime} /></div>
        </ThreadPrimitive.Root>
      </section>
    </AssistantRuntimeProvider>
  );
}

type StreamStatus = "idle" | "running" | "paused" | "complete";
type StreamCodeLanguage = "javascript" | "json" | "go" | "python";
type StreamEventKind = "run" | "token" | "tool" | "render" | "status";
type StreamEvent = { id: number; kind: StreamEventKind; label: string; detail: string; tone?: "running" | "complete" | "paused" };
type StreamDebugSettings = {
  provider: "siliconflow" | "deepseek" | "custom";
  model: string;
  baseUrl: string;
  streaming: boolean;
  timeout: number;
  retry: number;
  mode: "simulation" | "real";
  showEventLog: boolean;
};

const defaultStreamDebugSettings: StreamDebugSettings = {
  provider: "siliconflow",
  model: "DeepSeek-R1-Distill-Qwen-7B",
  baseUrl: "https://api.siliconflow.cn/v1",
  streaming: true,
  timeout: 30,
  retry: 1,
  mode: "simulation",
  showEventLog: true,
};

type StreamControl = {
  paused: boolean;
  generation: number;
  waiters: Array<() => void>;
};

const streamCode: Record<StreamCodeLanguage, string> = {
  javascript: `const stream = async function* () {\n  for (const token of tokens) {\n    yield token;\n    await wait(120);\n  }\n};`,
  json: `{"event":"token","index":7,"value":"规划","done":false}`,
  go: `for _, token := range tokens {\n    fmt.Fprint(writer, token)\n    writer.Flush()\n    time.Sleep(120 * time.Millisecond)\n}`,
  python: `async for token in response.aiter_tokens():\n    print(token, end="", flush=True)\n    await asyncio.sleep(0.12)`,
};

const streamCodeLabels: Record<StreamCodeLanguage, string> = {
  javascript: "JS",
  json: "JSON",
  go: "Go",
  python: "Python",
};

const streamResponseTokens = [
  "我先把你的问题拆成几个小步骤。",
  "接着读取本地示例上下文，",
  "再把结果整理成可以继续追问的回复。",
  "整个过程只在浏览器中运行，",
  "你可以随时暂停、继续或清空这次对话。",
];

const streamDelay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) {
    reject(new DOMException("Stream cancelled", "AbortError"));
    return;
  }
  const timer = window.setTimeout(() => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    window.clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    reject(new DOMException("Stream cancelled", "AbortError"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
});

const streamWaitForResume = (control: StreamControl, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (!control.paused) {
    resolve();
    return;
  }
  const onAbort = () => {
    control.waiters = control.waiters.filter((waiter) => waiter !== resume);
    reject(new DOMException("Stream cancelled", "AbortError"));
  };
  const resume = () => {
    signal.removeEventListener("abort", onAbort);
    resolve();
  };
  control.waiters.push(resume);
  signal.addEventListener("abort", onAbort, { once: true });
});

function StreamToolPart({ toolName, args, result, isPreliminary }: ToolCallMessagePartProps) {
  const isDone = result !== undefined && !isPreliminary;
  return <div className={`ds-stream-tool-event${isDone ? " is-complete" : " is-running"}`}>
    <span className="ds-stream-tool-event__icon"><Icon name={isDone ? "check-circle" : "wrench"} size={14} /></span>
    <span className="ds-stream-tool-event__copy"><b>{toolName === "local_context" ? "读取本地上下文" : "本地工具调用"}</b><small>{isDone ? `完成 · ${String(result)}` : `进行中 · ${JSON.stringify(args)}`}</small></span>
    <em>{isDone ? "完成" : "运行中"}</em>
  </div>;
}

function StreamMessageText() {
  return <MessagePartPrimitive.Text component="span" smooth />;
}

function StreamDebugMessage() {
  const parts = { Text: StreamMessageText, tools: { Fallback: StreamToolPart } };
  return <MessagePrimitive.Root className="ds-stream-message">
    <MessagePrimitive.If user><div className="ds-stream-message__bubble ds-stream-message__bubble--user"><span className="ds-stream-message__role">你</span><MessagePrimitive.Parts components={parts} /></div></MessagePrimitive.If>
    <MessagePrimitive.If assistant><div className="ds-stream-message__bubble ds-stream-message__bubble--assistant"><span className="ds-stream-message__role">DeepStudent · 本地仿真</span><MessagePrimitive.Parts components={parts} /></div></MessagePrimitive.If>
  </MessagePrimitive.Root>;
}

function StreamDebugComposer() {
  return <ComposerPrimitive.Root className="ds-stream-composer">
    <ComposerPrimitive.Input rows={1} placeholder="在本地仿真 Chat 中继续提问…" aria-label="输入调试消息" />
    <ComposerPrimitive.Send className="ds-stream-composer__send" aria-label="发送消息"><Icon name="arrow-up" size={16} /></ComposerPrimitive.Send>
  </ComposerPrimitive.Root>;
}

function StreamDebugPage() {
  const controlRef = useRef<StreamControl>({ paused: false, generation: 0, waiters: [] });
  const eventSequenceRef = useRef(0);
  const eventSinkRef = useRef<(event: Omit<StreamEvent, "id">) => void>(() => undefined);
  const [status, setStatus] = useState<StreamStatus>("idle");
  const [events, setEvents] = useState<StreamEvent[]>([]);
  const [codeLanguage, setCodeLanguage] = useState<StreamCodeLanguage>("javascript");
  const [progress, setProgress] = useState(0);
  const [settings, setSettings] = useState<StreamDebugSettings>(defaultStreamDebugSettings);
  const [settingsDraft, setSettingsDraft] = useState<StreamDebugSettings>(defaultStreamDebugSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const adapter = useMemo<ChatModelAdapter>(() => ({
    async *run({ messages, abortSignal }) {
      const currentGeneration = controlRef.current.generation;
      const latest = messages.at(-1);
      const prompt = latest?.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join(" ").trim() || "这个本地仿真是怎么工作的？";
      const emit = (event: Omit<StreamEvent, "id">) => eventSinkRef.current(event);
      const responseTokens = [`收到你的问题「${prompt}」。`, ...streamResponseTokens];
      const toolCallId = `local-context-${currentGeneration}-${Date.now()}`;
      const toolArgs = { query: prompt.slice(0, 72) };
      let settledToolCall: ToolCallMessagePart | undefined;
      let response = "";
      emit({ kind: "run", label: "run.start", detail: "本地仿真模型开始生成" , tone: "running" });
      setProgress(0);
      setStatus("running");
      for (let index = 0; index < responseTokens.length; index += 1) {
        await streamWaitForResume(controlRef.current, abortSignal);
        await streamDelay(index === 0 ? 220 : 155, abortSignal);
        response += responseTokens[index];
        emit({ kind: "token", label: `token.${index + 1}`, detail: responseTokens[index], tone: "running" });
        setProgress((index + 1) / (responseTokens.length + 1));
        if (index === 1) {
          emit({ kind: "tool", label: "tool.start · local_context", detail: "查找本地示例上下文", tone: "running" });
          yield { content: [{ type: "text", text: response }, { type: "tool-call", toolCallId, toolName: "local_context", args: toolArgs, argsText: JSON.stringify(toolArgs), isPreliminary: true }] };
          await streamWaitForResume(controlRef.current, abortSignal);
          await streamDelay(420, abortSignal);
          emit({ kind: "tool", label: "tool.end · local_context", detail: "已返回 2 个本地示例", tone: "complete" });
          settledToolCall = { type: "tool-call", toolCallId, toolName: "local_context", args: toolArgs, argsText: JSON.stringify(toolArgs), result: "2 个本地示例", isPreliminary: false };
          yield { content: [{ type: "text", text: response }, settledToolCall] };
          setProgress((index + 1.6) / (responseTokens.length + 1));
        } else {
          yield { content: settledToolCall ? [{ type: "text", text: response }, settledToolCall] : [{ type: "text", text: response }] };
        }
        emit({ kind: "render", label: "render.sync", detail: "消息、事件和 SVG 已同步", tone: "running" });
      }
      await streamWaitForResume(controlRef.current, abortSignal);
      setProgress(1);
      emit({ kind: "status", label: "run.complete", detail: "本地仿真流已完成", tone: "complete" });
      setStatus("complete");
      const finalToolPart = settledToolCall ?? { type: "tool-call" as const, toolCallId, toolName: "local_context", args: toolArgs, argsText: JSON.stringify(toolArgs), result: "2 个本地示例", isPreliminary: false };
      yield { content: [{ type: "text", text: response }, finalToolPart, { type: "text", text: "\n\n以上回复来自本地事件流仿真，不会调用真实 API。" }], status: { type: "complete", reason: "stop" } };
    },
  }), []);
  const runtime = useLocalRuntime(adapter);

  const pushEvent = (event: Omit<StreamEvent, "id">) => {
    eventSequenceRef.current += 1;
    setEvents((current) => [...current.slice(-39), { ...event, id: eventSequenceRef.current }]);
  };
  eventSinkRef.current = pushEvent;

  const openSettings = () => {
    setSettingsDraft(settings);
    setSettingsOpen(true);
  };
  const saveSettings = () => {
    setSettings(settingsDraft);
    setSettingsOpen(false);
  };

  const resetStream = () => {
    controlRef.current.generation += 1;
    controlRef.current.paused = false;
    controlRef.current.waiters.splice(0).forEach((resume) => resume());
    runtime.thread.cancelRun();
    runtime.thread.reset();
    setStatus("idle");
    setEvents([]);
    setProgress(0);
  };
  const pauseStream = () => {
    if (status !== "running") return;
    controlRef.current.paused = true;
    setStatus("paused");
    pushEvent({ kind: "status", label: "run.pause", detail: "等待继续输出", tone: "paused" });
  };
  const resumeStream = () => {
    if (status !== "paused") return;
    controlRef.current.paused = false;
    controlRef.current.waiters.splice(0).forEach((resume) => resume());
    setStatus("running");
    pushEvent({ kind: "status", label: "run.resume", detail: "继续本地事件流", tone: "running" });
  };

  const statusLabel: Record<StreamStatus, string> = { idle: "等待输入", running: "模型生成中", paused: "已暂停", complete: "已完成" };
  const svgProgress = Math.min(1, progress);

  return <section className="ds-workspace-page ds-stream-debug-page" aria-labelledby="stream-debug-title">
    <div className="ds-stream-debug__heading">
      <div><div className="ds-stream-debug__eyebrow"><Icon name="bug" size={14} />前端调试工具</div><h2 id="stream-debug-title">调试流式输出</h2><p>真实消息状态 + 可观察的本地事件流</p></div>
      <span className="ds-stream-sim-badge"><span className="ds-stream-sim-badge__dot" />本地仿真流 · 不连接真实 API</span>
    </div>
    <div className="ds-stream-debug__toolbar" role="toolbar" aria-label="流式输出控制">
      <span className={`ds-stream-status ds-stream-status--${status}`}><span className="ds-stream-status__dot" />{statusLabel[status]}</span>
      <span className="ds-stream-model-status">{settings.mode === "simulation" ? "本地仿真" : "真实 API（尚未接入，仍本地仿真）"} · {settings.provider} / {settings.model}</span>
      <button type="button" className="ds-secondary-button" onClick={status === "paused" ? resumeStream : pauseStream} disabled={status !== "running" && status !== "paused"}><Icon name={status === "paused" ? "play" : "pause"} size={14} />{status === "paused" ? "继续" : "暂停"}</button>
      <button type="button" className="ds-secondary-button" onClick={resetStream} disabled={status === "idle" && events.length === 0}><Icon name="reset" size={14} />清空 / 重置</button>
      <button type="button" className="ds-icon-button ds-stream-settings-trigger" onClick={openSettings} aria-label="打开流式调试设置" title="流式调试设置"><Icon name="settings" size={16} /></button>
    </div>

    <div className="ds-stream-chat-layout">
      <section className="ds-stream-chat-panel" aria-label="本地仿真 Chat">
        <div className="ds-stream-chat-panel__header"><div><b>本地仿真 Chat</b><p>输入消息，回复会逐段进入对话</p></div><span className="ds-stream-mini-label">ASSISTANT-UI</span></div>
        <AssistantRuntimeProvider runtime={runtime}>
          <ThreadPrimitive.Root className="ds-stream-thread">
            <ThreadPrimitive.Viewport className="ds-stream-thread__viewport" autoScroll>
              <ThreadPrimitive.Messages components={{ Message: StreamDebugMessage }} />
              <ThreadPrimitive.Empty><div className="ds-stream-thread__empty"><Sparkle size={20} /><b>开始一次可暂停的本地仿真</b><p>试着问“解释一下事件流”，然后观察消息、工具事件和右侧日志同步变化</p></div></ThreadPrimitive.Empty>
            </ThreadPrimitive.Viewport>
            <div className="ds-stream-composer-dock"><StreamDebugComposer /></div>
          </ThreadPrimitive.Root>
        </AssistantRuntimeProvider>
      </section>

      <aside className="ds-stream-inspector" aria-label="流式事件检查器">
        {settings.showEventLog && <section className="ds-panel ds-stream-event-panel"><div className="ds-panel-heading"><div><b>Event log</b><p>与消息渲染同步的本地事件</p></div><span className="ds-stream-counter">{events.length} events</span></div><ol className="ds-stream-event-log">{events.length === 0 ? <li className="ds-stream-event-log__empty">发送一条消息后，这里会实时出现 run、token、tool 和 render 事件</li> : events.map((event) => <li key={event.id} className={`ds-stream-event-log__item${event.tone ? ` is-${event.tone}` : ""}`}><span className="ds-stream-event-log__dot" /><span><b>{event.label}</b><small>{event.detail}</small></span></li>)}</ol></section>}
        <section className="ds-panel ds-stream-drawing-panel"><div className="ds-panel-heading"><div><b>SVG stroke</b><p>由同一进度驱动逐步绘制</p></div><span className="ds-stream-progress">{Math.round(svgProgress * 100)}%</span></div><div className="ds-stream-svg-wrap"><svg className="ds-stream-svg" viewBox="0 0 280 150" role="img" aria-label={`SVG 绘制进度 ${Math.round(svgProgress * 100)}%`}><path className="ds-stream-svg__guide" d="M24 111 C56 28 91 28 121 88 S183 142 208 71 S247 24 266 52" /><path className="ds-stream-svg__path" pathLength="1" d="M24 111 C56 28 91 28 121 88 S183 142 208 71 S247 24 266 52" style={{ strokeDasharray: 1, strokeDashoffset: 1 - svgProgress }} /><circle className="ds-stream-svg__endpoint" cx={24 + svgProgress * 242} cy={111 - Math.sin(svgProgress * Math.PI) * 62} r="4" /></svg><div className="ds-stream-svg-wrap__caption"><Icon name="wrench" size={13} />render.sync 驱动 stroke-dashoffset</div></div></section>
        <section className="ds-panel ds-stream-code-panel"><div className="ds-panel-heading"><div><b>事件载荷示例</b><p>同一事件的多语言实现</p></div></div><div className="ds-stream-code-tabs" role="tablist" aria-label="代码语言">{(Object.keys(streamCode) as StreamCodeLanguage[]).map((language) => <button key={language} type="button" role="tab" aria-selected={codeLanguage === language} className={codeLanguage === language ? "is-active" : ""} onClick={() => setCodeLanguage(language)}>{streamCodeLabels[language]}</button>)}</div><pre className="ds-stream-code-block"><code>{streamCode[codeLanguage]}</code></pre></section>
      </aside>
    </div>
    {settingsOpen && <div className="ds-stream-settings-modal" data-drop-ignore="true" role="dialog" aria-modal="true" aria-labelledby="stream-settings-title">
      <button type="button" className="ds-stream-settings-modal__backdrop" aria-label="关闭设置" onClick={() => setSettingsOpen(false)} />
      <form className="ds-stream-settings-modal__card" onSubmit={(event) => { event.preventDefault(); saveSettings(); }}>
        <div className="ds-stream-settings-modal__header"><div><span className="ds-stream-debug__eyebrow"><Icon name="settings" size={14} />调试设置</span><h3 id="stream-settings-title">流式模型配置</h3><p>当前页面默认只运行本地仿真，不会发送到远端 API</p></div><button type="button" className="ds-icon-button" aria-label="关闭设置" onClick={() => setSettingsOpen(false)}><Icon name="x" size={16} /></button></div>
        <div className="ds-stream-settings-modal__body">
          <label className="ds-stream-setting-field"><span>Provider</span><select value={settingsDraft.provider} onChange={(event) => setSettingsDraft((current) => ({ ...current, provider: event.target.value as StreamDebugSettings["provider"] }))}><option value="siliconflow">SiliconFlow</option><option value="deepseek">DeepSeek</option><option value="custom">Custom</option></select></label>
          <label className="ds-stream-setting-field"><span>Model</span><input value={settingsDraft.model} onChange={(event) => setSettingsDraft((current) => ({ ...current, model: event.target.value }))} /></label>
          <label className="ds-stream-setting-field"><span>Base URL</span><input value={settingsDraft.baseUrl} onChange={(event) => setSettingsDraft((current) => ({ ...current, baseUrl: event.target.value }))} /></label>
          <div className="ds-stream-settings-grid"><label className="ds-stream-setting-field"><span>Timeout (s)</span><input type="number" min={1} max={300} value={settingsDraft.timeout} onChange={(event) => setSettingsDraft((current) => ({ ...current, timeout: Number(event.target.value) || 1 }))} /></label><label className="ds-stream-setting-field"><span>Retry</span><input type="number" min={0} max={5} value={settingsDraft.retry} onChange={(event) => setSettingsDraft((current) => ({ ...current, retry: Number(event.target.value) || 0 }))} /></label></div>
          <label className="ds-stream-setting-check"><input type="checkbox" checked={settingsDraft.streaming} onChange={(event) => setSettingsDraft((current) => ({ ...current, streaming: event.target.checked }))} /><span><b>Streaming</b><small>按事件流逐段更新 assistant message</small></span></label>
          <label className="ds-stream-setting-check"><input type="checkbox" checked={settingsDraft.showEventLog} onChange={(event) => setSettingsDraft((current) => ({ ...current, showEventLog: event.target.checked }))} /><span><b>显示 Event log</b><small>在右侧展示与消息同步的事件</small></span></label>
          <fieldset className="ds-stream-setting-mode"><legend>运行模式</legend><label className={settingsDraft.mode === "simulation" ? "is-selected" : ""}><input type="radio" name="stream-mode" value="simulation" checked={settingsDraft.mode === "simulation"} onChange={() => setSettingsDraft((current) => ({ ...current, mode: "simulation" }))} /><span><b>本地仿真</b><small>推荐 · 不调用真实 API</small></span></label><label className={settingsDraft.mode === "real" ? "is-selected" : ""}><input type="radio" name="stream-mode" value="real" checked={settingsDraft.mode === "real"} onChange={() => setSettingsDraft((current) => ({ ...current, mode: "real" }))} /><span><b>真实 API</b><small>尚未接入，保存后仍保持本地仿真</small></span></label></fieldset>
        </div>
        <div className="ds-stream-settings-modal__footer"><button type="button" className="ds-secondary-button" onClick={() => setSettingsOpen(false)}>取消</button><button type="submit" className="ds-primary-button">保存设置</button></div>
      </form>
    </div>}
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
function Settings({ theme, onTheme, themeColor, onThemeColor, onOpenOnboarding }: { theme: Theme; onTheme: () => void; themeColor: ThemeColor; onThemeColor: (color: ThemeColor) => void; onOpenOnboarding: () => void }) {
  const [themeColorDraft, setThemeColorDraft] = useState(themeColor);
  useEffect(() => setThemeColorDraft(themeColor), [themeColor]);
  const saveThemeColor = () => onThemeColor(isThemeColor(themeColorDraft) ? themeColorDraft : defaultThemeColor);

  return <WorkspacePage><div className="ds-settings-layout"><nav className="ds-settings-nav ds-panel"><button className="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div className="ds-settings-content"><section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新会话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存会话" detail="编辑后立即保存更改" checked /><div className="ds-setting-row ds-setting-row--action"><span><b>学习配置向导</b><small>重新选择学习目标、方式、模型和运行时</small></span><button type="button" className="ds-secondary-button" onClick={onOpenOnboarding}>重新打开</button></div></section><section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label><div className="ds-theme-color-setting"><div className="ds-theme-color-setting__heading"><span><b>主题色</b><small>用于按钮、焦点、标题和录音波形</small></span><span className="ds-theme-color-preview"><i style={{ backgroundColor: themeColorDraft }} aria-hidden="true" /><code>{themeColorDraft.toUpperCase()}</code></span></div><div className="ds-theme-color-presets" role="group" aria-label="主题色预设"><span className="ds-theme-color-presets__label">预设</span>{themeColorPresets.map((preset) => <button key={preset.value} type="button" className={`ds-theme-color-swatch${themeColorDraft.toLowerCase() === preset.value ? " is-selected" : ""}`} style={{ backgroundColor: preset.value }} aria-label={`选择${preset.label}主题色`} aria-pressed={themeColorDraft.toLowerCase() === preset.value} onClick={() => setThemeColorDraft(preset.value)} />)}</div><label className="ds-theme-color-custom"><span>自定义颜色</span><input type="color" value={themeColorDraft} onChange={(event) => setThemeColorDraft(event.target.value)} aria-label="自定义主题色" /></label><div className="ds-theme-color-actions"><button type="button" className="ds-text-button" onClick={() => setThemeColorDraft(themeColor)}>取消</button><button type="button" className="ds-text-button" onClick={() => setThemeColorDraft(defaultThemeColor)}>恢复默认</button><button type="button" className="ds-primary-button" onClick={saveThemeColor} disabled={themeColorDraft.toLowerCase() === themeColor.toLowerCase()}>保存主题色</button></div></div></section></div></div></WorkspacePage>;
}
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) { return <section className="ds-workspace-page">{action && <div className="ds-page-actions"><button className="ds-primary-button">{action}</button></div>}{children}</section>; }

export function App() {
  const [view, setView] = useState<ViewId>("chat-v2");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [themeColor, setThemeColor] = useState<ThemeColor>(() => readThemeColor());
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [onboardingConfig, setOnboardingConfig] = useState<OnboardingConfig | null>(() => readOnboardingConfig());
  const [onboardingOpen, setOnboardingOpen] = useState(() => onboardingConfig === null);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem("dstu-theme-mode", theme);
  }, [theme]);
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ds-accent", themeColor);
    root.style.setProperty("--ds-focus", themeColor);
    root.style.setProperty("--ds-title-accent", themeColor);
    root.style.setProperty("--ds-voice-color", themeColor);
    window.localStorage.setItem(themeColorStorageKey, themeColor);
  }, [themeColor]);
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
  const selectView = (next: ViewId) => { setView(next); setSidebarOpen(false); };
  const content = useMemo(() => {
    if (view === "chat-v2") return <ChatWorkspace />;
    if (view === "stream-debug") return <StreamDebugPage />;
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <Settings theme={theme} onTheme={toggleTheme} themeColor={themeColor} onThemeColor={setThemeColor} onOpenOnboarding={openOnboarding} />;
  }, [theme, themeColor, view]);
  const toggleSidebar = () => {
    if (window.matchMedia("(max-width: 767px)").matches) {
      setSidebarOpen((open) => !open);
      return;
    }
    setSidebarCollapsed((collapsed) => !collapsed);
  };

  return <div className="ds-shell" data-sidebar-open={sidebarOpen} data-sidebar-collapsed={sidebarCollapsed} data-view={view}>
    <div className="ds-body">
      <aside className="ds-sidebar" data-shell-layer="navigation" data-drop-ignore="true" aria-label="DeepStudent 主入口">
        <div className="ds-sidebar__brand">
          <span className="ds-sidebar__brand-name">DeepStudent</span>
          <div className="ds-sidebar__brand-actions">
            <button className="ds-icon-button" type="button" onClick={() => selectView("learning-hub")} aria-label="搜索学习资源"><Icon name="search" size={15} /></button>
            <button className="ds-sidebar-toggle" type="button" onClick={toggleSidebar} aria-label="收起侧边栏"><Icon name="sidebar" size={16} /></button>
          </div>
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
        <div className="ds-main__drag-region" aria-hidden="true" />
        <div className="ds-main__floating-actions" aria-label="窗口与工作区操作">
          <button className="ds-sidebar-affordance" type="button" onClick={toggleSidebar} aria-label="打开导航" aria-expanded={sidebarOpen || !sidebarCollapsed}>
            <Icon name="sidebar" size={17} />
          </button>
          <div className="ds-main__actions">
            <button className="ds-icon-button" type="button" onClick={toggleTheme} aria-label="切换主题"><Icon name="sun" size={16} /></button>
          </div>
        </div>
        <WorkspaceDropZone>{content}</WorkspaceDropZone>
      </main>
    </div>
    {onboardingOpen && <Onboarding initial={onboardingConfig} onComplete={completeOnboarding} />}
  </div>;
}
