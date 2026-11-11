import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { cloudBlobUrl } from '../store/cloudBlob';
import { appendConversationSession, removeConversationMessage, reviseConversationSession, readConversationSession, readConversationMessage } from '../store/conversationProducts';
import { deleteServerSession, forkServerSession, removeConversationMessages } from '../client/conversations';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, ListBox, Select, Tooltip } from '@heroui/react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { MaterialImage, SourceImage } from './MaterialImage';
import { parseMaterialImageHref } from '../materials/imageRefs';
import { Markdown as XMarkdown } from './markdown/Markdown';
import { systemMaterialPath } from '../materials/systemFiles';
import type { MediaPlayerInstance } from '@vidstack/react';
import { db, type ChatImage, type ChatSessionRow, type ChatToolCall, type QuizState, type FrameRow } from '../store/db';
import { loadCollection } from '../client/collections';
import { readRecordKeys } from '../cloud/sync';
import { useSettings } from '../store/settings';
import { estimateTokens } from '../harness/context';
import { PROMPTS } from '../harness/prompts';
import { EMPTY_COMPRESSION, retainedContext, useContextCompressionStore } from '../store/contextCompression';
import ContextUsageButton from './ContextUsageButton';
import ComposerExpand from './ComposerExpand';
import { useContextCompression } from './useContextCompression';
import { explicitSkillIds } from '../skills/activation';
import { captureFrame, resolveVideoEl, type Snapshot } from '../media/snapshot';
import { type ThinkingLevel } from '../api/siliconflow';
import { fmtTime } from '../utils/vtt';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../utils/linkify';
import { fmtUnitRef, type UnitKind } from '../materials/units.ts';
import type { MaterialReaderHandle } from '../materials/types';
import { useSelectionAsk, formatCitation, EXPLAIN_PROMPT, MAX_REFS, type Citation } from '../store/selectionAsk';
import { buildSessionMarkdown, exportFileName, markdownToPlainText } from '../utils/chatExport';
import { copyWithFeedback } from '../utils/copyFeedback';
import { CopyButton } from '../ui/copy-button';
import { messageTime } from '../utils/messageTime';
import { useMediaQuery } from '../utils/useMobile';
import { useModelMetaRevision } from '../utils/useModelMeta';
import { displayChatError, displayChatFailure } from '../utils/chatError';
import {
  Panel,
  PanelBar,
  PanelBody,
  PanelPlaceholder,
  Sym,
  toast,
  popconfirm,
} from '../ui';
import { StreamParagraph, useMessageEnter } from './motion';
import ResponseTimeline from './ResponseTimeline';
import type { ResponseSegment, SessionIndexPage } from '@wangke/contracts/client-runtime';
import { isTaskUnfinished } from '@wangke/contracts/task-status';
import { responsePhase, type ProcessPhase } from '../utils/responseProcess';
import VirtualMessages, { type VirtualMessagesHandle } from './VirtualMessages';
import { useMessageDeletion } from './useMessageDeletion';
import { useChatScroll } from './useChatScroll';
import ChatHistorySkeleton from './ChatHistorySkeleton';
import { readChatPage, readChatHistory } from '../store/chatHistory';
import { materialBlocksSnapshotExist } from '../client/material-blocks';
import { framePatch } from '../utils/framePatch';
import { MarkdownCode, MarkdownPre } from './mermaid/markdown';
import { MarkdownTable } from './MdTable';
import { MarkdownStreamingProvider } from './markdown/streaming';
import TaskModelPicker from './TaskModelPicker';
import SkillPicker from './SkillPicker';
import InlineSkillInput, { type InlineSkillInputHandle } from './InlineSkillInput';
import SkillMessageContent from './SkillMessageContent';
import QuizCard from './QuizCard';
import { canUpdateQuizPick, type QuizPick } from '../harness/quiz';
import WidgetMessage from './WidgetMessage';
import WidgetStreamFrame from './WidgetStreamFrame';
import { ArtifactEditProvider } from './ArtifactEditor';
import AssistantContent from './AssistantContent';
import ChatScreenshots from './ChatScreenshots';
import { useResolvedDark } from '../ui/theme';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { followServerSession } from '../client/session';
import { cloud } from '../cloud/state';
import { serverRuntime } from '../client/bootstrap';
import { useRecentSessionIndex } from './useRecentSessionIndex';
import { taskModelChoice, taskModelKey, useTaskModel } from '../store/taskModel';
import { accountLifecycle } from '../client/account-lifecycle';
import { editMessage } from '../client/learning';
import { useMaterialPluginView } from '../plugins/useMaterialPluginView';
import { usePluginAvailable } from '../plugins/catalog';
import { isPluginAvailable, assertPluginAvailable } from '../plugins/availability';
import './chat-panel.css';

interface Props {
  videoId: string;
  videoName: string;
  /** 视频：播放器实例；材料：传一个恒为 null 的 ref（材料没有播放器） */
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  /**
   * 阅读器句柄（只有材料课程有）。用于把回答里的 `[第3页]` 引用变成「点一下就滚过去」。
   * 与 playerRef 完全对称：视频靠 playerRef 跳时间，材料靠 readerRef 跳页/段。
   */
  readerRef?: React.RefObject<MaterialReaderHandle | null>;
  /**
   * 材料的定位单元类型：`'page'`（PDF）/ `'para'`（Word）。
   * **不传 = 视频课程**，此时走字幕检索 + 时间戳引用。
   */
  materialKind?: UnitKind;
  /**
   * 材料的原始格式（视频课程不传）。**只有 `'md'` 有编辑面**，
   * `edit_markdown` 工具与「材料可编辑」那条提示词都据此开关（见 send 里那段注释）。
   *
   * 为什么与 materialKind 分开两个 prop：kind 是**定位单位**（页码 / 段落号），
   * format 是**文件格式**（能不能改）。`'html'` 与 `'md'` 的定位单位相同但一个能改一个不能，
   * 合成一个 prop 就得在两边各自反推「这个 kind 是不是可编辑的」，那是两处会漂移的判断。
   */
  materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
}

interface ChatMsg {
  responseSegments?: ResponseSegment[];
  processPhase?: ProcessPhase;
  /** 本轮启动时刻，切页重挂时不重置过程计时（不落库）。 */
  processStartedAt?: number;
  key: string;
  role: 'user' | 'ai';
  content: string;
  explicitSkillIds?: number[];
  /** 落库时间：手机端长按用户气泡时显示（与主页对话一致） */
  createdAt?: number;
  /** 用户消息附带的截图缩略图 */
  images?: ChatImage[];
  /** 思考过程（推理模型 reasoning_content 的回调累计值） */
  reasoning?: string;
  /** 思考耗时（毫秒）：首个思考 token → 末个。落库，历史消息也显示 */
  reasoningMs?: number;
  /**
   * 首个思考 token 的时刻（毫秒时间戳）。
   *
   * **不落库**：它只服务「思考中」那几秒的实时计时（`ReasoningChain` 的 `since`），
   * 历史消息用的是终值 `reasoningMs`。存进库里只会多一个没人读、还会过期的字段。
   */
  reasoningStartedAt?: number;
  /** 工具调用期间的提示（如"正在检索…"） */
  hint?: string;
  /**
   * 这一轮调过的工具（含正在跑的那次）。落库，历史消息也回放 ——
   * 见 `components/ToolTrace.tsx` 顶部那段「为什么要有这一块」。
   */
  tools?: ChatToolCall[];
  /** 答题卡（present_quiz 工具产出） */
  quiz?: QuizState;
  /** 沙箱图形卡（show_widget 的 html 形态产出） */
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  /** show_widget 参数尚未完整到达时的静态安全预览（不落库） */
  widgetPreview?: { html: string };
  /** 落库后的 chats 行 id（作答状态回写用） */
  rowId?: number;
  taskId?: string;
  streaming?: boolean;
  error?: boolean;
  interrupted?: boolean;
  interruptReason?: string;
}

let keySeq = 0;
const nextKey = () => `${Date.now()}-${keySeq++}`;

/** 幻灯片帧元数据（blob 按需经 id 单取，不进 React 状态） */
interface FrameMeta {
  id: number;
  ts: number;
}

/**
 * AI 回答里的课程画面引用（[图@mm:ss] → #frame-秒 → 本组件）。
 * 就近匹配（±2s，时间戳经 fmtTime/parse 往返有秒级误差）后从 db.frames 取 blob 渲染缩略图，
 * 点击跳转播放器；匹配不到画面时降级为可点击的时间戳链接。
 */
