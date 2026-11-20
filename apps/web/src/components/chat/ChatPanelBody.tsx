import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { liveQuery } from 'dexie';
import { Button, Dropdown, ListBox, Select, Tooltip } from '@heroui/react';
import { appendConversationSession, removeConversationMessage, reviseConversationSession, readConversationSession, readConversationMessage } from '../../store/conversationProducts';
import { deleteServerSession, forkServerSession, removeConversationMessages } from '../../client/conversations';
import { MaterialImage } from '../MaterialImage';
import { useSelectionAsk, formatCitation, EXPLAIN_PROMPT, MAX_REFS, type Citation } from '../../store/selectionAsk';
import { Markdown as XMarkdown } from '../markdown/Markdown';
import { WebsiteCitations } from '../markdown/WebsiteCitations';
import { WebsiteLink } from '../markdown/WebsiteLink';
import { systemMaterialPath } from '../../materials/systemFiles';
import type { ComponentProps } from '@ant-design/x-markdown';
import { db, type ChatImage, type ChatSessionRow, type ChatToolCall } from '../../store/db';
import { useSettings } from '../../store/settings';
import { estimateTokens } from '../../harness/context';
import { PROMPTS } from '../../harness/prompts';
import { EMPTY_COMPRESSION, retainedContext, useContextCompressionStore } from '../../store/contextCompression';
import ContextUsageButton from '../ContextUsageButton';
import ComposerExpand from '../ComposerExpand';
import { useContextCompression } from '../useContextCompression';
import { explicitSkillIds } from '../../skills/activation';
import { captureFrame, resolveVideoEl, type Snapshot } from '../../media/snapshot';
import { fmtTime } from '../../utils/vtt';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../../utils/linkify';
import { fmtUnitRef, type UnitKind } from '../../materials/units.ts';
import type { MaterialReaderHandle } from '../../materials/types';
import { useSessionExport } from './useSessionExport';
import { useOlderMessages, useSessionDeleteConfirm, useStopGenerating } from './useSessionHistory';
import { useContextMeter } from './useContextMeter';
import { createDeleteMessageHandler } from './deleteMessageRow';
import { useAccountReset, useLatestInterruptedKey } from './usePanelLifecycle';
import { useSessionActions } from './useSessionActions';
import { useQuizAnswer } from './useQuizAnswer';
import { useSendMessage } from './useSendMessage';
import { useRetryMessage } from './useMessageActions';
import { useMessageDeletion } from '../useMessageDeletion';
import { useModelMetaRevision } from '../../utils/useModelMeta';
import { displayChatError, displayChatFailure } from '../../utils/chatError';
import { Panel, PanelPlaceholder, Sym, toast, popconfirm } from '../../ui';
import { StreamParagraph, useMessageEnter } from '../motion';
import ResponseTimeline from '../ResponseTimeline';
import type { ResponseSegment, SessionIndexPage } from '@wangke/contracts/client-runtime';
import { isTaskUnfinished } from '@wangke/contracts/task-status';
import { responsePhase, type ProcessPhase } from '../../utils/responseProcess';
import VirtualMessages, { type VirtualMessagesHandle } from '../VirtualMessages';
import { useChatScroll } from '../useChatScroll';
import ChatHistorySkeleton from '../ChatHistorySkeleton';
import { readChatPage, readChatHistory } from '../../store/chatHistory';
import { materialBlocksSnapshotExist } from '../../client/material-blocks';
import { framePatch } from '../../utils/framePatch';
import { MarkdownCode, MarkdownPre } from '../mermaid/markdown';
import { MarkdownTable } from '../MdTable';
import { MarkdownStreamingProvider } from '../markdown/streaming';
import TaskModelPicker from '../TaskModelPicker';
import SkillPicker from '../SkillPicker';
import type { InlineSkillInputHandle } from '../InlineSkillInput';
// CodeMirror 全家桶(~130KB gzip)只服务这个输入框,懒加载别让对话首屏静态依赖它。
const InlineSkillInput = lazy(() => import('../InlineSkillInput'));
import SkillMessageContent from '../SkillMessageContent';
import QuizCard from '../QuizCard';
import { canUpdateQuizPick, type QuizPick } from '../../harness/quiz';
import WidgetMessage from '../WidgetMessage';
import WidgetStreamFrame from '../WidgetStreamFrame';
import { ArtifactEditProvider } from '../ArtifactEditor';
import AssistantContent from '../AssistantContent';
import ChatScreenshots from '../ChatScreenshots';
import { useResolvedDark } from '../../ui/theme';
import type { WidgetPayload } from '../../harness/widgetRuntime';
import { followServerSession } from '../../client/session';
import { cloud } from '../../cloud/state';
import { serverRuntime } from '../../client/bootstrap';
import { taskModelChoice, taskModelKey, useTaskModel } from '../../store/taskModel';
import { accountLifecycle } from '../../client/account-lifecycle';
import { editMessage } from '../../client/learning';
import { useMaterialPluginView } from '../../plugins/useMaterialPluginView';
import { usePluginAvailable } from '../../plugins/catalog';
import { isPluginAvailable, assertPluginAvailable } from '../../plugins/availability';
import { CopyButton } from '../../ui/copy-button';
import type { MediaPlayerInstance } from '@vidstack/react';
import { FocusEffect, type FocusRequest } from './FocusEffect';
import type { ComponentLink } from './ChatMessageThread';
import { useRecentSessionIndex } from '../useRecentSessionIndex';
import { useCourseFrames } from './useCourseFrames';
import { UserContent } from './UserContent';
import { MessageActions } from './MessageActions';
import { ChatMessageThread } from './ChatMessageThread';
import { ChatComposer } from './ChatComposer';
import { ChatToolbar } from './ChatToolbar';
import { ChatIndexNote } from './ChatIndexNote';
import { ChatSessionEffects } from './ChatSessionEffects';
import type { ChatMsg, ChatPanelProps } from './chatPanelTypes';
import './chat-panel.css';

