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
  AttachmentPrimitive,
} from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  BookOpen,
  Brain,
  Cards,
  CaretDown,
  CheckSquare,
  Gear,
  List,
  MagnifyingGlass,
  Microphone,
  Plus,
  SidebarSimple,
  Sparkle,
  StackSimple,
  Sun,
  X,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import { HealthService } from "./mygo";

type ViewId =
  | "chat-v2"
  | "learning-hub"
  | "todo"
  | "skills-management"
  | "flashcards"
  | "settings";
type Theme = "light" | "dark";

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

type IconName = "sparkle" | "book" | "check" | "sparkle-two" | "cards" | "stack" | "settings" | "plus" | "search" | "sidebar" | "menu" | "chevron-down" | "sun" | "arrow-up" | "microphone" | "x" | "brain";

const navItems: Array<{ id: ViewId; label: string; icon: IconName }> = [
  { id: "chat-v2", label: "新会话", icon: "sparkle" },
  { id: "learning-hub", label: "学习资源", icon: "book" },
  { id: "todo", label: "待办事项", icon: "check" },
  { id: "skills-management", label: "技能管理", icon: "sparkle-two" },
  { id: "flashcards", label: "闪卡", icon: "stack" },
];

const viewTitles: Record<ViewId, string> = {
  "chat-v2": "",
  "learning-hub": "学习资源",
  todo: "待办事项",
  "skills-management": "技能管理",
  flashcards: "闪卡",
  settings: "设置",
};

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
    // Keep regular controls clickable. The textarea and the empty composer
    // surface are the intentional long-press recording targets.
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
    {recording && <span className="ds-voice-status" aria-hidden="true">{cancelZone ? "松开取消" : "松开结束"}</span>}
  </button>;
}

type ComposerDropState = "idle" | "dragging" | "adding" | "added" | "error";