function FrameThumb({
  secs,
  alt,
  frames,
  onSeek,
}: {
  secs: number;
  alt?: string;
  frames: FrameMeta[];
  onSeek: (t: number) => void;
}) {
  const frame = useMemo(() => {
    let best: FrameMeta | null = null;
    for (const f of frames) {
      const d = Math.abs(f.ts - secs);
      if (d <= 2 && (!best || d < Math.abs(best.ts - secs))) best = f;
    }
    return best;
  }, [secs, frames]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    let objUrl: string | null = null;
    void (cloud.enabled ? readRecordKeys<FrameRow>('frames', [frame.id]).then(rows => rows[0]) : db.frames.get(frame.id)).then((row) => {
      if (cancelled || !row) return;
      const remote = cloudBlobUrl(row.blob);
      if (!remote) objUrl = URL.createObjectURL(row.blob as Blob);
      setUrl(remote ?? objUrl);
    }).catch(() => { /* An unavailable image must not hide the conversation. */ });
    return () => {
      cancelled = true;
      if (objUrl) URL.revokeObjectURL(objUrl);
      setUrl(null);
    };
  }, [frame]);

  if (!frame) {
    return (
      <a
        onClick={(e) => {
          e.preventDefault();
          onSeek(secs);
        }}
        className="chat-ts"
      >
        {alt || `[图@${fmtTime(secs)}]`}
      </a>
    );
  }
  return (
    <span className="chat-frame-wrap">
      {url ? (
        <img
          src={url}
          alt={alt ?? ''}
          loading="lazy"
          decoding="async"
          onClick={() => onSeek(frame.ts)}
          className="chat-frame-img"
        />
      ) : (
        <span className="chat-frame-img chat-frame-img--pending" />
      )}
      <span className="chat-ts-chip">
        {fmtTime(frame.ts)}
      </span>
    </span>
  );
}

/**
 * 用户气泡内容：把开头的**引用块**（`> ` 前缀的连续行）单独渲染成引用样式。
 *
 * 为什么要拆：引用块落库时存的是 Markdown blockquote 原文，而用户气泡是**纯文本渲染**
 * （不走 markdown），直接吐出来会把 `> ` 露在脸上。拆开渲染既好看，也让人一眼分清
 * 「这是我引的原文」与「这是我问的问题」。
 *
 * 没有引用块时行为与从前完全一致（原样渲染 `content`），既有消息与 e2e 都不受影响。
 */
function UserContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].startsWith('> ')) {
    quoted.push(lines[i].slice(2));
    i++;
  }
  if (quoted.length === 0) return <>{content}</>;
  const rest = lines.slice(i).join('\n').trim();
  // formatCitation 的首行固定是「[选自 位置]」，抽出来单独当来源标签
  const src = /^\[选自\s*(.+?)\]$/.exec(quoted[0] ?? '');
  const body = src ? quoted.slice(1).join('\n') : quoted.join('\n');
  return (
    <>
      <span className="chat-quote" data-testid="chat-quote">
        <span className="chat-quote__src">{src ? `选自 ${src[1]}` : '引用原文'}</span>
        <span className="chat-quote__text">{body}</span>
      </span>
      {rest && <span className="chat-quote__ask">{rest}</span>}
    </>
  );
}

/**
 * 一条消息下面的操作行。
 *
 * 与主页「AI 助手」页的 `MessageActions` 保持同一套交互：复制 / 重试 / 分支 / 更多，
 * 悬浮或键盘焦点进入才显形，触屏常显；用户消息的动作行挂在气泡**外面**，
 * 避免悬停时气泡底色多长出一条图标行。见 pages/CourseChat.tsx 的同名组件。
 */