export type { ChatMsg, ChatPanelProps };

let keySeq = 0;
const nextKey = () => `${Date.now()}-${keySeq++}`;

export function ChatPanelBody({
  videoId,
  videoName,
  playerRef,
  readerRef,
  materialKind,
  materialFormat,
}: ChatPanelProps) {
  const { t: chatText } = useTranslation('common');
  const learningPlugin = useMaterialPluginView(videoId);
  const practiceAvailable = usePluginAvailable('practice'), reviewAvailable = usePluginAvailable('review');
  const openLearningPlugin = (id: string) => { void learningPlugin.open(id).catch(error => toast.error(error instanceof Error ? error.message : 'plugin_view_unavailable')); };
  /** 材料课程（PDF / Word / Markdown / HTML）：没有字幕、没有播放器，检索与引用都走材料那一套 */
  const isMaterial = materialKind !== undefined;
  // ── 消息流与历史分页（写入方：send/retry 与 ChatSessionEffects）──
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  /** 「继续」按钮只挂在最后一条被中断的回答上：更早的那些已经有后续消息，再给按钮会重复触发 */
  const latestInterruptedKey = useLatestInterruptedKey(msgs);
  const historyRequest = useRef(false);
  // ── 输入区：文本、引用条、截图、添加菜单 ──
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const localRequest = useRef(false);
  const qaFollower = useRef<ReturnType<typeof followServerSession> | undefined>(undefined);
  const inflightAbort = useRef<AbortController | null>(null);
  // 账号注销 / 切号：abort 在途请求、清空列表与草稿（与原先挂载 effect 同一时机）
  useAccountReset(() => {
    inflightAbort.current?.abort(); inflightAbort.current = null; localRequest.current = false;
    setMsgs([]); setSessions([]); setActiveId(null); setLoadedSessionId(null); setLoading(false);
    setInput(''); setShots([]); setRefs([]); refsRef.current = [];
  }, () => { inflightAbort.current?.abort(); });
  const [indexReady, setIndexReady] = useState(false);
  /** 缺少可检索正文时的说明，不阻止聊天或截图提问。 */
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [indexFailure, setIndexFailure] = useState(false);
  const [indexAttempt, setIndexAttempt] = useState(0);
  // ── 会话层：列表、当前 id、云端索引、技能范围 ──
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  /** 云端会话索引：工具条的分页与 ChatSessionEffects 的列表投影共用这一份订阅 */
  const sessionIndex = useRecentSessionIndex(cloud.enabled && !!videoId, false, false, videoId);
  /** 新追加的消息（发出去的提问 + 助手占位）播一次上浮淡入，见 useMessageEnter */
  const entering = useMessageEnter(msgs.map((m) => m.key), activeId);
  const historySession = useRef(activeId);
  historySession.current = activeId;
  const [loadedSessionId, setLoadedSessionId] = useState<number | null>(null);
  /**
   * 当前会话的技能白名单（`undefined` = 不限定，见 `ChatSessionRow.skillIds`）。
   *
   * 与 `activeId` 同步切换，**不做跨会话记忆**：它是会话的属性，不是面板的属性。
   * 发送时这个值要同时喂给「提示词清单」和「工具白名单」两处，只改一处会得到
   * 「模型看不到某技能、但调了却能成功」的错配。
   */
  const [skillIds, setSkillIds] = useState<number[] | undefined>(undefined);
  const [turnSkillIds, setTurnSkillIds] = useState<number[]>([]);
  const [mcpServerIds, setMcpServerIds] = useState<string[] | undefined>();
  const [skillsOpen, setSkillsOpen] = useState(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [shots, setShots] = useState<Snapshot[]>([]);
  /**
   * 划词/框选带进来的引用条（最多 MAX_REFS 条）。
   * 做成独立的 chip 列表而不是把引用拼进 textarea：用户能看清自己引了什么、能单条删掉。
   */
  const [refs, setRefs] = useState<Citation[]>([]);
  /** 选区提问的投递（来自 SelectionAsk 浮层 / PDF 框选） */
  const pendingAsk = useSelectionAsk((s) => s.pending);
  const takeAsk = useSelectionAsk((s) => s.take);
  /** 发送时读最新引用：send 会被 effect 同步调用，闭包里的 refs 可能还没更新 */
  const refsRef = useRef<Citation[]>([]);
  useEffect(() => {
    refsRef.current = refs;
  }, [refs]);
  // 行内编辑器值从 onChange 拿；「选区提问」通过句柄聚焦。
  // 声明放在这里（而不是靠近 JSX）是因为那个 effect 在组件体上方就要用到 ——
  // 常量声明在使用之后会被 TS 判为 use-before-declaration。
  const composerInput = useRef<InlineSkillInputHandle>(null);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const [composerOverflow, setComposerOverflow] = useState(false);
  const agentInstructions = useSettings((s) => s.agentInstructions);
  const compressionEnabled = useSettings((s) => s.jev.contextCompression && !!s.decisionModel.model && s.providers.some(provider => provider.id === s.decisionModel.providerId));
  const contextPlan = useContextCompressionStore((s) => activeId == null ? EMPTY_COMPRESSION : s.sessions[activeId] ?? EMPTY_COMPRESSION);
  // 沙箱 widget 是独立文档，拿不到 mdui 的 CSS 令牌，所以明暗得由宿主算完显式传进去。
  // （`useResolvedDark` 原先只服务 antd，这里是第二个消费者 —— 理由同为「明暗是 JS 算的」。）
  const widgetDark = useResolvedDark(useSettings((s) => s.theme));
  // 消息流滚动容器（原 Bubble.List 的 ref 只暴露 scrollTo，现在自己持有真实元素）
  const listRef = useRef<HTMLDivElement | null>(null);
  const { deleteMessage, deleting } = useMessageDeletion(listRef, activeId, createDeleteMessageHandler({ msgs, loading, activeId, setMsgs }));

  // 思考深度能不能调取决于模型自己声明了什么，而元数据是启动后异步拉回来的
  useModelMetaRevision();

  /** 截取当前视频画面，加入待发送列表（最多 4 张） */
  const addShot = () => {
    const video = resolveVideoEl(playerRef);
    const t = playerRef.current?.currentTime ?? 0;
    if (!video) return toast.warning(chatText('chatPanel.videoNotReady'));
    const snap = captureFrame(video, t);
    if (!snap) return toast.warning(chatText('chatPanel.shotFailed'));
    if (shots.length >= 4) return toast.info(chatText('chatPanel.maxShots'));
    setShots((prev) => [...prev, snap]);
  };

  const seekTo = useCallback(
    (t: number) => {
      if (playerRef.current) playerRef.current.currentTime = t + 0.01;
    },
    [playerRef],
  );

  // 帧元数据与正文里的两种自定义渲染器（#frame- 缩略图 / #source-image 文档引用）
  const { FrameImage, SourceImageLink } = useCourseFrames({ videoId, readerRef, onSeek: seekTo });

  /** 自定义链接渲染：#seek-N 跳播放器、#unit-N 跳材料对应页/段，其余外链新窗口打开 */
  const SeekLink: ComponentLink = useCallback(
    ({ href, children, ...props }) => {
      const h = href ?? '';
      // 文档引用（#source-image/）的渲染与判断在 useCourseFrames 里，和 img 那一支共用同一份
      if (h.startsWith('#source-image/')) return <SourceImageLink href={h}>{children}</SourceImageLink>;
      if (h.startsWith('#seek-')) {
        const secs = Number(h.slice(6));
        return (
          <a
            onClick={(e) => {
              e.preventDefault();
              seekTo(secs);
            }}
            className="chat-ts"
          >
            {children}
          </a>
        );
      }
      // 阅读材料的引用：[第3页] → #unit-3，点一下滚动阅读器并高亮
      if (h.startsWith('#unit-')) {
        const unit = Number(h.slice(6));
        return (
          <a
            onClick={(e) => {
              e.preventDefault();
              readerRef?.current?.scrollToUnit(unit);
            }}
            className="chat-ts"
          >
            {children}
          </a>
        );
      }
      return (
        <WebsiteLink {...props} href={h} target="_blank" rel="noreferrer">
          {children}
        </WebsiteLink>
      );
    },
    [seekTo, readerRef, SourceImageLink],
  );

  /**
   * 消费「选区提问」的投递：浮层点「解释这段」或「就这段提问」后进到这里。
   *
   * 两种模式的分工：
   * - `compose`：只把引用压进引用条并聚焦输入框，用户自己补问题（多数情况）
   * - `explain`：直接用默认提问发送，省一步（「这段什么意思」这种不用再打字）
   *
   * 引用条满了就丢掉最旧的一条：用户刚点的这条显然比三分钟前那条更相关。
   */
  useEffect(() => {
    if (!pendingAsk) return;
    const { cite, mode } = pendingAsk;
    takeAsk();
    // 直接基于 refsRef 算下一份并同步写回：同一次事件里 setState 还没落地，
    // 而 explain 模式要立刻把这份引用发出去，不能用 state 读
    const next =
      refsRef.current.length >= MAX_REFS
        ? [...refsRef.current.slice(refsRef.current.length - MAX_REFS + 1), cite]
        : [...refsRef.current, cite];
    refsRef.current = next;
    setRefs(next);
    if (mode === 'explain') {
      void send(EXPLAIN_PROMPT, next);
    } else {
      // compose：引用已进引用条，焦点交给输入框，用户直接补问题。
      // 组件身份由外层 ChatPanel 持有，输入框句柄在本组件里 —— 所以这里只写「焦点请求」，
      // 由 FocusEffect 在同一帧提交后落到句柄上。
      setFocusRequest(next => ({ kind: 'composer', nonce: (next?.nonce ?? 0) + 1 }));
    }
    // send 每轮渲染都是新引用，放进依赖会无限触发；这里只在 pendingAsk 变化时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk]);

  const loadOlder = useOlderMessages({ activeId, msgs, hasOlder, historyRequest, historySession, setLoadingOlder, setHistoryError });

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';
  const { sessionMarkdown, downloadSession } = useSessionExport({ activeId, msgs, activeTitle, videoName });

  const stopGenerating = useStopGenerating(inflightAbort, activeId);

  // Actual content resizing (including final action rows and async previews)
  // is also reported by VirtualMessages before paint.
  const lastMsg = msgs[msgs.length - 1];
  const scrollSignal = [
    msgs.length,
    lastMsg?.key ?? '',
    lastMsg?.content.length ?? 0,
    lastMsg?.reasoning?.length ?? 0,
    lastMsg?.streaming ? 1 : 0,
    lastMsg?.hint ?? '',
    // 工具链每多一次调用也要跟到底：那一行是**新长出来的高度**，
    // 不跟的话它会顶到可视区外，用户只看到「字数没变但内容跳了一下」
    lastMsg?.tools?.length ?? 0,
    lastMsg?.quiz ? 1 : 0,
    lastMsg?.widget ? 1 : 0,
    lastMsg?.widgetPreview?.html.length ?? 0,
  ].join('|');
  const virtualMessagesRef = useRef<VirtualMessagesHandle>(null);
  const { pinIfSticking: pinList, pauseFollowing } = useChatScroll(listRef, {
    sessionKey: activeId, historyReady: loadedSessionId === activeId, revision: scrollSignal, messages: msgs, virtualRef: virtualMessagesRef,
    onReachStart: () => { if (!historyError) void loadOlder(); },
  });

  const { handleAnswer } = useQuizAnswer({ msgs, pauseFollowing, setMsgs });
  // 上下文用量估算（system + 历史 + 当前输入/截图/引用），仅作 UI 提示
  const { ctxEst, ctxWin: meterWindow, ctxBreakdown, contextCompression, ctxLevel } = useContextMeter({
    videoName, materialKind, materialFormat, isMaterial, input, shots, refs, msgs,
    agentInstructions, compressionEnabled, contextPlan, activeId, loadedSessionId, loading, indexReady,
  });
  const { send } = useSendMessage({
    videoId, videoName, materialKind, materialFormat, refs, refsRef, shots, turnSkillIds, skillIds,
    loading, indexReady, activeId, msgs, localRequest, inflightAbort, historySession,
    refreshFollower: () => qaFollower.current?.refresh(),
    setInput, setShots, setRefs, setLoading, setMsgs, setTurnSkillIds,
  });
  const retryMessage = useRetryMessage({ msgs, loading, activeId, turnSkillIds, setMsgs, send });
  const { createSession, deleteSession, forkMessage, updateMcpServerIds, updateSkillIds } = useSessionActions({
    videoId, activeId, sessions, loading, historySession, setSessions, setActiveId, setSkillIds, setMcpServerIds,
  });

  const confirmDeleteSession = useSessionDeleteConfirm(deleteSession);
  /**
   * 会话下拉：selectedKey 是字符串（HeroUI 的 Key），会话 id 是数字 —— 回传时转回数字。
   * 取消选择（null）不动当前会话，保留原来「只处理有效值」的行为。
   */
  const selectSession = (key: React.Key | null) => {
    if (key == null) return;
    const n = Number(key);
    if (Number.isFinite(n)) setActiveId(n);
  };

  return (
    <Panel testId="panel-chat">
      <ChatToolbar
        sessions={sessions}
        activeId={activeId}
        activeTitle={activeTitle}
        loading={loading}
        msgsLength={msgs.length}
        selectSession={selectSession}
        onNewSession={() => void createSession()}
        onDeleteSession={() => void confirmDeleteSession()}
        sessionMarkdown={sessionMarkdown}
        onDownload={() => void downloadSession()}
        sessionIndex={sessionIndex}
        cloudEnabled={cloud.enabled}
      />
      <ChatSessionEffects
        videoId={videoId}
        activeId={activeId}
        isMaterial={isMaterial}
        materialKind={materialKind}
        indexAttempt={indexAttempt}
        sessionIndex={sessionIndex}
        refs={{ localRequest, historyRequest, historySession, qaFollower }}
        setSessions={setSessions}
        setActiveId={setActiveId}
        setSkillIds={setSkillIds}
        setMcpServerIds={setMcpServerIds}
        setTurnSkillIds={setTurnSkillIds}
        setMsgs={setMsgs}
        setHasOlder={setHasOlder}
        setLoadingOlder={setLoadingOlder}
        setHistoryError={setHistoryError}
        setLoading={setLoading}
        setLoadedSessionId={setLoadedSessionId}
        setIndexReady={setIndexReady}
        setIndexNote={setIndexNote}
        setIndexFailure={setIndexFailure}
      />
      <SkillPicker onInserted={() => composerInput.current?.focus()} anchorRef={addButton} value={skillIds} onChange={updateSkillIds} turnValue={turnSkillIds} onTurnChange={setTurnSkillIds} disabled={loading} mcpValue={mcpServerIds} onMcpChange={updateMcpServerIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />
      {learningPlugin.dialog}
      {/* 焦点通道：挂在「永远存在」的组件上，请求变化后由这一帧的句柄去聚焦 */}
      <FocusEffect request={focusRequest} onFocus={() => composerInput.current?.focus()} />

      {/* 消息流：AI 靠左、用户靠右。两种气泡的形状差是 MD3 聊天的标志 ——
          靠对话侧收小圆角、另一侧全圆角。流式 markdown / 思考块 / 题卡都留在 AI 气泡内。 */}
      <ChatMessageThread
        activeId={activeId}
        loadedSessionId={loadedSessionId}
        msgs={msgs}
        entering={entering}
        hasOlder={hasOlder}
        loadingOlder={loadingOlder}
        historyError={historyError}
        loading={loading}
        deleting={deleting}
        latestInterruptedKey={latestInterruptedKey}
        materialKind={materialKind}
        videoId={videoId}
        videoName={videoName}
        widgetDark={widgetDark}
        readerRef={readerRef}
        listRef={listRef}
        virtualMessagesRef={virtualMessagesRef}
        onResize={pinList}
        onLoadOlder={() => void loadOlder()}
        retryMessage={retryMessage}
        forkMessage={forkMessage}
        deleteMessage={deleteMessage}
        downloadSession={downloadSession}
        seekTo={seekTo}
        handleAnswer={handleAnswer}
        SeekLink={SeekLink}
        FrameImage={FrameImage}
        send={send}
        onEditSaved={(row) => setMsgs((prev) => prev.map((item) => item.rowId === row.id ? { ...item, content: row.content, responseSegments: row.responseSegments, widget: row.widget, widgets: row.widgets } : item))}
      />

      {indexNote && <ChatIndexNote note={indexNote} failed={indexFailure} onRetry={() => setIndexAttempt(value => value + 1)} />}

      {/* 输入区与首页一致：添加、文本、模型和发送共用一行，长文本按需增高。
          Enter 发送、Shift+Enter 换行；isComposing 时放行（中文输入法选词的回车不是提交意图）。 */}
      <ChatComposer
        activeId={activeId}
        loadedSessionId={loadedSessionId}
        input={input}
        onInputChange={setInput}
        loading={loading}
        indexReady={indexReady}
        isMaterial={isMaterial}
        materialKind={materialKind}
        materialFormat={materialFormat}
        refs={refs}
        onRemoveRef={(index) => {
          const next = refs.filter((_, j) => j !== index);
          refsRef.current = next;
          setRefs(next);
        }}
        shots={shots}
        onRemoveShot={(index) => setShots((prev) => prev.filter((_, j) => j !== index))}
        turnSkillIds={turnSkillIds}
        onTurnSkillsChange={setTurnSkillIds}
        skillIds={skillIds}
        mcpServerIds={mcpServerIds}
        skillsOpen={skillsOpen}
        onSkillsOpenChange={setSkillsOpen}
        composerOverflow={composerOverflow}
        onComposerOverflowChange={setComposerOverflow}
        composerInput={composerInput}
        addButton={addButton}
        addOpen={addOpen}
        onAddOpenChange={setAddOpen}
        practiceAvailable={practiceAvailable}
        reviewAvailable={reviewAvailable}
        onOpenPlugin={openLearningPlugin}
        onShot={addShot}
        send={send}
        onStop={stopGenerating}
        ctxEst={ctxEst}
        ctxWin={meterWindow}
        ctxBreakdown={ctxBreakdown}
        contextCompression={contextCompression}
        ctxLevel={ctxLevel}
        pinList={pinList}
      />
    </Panel>
  );
}