function ChatComposer({ runtime }: { runtime: ReturnType<typeof useLocalRuntime> }) {
  const composer = unstable_useComposerInput();
  const [voiceState, setVoiceState] = useState<VoiceOverlayState>({ recording: false, cancelZone: false, level: 0, elapsed: 0 });
  const [dropState, setDropState] = useState<ComposerDropState>("idle");
  const gestureRef = useRef<ComposerGestureHandlers | null>(null);
  const dragDepthRef = useRef(0);
  const dropFeedbackTimerRef = useRef<number | null>(null);
  const registerGesture = (handlers: ComposerGestureHandlers | null) => { gestureRef.current = handlers; };
  const handleAreaPointerDown = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerDown(event);
  const handleAreaPointerMove = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerMove(event);
  const handleAreaPointerUp = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerUp(event);
  const handleAreaPointerCancel = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerCancel(event);
  const hasFiles = (event: React.DragEvent<HTMLElement>) => Array.from(event.dataTransfer.types).includes("Files");
  const clearDropFeedback = () => {
    if (dropFeedbackTimerRef.current !== null) {
      window.clearTimeout(dropFeedbackTimerRef.current);
      dropFeedbackTimerRef.current = null;
    }
  };
  const showDropFeedback = (state: Exclude<ComposerDropState, "idle" | "dragging">) => {
    clearDropFeedback();
    setDropState(state);
    dropFeedbackTimerRef.current = window.setTimeout(() => {
      dropFeedbackTimerRef.current = null;
      setDropState("idle");
    }, 2200);
  };
  const isInsideComposer = (event: React.DragEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    return next instanceof Node && event.currentTarget.contains(next);
  };
  const handleDragEnter = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!runtime.thread.getState().capabilities.attachments) {
      event.dataTransfer.dropEffect = "none";
      showDropFeedback("error");
      return;
    }
    if (isInsideComposer(event)) return;
    dragDepthRef.current += 1;
    clearDropFeedback();
    setDropState("dragging");
    event.dataTransfer.dropEffect = "copy";
  };
  const handleDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (!runtime.thread.getState().capabilities.attachments) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    if (dropState === "idle") setDropState("dragging");
  };
  const handleDragLeave = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (isInsideComposer(event)) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0 && dropState === "dragging") setDropState("idle");
  };
  const handleDrop = (event: React.DragEvent<HTMLElement>) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    clearDropFeedback();
    const files = Array.from(event.dataTransfer.files);
    if (!runtime.thread.getState().capabilities.attachments || files.length === 0) {
      setDropState("idle");
      return;
    }

    setDropState("adding");
    void (async () => {
      let failed = 0;
      for (const file of files) {
        try {
          await runtime.thread.composer.addAttachment(file);
        } catch {
          failed += 1;
        }
      }
      showDropFeedback(failed === files.length ? "error" : "added");
    })();
  };
  useEffect(() => () => clearDropFeedback(), []);
  const overlayStyle = {
    "--ds-voice-level": voiceState.level.toFixed(3),
    "--ds-voice-elapsed": `${voiceState.elapsed}ms`,
  } as React.CSSProperties;
  const dropStateLabel: Record<Exclude<ComposerDropState, "idle">, string> = {
    dragging: "松开以添加附件",
    adding: "正在加入附件…",
    added: "附件已加入待发送",
    error: "附件未能加入",
  };
  return <ComposerPrimitive.Root className="ds-composer" compact data-composer-empty={!composer.value.trim()} data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} data-drop-state={dropState} onPointerDown={handleAreaPointerDown} onPointerMove={handleAreaPointerMove} onPointerUp={handleAreaPointerUp} onPointerCancel={handleAreaPointerCancel} onDragEnter={handleDragEnter} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
    {dropState !== "idle" && <div className="ds-composer__drop-state" role="status" aria-live="polite">{dropStateLabel[dropState]}</div>}
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
      <div className="ds-voice-overlay__wave">{Array.from({ length: 18 }, (_, index) => <i key={index} style={{ "--ds-voice-bar": index } as React.CSSProperties} />)}</div>
    </div>
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
function Settings({ theme, onTheme, onOpenOnboarding }: { theme: Theme; onTheme: () => void; onOpenOnboarding: () => void }) { return <WorkspacePage><div className="ds-settings-layout"><nav className="ds-settings-nav ds-panel"><button className="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div className="ds-settings-content"><section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新会话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存会话" detail="编辑后立即保存更改" checked /><div className="ds-setting-row ds-setting-row--action"><span><b>学习配置向导</b><small>重新选择学习目标、方式、模型和运行时</small></span><button type="button" className="ds-secondary-button" onClick={onOpenOnboarding}>重新打开</button></div></section><section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label></section></div></div></WorkspacePage>; }
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) { return <section className="ds-workspace-page">{action && <div className="ds-page-actions"><button className="ds-primary-button">{action}</button></div>}{children}</section>; }

export function App() {
  const [view, setView] = useState<ViewId>("chat-v2");
  const [theme, setTheme] = useState<Theme>(() => readTheme());
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
    if (view === "learning-hub") return <LearningHub />;
    if (view === "todo") return <Todo />;
    if (view === "skills-management") return <Skills />;
    if (view === "flashcards") return <Flashcards />;
    return <Settings theme={theme} onTheme={toggleTheme} onOpenOnboarding={openOnboarding} />;
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
        <header className="ds-main__header">
          <div className="ds-main__leading">
            <button className="ds-menu-button" type="button" onClick={toggleSidebar} aria-label="切换边栏" aria-expanded={sidebarOpen || !sidebarCollapsed}><Icon name="menu" size={17} /></button>
            <button className="ds-sidebar-toggle ds-main-sidebar-toggle" type="button" onClick={toggleSidebar} aria-label="展开侧边栏" aria-expanded={!sidebarCollapsed}>
              <Icon name="sidebar" size={16} />
            </button>
          </div>
          {viewTitles[view] && <h1 className="ds-main__title">{viewTitles[view]}</h1>}
          <div className="ds-main__actions"><button className="ds-icon-button" type="button" onClick={toggleTheme} aria-label="切换主题"><Icon name="sun" size={16} /></button></div>
        </header>
        <div className="ds-main__content">{content}</div>
      </main>
    </div>
    {onboardingOpen && <Onboarding initial={onboardingConfig} onComplete={completeOnboarding} />}
  </div>;
}