function MessageActions({
  content,
  isUser,
  busy,
  canRetry,
  retryHint,
  onRetry,
  onFork,
  onExport,
  onDelete,
}: {
  content: string;
  isUser: boolean;
  busy: boolean;
  canRetry: boolean;
  retryHint: string;
  onRetry: () => void;
  onFork: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { t: chatText } = useTranslation('common');
  const action = (
    label: string,
    icon: React.ReactNode,
    onPress: () => void,
    testId: string,
    disabled = false,
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant="tertiary"
          size="sm"
          className="chat-action"
          aria-label={label}
          isDisabled={disabled}
          data-testid={testId}
          onPress={onPress}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  const copyLabel = isUser ? chatText('chatPanel.copyQuestion') : chatText('chatPanel.copyAnswer');

  return (
    <div className="chat-message-actions" data-testid="chat-message-actions">
      <CopyButton text={content} label={copyLabel} isIconOnly variant="tertiary" size="sm"
        className="chat-action" data-testid="chat-copy-message" />

      {action(retryHint, <Sym name="refresh" />, onRetry, 'chat-retry-message', busy || !canRetry)}

      {action(chatText('chatPanel.fork'), <Sym name="fork" />, onFork, 'chat-fork-message', busy)}
      {action('删除这条消息', <Sym name="delete" />, onDelete, 'chat-delete-message', busy)}

      {!isUser && (
        <Dropdown>
          {/* Dropdown.Trigger 自己渲染 <button>，不能在里面再套 HeroUI Button */}
          <Dropdown.Trigger
            className="chat-action"
            aria-label={chatText('chatPanel.more')}
            data-testid="chat-message-more"
          >
            <Sym name="more_horiz" />
          </Dropdown.Trigger>
          <Dropdown.Popover placement="bottom start">
            <Dropdown.Menu
              onAction={(key) => {
                if (key === 'copy-plain') void copyWithFeedback(markdownToPlainText(content), chatText('chatPanel.copiedPlain'));
                else if (key === 'export') onExport();
              }}
            >
              <Dropdown.Item id="copy-plain" textValue={chatText('chatPanel.copyPlain')} data-testid="chat-copy-plain">
                <span className="chat-menu-item">复制纯文本</span>
              </Dropdown.Item>
              <Dropdown.Item id="export" textValue={chatText('chatPanel.exportSession')} data-testid="chat-export-session">
                <span className="chat-menu-item">导出本次会话</span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      )}
    </div>
  );
}

/** 长消息默认展示六行；触屏长按可查看时间、复制完整提问与操作。 */
function UserMessageBubble({ message, busy, canRetry, onRetry, onFork, onDelete }: {
  message: ChatMsg;
  busy: boolean;
  canRetry: boolean;
  onRetry: () => void;
  onFork: () => void;
  onDelete: () => void;
}) {
  const { t: chatText } = useTranslation('common');
  const touchMenu = useMediaQuery('(hover: none), (pointer: coarse), (max-width: 640px)');
  const textRef = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const measure = () => setOverflows(text.scrollHeight > parseFloat(getComputedStyle(text).lineHeight) * 6 + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(text);
    return () => observer.disconnect();
  }, [message.content, touchMenu]);
  const content = (
    <span ref={textRef} id={`chat-user-text-${message.key}`} className="chat-user-text"
      data-collapsed={overflows && !expanded}>
      <SkillMessageContent content={message.content || chatText('chatPanel.imageMessage')} ids={message.explicitSkillIds} renderText={text => <UserContent content={text} />} />
    </span>
  );
  return (
    <div className="chat-user-content">
      <div className="chat-bubble chat-bubble--user">
        {!touchMenu ? content : (
          <Dropdown trigger="longPress">
            <Dropdown.Trigger className="chat-user-trigger"
              aria-label={chatText('chatPanel.userMessageAria')} data-testid="chat-user-message-trigger">
              {content}
            </Dropdown.Trigger>
            <Dropdown.Popover placement="bottom end" className="chat-message-menu">
              {message.createdAt != null && (
                <time className="chat-message-time" dateTime={new Date(message.createdAt).toISOString()}
                  data-testid="chat-message-time">
                  {messageTime(message.createdAt)}
                </time>
              )}
              <Dropdown.Menu
                aria-label={chatText('chatPanel.askActions')}
                disabledKeys={busy || message.rowId == null ? ['retry', 'fork', 'delete'] : canRetry ? [] : ['retry']}
                onAction={(key) => {
                  if (key === 'retry') onRetry();
                  else if (key === 'fork') onFork();
                  else if (key === 'delete') onDelete();
                  else if (key === 'copy') void copyWithFeedback(message.content, chatText('chatPanel.copiedQuestion'));
                }}
              >
                <Dropdown.Item id="copy" textValue="复制" data-testid="chat-user-copy">
                  <Sym name="content_copy" />复制
                </Dropdown.Item>
                <Dropdown.Item id="retry" textValue={chatText('chatPanel.retry')} data-testid="chat-user-retry">
                  <Sym name="refresh" />重试
                </Dropdown.Item>
                <Dropdown.Item id="fork" textValue="分支出新会话" data-testid="chat-user-fork">
                  <Sym name="fork" />分支出新会话
                </Dropdown.Item>
                <Dropdown.Item id="delete" textValue={chatText('chatPanel.deleteMessage')} data-testid="chat-user-delete">
                  <Sym name="delete" />删除这条消息
                </Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        )}
        {overflows && (
          <Button size="sm" variant="tertiary" className="chat-user-expand"
            aria-expanded={expanded} aria-controls={`chat-user-text-${message.key}`}
            data-testid="chat-user-expand" onPress={() => setExpanded((value) => !value)}>
            {expanded ? chatText('chatPanel.collapse') : chatText('chatPanel.expand')}<Sym name="keyboard_arrow_down" />
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * 正在跑的那一轮的 abort 句柄。
 *
 * 模块级而不是组件 state：停止按钮要在 React 渲染之外读到它（放进 state 只会平白多几次
 * 渲染；「有没有在跑」看 `loading` 就够）。**只能有一个**：问答面板与课程助手同屏时
 * 各自的 send 都会写它，但生成中用户看不到另一个面板的停止键。
 */

export default function ChatPanel({
  videoId,
  videoName,
  playerRef,
  readerRef,
  materialKind,
  materialFormat,
}: Props) {
  const { t: chatText } = useTranslation('common');
  const { t: settingsText } = useTranslation('settings');
  const { t: navigationText } = useTranslation('interface');
  const learningPlugin = useMaterialPluginView(videoId);
  const practiceAvailable = usePluginAvailable('practice'), reviewAvailable = usePluginAvailable('review');
  const openLearningPlugin = (id: string) => { void learningPlugin.open(id).catch(error => toast.error(error instanceof Error ? error.message : 'plugin_view_unavailable')); };
  /** 材料课程（PDF / Word / Markdown / HTML）：没有字幕、没有播放器，检索与引用都走材料那一套 */
  const isMaterial = materialKind !== undefined;
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [hasOlder, setHasOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const latestInterruptedKey = useMemo(
    () => [...msgs].reverse().find((message) => message.role === 'ai' && message.interrupted && !message.streaming)?.key,
    [msgs],
  );
  const historyRequest = useRef(false);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const localRequest = useRef(false);
  const qaFollower = useRef<ReturnType<typeof followServerSession> | undefined>(undefined);
  const inflightAbort = useRef<AbortController | null>(null);
  useEffect(() => {
    const clear = () => {
      inflightAbort.current?.abort(); inflightAbort.current = null; localRequest.current = false;
      setMsgs([]); setSessions([]); setActiveId(null); setLoadedSessionId(null); setLoading(false);
      setInput(''); setShots([]); setRefs([]); refsRef.current = [];
    };
    const off = accountLifecycle.onDisposed(clear);
    return () => { off(); inflightAbort.current?.abort(); };
  }, []);
  const [indexReady, setIndexReady] = useState(false);
  /** 缺少可检索正文时的说明，不阻止聊天或截图提问。 */
  const [indexNote, setIndexNote] = useState<string | null>(null);
  const [indexFailure, setIndexFailure] = useState(false);
  const [indexAttempt, setIndexAttempt] = useState(0);
  const [sessions, setSessions] = useState<ChatSessionRow[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const sessionIndex = useRecentSessionIndex(cloud.enabled && !!videoId, false, false, videoId);
  useEffect(() => {
    if (!cloud.enabled || !sessionIndex.page) return;
    setSessions(previous => {
      const rows: ChatSessionRow[] = sessionIndex.page!.sessions.map(row => ({ id: row.id, videoId: row.videoId, title: row.title, createdAt: row.createdAt, pinned: row.pinned, archived: row.archived }));
      const active = previous.find(row => row.id === activeId);
      if (active && !rows.some(row => row.id === activeId)) rows.push(active);
      return rows.sort((a, b) => a.createdAt - b.createdAt || a.id! - b.id!);
    });
  }, [sessionIndex.page, activeId]);
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
  const [composerOverflow, setComposerOverflow] = useState(false);
  // 讲义抽帧元数据：决定 list_frames 工具/提示词注入，也供 AI 气泡里的画面引用渲染
  const [framesMeta, setFramesMeta] = useState<FrameMeta[]>([]);
  // 思考能力要按**这家供应商**的能力数据源查（同一模型 id 在别家可能不支持思考）
  const thinking = useSettings((s) => s.thinkingEnabled);
  const effort = useSettings((s) => s.thinkingEffort);
  const ctxWin = useSettings((s) => s.contextWindow);
  const agentInstructions = useSettings((s) => s.agentInstructions);
  const compressionEnabled = useSettings((s) => s.jev.contextCompression && !!s.decisionModel.model && s.providers.some(provider => provider.id === s.decisionModel.providerId));
  const contextPlan = useContextCompressionStore((s) => activeId == null ? EMPTY_COMPRESSION : s.sessions[activeId] ?? EMPTY_COMPRESSION);
  /**
   * 思考能力分两层，工具行上给什么控件就看这两层：
   *
   * - 能思考 + 声明了深度档位 → 一条 6 档滑块（第一档「不思考」就是关，不再单摆灯泡）
   * - 能思考但只有开关（Qwen3.5 系、部分 DeepSeek）→ 一枚灯泡
   * - 不会思考 → 什么都没有
   */
  /** 滑块当前值：关着思考就是第一档（档位本身留着，下次打开还是它） */
  const thinkingLevel: ThinkingLevel = thinking ? effort : 'none';
  // 沙箱 widget 是独立文档，拿不到 mdui 的 CSS 令牌，所以明暗得由宿主算完显式传进去。
  // （`useResolvedDark` 原先只服务 antd，这里是第二个消费者 —— 理由同为「明暗是 JS 算的」。）
  const widgetDark = useResolvedDark(useSettings((s) => s.theme));
  // 消息流滚动容器（原 Bubble.List 的 ref 只暴露 scrollTo，现在自己持有真实元素）
  const listRef = useRef<HTMLDivElement | null>(null);
  const deletionState = useRef({ loading, activeId });
  deletionState.current = { loading, activeId };
  const { deleteMessage, deleting } = useMessageDeletion(listRef, activeId, async (key) => {
    const message = msgs.find((item) => item.key === key);
    const database = db, lifetime = accountLifecycle.current();
    const current = () => database === db && (!lifetime || lifetime.current()) && deletionState.current.activeId === activeId;
    if (deletionState.current.loading || deletionState.current.activeId !== activeId
      || activeId == null || !message || message.streaming || message.rowId == null) return false;
    const remove = async () => {
      const row = await readConversationMessage(message.rowId!);
      if (!current()) return false;
      if (!row || row.sessionId !== activeId) return false;
      await removeConversationMessage(message.rowId!);
      return true;
    };
    const deleted = await remove();
    if (!deleted) return false;
    if (current()) {
      setMsgs((current) => current.filter((item) => item.key !== key));
    }
    return true;
  });
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

  /** 题卡作答：更新消息状态；已落库的同步回写 IndexedDB */
  const handleAnswer = async (key: string, qi: number, oi: QuizPick) => {
    // Revealing an explanation is a reading interaction, not new model output.
    pauseFollowing();
    const message = msgs.find(item => item.key === key), database = db, lifetime = accountLifecycle.current();
    if (!message?.quiz || message.rowId == null || !canUpdateQuizPick(message.quiz.data.questions[qi], message.quiz.picks[qi], oi)) return;
    const picks = [...message.quiz.picks]; picks[qi] = oi;
    const quiz = { ...message.quiz, picks };
    try {
      const row = await readConversationMessage(message.rowId);
      if (database !== db || lifetime && !lifetime.current()) return;
      if (!row || JSON.stringify(row.quiz) !== JSON.stringify(message.quiz)) throw new Error(chatText('chatPanel.quizChanged'));
      await editMessage(row, { ...row, quiz });
      if (database === db && (!lifetime || lifetime.current())) setMsgs(prev => prev.map(item => item.key === key ? { ...item, quiz } : item));
    } catch (error) { if (database === db && (!lifetime || lifetime.current())) toast.error(error instanceof Error ? error.message : chatText('chatPanel.answerSaveFailed')); }
  };

  /** 自定义链接渲染：#seek-N 跳播放器、#unit-N 跳材料对应页/段，其余外链新窗口打开 */
  const SeekLink = useCallback(
    ({ href, children }: ComponentProps & { href?: string }) => {
      const h = href ?? '';
      if (h.startsWith('#source-image/')) return <MaterialImage href={h} label={children} linkOnly onSource={readerRef && parseMaterialImageHref(h)?.courseId === videoId ? (unit) => { if (unit) readerRef.current?.scrollToUnit(unit); } : undefined} />;
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
        <a href={h} target="_blank" rel="noreferrer">
          {children}
        </a>
      );
    },
    [seekTo, readerRef, videoId],
  );

  // 上下文用量估算（system + 历史 + 当前输入/截图/引用），仅作 UI 提示
  const ctxBreakdown = useMemo(() => {
    // 注意 estimateTokens：两个 qaSystem 返回的都是**提示词文本**，忘了包就变成字符串拼接
    // 末尾的 canEditMd 参数：这里用「格式是 md」代替 send 里的完整判断（材料 + 编辑面开着）——
    // 注册表是模块级的，点「编辑」不会触发本组件重渲染，按状态算就得把它塞进 useMemo 依赖。
    // 于是按「最坏情况 = 多带一条可编辑规则」估：估高只是用量条早一点变色，估低会让用户以为还有余量。
    const sysText = isMaterial
      ? PROMPTS.qaSystemMaterial(videoName, materialKind!, undefined, shots.length, refs.length, materialFormat === 'md', agentInstructions)
      : PROMPTS.qaSystem(videoName, undefined, undefined, shots.length, refs.length, agentInstructions);
    const sys = estimateTokens(sysText);
    // 历史只发送 content，reasoning 不计入
    const historyRows = compressionEnabled ? retainedContext(msgs, contextPlan) : msgs;
    const hist = historyRows.reduce((s, m) => s + estimateTokens(m.content), 0);
    // 引用块会随本轮一起发出去，得算进去（一段 1200 字上限 ≈ 1.2k tokens），否则用量条会低估
    const refTokens = refs.reduce((n, c) => n + estimateTokens(c.text) + 12, 0);
    const cur = estimateTokens(input) + shots.length * 1200 + refTokens; // 每张图约 1.2k tokens
    return { system: sys, history: hist, current: cur };
  }, [msgs, input, shots, refs, videoName, isMaterial, materialKind, materialFormat, contextPlan, compressionEnabled, agentInstructions]);
  const ctxEst = ctxBreakdown.system + ctxBreakdown.history + ctxBreakdown.current;
  const contextCompression = useContextCompression({
    sessionId: activeId, tokens: ctxEst, windowTokens: ctxWin, query: input,
    busy: loading || !indexReady || activeId !== loadedSessionId,
  });
  const ratio = ctxEst / ctxWin;
  // 用量告警分三档（>90% 危险 / >70% 注意），色走 MD3 语义令牌
  const ctxLevel = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : '';

  /** 自定义图片渲染：#frame-秒 渲染课程画面缩略图（点击跳转），其余按原样 */
  const FrameImage = useCallback(
    ({ src, alt }: ComponentProps & { src?: string; alt?: string }) => {
      if (src?.startsWith('#frame-')) {
        return <FrameThumb secs={Number(src.slice(7))} alt={alt} frames={framesMeta} onSeek={seekTo} />;
      }
      if (src?.startsWith('#source-image/')) return <MaterialImage href={src} label={alt} onSource={readerRef && parseMaterialImageHref(src)?.courseId === videoId ? (unit) => { if (unit) readerRef.current?.scrollToUnit(unit); } : undefined} />;
      return <SourceImage src={src} alt={alt} />;
    },
    [framesMeta, seekTo, readerRef, videoId],
  );

  /** 读取讲义抽帧元数据（幻灯片帧，blob 不进状态） */
  const loadFramesMeta = useCallback(async () => {
    const database = db, owner = cloud.userId;
    const rows = cloud.enabled ? (await loadCollection<FrameRow>('frames', videoId)).filter(row => row.kind === 'slide').sort((a, b) => a.ts - b.ts) : await db.frames
      .where('videoId')
      .equals(videoId)
      .filter((r) => r.kind === 'slide')
      .sortBy('ts');
    if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
    const meta = rows.map((r) => ({ id: r.id!, ts: r.ts }));
    setFramesMeta(meta);
    return meta;
  }, [videoId]);

  /**
   * 初始化会话列表 + 判断「能不能提问」。
   *
   * 2026-09-24：检索改为词法后，这里**不再有建索引这一步**。原来是一段
   * 「查向量计数 → 缺就建 → 建好才置 indexReady」的流程，也带来过一整类 bug
   * （索引过期后计数仍然达标，于是永远不重建）。没有索引就没有这些问题。
    * 现在只检查有没有可检索的正文以显示提示；没有字幕也允许提问。
   */
  useEffect(() => {
    let cancelled = false;
    const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
    const current = () => !cancelled && database === db && owner === cloud.userId && (!lifetime || lifetime.current());
    setIndexReady(false);
    setIndexFailure(false);
    setIndexNote(null);
    (async () => {
      let list: ChatSessionRow[];
      let readiness: { hasMaterialText: boolean; hasSubtitles: boolean } | undefined;
      if (cloud.enabled) {
        const runtime = await serverRuntime(owner);
        if (!current()) return;
        const [response, content] = await Promise.all([
          runtime.read({ kind: 'sessionIndex', videoId, archived: false, recentOnly: false }),
          systemMaterialPath(videoId) ? undefined : runtime.read({ kind: 'courseReadiness', videoId }),
        ]);
        if (!current()) return;
        readiness = content?.value as unknown as typeof readiness;
        const index = response.value as unknown as SessionIndexPage;
        list = index.sessions.map(row => ({ id: row.id, videoId: row.videoId, title: row.title, createdAt: row.createdAt }));
        if (index.latestId != null && !list.some(row => row.id === index.latestId)) {
          const latest = await readConversationSession(index.latestId);
          if (latest) list.push(latest);
        }
        list.sort((a, b) => a.createdAt - b.createdAt || a.id! - b.id!);
      } else list = await db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt');
      if (!current()) return;
      if (list.length === 0) {
        const now = Date.now();
        const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
        list = [{ id, videoId, title: '新会话', createdAt: now }];
      }
      if (!current()) return;
      setSessions(list);
      setActiveId(list[list.length - 1].id!);

      if (systemMaterialPath(videoId)) {
        setIndexNote(null);
        setIndexReady(true);
        return;
      }
      if (readiness) {
        setIndexNote(isMaterial
          ? readiness.hasMaterialText ? null : chatText(materialKind === 'page' ? 'chatPanel.noSearchText' : 'chatPanel.noSearchBody')
          : readiness.hasSubtitles ? null : chatText('chatPanel.noSubtitlesYet'));
        setIndexReady(true);
        return;
      }
      // ── 阅读材料：检索的是文本块（materialBlocks）──
      if (isMaterial) {
        const hasBlocks = await materialBlocksSnapshotExist(videoId, () => { if (!current()) throw new Error('material_read_cancelled'); });
        if (!current()) return;
        // 没有可检索文字也能读取图片目录、展示原图或框选提问，不能把整个聊天锁死。
        if (!hasBlocks) {
          setIndexNote(
            materialKind === 'page'
              ? chatText('chatPanel.noSearchText')
              : chatText('chatPanel.noSearchBody'),
          );
          setIndexReady(true);
          return;
        }
        setIndexNote(null);
        setIndexReady(true);
        return;
      }

      const segCount = await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.status === 1 && !!r.text)
        .count();
      if (!current()) return;
      setIndexNote(segCount === 0
        ? chatText('chatPanel.noSubtitlesYet')
        : null);
      setIndexReady(true);
    })().catch(error => { if (current()) { setIndexNote(displayChatError(error instanceof Error ? error.message : String(error))); setIndexFailure(true); } });
    return () => {
      cancelled = true;
    };
  }, [videoId, isMaterial, indexAttempt]);

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
      // 复用行内编辑器的聚焦句柄。
      composerInput.current?.focus();
    }
    // send 每轮渲染都是新引用，放进依赖会无限触发；这里只在 pendingAsk 变化时消费一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAsk]);

  // 进入面板时预载帧元数据（历史消息里的画面引用回放需要）
  useEffect(() => {
    void loadFramesMeta();
  }, [loadFramesMeta]);

  // 切换会话时加载该会话的历史消息与技能范围
  useEffect(() => {
    if (activeId == null) {
      setMsgs([]);
      setSkillIds(undefined);
      setTurnSkillIds([]);
      setMcpServerIds(undefined);
      return;
    }
    let cancelled = false;
    setTurnSkillIds([]);
    setMsgs([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setHistoryError(false);
    historyRequest.current = false;
    (async () => {
      // 技能范围从库里现查而不是读 sessions state：会话行可能刚被别处改过，
      // 且这样 effect 只依赖 activeId，不会因为 sessions 数组变化而重载整个历史。
      const row = await readConversationSession(activeId);
      if (!cancelled) setSkillIds(row?.skillIds);
      if (!cancelled) setMcpServerIds(row?.mcpServerIds);
      if (!cancelled && row) setSessions(previous => [...previous.filter(item => item.id !== row.id).slice(-50), row]);
    })().catch(() => { if (!cancelled) setHistoryError(true); });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // A server-owned QA turn may originate on another device, or outlive this panel.
  useEffect(() => {
    let cancelled = false;
    let requested = 0;
    const refresh = async (page: Parameters<Parameters<typeof followServerSession>[1]['changed']>[0]) => {
      if (localRequest.current) return;
      const task = page.tasks.find(t => t.kind === 'qa' && t.input.sessionId === activeId);
      const revision = ++requested;
      const current = () => !cancelled && revision === requested && !localRequest.current;
      if (activeId == null) return;
      const running = task && isTaskUnfinished(task.status);
      if (running && !await (await import('../cloud/tasks')).syncTaskWidgets(task.progress)) return;
      const messages: ChatMsg[] = page.rows.filter(row => !running || row.taskId !== task.id || row.role !== 'assistant')
        .map(row => ({ ...row, key: `h-${row.id}`, rowId: row.id, role: row.role === 'user' ? 'user' : 'ai' }));
      if (running) messages.push({ key: `cloud-${task.id}`, taskId: task.id, role: 'ai', content: String(task.progress?.content ?? ''), reasoning: String(task.progress?.reasoning ?? ''),
        rowId: typeof task.progress?.rowId === 'number' ? task.progress.rowId : undefined,
        tools: Array.isArray(task.progress?.tools) ? task.progress.tools as unknown as ChatToolCall[] : undefined,
        responseSegments: task.progress?.responseSegments as ResponseSegment[] | undefined,
        processPhase: responsePhase(task.progress?.phase), processStartedAt: Date.parse(task.createdAt),
        widgets: Array.isArray(task.progress?.widgets) ? task.progress.widgets as unknown as WidgetPayload[] : undefined,
        widgetPreview: task.progress?.widgetPreview as { html: string } | undefined, streaming: true });
      else if (task && ['failed', 'interrupted', 'cancelled'].includes(task.status)) messages.push({ key: `cloud-${task.id}`, role: 'ai', content: task.error || chatText('chatPanel.taskStopped') });
      // Reconciliation must not remount an already opened iframe when the
      // in-flight message becomes a synced history row.
      setMsgs(current => messages.map(message => {
        const existing = current.find(item => item.role === message.role && (
          message.rowId != null && item.rowId === message.rowId || message.taskId && item.taskId === message.taskId));
        return existing ? { ...message, key: existing.key } : message;
      }));
      setHasOlder(page.hasOlder); setLoading(Boolean(running)); setLoadedSessionId(activeId);
    };
    // Metadata changes do not read/serialize message bodies. One shared journal
    // owns the loaded window, pagination fences, deletes and task checkpoints.
    const records = cloud.enabled ? undefined : liveQuery(() => db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt')).subscribe({
      next: list => { if (!cancelled) setSessions(list); },
      error: () => { if (!cancelled) setHistoryError(true); },
    });
    const follower = activeId == null ? undefined : followServerSession(activeId, {
      changed: refresh,
      failed: () => { if (!cancelled) setHistoryError(true); },
    });
    qaFollower.current = follower;
    return () => { cancelled = true; follower?.(); if (qaFollower.current === follower) qaFollower.current = undefined; records?.unsubscribe(); };
  }, [activeId, videoId]);

  const loadOlder = useCallback(async () => {
    const first = msgs[0];
    if (activeId == null || !hasOlder || historyRequest.current || first?.rowId == null) return;
    historyRequest.current = true;
    setLoadingOlder(true);
    setHistoryError(false);
    try {
      if (first.createdAt == null) throw new Error('invalid_session_cursor');
      await readChatPage(activeId, { id: first.rowId, createdAt: first.createdAt, role: first.role === 'user' ? 'user' : 'assistant' });
      // Only the journal's accepted page merge may publish pagination metadata.
    } catch {
      if (historySession.current === activeId) setHistoryError(true);
    } finally {
      if (historySession.current === activeId) {
        historyRequest.current = false;
        setLoadingOlder(false);
      }
    }
  }, [activeId, hasOlder, msgs]);

  const activeTitle = sessions.find((s) => s.id === activeId)?.title ?? '新会话';

  /** 当前会话 → Markdown 全文（复制与导出共用） */
  const sessionMarkdown = async () => {
    const rows = activeId == null ? [] : await readChatHistory(activeId);
    const ids = new Set(rows.map((row) => row.id));
    const all = [...rows.map((row) => ({ ...row, role: row.role === 'user' ? 'user' : 'ai' })), ...msgs.filter((m) => !ids.has(m.rowId))];
    return buildSessionMarkdown({
      title: activeTitle,
      videoName,
      messages: all.map((m) => ({
        role: m.role === 'user' ? ('user' as const) : ('assistant' as const),
        content: m.content,
        reasoning: m.reasoning,
        quiz: m.quiz,
      })),
    });
  };

  /** 导出整个会话为 .md 文件（归档/跨设备带走） */
  const downloadSession = async () => {
    if (msgs.length === 0) return void toast.info(chatText('chatPanel.sessionEmpty'));
    const url = URL.createObjectURL(new Blob([await sessionMarkdown()], { type: 'text/markdown;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(videoName, activeTitle);
    a.click();
    URL.revokeObjectURL(url);
    toast.success(chatText('chatPanel.exportedMarkdown'));
  };

  /**
   * 改当前会话的技能范围。
   *
   * UI 先落地、库写异步补上：勾选框是「点一下就该有反馈」的控件，等 IndexedDB 回来再重渲染
   * 会有一帧迟滞。写失败也只是下次切回来时回到旧范围，不会留下坏状态。
   */
  const updateMcpServerIds = async (next: string[] | undefined) => {
    if (activeId == null) return;
    await reviseConversationSession(activeId, row => {
      if (next === undefined) delete row.mcpServerIds;
      else row.mcpServerIds = next;
    });
    // 只需把这一条会话修订推上去：会话字段是学习命令 journal 的一部分，
    // 精确排空该实体即可，不再为此拉起全账号 records 周期。
    await (await import('../client/learning')).drainLearning([`session:${activeId}`]);
    if (historySession.current === activeId) setMcpServerIds(next);
  };
  const updateSkillIds = (next: number[] | undefined) => {
    if (activeId == null) return;
    setSkillIds(next);
    void reviseConversationSession(activeId, (row) => {
        // 「不限定」= 字段不存在，而不是「字段值为 undefined」—— 后者经过结构化克隆后
        // 到底留下 undefined 还是 null 依赖实现，删掉字段最干净、读回来必然 undefined。
        if (next === undefined) delete row.skillIds;
        else row.skillIds = next;
      });
  };

  /** 新开会话 */
  const createSession = async () => {
    const now = Date.now();
    const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
    setSessions((prev) => [...prev.filter(session => session.id !== id), { id, videoId, title: '新会话', createdAt: now }]);
    setActiveId(id);
  };

  /** 删除当前会话（删光后自动补一个空会话） */
  const deleteSession = async () => {
    if (activeId == null) return;
    await deleteServerSession(activeId, await readChatHistory(activeId));
    const rest = sessions.filter((s) => s.id !== activeId);
    if (rest.length === 0) {
      const now = Date.now();
      const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
      setSessions([{ id, videoId, title: '新会话', createdAt: now }]);
      setActiveId(id);
    } else {
      setSessions(rest);
      setActiveId(rest[rest.length - 1].id!);
    }
    toast.success(chatText('chatPanel.sessionDeleted'));
  };

  /**
   * 发送一轮提问。
   *
   * `extraRefs` 用于「解释这段」：那一步在 effect 里触发，走 refsRef 传进来，
   * 免得依赖 state 的落地时序。普通输入框发送不传，用当前引用条。
   */
  const send = async (question: string, extraRefs?: Citation[], suppliedSkills?: number[]) => {
    const q = question.trim();
    const curRefs = extraRefs ?? refsRef.current;
    // 引用也算内容：只划了词没打字也应能发送
    if ((!q && shots.length === 0 && curRefs.length === 0) || loading || activeId == null) return;
    if (!indexReady) {
      toast.warning(chatText('chatPanel.indexNotReady'));
      return;
    }
    const sessionId = activeId;
    /**
     * 框选截图与视频截图共用同一条多模态通道：把引用里的裁图折进 shots，
     * 下面的「多模态直读 / 视觉模型描述 / 不支持则拦截」三级降级链就**一行都不用改**。
     * 材料的锚点是页号，正好复用 Snapshot.ts 这个字段（语义由 isMaterial 决定）。
     */
    const refShots: Snapshot[] = curRefs
      .filter((c) => c.image)
      .map((c) => ({ dataUrl: c.image!.dataUrl, thumb: c.image!.thumb, ts: c.unit ?? 0 }));
    const curShots = [...shots, ...refShots].sort((a, b) => a.ts - b.ts);

    /** 素材标记：视频是 [截图@mm:ss]，材料是 [选区@第N页] */
    const shotTag = (s: Snapshot) =>
      isMaterial ? `[选区@${fmtUnitRef(materialKind!, s.ts)}]` : `[截图@${fmtTime(s.ts)}]`;

    // Screenshot capability and any vision-model preparation belong to the server.
    const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
    const current = () => database === db && owner === cloud.userId && (!lifetime || lifetime.current()) && historySession.current === sessionId;

    setInput('');
    setShots([]);
    setRefs([]);
    refsRef.current = [];
    setLoading(true);
    localRequest.current = true;

    const userKey = nextKey();
    const aiKey = nextKey();
    let answer = '';
    let reasoning = '';
    const selectedSkills = explicitSkillIds(suppliedSkills ?? turnSkillIds);
    let widgetState: WidgetPayload | undefined;
    const widgets: WidgetPayload[] = [];
    const abort = new AbortController();
    inflightAbort.current = abort;
    const updates = framePatch<ChatMsg>((patch) => {
      if (current()) setMsgs((prev) => prev.map((m) => (m.key === aiKey ? { ...m, ...patch } : m)));
    });
    const patchAi = updates.write;

    try {
      // 先上屏用户气泡与 AI 占位，此后描述/落库/问答任何一步抛错都能落到占位气泡上
      //
      // 引用块放在最前面：模型对「开头是引用、后面是问题」的结构最敏感，
      // 也让用户回看历史时一眼看到「我当时引的是哪一段」。
      const quoteBlock = curRefs.map(formatCitation).join('\n\n');
      const marker = curShots.map(shotTag).join('');
      const displayContent = (quoteBlock ? `${quoteBlock}\n\n` : '') + marker + q;
      const createdAt = Date.now();
      const userImages: ChatImage[] = curShots.map((s) =>
        isMaterial
          ? {
              ts: s.ts,
              thumb: s.thumb,
              label: `${fmtUnitRef(materialKind!, s.ts)}选区`,
              kind: 'page-selection' as const,
            }
          : { ts: s.ts, thumb: s.thumb },
      );
      setMsgs((prev) => [
        ...prev,
        {
          key: userKey,
          role: 'user',
          content: displayContent,
          explicitSkillIds: selectedSkills,
          createdAt,
          images: userImages.length > 0 ? userImages : undefined,
        },
        { key: aiKey, role: 'ai', content: '', streaming: true, processStartedAt: Date.now() },
      ]);

        const { runQa } = await import('../harness/qaRunner');
        const result = await runQa({ videoId, sessionId, text: (quoteBlock ? `${quoteBlock}\n\n` : '') + q,
          displayText: displayContent, chatImages: userImages, videoName, skillIds, explicitSkillIds: selectedSkills,
          modelSelection: taskModelChoice(sessionId),
          materialKind, materialFormat, refsCount: curRefs.length, shotCount: curShots.length,
          images: curShots.flatMap(s => [{ type: 'text' as const, text: shotTag(s) }, { type: 'image_url' as const, image_url: { url: s.dataUrl } }]),
        }, { signal: abort.signal,
          onPersist: rowId => patchAi({ rowId }),
          onWidgetPreview: preview => patchAi({ widgetPreview: preview }),
          onProgress: progress => { answer = progress.content; reasoning = progress.reasoning; updates.stream(progress); },
          onCard: card => {
            if (card.kind === 'widget') { widgetState = card.widget; widgets.push(card.widget); patchAi({ widgets: [...widgets], widget: card.widget }); }
          },
        });
        patchAi({ ...result, streaming: false, hint: undefined, widgetPreview: undefined });
        if (current()) { setTurnSkillIds([]); useTaskModel.getState().set(taskModelKey(sessionId)); }
    } catch (e) {
        // Server progress already owns the durable row. Never create a second
        // local assistant when a remote task fails before the next sync poll.
        const reason = e instanceof Error ? e.message : String(e);
        const useful = !!answer.trim() || !!widgetState;
        patchAi({ streaming: false, hint: undefined, widgetPreview: undefined,
          content: abort.signal.aborted ? `${answer}\n\n_（已停止生成）_` : useful ? answer : `回答失败：${reason}`,
          error: !useful && !abort.signal.aborted, interrupted: useful && !abort.signal.aborted,
          interruptReason: abort.signal.aborted ? undefined : reason });
    } finally {
      updates.flush();
      if (inflightAbort.current === abort) inflightAbort.current = null;
      if (current()) { localRequest.current = false; setLoading(false); qaFollower.current?.refresh(); }
    }
  };

  /**
   * 消息重试。语义与主页一致：
   * - 提问上的重试 = 重新回答这句话（删掉这一问一答，用同样的问题重跑）
   * - 回答上的重试 = 重新生成（只对最后一条完整回答成立）
   *
   * 判据在 UI 与这里各挡一道：删掉历史中间的一段是一次不可见的批量删除，
   * 要改中间那一步应该用「分支」。
   */
  const retryMessage = async (key: string) => {
    const database = db, lifetime = accountLifecycle.current();
    try {
    if (loading || activeId == null) return;
    const idx = msgs.findIndex((m) => m.key === key);
    const message = msgs[idx];
    if (!message) return;

    // 流式请求失败时，助手占位尚未落库，但用户问题已经落库；允许从这条失败消息继续，
    // 不要求先有一个 assistant rowId。删除原问题后交给 send 重新创建一轮，避免上下文重复。
    if (message.role === 'ai' && message.rowId == null && message.error) {
      const previous = msgs[idx - 1];
      if (!previous || previous.role !== 'user' || previous.rowId == null) return;
      const original = await readConversationMessage(previous.rowId);
      await removeConversationMessages([previous.rowId]);
      setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.key !== previous.key));
      await send(previous.content, undefined, original?.explicitSkillIds ?? turnSkillIds);
      return;
    }

    const rows = await readChatHistory(activeId);
    const rowIdx = rows.findIndex((row) => row.id === message.rowId);
    if (rowIdx < 0) return;

    if (message.role === 'user') {
      if (msgs[idx + 1]?.role !== 'ai' || idx !== msgs.length - 2) return;
      const tail = rows.slice(rowIdx);
      await removeConversationMessages(tail.flatMap(row => row.id != null ? [row.id] : []));
      setMsgs((prev) => prev.slice(0, idx));
      await send(message.content, undefined, rows[rowIdx].explicitSkillIds ?? []);
      return;
    }

    if (idx !== msgs.length - 1) return;
    let userIdx = -1;
    for (let i = rowIdx - 1; i >= 0; i--) {
      if (rows[i].role === 'user') {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;
    const userRow = rows[userIdx];
    await removeConversationMessages([...(message.rowId != null ? [message.rowId] : []), userRow.id!]);
    setMsgs((prev) => prev.filter((m) => m.key !== message.key && m.rowId !== userRow.id));
    await send(userRow.content, undefined, userRow.explicitSkillIds ?? []);
    } catch (error) {
      if (database === db && (!lifetime || lifetime.current())) toast.error(error instanceof Error ? error.message : chatText('chatPanel.answerSaveFailed'));
    }
  };

  /** 从某条消息处分叉出新会话（复制到这条为止，原会话不动）。 */
  const forkMessage = async (message: ChatMsg) => {
    if (loading || activeId == null || message.rowId == null) return;
    const source = await readConversationSession(activeId);
    if (!source) return;
    const rows = await readChatHistory(activeId);
    const cut = rows.findIndex((row) => row.id === message.rowId);
    if (cut < 0) return;
    const kept = rows.slice(0, cut + 1);
    if (kept.length === 0) return;
    const now = Date.now();
    const newId = await forkServerSession(source, kept);
    setSessions((prev) => [...prev.filter(session => session.id !== newId), {
      id: newId,
      videoId,
      title: `${source.title} · 分支`,
      createdAt: now,
      ...(source.skillIds !== undefined ? { skillIds: [...source.skillIds] } : {}),
      ...(source.mcpServerIds !== undefined ? { mcpServerIds: [...source.mcpServerIds] } : {}),
    }]);
    setActiveId(newId);
    toast.success(chatText('chatPanel.forkedToast'));
  };

  /** 停止生成：断掉当前的 LLM 请求与 agent 循环（已流出的内容保留） */
  const stopGenerating = () => {
    inflightAbort.current?.abort();
    if (activeId != null) void import('../cloud/tasks').then(tasks => tasks.cancelResourceTasks(`session:${activeId}`)).catch(error => toast.error((error as Error).message));
  };

  // 会话下拉：selectedKey 是字符串（HeroUI 的 Key），会话 id 是数字 —— 回传时转回数字。
  // 取消选择（key 为 null）时不动当前会话，保留原来「只处理有效值」的行为。
  const selectSession = (key: React.Key | null) => {
    if (key == null) return;
    const n = Number(key);
    if (Number.isFinite(n)) setActiveId(n);
  };
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

  /** 删除当前会话前确认（危险操作：确认按钮上错误色，文案写清动作） */
  const confirmDeleteSession = async () => {
    const ok = await popconfirm({
      headline: chatText('chatPanel.deleteSessionTitle'),
      description: chatText('chatPanel.deleteSessionDesc'),
      confirmText: chatText('chatPanel.delete'),
      danger: true,
      testId: 'session-delete-popconfirm',
    });
    if (ok) void deleteSession();
  };

  /** 顶部一排小图标按钮（新开 / 复制 / 导出 / 删除 / 思考开关） */
  const iconBtn = (
    testId: string,
    label: string,
    icon: React.ReactNode,
    onClick: () => void,
    disabled?: boolean,
    variant?: 'primary' | 'tertiary',
  ) => (
    <Tooltip>
      <Tooltip.Trigger>
        <Button
          isIconOnly
          variant={variant ?? 'tertiary'}
          size="sm"
          data-testid={testId}
          aria-label={label}
          isDisabled={disabled}
          onPress={onClick}
        >
          {icon}
        </Button>
      </Tooltip.Trigger>
      <Tooltip.Content>
        <p>{label}</p>
      </Tooltip.Content>
    </Tooltip>
  );

  return (
    <Panel testId="panel-chat">
      <PanelBar wrap={false} testId="chat-toolbar">
        <Select
          className="chat-session-select"
          selectedKey={activeId != null ? String(activeId) : null}
          onSelectionChange={selectSession}
          isDisabled={loading}
          data-testid="chat-session"
          aria-label={chatText('chatPanel.switchSession')}
        >
          <Select.Trigger>
            <Select.Value className="chat-session-title" title={activeTitle} />
            <Select.Indicator />
          </Select.Trigger>
          <Select.Popover>
            <ListBox>
              {sessions.map((s) => (
                <ListBox.Item key={s.id} id={String(s.id)} textValue={s.title}>
                  {s.title}
                </ListBox.Item>
              ))}
            </ListBox>
            {cloud.enabled && <div className="flex flex-wrap gap-1 p-1">
              {sessionIndex.page?.previous && <Button size="sm" variant="tertiary" isDisabled={sessionIndex.loading} onPress={sessionIndex.previous} data-testid="qa-sessions-previous">{navigationText('recent.previousPage')}</Button>}
              {sessionIndex.page?.next && <Button size="sm" variant="tertiary" isDisabled={sessionIndex.loading} onPress={sessionIndex.next} data-testid="qa-sessions-next">{navigationText('recent.nextPage')}</Button>}
              {sessionIndex.error && <><span role="status">{navigationText('recent.loadFailed')}</span><Button size="sm" variant="tertiary" onPress={sessionIndex.retry}>{navigationText('recent.retry')}</Button></>}
            </div>}
          </Select.Popover>
        </Select>
        {iconBtn('chat-new-session', chatText('chatPanel.newChat'), <Sym name="add" />, createSession, loading)}
        <CopyButton key={activeId} text={sessionMarkdown} label="复制整个会话（Markdown）" isIconOnly
          variant="tertiary" size="sm" data-testid="copy-session-btn" isDisabled={loading || msgs.length === 0} />
        {iconBtn('export-session-btn', chatText('chatPanel.exportMd'), <Sym name="download" />, downloadSession, loading || msgs.length === 0)}
        {iconBtn('chat-delete-session', chatText('chatPanel.deleteSession'), <Sym name="delete" />, confirmDeleteSession, loading)}
      </PanelBar>
      <SkillPicker onInserted={() => composerInput.current?.focus()} anchorRef={addButton} value={skillIds} onChange={updateSkillIds} turnValue={turnSkillIds} onTurnChange={setTurnSkillIds} disabled={loading} mcpValue={mcpServerIds} onMcpChange={updateMcpServerIds} isOpen={skillsOpen} onOpenChange={setSkillsOpen} hideTrigger />
      {learningPlugin.dialog}

      {/* 消息流：AI 靠左、用户靠右。两种气泡的形状差是 MD3 聊天的标志 ——
          靠对话侧收小圆角、另一侧全圆角。流式 markdown / 思考块 / 题卡都留在 AI 气泡内。 */}
      <div className="chat-message-viewport">
      <PanelBody bodyRef={listRef} className="chat-list-wrap" testId="chat-list">
        {activeId != null && loadedSessionId !== activeId && <ChatHistorySkeleton />}
        {msgs.length === 0 && (activeId == null || loadedSessionId === activeId) && (
          <PanelPlaceholder testId="chat-empty">针对课程内容提问，回答中的时间戳可点击跳转</PanelPlaceholder>
        )}
        {msgs.length > 0 && loadedSessionId === activeId && <div className="chat-panel-history" data-chat-session-id={activeId} aria-live="polite">
          {hasOlder && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
            {loadingOlder ? chatText('chat.loadingEarlier') : historyError ? chatText('chat.historyLoadFailed') : chatText('chat.loadEarlier')}
          </button>}
        </div>}
        {msgs.length > 0 && loadedSessionId === activeId && <VirtualMessages key={activeId} items={msgs} scrollRef={listRef} ref={virtualMessagesRef} onResize={pinList}>{(m, index) => {
          const isUser = m.role === 'user';
          /** 与主页同一套判据：回答只重试最后一条；提问只重试「答复就在末尾」的那一句 */
          const canRetry = !isUser && index === msgs.length - 1;
          const canRetryAsk = isUser && msgs[index + 1]?.role === 'ai' && index === msgs.length - 2;
          return (
            <div
              key={m.key}
              className={(isUser ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--ai')
                + (entering.has(m.key) ? ' t-msg-enter' : '')}
              data-testid={isUser ? 'chat-msg-user' : 'chat-msg-ai'}
              data-streaming={m.streaming ? 'true' : undefined}
              data-error={m.error ? 'true' : undefined}
              data-chat-message={m.key}
            >
              {isUser ? (
                <>
                  {m.images && m.images.length > 0 && <ChatScreenshots images={m.images} materialKind={materialKind}
                    onSource={image => image.kind === 'page-selection' ? readerRef?.current?.scrollToUnit(image.ts) : seekTo(image.ts)} />}
                  <UserMessageBubble
                    message={m}
                    busy={loading || deleting}
                    canRetry={canRetryAsk}
                    onRetry={() => void retryMessage(m.key)}
                    onFork={() => void forkMessage(m)}
                    onDelete={() => void deleteMessage(m.key)}
                  />
                  {!m.streaming && m.rowId != null && (
                    <MessageActions
                      content={m.content}
                      isUser
                      busy={loading || deleting}
                      canRetry={canRetryAsk}
                      retryHint={chatText('chatPanel.retryFull')}
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              ) : (
                <>
                  <ArtifactEditProvider rowId={m.rowId} content={m.content} disabled={loading || !!m.streaming || !!m.error}
                    onSaved={(row) => setMsgs((prev) => prev.map((item) => item.rowId === row.id ? { ...item, content: row.content, responseSegments: row.responseSegments, widget: row.widget, widgets: row.widgets } : item))}>
                  <div className="chat-bubble chat-bubble--ai">
                        <WidgetMessage message={m} content={m.error ? displayChatFailure(m.content) : m.content} dark={widgetDark} rowId={m.rowId}
                          disabled={loading || !!m.streaming || !!m.error} onPrompt={(text) => void send(text)}>
                        {(markdown) => (
                          <ResponseTimeline message={m} content={markdown}>
                          {(content, active) => <AssistantContent content={content} streaming={active}>
                            {(part, streaming) => (
                              <MarkdownStreamingProvider value={streaming}>
                                <XMarkdown
                                  // 材料只跑 linkifyUnits：#seek- 需要一个存在的播放器，
                                  // 材料没有播放器，留着会生成点了没反应的死链；
                                  // #frame- 画面引用同理（材料没有抽帧）。
                                  content={
                                    isMaterial && materialKind
                                      ? linkifyUnits(part, materialKind)
                                      : linkifyTimestamps(linkifyFrames(part))
                                  }
                                  components={{ a: SeekLink, p: StreamParagraph, img: FrameImage, code: MarkdownCode, pre: MarkdownPre, table: MarkdownTable }}
                                  streaming={{ hasNextChunk: streaming, tail: streaming }}
                                />
                              </MarkdownStreamingProvider>
                            )}
                          </AssistantContent>}
                          </ResponseTimeline>
                        )}
                        </WidgetMessage>
                        {m.quiz && (
                          <QuizCard
                            notebookSource={{ courseId: videoId, name: videoName }}
                            quiz={m.quiz.data}
                            picks={m.quiz.picks}
                            onAnswer={(qi, oi) => handleAnswer(m.key, qi, oi)}
                            onReview={loading || m.streaming ? undefined : (text) => void send(text)}
                            onSeek={seekTo}
                            // 材料没有播放器：解析里的时间戳不 linkify，免得出现点了没反应的死链
                            seekable={!isMaterial}
                          />
                        )}
                        {m.widgetPreview && (
                          <WidgetStreamFrame html={m.widgetPreview.html} dark={widgetDark} status={chatText('chatPanel.generatingWidget')} />
                        )}
                  </div>
                  </ArtifactEditProvider>
                  {!m.streaming && m.interrupted && m.key === latestInterruptedKey && (
                    <div className="chat-note chat-note--interrupted" role="status" data-testid="chat-interrupted">
                      <span>{chatText('chat.interrupted')}{m.interruptReason ? `：${displayChatError(m.interruptReason)}` : ''}</span>
                      <Button size="sm" variant="tertiary" className="chat-note__continue" onPress={() => void retryMessage(m.key)}>
                        {chatText('chat.continue')}
                      </Button>
                    </div>
                  )}
                  {!m.streaming && (m.content || m.widget || m.quiz) && (m.rowId != null || m.error) && (
                    <MessageActions
                      content={m.content}
                      isUser={false}
                      busy={loading || deleting}
                      canRetry={canRetry}
                      retryHint={chatText('chatPanel.regenerate')}
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              )}
            </div>
          );
        }}</VirtualMessages>}
      </PanelBody>
      </div>

      {/* 缺少可检索正文时提示能力边界，不禁用输入区 */}
      {indexNote && (
        <div className="chat-note" data-testid="chat-index-note">
          <Sym name="warning" className="chat-note__icon" />
          <span>{indexNote}</span>
          {indexFailure && <Button size="sm" variant="tertiary" data-testid="chat-index-retry" onPress={() => setIndexAttempt(value => value + 1)}>{chatText('chatPanel.retry')}</Button>}
        </div>
      )}

      {/* 输入区与首页一致：添加、文本、模型和发送共用一行，长文本按需增高。
          Enter 发送、Shift+Enter 换行；isComposing 时放行（中文输入法选词的回车不是提交意图）。 */}
      <div className="chat-composer" data-testid="chat-composer">
        {/*
          引用条：划词/框选带进来的原文片段（最多 MAX_REFS 条）。
          单独一行而不是塞进输入框文本里 —— 用户能一眼看清引了什么、能单条删掉，
          也不会污染自己正在写的句子。
        */}
        {refs.length > 0 && (
          <div className="chat-refs" data-testid="chat-refs">
            {refs.map((c, i) => (
              <span
                key={`${c.source}-${c.unit ?? c.time ?? 0}-${i}`}
                className="chat-ref"
                data-testid="chat-ref-chip"
              >
                {c.image && <img src={c.image.thumb} alt="" className="chat-ref__img" />}
                <span className="chat-ref__body">
                  {c.unitLabel && <span className="chat-ref__where">{c.unitLabel}</span>}
                  <span className="chat-ref__text" title={c.text}>
                    {c.text}
                  </span>
                </span>
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="chat-ref__remove"
                  aria-label={chatText('chatPanel.removeQuote')}
                  data-testid="ref-chip-remove"
                  onPress={() => {
                    const next = refs.filter((_, j) => j !== i);
                    refsRef.current = next;
                    setRefs(next);
                  }}
                >
                  <Sym name="close" />
                </Button>
              </span>
            ))}
          </div>
        )}
        {shots.length > 0 && (
          <div className="chat-shots chat-shots--pending">
            {shots.map((s, i) => (
              <span key={i} className="chat-shot">
                <img src={s.thumb} alt="" className="chat-shot__img chat-shot__img--sm" />
                <span className="chat-ts-chip">
                  {isMaterial ? fmtUnitRef(materialKind!, s.ts) : fmtTime(s.ts)}
                </span>
                <Button
                  isIconOnly
                  variant="tertiary"
                  size="sm"
                  className="chat-shot__remove"
                  aria-label={chatText('chatPanel.removeShot')}
                  onPress={() => setShots((prev) => prev.filter((_, j) => j !== i))}
                >
                  <Sym name="close" />
                </Button>
              </span>
            ))}
          </div>
        )}
        <div className="chat-composer__row">
          <ComposerExpand visible={composerOverflow} key={activeId} value={input} onChange={setInput}
            renderInput={className => <InlineSkillInput expanded autoFocus className={className} label={chatText('chatPanel.fullMessage')}
              value={input} onChange={setInput} skillIds={turnSkillIds} availableSkillIds={skillIds} onSkillsChange={setTurnSkillIds} />} />
          <div className="chat-input" data-testid="chat-input">
            <InlineSkillInput
              documentKey={activeId}
              label={chatText('chatPanel.composerLabel')}
              placeholder={indexReady ? chatText('chatPanel.inputReady') : chatText('chatPanel.inputWaiting')}
              disabled={!indexReady}
              value={input}
              ref={composerInput}
              onChange={setInput}
              skillIds={turnSkillIds}
              availableSkillIds={skillIds}
              onSkillsChange={setTurnSkillIds}
              onOverflowChange={setComposerOverflow}
              onFocus={pinList}
              onSubmit={() => void send(input)}
            />
          </div>
          <div className="chat-composer__tools">
          <Dropdown isOpen={addOpen} onOpenChange={setAddOpen}>
            <Button ref={addButton} isIconOnly variant="tertiary" size="sm" data-testid="panel-chat-add"
              aria-label={chatText('chatPanel.addMenuAria')} isDisabled={activeId == null || activeId !== loadedSessionId}>
              <Sym name="add" />
            </Button>
            <Dropdown.Popover placement="top start">
              <div className="px-2 py-1">
                <TaskModelPicker sessionId={activeId} />
              </div>
              <Dropdown.Menu aria-label={chatText('chatPanel.addToQA')}
                disabledKeys={[
                  ...(!indexReady || loading ? ['shot', 'quiz', 'question-bank', 'bank-practice'] : []),
                  ...(!practiceAvailable ? ['quiz', 'question-bank', 'bank-practice'] : []),
                  ...(!reviewAvailable ? ['review'] : []),
                  ...(shots.length >= 4 ? ['shot'] : []),
                ]}
                onAction={(key) => {
                  if (key === 'shot') addShot();
                  else if (key === 'quiz') openLearningPlugin('practice');
                  else if (key === 'quiz') void assertPluginAvailable('practice').then(() => send('根据课程内容出 3 道单选题考考我，选项要有干扰性')).catch(e => toast.error(e.message));
                  else if (key === 'question-bank') openLearningPlugin('practice');
                  else if (key === 'question-bank') void send('请按「原题题库」技能，逐页提取这份资料的原题，保留题号、题干、选项和原图引用，核对原文答案及解析，并用 edit 保存到 /courses/current/questions.md。已有题库就读最新版后继续，不覆盖用户修改。缺答案和无法辨读的题明确标注；预算不足先保存已完成部分并说明尚未覆盖范围，不要重新编题。保存后给我题库链接，并展示第一批原题供我直接作答和批改。');
                  else if (key === 'bank-practice') openLearningPlugin('practice');
                  else if (key === 'bank-practice') void send(`请从题库最新版开始做原题。${materialFormat === 'md' ? '先 read 当前 Markdown 原文：若它本身含原题 quiz 数据块，使用 /courses/current/material，否则使用 /courses/current/questions.md。' : '题库路径为 /courses/current/questions.md。'}调用 present_quiz 的 path 参数，每批最多 5 题，不要改写或提前透露答案。若题库尚不存在，请说明并引导先提取原题。`);
                  else if (key === 'review') openLearningPlugin('review');
                  else if (key === 'skills') setSkillsOpen(true);
                }}>
                {!isMaterial && <Dropdown.Item id="shot" textValue={chatText('chatPanel.shot')} data-testid="shot-btn"><Sym name="photo_camera" />{chatText('chatPanel.shot')}</Dropdown.Item>}
                <Dropdown.Item id="quiz" textValue={chatText('chatPanel.quizMe')} data-testid="quiz-btn"><Sym name="quiz" />{chatText('chatPanel.quizMe')}</Dropdown.Item>
                {isMaterial && <Dropdown.Item id="question-bank" textValue={chatText('chatPanel.extractQuestions')} data-testid="question-bank-extract"><Sym name="description" />{chatText('chatPanel.extractQuestions')}</Dropdown.Item>}
                {isMaterial && <Dropdown.Item id="bank-practice" textValue={chatText('chatPanel.startQuiz')} data-testid="question-bank-practice"><Sym name="quiz" />{chatText('chatPanel.startQuiz')}</Dropdown.Item>}
                {<Dropdown.Item id="review" textValue={chatText('chatPanel.reviewList')} data-testid="question-bank-review"><Sym name="checklist" />{chatText('chatPanel.reviewList')}</Dropdown.Item>}
                <Dropdown.Item id="skills" textValue={settingsText('skillPicker.title')}><Sym name="extension" />{settingsText('skillPicker.title')}{skillIds !== undefined || mcpServerIds !== undefined ? chatText('chatPanel.restrictedSuffix') : ''}</Dropdown.Item>
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
          {/* 上文用量环：只留环，不再跟一串 `≈2.1k / 131k` 文字 —— 常驻的估值
              在工具行上太吵（详情在环的弹层里），文字还会把发送键从最右侧挤开。
              环排在发送键**前面**，发送键永远占最右那一格。 */}
          <div className={ctxLevel ? `chat-ctx chat-ctx--${ctxLevel}` : 'chat-ctx'} data-testid="chat-ctx">
            <ContextUsageButton
              tokens={ctxEst} windowTokens={ctxWin} breakdown={ctxBreakdown} testId="panel-context-usage"
              compression={contextCompression.state} onCompress={contextCompression.compress}
              isDisabled={loading || !indexReady || activeId == null || activeId !== loadedSessionId}
            />
          </div>
          {/* 生成中：发送键**变成**停止键。单课程问答没有课程上下文要等用户，
              所以不用给「提问卡悬着」开口子（那边是例外）。 */}
          {loading ? (
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="secondary"
                  size="sm"
                  className="chat-send"
                  data-testid="chat-stop"
                  aria-label={chatText('chatPanel.stop')}
                  onPress={stopGenerating}
                >
                  <Sym name="stop" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>停止生成</p>
              </Tooltip.Content>
            </Tooltip>
          ) : (
            <Tooltip>
              <Tooltip.Trigger>
                <Button
                  isIconOnly
                  variant="primary"
                  size="sm"
                  className="chat-send"
                  data-testid="chat-send"
                  aria-label={chatText('chatPanel.send')}
                  isDisabled={!indexReady}
                  onPress={() => send(input)}
                >
                  <Sym name="arrow_upward" />
                </Button>
              </Tooltip.Trigger>
              <Tooltip.Content>
                <p>发送</p>
              </Tooltip.Content>
            </Tooltip>
          )}
          </div>
        </div>
      </div>
    </Panel>
  );
}
