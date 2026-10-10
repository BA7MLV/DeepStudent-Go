import { useEffect, useMemo, useRef, useState } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  unstable_useComposerInput,
  useLocalRuntime,
  type ThreadComposerRuntime,
  type ChatModelAdapter,
} from "@assistant-ui/react";
import { createGoRuntimeAdapter } from "../go-runtime";
import { ResourceLibrary, type ResourceQuestion } from "../ResourceLibrary";
import { Icon } from "../components/Icon";
import { quickPrompts } from "../routes";
import type { Theme } from "../routes";
import type React from "react";

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
  const rows = [quickPrompts.slice(0, 3), quickPrompts.slice(3, 5), quickPrompts.slice(5, 6), quickPrompts.slice(6)];
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

/**
 * Small canvas visualizer for the mobile recording surface. The recorder's
 * analyser already publishes a normalized live level; this renderer turns it
 * into layered liquid wave fronts without adding a second audio graph or a
 * heavyweight dependency.
 */
function VoiceWaveformCanvas({ level, active }: { level: number; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const levelRef = useRef(level);

  useEffect(() => {
    levelRef.current = level;
  }, [level]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let frame = 0;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let phase = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    const draw = () => {
      if (!width || !height) resize();
      context.clearRect(0, 0, width, height);
      const level = Math.max(0, Math.min(1, levelRef.current));
      const color = getComputedStyle(canvas).getPropertyValue("--ds-voice-color").trim() || "#2563eb";
      const baseline = Math.max(22, height - 26);
      const amplitude = 8 + level * Math.min(88, height * .3);
      const layers = [
        { speed: 1, frequency: .012, alpha: .16 + level * .26, offset: 0 },
        { speed: -.7, frequency: .017, alpha: .1 + level * .2, offset: 10 },
        { speed: .45, frequency: .008, alpha: .08 + level * .14, offset: 20 },
      ];
      for (let layer = 0; layer < layers.length; layer += 1) {
        const { speed, frequency, alpha, offset } = layers[layer];
        const localAmplitude = amplitude * (1 - layer * .18);
        context.beginPath();
        context.moveTo(0, height);
        context.lineTo(0, baseline - offset);
        for (let x = 0; x <= width; x += 6) {
          const envelope = .68 + .32 * Math.sin(x * .003 + phase * .12 + layer);
          const y = baseline - offset - Math.sin(x * frequency + phase * speed + layer * 1.6) * localAmplitude * envelope;
          context.lineTo(x, y);
        }
        context.lineTo(width, height);
        context.closePath();
        context.fillStyle = color;
        context.globalAlpha = Math.min(.7, alpha);
        context.fill();
        context.beginPath();
        context.moveTo(0, baseline - offset);
        for (let x = 0; x <= width; x += 6) {
          const y = baseline - offset - Math.sin(x * frequency + phase * speed + layer * 1.6) * localAmplitude * (.68 + .32 * Math.sin(x * .003 + phase * .12 + layer));
          context.lineTo(x, y);
        }
        context.strokeStyle = color;
        context.globalAlpha = Math.min(.58, alpha + .12);
        context.lineWidth = 1 + level * 1.2;
        context.stroke();
      }
      context.globalAlpha = 1;
      phase += .045 + level * .06;
      frame = window.requestAnimationFrame(draw);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resize);
    observer?.observe(canvas);
    resize();
    if (active) frame = window.requestAnimationFrame(draw);
    return () => {
      observer?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  }, [active]);

  return <canvas ref={canvasRef} className="ds-voice-waveform" aria-hidden="true" />;
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

      // Keep the recording surface expressive even when Web Audio is not
      // available. The CSS overlay falls back to elapsed-time animation.
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
    // The whole empty composer is the long-press surface, including the
    // textarea itself. Keep only actionable controls out of the gesture so
    // attachment/send buttons retain their normal click behavior.
    return !event.target.closest("button, select, a, [role=button], [data-voice-control]");
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

  useEffect(() => () => {
    clearLongPressTimer();
    stopMeter();
  }, []);

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

function ChatComposer({ runtime }: { runtime: ReturnType<typeof useLocalRuntime> }) {
  const composer = unstable_useComposerInput();
  const hasComposerText = composer.value.trim().length > 0;
  const [voiceState, setVoiceState] = useState<VoiceOverlayState>({ recording: false, cancelZone: false, level: 0, elapsed: 0 });
  const gestureRef = useRef<ComposerGestureHandlers | null>(null);
  const registerGesture = (handlers: ComposerGestureHandlers | null) => { gestureRef.current = handlers; };
  const handleAreaPointerDown = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerDown(event);
  const handleAreaPointerMove = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerMove(event);
  const handleAreaPointerUp = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerUp(event);
  const handleAreaPointerCancel = (event: React.PointerEvent<HTMLElement>) => gestureRef.current?.onPointerCancel(event);
  const overlayStyle = {
    "--ds-voice-level": voiceState.level.toFixed(3),
    "--ds-voice-elapsed": `${voiceState.elapsed}ms`,
  } as React.CSSProperties;
  return <div className="ds-composer-shell" data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} style={overlayStyle}>
    <div className="ds-voice-wave" aria-hidden="true"><VoiceWaveformCanvas level={voiceState.level} active={voiceState.recording} /></div>
    <ComposerPrimitive.Root className="ds-composer" compact data-composer-empty={!hasComposerText} data-voice-recording={voiceState.recording} data-voice-cancel={voiceState.cancelZone} onPointerDown={handleAreaPointerDown} onPointerMove={handleAreaPointerMove} onPointerUp={handleAreaPointerUp} onPointerCancel={handleAreaPointerCancel}>
      <div className="ds-voice-overlay" aria-hidden="true">
        <div className="ds-voice-overlay__wash" />
        <div className="ds-voice-overlay__aurora" />
        <div className="ds-voice-overlay__ripple" />
        <div className="ds-voice-overlay__ripple ds-voice-overlay__ripple--two" />
        <div className="ds-voice-overlay__ripple ds-voice-overlay__ripple--three" />
      </div>
      <ComposerPrimitive.AddAttachment className="ds-composer-tool ds-composer-attachment" aria-label="添加附件"><Icon name="plus" size={16} /></ComposerPrimitive.AddAttachment>
      <ComposerPrimitive.Input rows={1} placeholder="问问 DeepStudent…" aria-label="输入消息" />
      <div className="ds-composer__toolbar">
        <VoiceComposerButton composer={runtime.thread.composer} input={composer} onRegister={registerGesture} onVoiceStateChange={setVoiceState} />
      </div>
    </ComposerPrimitive.Root>
    <div className="ds-voice-recording-status" role="status" aria-live="polite" aria-hidden={!voiceState.recording}>
      <time>{formatRecordingElapsed(voiceState.elapsed)}</time>
      <span>{voiceState.cancelZone ? "松开取消" : "上滑取消"}</span>
    </div>
  </div>;
}

function ChatPromptBridge({ prompt, onConsumed }: { prompt?: string; onConsumed?: () => void }) {
  const composer = unstable_useComposerInput();
  useEffect(() => {
    if (prompt?.trim()) {
      composer.setText(prompt);
      onConsumed?.();
    }
  }, [prompt]);
  return null;
}

export function ChatWorkspace({ initialPrompt, onPromptConsumed }: { initialPrompt?: string; onPromptConsumed?: () => void } = {}) {
  // The Go HTTP/SSE runtime is the primary adapter for the desktop shell and
  // local web server. Keep the small local adapter as a graceful fallback so
  // static previews and an offline first visit still render a usable chat.
  const adapter = useMemo(() => createGoRuntimeAdapter({ timeoutMs: 45_000, fallback: StubAdapter }), []);
  const runtime = useLocalRuntime(adapter);
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ChatPromptBridge prompt={initialPrompt} onConsumed={onPromptConsumed} />
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

export function LearningHub({ onAsk }: { onAsk?: (question: ResourceQuestion) => void } = {}) {
  return <WorkspacePage>
    <ResourceLibrary onAsk={onAsk} />
  </WorkspacePage>;
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return <div className="ds-empty-state"><p><b>{title}</b>，{description}</p></div>;
}

export function Todo() { return <WorkspacePage action={<><Icon name="plus" size={14} />新建任务</>}><div className="ds-panel"><EmptyState title="还没有任务" description="创建一个任务，让下一步学习行动清晰可见" /></div></WorkspacePage>; }
export function Skills() { return <WorkspacePage action={<><Icon name="plus" size={14} />添加技能</>}><EmptyState title="还没有可用技能" description="添加技能后，它们会出现在这里" /></WorkspacePage>; }
export function Flashcards() { return <WorkspacePage action={<><Icon name="plus" size={14} />新建卡片组</>}><EmptyState title="还没有卡片组" description="创建一个卡片组，开始用主动回忆巩固知识" /></WorkspacePage>; }
export function Settings({ theme, onTheme, onOpenOnboarding }: { theme: Theme; onTheme: () => void; onOpenOnboarding: () => void }) { return <WorkspacePage><div className="ds-settings-layout"><nav className="ds-settings-nav ds-panel"><button className="is-active">常规</button><button>外观</button><button>AI 助手</button><button>快捷键</button><button>关于</button></nav><div className="ds-settings-content"><section className="ds-panel ds-setting-section"><PanelHeading title="常规" meta="管理工作区和学习体验" /><SettingRow title="启动时打开新对话" detail="每次打开应用时回到 DeepStudent" checked /><SettingRow title="自动保存对话" detail="编辑后立即保存更改" checked /><div className="ds-setting-row ds-setting-row--action"><span><b>学习配置向导</b><small>重新选择学习目标、方式、模型和运行环境偏好</small></span><button type="button" className="ds-secondary-button" onClick={onOpenOnboarding}>重新打开</button></div></section><section className="ds-panel ds-setting-section"><PanelHeading title="外观" meta="调整界面的显示方式" /><label className="ds-setting-row"><span><b>深色模式</b><small>让界面更适合长时间学习</small></span><input className="ds-switch" type="checkbox" checked={theme === "dark"} onChange={onTheme} /></label></section></div></div></WorkspacePage>; }
function SettingRow({ title, detail, checked }: { title: string; detail: string; checked?: boolean }) { return <label className="ds-setting-row"><span><b>{title}</b><small>{detail}</small></span><input className="ds-switch" type="checkbox" defaultChecked={checked} /></label>; }
function PanelHeading({ title, meta, action }: { title: string; meta?: string; action?: string }) { return <div className="ds-panel-heading"><div><b>{title}</b>{meta && <p>{meta}</p>}</div>{action && <button className="ds-text-button">{action}</button>}</div>; }
function WorkspacePage({ action, children }: { action?: React.ReactNode; children: React.ReactNode }) { return <section className="ds-workspace-page">{action && <div className="ds-page-actions"><button className="ds-primary-button">{action}</button></div>}{children}</section>; }
