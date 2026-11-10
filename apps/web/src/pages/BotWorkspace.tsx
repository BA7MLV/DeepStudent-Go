import { Suspense, lazy, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Avatar, Button, Dropdown, ListBox, Modal, Spinner, cn } from '@heroui/react';
import { PageLoader, PageShell, Sym, toast, promptDialog, popconfirm } from '../ui';
import { openSettings } from '../components/settingsDialogStore';
import { cloud } from '../cloud/state';
import TaskModelPicker from '../components/TaskModelPicker';
import { taskModelChoice } from '../store/taskModel';
import { MoreMenu, type MenuAction } from '../ui';
import { useBotPanel } from '../store/botPanel';
import { serverClient, type ApprovalDto, type ThreadDetail, type Session, type ThreadQuestionDto } from '../api/serverClient';
import type { AgentProfileDto, BootstrapStatusDto, BotActivityDto, MessageDto, ProjectDetailDto, ThreadDto } from '@wangke/contracts';
import { parseBotAttachments, parseLegacyBotAttachments, MAX_BOT_ATTACHMENTS, type BotAttachment } from '@wangke/contracts';
import { BotAttachmentDraft, BotMessageAttachments, type BotDraftFile } from '../components/BotAttachments';
import { botProgressText } from '@wangke/contracts/cloud';
import MessageComposer from '../components/MessageComposer';
import VirtualMessages from '../components/VirtualMessages';
import { compactThreadTitle, formatListTime, createMessageGrouper, timeOf, type Row } from './botMessages';
import DeliveryReceipt from '../components/DeliveryReceipt';
import AccessForm from './BotAccess';
import './bot.css';
import { useBotHistory } from './useBotHistory';
import { mergeMessages } from './botMessageCache';
import BotMessageBoundary from './BotMessageBoundary';
import BotMcpScope from '../mcp/BotMcpScope';
import { MODAL_CONTAINER_CLASS } from '../ui/modalContainer';
import { useTranslation } from 'react-i18next';
import ProjectSettings from '../projects/ProjectSettings';
import ProjectFiles from '../projects/ProjectFiles';
import { projectError } from '../projects/errors';
import '../projects/projects.css';

/** 富内容渲染器（Markdown / 代码 / 表格 / HTML artifact）按需加载，纯文字聊天不下载它。 */
const BotRich = lazy(() => import('./BotRich'));
const WebSources = lazy(() => import('../web-search/WebSources'));
import { parseWebSearchResult } from '@wangke/contracts/web-search';
/** 看起来像 Markdown 的回复才走富渲染：普通聊天句子保持轻量的纯文本气泡。 */
const looksRich = (text: string) => /(^|\n)\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|\|.*\|)|```|\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|\$\$?[^$]+\$/.test(text);

/*
 * Bot 的两处落点，共用同一个对话区与同一份样式（bot.css）：
 *   - 主页右侧的 Bot 栏（BotPanel）：一条连续的对话，标题即会话切换器；
 *   - 项目页（默认导出）：PageShell 里左列会话、右列对话或文件；手机上两列变两屏。
 * 视觉与课程问答一致：没有气泡尾巴、送达勾和浮动日期。
 */

/** 窄屏：两栏收成两屏。和 bot.css 里的断点保持一致。 */
const NARROW_QUERY = '(max-width: 760px)';
function useNarrow() {
  const [narrow, setNarrow] = useState(() => window.matchMedia(NARROW_QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia(NARROW_QUERY);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    setNarrow(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

/* ─────────────────────────── 头像 ─────────────────────────── */

/** iOS 通讯录式的字母头像：英文取前两个词的首字母，其他语言取第一个字。 */
function monogram(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  if (words.length > 1 && /^[a-z]/i.test(words[0]) && /^[a-z]/i.test(words[1])) return (words[0][0] + words[1][0]).toUpperCase();
  return [...words[0]][0].toUpperCase();
}

const BotAvatar = memo(function BotAvatar({ agent, size = 40, className }: { agent?: AgentProfileDto | null; size?: number; className?: string }) {
  const name = agent?.name ?? '';
  const raw = agent?.avatar?.trim() ?? '';
  const src = /^(https?:|data:image\/|\/)/.test(raw) ? raw : undefined;
  // 头像字段里放一个 emoji 也能用。
  const glyph = raw && !src && [...raw].length <= 2 ? raw : monogram(name);
  return (
    <Avatar className={cn('bh-avatar', className)} style={{ '--bh-avatar': `${size}px` } as CSSProperties} aria-hidden="true">
      {src && <Avatar.Image src={src} alt="" />}
      <Avatar.Fallback className="bh-avatar__fallback">{glyph}</Avatar.Fallback>
    </Avatar>
  );
});

/** 顶栏浮在消息之上；实测高度让首条消息避开安全区和动态状态行。 */
function BotTopBar({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const parent = bar?.parentElement;
    if (!bar || !parent) return;
    const measure = () => parent.style.setProperty('--bot-bar-h', `${bar.offsetHeight}px`);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(bar);
    return () => {
      observer.disconnect();
      parent.style.removeProperty('--bot-bar-h');
    };
  }, []);
  return (
    <header ref={ref} className={cn('bot-top-bar', className)}>
      <div className="page-app-bar__blur page-app-bar__blur--always" aria-hidden="true">
        <span /><span /><span /><span />
      </div>
      {children}
    </header>
  );
}

const IDLE_ACTIONS = ['star', 'pillow', 'paws', 'cloud'] as const;

/** Decorative waiting, not execution claims. Unmount immediately on real progress. */
function BotIdleAction() {
  const { t } = useTranslation();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) setIndex(value => (value + 1) % IDLE_ACTIONS.length);
    }, 4200);
    return () => window.clearInterval(timer);
  }, []);
  const text = t(`botHome.activity.idle.${IDLE_ACTIONS[index]}`);
  return <span className="bot-activity__text" key={text} aria-hidden="true">{text}</span>;
}

/** Web live work label. Only selected runtime milestones are also projected to IM. */
function BotActivity({ active, activity, progress }: { active: boolean; activity?: BotActivityDto | null; progress?: string }) {
  const { t, i18n } = useTranslation();
  if (!active) return null;
  // 真实状态优先；泛化的 running / 无进度时才显示不冒充实际工作的可爱动作。
  const reported = botProgressText(progress ?? '', i18n.language).replace(/\s+/g, ' ').trim();
  const tools = activity?.tools.map(tool => tool.name).join(' · ');
  const text = (activity && activity.phase !== 'running' ? activity.phase === 'tools'
    ? t(activity.activeTools > 1 ? 'botHome.activity.parallel' : 'botHome.activity.tools', { tools, count: activity.activeTools })
    : t(`botHome.activity.${activity.phase}`)
    : (activity === undefined && reported) || '').slice(0, 200);
  return (
    <div className="bot-activity" role="status" aria-live={text ? 'polite' : 'off'} aria-label={text ? undefined : t('botHome.activity.waiting')} data-phase={activity?.phase ?? 'idle'}>
      <span className="bot-activity__spark" aria-hidden="true">✦</span>
      {text ? <span className="bot-activity__text" key={text} title={text}>{text}</span> : <BotIdleAction />}
      {activity && activity.completedTools > 0 && <span className="bot-activity__count">{t('botHome.activity.returned', { count: activity.completedTools })}</span>}
    </div>
  );
}

/* ─────────────────────────── 单条气泡 ─────────────────────────── */

const Bubble = memo(function Bubble({
  row,
  approval,
  question,
  onReact,
  onResolve,
  onAnswer,
  projectId,
  rich,
}: {
  row: Row;
  approval?: ApprovalDto;
  question?: ThreadQuestionDto;
  onReact: (messageId: string) => void;
  onResolve: (approvalId: string, approved: boolean) => void;
  onAnswer: (question: ThreadQuestionDto) => void;
  projectId?: string;
  /** 项目里 Bot 的文字回复一律走富渲染；聊天里只有像 Markdown 的才走。 */
  rich?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { message, first, last, stamp, status } = row;
  const mine = message.role === 'user';
  // 只有刚到的消息播入场动效；虚拟列表滚回来重新挂载的旧消息不再动一遍。
  const [fresh] = useState(() => Date.now() - timeOf(message) < 4000);
  const pending = message.id.startsWith('pending-');
  const attachment = message.kind === 'attachment' ? parseBotAttachments(message.content)
    : mine && message.kind === 'text' ? parseLegacyBotAttachments(message.content) : null;
  let body;
  if (message.kind === 'progress') {
    const progress = botProgressText(message.content, i18n.language);
    // 进度用「正在输入」的三点气泡，正文是 Bot 当前在做的事。
    body = (
      <div className="imsg-bubble imsg-bubble--typing" role="status" aria-label={progress || t('botHome.typingShort')}>
        <span className="imsg-typing" aria-hidden="true"><i /><i /><i /></span>
        {progress && <span className="imsg-typing__text">{progress}</span>}
      </div>
    );
  } else if (message.kind === 'web_sources') {
    const result = parseWebSearchResult(message.content);
    body = result ? <div className="imsg-bubble imsg-bubble--rich"><Suspense fallback={null}><WebSources result={result} /></Suspense></div> : null;
  } else if (attachment) {
    body = (
      <div className="bot-attachment-message">
        <BotMessageAttachments files={attachment.files} projectId={projectId} compact={mine} />
        {attachment.text && <div className="imsg-bubble"><p className="imsg-text">{attachment.text}</p></div>}
      </div>
    );
  } else if (message.kind === 'approval' || message.kind === 'question') {
    const waiting = message.kind === 'approval' && approval?.status === 'pending';
    body = (
      <div className="imsg-bubble imsg-bubble--action">
        <p className="imsg-text">{message.content}</p>
        {waiting && approval && (
          <div className="imsg-actions">
            <Button size="sm" variant="secondary" onPress={() => onResolve(approval.id, false)}>{t('botHome.reject')}</Button>
            <Button size="sm" variant="primary" onPress={() => onResolve(approval.id, true)}>{t('botHome.approve')}</Button>
          </div>
        )}
        {approval && approval.status !== 'pending' && (
          <span className="imsg-resolved" data-status={approval.status}>
            <Sym name={approval.status === 'approved' ? 'check' : 'close'} />
            {approval.status === 'approved' ? t('botHome.approved') : t('botHome.rejected')}
          </span>
        )}
        {message.kind === 'question' && question?.status === 'pending' && (
          <div className="imsg-actions"><Button size="sm" variant="primary" onPress={() => onAnswer(question)}>{t('botHome.answer')}</Button></div>
        )}
      </div>
    );
  } else if (message.kind === 'widget') {
    // Bot 线程不执行任意 widget，只把源码当作代码块安全地展示。
    body = (
      <div className="imsg-bubble imsg-bubble--code">
        <pre>{message.content.slice(0, 1000)}</pre>
      </div>
    );
  } else if (!mine && (rich || looksRich(message.content))) {
    body = (
      <div className="imsg-bubble imsg-bubble--rich" title={row.time} onDoubleClick={pending ? undefined : () => onReact(message.id)}>
        <Suspense fallback={<p className="imsg-text">{message.content}</p>}>
          <BotRich content={message.content} />
        </Suspense>
      </div>
    );
  } else {
    body = (
      <div className="imsg-bubble" title={row.time} onDoubleClick={mine || pending ? undefined : () => onReact(message.id)}>
        <p className="imsg-text">{message.content}</p>
      </div>
    );
  }

  return (
    <>
      {stamp && <div className="imsg-stamp"><span>{stamp}</span></div>}
      <div
        className={cn('imsg-row', mine ? 'imsg-row--mine' : 'imsg-row--theirs')}
        data-first={first || undefined}
        data-last={last || undefined}
        data-pending={pending || undefined}
        data-fresh={fresh || undefined}
        data-day={row.day}
      >
        <BotMessageBoundary key={message.content} content={message.content}>{body}</BotMessageBoundary>
      </div>
      {/* iMessage：只在自己最后一条下面写一次「已读 / 已送达」。 */}
      {row.lastMine && status && <DeliveryReceipt status={status} createdAt={timeOf(message)} />}
    </>
  );
});

/* ─────────────────────────── 页面 ─────────────────────────── */

const EMPTY: MessageDto[] = [];

/** 项目页（#/projects/:id 与其 /files）。 */
export default function BotWorkspace() {
  const { projectId } = useParams();
  return <Workspace key={projectId ?? 'bots'} projectId={projectId} />;
}

/**
 * Bot 辅助栏：对话主页右侧的一项功能，而不是一个独立页面。
 * 宽屏并排在主列右边，窄屏由 PageShell 放进全屏面板。
 */
export function BotPanel({ onClose }: { onClose: () => void }) {
  return <Workspace embedded onClose={onClose} />;
}

/** 列表预览只要一句人话：去掉 Markdown 记号、代码块和表格竖线。 */
function plainPreview(text: string) {
  return text
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/^\s*\|?\s*:?-{2,}.*$/gm, ' ')
    .replace(/[|*_`#>~]+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function lastText(messages: MessageDto[] | undefined) {
  if (!messages) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].kind === 'text') return messages[i];
  return undefined;
}

function Workspace({ projectId, embedded = false, onClose }: { projectId?: string; embedded?: boolean; onClose?: () => void }) {
  const { t, i18n } = useTranslation();
  const { t: ts } = useTranslation('settings');
  const { t: tp } = useTranslation('projects');
  const locale = i18n.language;
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  // 渲染只读取请求；消费放在 effect 中，否则每次重渲染都会提前清掉新到的跳转请求。
  const initialThreadId = useRef(embedded ? useBotPanel.getState().requestedThread : search.get('thread'));
  /** 内嵌在主页时 URL 属于对话页，Bot 的线程不写进地址栏。 */
  const setThreadParam = (value: Record<string, string>) => { if (!embedded) setSearch(value, { replace: true }); };
  const filesOpen = Boolean(projectId && location.pathname.endsWith('/files'));
  const narrow = useNarrow();
  /** 窄屏时显示哪一屏。宽屏两栏并排，这个值不起作用。 */
  const [pane, setPane] = useState<'list' | 'chat'>(() => (initialThreadId.current || filesOpen ? 'chat' : 'list'));
  const [mcpOpen, setMcpOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [project, setProject] = useState<ProjectDetailDto | null>(null);
  const [agents, setAgents] = useState<AgentProfileDto[]>([]);
  const [agentId, setAgentId] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [listMoreBusy, setListMoreBusy] = useState(false);
  const [listMoreError, setListMoreError] = useState(false);
  const listMoreFlight = useRef(false);
  const protocol = useRef(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [messageTarget, setMessageTarget] = useState<{ kind: 'run'; runId: string } | { kind: 'question'; questionId: string } | undefined>();
  const sendLock = useRef(false);
  const loadVersion = useRef(0);
  const [status, setStatus] = useState<BootstrapStatusDto | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [connectError, setConnectError] = useState('');
  /** 线程列表只拿摘要；详情（消息）只为当前打开的线程拉。 */
  const [threads, setThreads] = useState<ThreadDto[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const history = useBotHistory(session?.authenticated ? session.user?.id ?? null : null, activeId, !filesOpen, status?.botSyncVersion === 1);
  const { details, setDetails, patchActive, detailError } = history;
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draftKey = activeId ?? `new:${agentId}`;
  const draft = drafts[draftKey] ?? '';
  const setDraft = (value: string) => setDrafts(old => ({ ...old, [draftKey]: value }));
  const [attachmentDrafts, setAttachmentDrafts] = useState<Record<string, BotDraftFile[]>>({});
  const draftFiles = attachmentDrafts[draftKey] ?? [];
  const attachmentsPending = draftFiles.some(file => !file.uploaded || !!file.error || file.editing);
  const uploadFlights = useRef(new Set<string>());
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const positionedThread = useRef(activeId);
  if (positionedThread.current !== activeId) {
    positionedThread.current = activeId;
    stickRef.current = history.reading?.follow ?? true;
  }
  /** 每个线程有没有任务在跑：决定「正在输入」和已读。 */
  const [running, setRunning] = useState<Record<string, boolean>>({});
  const chatMode = !projectId;

  const active = activeId ? details[activeId] ?? null : null;
  useEffect(() => {
    if (!active) return;
    setThreads(old => old.map(thread => thread.id === active.id && (thread.title !== active.title || thread.archived !== active.archived || thread.updatedAt < active.updatedAt)
      ? { ...thread, title: active.title, archived: active.archived, updatedAt: active.updatedAt } : thread));
  }, [active?.id, active?.title, active?.archived, active?.updatedAt]);
  const activeSummary = threads.find((thread) => thread.id === activeId) ?? null;
  const availableAgents = agents.filter(agent => agent.enabled && (!projectId || project?.grants.some(g => g.agentId === agent.id)));
  const agentOf = useCallback((thread: ThreadDto | null) => agents.find(a => a.id === (thread?.agentId ?? agents[0]?.id)) ?? null, [agents]);
  const currentAgentId = activeSummary ? activeSummary.agentId ?? agents[0]?.id ?? '' : agentId;
  const currentAgent = agents.find(a => a.id === currentAgentId) ?? null;
  const canChat = !listLoading && !listError && !project?.archived && !activeSummary?.archived && availableAgents.some(a => a.id === currentAgentId);
  const messages = active?.messages ?? EMPTY;
  const activeRuns = active?.runs ?? [];
  const activeBusy = Boolean(activeId && (activeRuns.length
    ? activeRuns.some(run => ['queued', 'running', 'waiting_user', 'waiting_event'].includes(run.status))
    : active?.running ?? running[activeId]));
  const activeWaiting = activeRuns.some(run => run.status === 'waiting_event');
  const activeModelRunning = activeRuns.some(run => ['queued', 'running'].includes(run.status));
  const activeRunning = activeModelRunning || (!activeRuns.length && Boolean(activeId && (active?.running ?? running[activeId])));
  const activeRunTarget = activeRuns.find(run => ['queued', 'running', 'waiting_event'].includes(run.status));
  /** 最近一条内部进度用于 Web 顶栏；普通进度不会成为聊天或 IM 回复。 */
  const activeProgress = history.reading?.progress;
  const groupMessages = useMemo(() => createMessageGrouper(), [activeId, locale]);
  const rows = useMemo(() => {
    // Optimistic "running" only controls the stop/typing UI, not a read receipt.
    const grouped = groupMessages(messages, locale);
    // 只显示无执行细节的输入指示，历史工具进度已在分组前过滤。
    const tail = grouped.at(-1)?.message;
    if (activeRunning && tail) {
      const typing: MessageDto = { id: 'typing', threadId: tail.threadId, clientNonce: null, seq: Number.MAX_SAFE_INTEGER, role: 'assistant', kind: 'progress', content: '', createdAt: new Date().toISOString(), replyTo: null };
      return grouped.concat({ key: 'typing', message: typing, first: true, last: true, stamp: null, day: grouped[grouped.length - 1]?.day ?? '', time: '' });
    }
    return grouped;
  }, [messages, locale, activeRunning, groupMessages]);
  const approvalByMessage = useMemo(() => {
    const map = new Map<string, ApprovalDto>();
    for (const approval of active?.approvals ?? []) map.set(approval.messageId, approval);
    return map;
  }, [active?.approvals]);
  const questionByMessage = useMemo(() => {
    const map = new Map<string, ThreadQuestionDto>();
    for (const question of active?.questions ?? []) map.set(question.messageId, question);
    return map;
  }, [active?.questions]);

  /** 列表行：最后一句话优先用已经拉到的消息，没拉过的线程用列表接口带回的 preview。 */
  const listRows = useMemo(() => threads
    .filter(thread => showArchived || !thread.archived)
    .map(thread => {
      const last = lastText(details[thread.id]?.messages);
      const time = last && last.createdAt > thread.updatedAt ? last.createdAt : thread.updatedAt;
      return { thread, preview: plainPreview(last?.content ?? thread.preview ?? ''), time };
    })
    .sort((a, b) => b.time.localeCompare(a.time)), [threads, details, showArchived]);

  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    setListError(''); setListLoading(true);
    try {
      const [result, profiles, nextProject] = await Promise.all([protocol.current ? serverClient.threadPage(projectId) : serverClient.threads(projectId), serverClient.agents(), projectId ? serverClient.project(projectId) : Promise.resolve(null)]);
      if (loadVersion.current !== version) return;
      const bots = result.threads.filter(thread => thread.mode === 'bot' && (projectId ? thread.projectId === projectId : !thread.projectId));
      setListCursor('nextCursor' in result ? result.nextCursor as string | null : null);
      const requestedId = initialThreadId.current;
      if (protocol.current && requestedId && !bots.some(thread => thread.id === requestedId)) {
        const summary = await serverClient.threadSummary(requestedId);
        if (loadVersion.current !== version) return;
        if (summary.mode === 'bot' && (projectId ? summary.projectId === projectId : !summary.projectId)) bots.unshift(summary);
      }
      setThreads(bots); setAgents(profiles.agents); setProject(nextProject);
      const firstAgent = profiles.agents.find(a => a.enabled && (!nextProject || nextProject.grants.some(g => g.agentId === a.id)));
      const requested = bots.find(thread => thread.id === initialThreadId.current);
      // 聊天模式只有一条连续的对话：默认接着最近那条往下聊。
      const latest = !projectId ? bots.find(thread => !thread.archived) : undefined;
      const target = requested ?? latest;
      if (target) { setActiveId(target.id); setAgentId(target.agentId ?? firstAgent?.id ?? ''); if (target.archived) setShowArchived(true); }
      else setAgentId(id => id && profiles.agents.some(a => a.id === id) ? id : firstAgent?.id ?? '');
      // 还没有任何会话时，手机上直接落在问候页，而不是一张空列表。
      if (!requested && !bots.some(thread => !thread.archived)) setPane('chat');
      initialThreadId.current = null;
    } catch (error) { if (loadVersion.current === version) setListError(projectError(error)); }
    finally { if (loadVersion.current === version) setListLoading(false); }
  }, [projectId]);

  useEffect(() => {
    let ignore = false;
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()])
      .then(([nextStatus, nextSession]) => {
        if (ignore) return;
        setStatus(nextStatus);
        protocol.current = nextStatus.botSyncVersion === 1;
        setSession(nextSession);
        if (nextSession.authenticated) void refresh();
      })
      .catch((e) => { if (!ignore) setConnectError(t('botHome.offline')); });
    return () => { ignore = true; loadVersion.current++; };
  }, [refresh, t]);

  const loadMoreThreads = async () => {
    if (!listCursor || listMoreFlight.current) return;
    listMoreFlight.current = true; setListMoreBusy(true); setListMoreError(false);
    const version = loadVersion.current;
    try {
      const page = await serverClient.threadPage(projectId, listCursor);
      if (loadVersion.current !== version) return;
      setThreads(old => { const rows = new Map(old.map(thread => [thread.id, thread])); for (const thread of page.threads) if (!rows.has(thread.id)) rows.set(thread.id, thread); return [...rows.values()]; });
      setListCursor(page.nextCursor);
    } catch { setListMoreError(true); }
    finally { listMoreFlight.current = false; setListMoreBusy(false); }
  };

  // 吸底：用户停在底部时，新消息和高度变化都把视图留在最新一条；往上翻了就不打扰。
  const followEnd = useCallback(() => {
    const scroll = scrollRef.current;
    if (scroll && stickRef.current) scroll.scrollTop = scroll.scrollHeight;
  }, []);
  useEffect(followEnd, [rows.length, followEnd]);

  const create = async () => {
    if (!agentId || project?.archived) return null;
    const thread = await serverClient.createThread(tp('newTitle'), { projectId, agentId });
    setThreads((old) => [thread, ...old]);
    setDetails((old) => ({ ...old, [thread.id]: { ...thread, messages: [] } }));
    setActiveId(thread.id);
    setThreadParam({ thread: thread.id });
    return thread;
  };
  const leaveFiles = () => { if (filesOpen) navigate(`/library/folders/${projectId}/chat`); };
  const newDraft = () => { setActiveId(null); setMessageTarget(undefined); setThreadParam({}); };
  /** 和某个 Bot 开始一段新对话：落在它的问候页。 */
  const startWith = (id: string) => { setAgentId(id); newDraft(); leaveFiles(); setPane('chat'); };
  const openThread = (thread: ThreadDto) => {
    setActiveId(thread.id);
    if (thread.agentId) setAgentId(thread.agentId);
    setPane('chat');
    setMessageTarget(undefined);
    if (filesOpen) navigate(`/library/folders/${projectId}/chat?thread=${thread.id}`);
    else setThreadParam({ thread: thread.id });
  };

  /* 已经打开着 Bot 栏时又点了「接管」之类的链接：切到那条线程。 */
  const requestedThread = useBotPanel((state) => state.requestedThread);
  useEffect(() => {
    if (!embedded || !requestedThread || listLoading) return;
    const id = useBotPanel.getState().consumeRequest();
    const hit = threads.find((thread) => thread.id === id);
    if (hit) openThread(hit);
    else if (id) { initialThreadId.current = id; void refresh(); }
    // openThread 每次渲染都是新函数；这里只该在请求到来时跑一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embedded, requestedThread, listLoading, threads, refresh]);

  const appendPending = (threadId: string, kind: MessageDto['kind'], content: string, nonce: string): MessageDto => {
    const pending: MessageDto = {
      id: `pending-${nonce}`, threadId, clientNonce: nonce, seq: Number.MAX_SAFE_INTEGER,
      role: 'user', kind, content, createdAt: new Date().toISOString(), replyTo: null,
    };
    patchActive(threadId, (thread) => ({ ...thread, messages: [...thread.messages, pending] }));
    stickRef.current = true;
    return pending;
  };
  const settlePending = (threadId: string, pendingId: string, accepted: MessageDto | null) => {
    patchActive(threadId, (thread) => ({
      ...thread,
      messages: accepted
        ? mergeMessages(thread.messages, [accepted])
        : thread.messages.filter((message) => message.id !== pendingId),
    }));
  };
  const mergeThread = (updated: ThreadDto) => setThreads(old => old.map(thread => thread.id === updated.id ? { ...thread, ...updated } : thread));

  const send = async () => {
    const modelSelection = taskModelChoice(activeId);
    if (!canChat || attachmentsPending || (!draft.trim() && !draftFiles.length) || sendLock.current || (activeId && !active)) return;
    sendLock.current = true; setSendBusy(true);
    const content = draft.trim();
    const nonce = crypto.randomUUID();
    const sourceKey = draftKey;
    const files = draftFiles;
    let targetId: string | undefined;
    let pending: MessageDto | undefined;
    let clearedDraft = false;
    try {
      const target = active ?? await create();
      if (!target) return;
      targetId = target.id;
      // A first send creates a thread; move its draft without touching other conversations.
      if (sourceKey !== target.id) {
        setDrafts(old => { const next = { ...old, [target.id]: old[sourceKey] ?? '' }; delete next[sourceKey]; return next; });
        setAttachmentDrafts(old => { const next = { ...old, [target.id]: old[sourceKey] ?? [] }; delete next[sourceKey]; return next; });
      }
      // Files upload on selection; never create/send a conversation for a partial batch.
      const attachments = files.map(item => item.uploaded!);
      const payload = attachments.length ? JSON.stringify({ ...attachments[0], attachments, caption: content }) : content;
      // Do not append across a trimmed, unloaded gap while the reader is in history.
      if (target.id === activeId && !await history.jumpLatest()) throw new Error('load_failed');
      history.setReading(true, scrollRef.current?.scrollTop ?? 0);
      pending = appendPending(target.id, attachments.length ? 'attachment' : 'text', payload, nonce);
      // Keep edits made during submission. A failed send restores the submitted draft.
      if ((drafts[sourceKey] ?? '').trim() === content) {
        clearedDraft = true;
        setDrafts(old => old[target.id]?.trim() === content ? { ...old, [target.id]: '' } : old);
      }
      settlePending(target.id, pending.id, await (attachments.length
         ? serverClient.sendAttachment(target.id, payload, nonce, messageTarget, undefined, modelSelection)
         : serverClient.sendMessage(target.id, payload, nonce, messageTarget, undefined, modelSelection)));
       setMessageTarget(undefined);
      setAttachmentDrafts(old => ({ ...old, [target.id]: (old[target.id] ?? []).filter(item => !files.some(file => file.id === item.id)) }));
      setRunning(old => ({ ...old, [target.id]: true }));
      if (target.title === tp('newTitle')) {
        const updated = await serverClient.updateThread(target.id, { title: (content || files[0]?.file.name || '').slice(0, 60) }).catch(() => null);
        if (updated) mergeThread(updated);
      }
       } catch (error) {
       if (error instanceof Error && ['target_expired', 'question_already_answered', 'target_waiting_for_specific_answer'].includes(error.message)) setMessageTarget(undefined);
       if (targetId && pending) settlePending(targetId, pending.id, null);
      if (clearedDraft) setDrafts(old => ({ ...old, [targetId ?? sourceKey]: old[targetId ?? sourceKey] || content }));
      toast.error(projectError(error));
    } finally { sendLock.current = false; setSendBusy(false); }
  };

  const storeDraftFile = async (file: File): Promise<BotAttachment> => {
    if (projectId) {
      const result = await serverClient.uploadProjectFile(projectId, file.name, file);
      return { projectId, projectPath: result.path, originalName: file.name, mimeType: file.type, sizeBytes: file.size };
    }
    const result = await serverClient.uploadFile(file);
    return { fileId: result.id, originalName: result.originalName, mimeType: result.mimeType, sizeBytes: result.sizeBytes };
  };

  const uploadDraftFile = async (item: BotDraftFile) => {
    if (item.uploaded || uploadFlights.current.has(item.id)) return;
    uploadFlights.current.add(item.id);
    // Locate by ID so switching conversations or creating a thread cannot misroute completion.
    const patch = (updates: Partial<BotDraftFile>) => setAttachmentDrafts(old => Object.fromEntries(
      Object.entries(old).map(([key, files]) => [key, files.some(file => file.id === item.id)
        ? files.map(file => file.id === item.id ? { ...file, ...updates } : file) : files]),
    ));
    patch({ error: undefined });
    try {
      const uploaded = await storeDraftFile(item.file);
      patch({ uploaded, error: undefined });
    } catch (error) { patch({ error: projectError(error) }); }
    finally { uploadFlights.current.delete(item.id); }
  };

  const replaceDraftFile = async (id: string, file: File) => {
    const original = draftFiles.find(item => item.id === id);
    if (!original?.uploaded || original.editing || sendLock.current || uploadFlights.current.has(id)) throw new Error(i18n.t('interface:imageCrop.wait'));
    uploadFlights.current.add(id);
    const patch = (update: (item: BotDraftFile) => BotDraftFile) => setAttachmentDrafts(old => Object.fromEntries(
      Object.entries(old).map(([key, files]) => [key, files.map(item => item.id === id ? update(item) : item)]),
    ));
    patch(item => ({ ...item, editing: true }));
    try {
      const uploaded = await storeDraftFile(file);
      const replacement = { id: crypto.randomUUID(), file, uploaded };
      patch(() => replacement);
      // Project uploads are user resources: keep the original, never overwrite/delete it.
    } catch (error) { patch(() => original); throw new Error(projectError(error)); }
    finally { uploadFlights.current.delete(id); }
  };

  const addFiles = (files: File[]) => {
    if (!canChat) return;
    if (files.some(file => !file.size || file.size > 20 * 1024 * 1024)) { toast.error('附件不能为空，单个附件不能超过 20 MB'); return; }
    if (files.length + draftFiles.length > MAX_BOT_ATTACHMENTS) { toast.error(`最多添加 ${MAX_BOT_ATTACHMENTS} 个附件`); return; }
    const items = files.map(file => ({ id: crypto.randomUUID(), file }));
    setAttachmentDrafts(old => ({ ...old, [draftKey]: [...(old[draftKey] ?? []), ...items].slice(0, MAX_BOT_ATTACHMENTS) }));
    for (const item of items) void uploadDraftFile(item);
  };

  const react = useCallback(async (messageId: string) => {
    try {
      await serverClient.react(messageId, '👍');
      toast.success('👍');
    } catch {
      toast.error(t('botHome.reactFailed'));
    }
  }, [t]);

  const resolveApproval = useCallback(async (approvalId: string, approved: boolean) => {
    if (!activeId) return;
    try {
      const resolved = await serverClient.resolveApproval(approvalId, approved);
      patchActive(activeId, (thread) => ({ ...thread, approvals: thread.approvals?.map((approval) => approval.id === approvalId ? resolved : approval) }));
    } catch {
      toast.error(t('botHome.approvalFailed'));
    }
  }, [activeId, patchActive, t]);

  const stop = async () => {
    if (!active) return;
    try {
      const result = await serverClient.stopThread(active.id);
      setRunning(old => ({ ...old, [active.id]: false }));
      toast.info(result.stopped ? t('botHome.stopped') : t('botHome.notRunning'));
    } catch {
      toast.error(t('botHome.stopFailed'));
    }
  };

  const answerQuestion = useCallback((question: ThreadQuestionDto) => {
    if (question.status !== 'pending') return;
    setMessageTarget({ kind: 'question', questionId: question.id });
    setDrafts(old => ({ ...old, [draftKey]: old[draftKey] ?? '' }));
    toast.info(t('botHome.answerPrompt'));
  }, [draftKey, t]);

  const continueRun = useCallback(() => {
    if (!activeRunTarget) return;
    setMessageTarget({ kind: 'run', runId: activeRunTarget.id });
  }, [activeRunTarget]);

  const clearTarget = useCallback(() => setMessageTarget(undefined), []);

  const editThread = async (thread: ThreadDto, action: 'rename' | 'archive' | 'delete') => {
    try {
      if (action === 'delete') {
        if (!await popconfirm({ headline: tp('deleteConfirm', { name: thread.title }), description: tp('sessionDeleteHint'), confirmText: tp('delete'), danger: true, testId: 'bot-thread-delete-popconfirm' })) return;
        await serverClient.deleteThread(thread.id);
        setThreads(old => old.filter(row => row.id !== thread.id));
        if (activeId === thread.id) { newDraft(); setPane('list'); }
        setDetails(old => { const next = { ...old }; delete next[thread.id]; return next; });
        return;
      }
      let title: string | null = null;
      if (action === 'rename') {
        title = await promptDialog({ headline: tp('rename'), defaultValue: thread.title ?? '', confirmText: tp('save'), cancelText: tp('cancel') });
        if (!title) return;
      }
      const updated = await serverClient.updateThread(thread.id, title ? { title } : { archived: !thread.archived });
      mergeThread(updated);
      patchActive(thread.id, detail => ({ ...detail, ...updated }));
      if (updated.archived && activeId === thread.id && !showArchived) { newDraft(); setPane('list'); }
    } catch (error) { toast.error(projectError(error)); }
  };

  const reload = () => {
    void Promise.all([serverClient.bootstrapStatus(), serverClient.session()]).then(([nextStatus, nextSession]) => {
      setStatus(nextStatus);
      protocol.current = nextStatus.botSyncVersion === 1;
      setSession(nextSession);
      if (nextSession.authenticated) return refresh();
      return undefined;
    });
  };

  /* 内嵌在主页右侧时，加载 / 登录态也待在这块面板里，不另起一页。 */
  const panelBar = (extra?: ReactNode) => (
    <BotTopBar className="bot-panel__bar">
      <h2 className="bot-panel__title" title={currentAgent?.name || 'Bot'}>{currentAgent?.name || 'Bot'}</h2>
      <div className="bot-panel__actions">
        {extra}
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.close')} data-testid="bot-panel-close" onPress={onClose}>
          <Sym name="close" />
        </Button>
      </div>
    </BotTopBar>
  );
  const frame = (body: ReactNode, title = 'Bot') => embedded
    ? <section className="bot-panel" aria-label="Bot">{panelBar()}{body}</section>
    : <PageShell title={title} onBack={() => navigate('/library')}>{body}</PageShell>;

  if (!status) {
    return frame(
      <div className="bot-center">
        {connectError
          ? <div className="bot-center__error" role="alert"><p>{connectError}</p><Button size="sm" variant="secondary" onPress={reload}>{tp('retry')}</Button></div>
          : embedded ? <Spinner size="lg" color="current" /> : <PageLoader contained />}
      </div>,
    );
  }

  if (!session?.authenticated) {
    return frame(<AccessForm initialized={status.initialized} hasPasskey={status.hasPasskey} onDone={reload} />);
  }

  /* ── 菜单 ── */

  const runActions: MenuAction[] = [
    { key: 'stop', label: t('botHome.stop'), icon: <Sym name="stop" />, disabled: !activeBusy, onAction: () => void stop() },
    ...(!projectId ? [{ key: 'permissions', label: t('botHome.permissions'), icon: <Sym name="tune" />, onAction: () => openSettings('bot') }] : []),
    ...(!projectId ? [{ key: 'mcp', label: ts('mcp.scope'), icon: <Sym name="extension" />, disabled: !active, onAction: () => setMcpOpen(true) }] : []),
  ];
  const threadMenu: MenuAction[] = activeSummary ? [
    { key: 'rename', label: tp('rename'), icon: <Sym name="edit" />, onAction: () => void editThread(activeSummary, 'rename') },
    { key: 'archive', label: tp(activeSummary.archived ? 'restore' : 'archive'), icon: <Sym name={activeSummary.archived ? 'archive_restore' : 'archive'} />, onAction: () => void editThread(activeSummary, 'archive') },
    ...runActions,
    { key: 'delete', label: tp('delete'), icon: <Sym name="delete" />, danger: true, onAction: () => void editThread(activeSummary, 'delete') },
  ] : [];

  const landing = !activeId && !filesOpen;
  const chatTitle = filesOpen ? tp('files') : activeSummary?.title && activeSummary.title !== tp('newTitle') ? compactThreadTitle(activeSummary.title) : currentAgent?.name ?? '';
  const fullChatTitle = filesOpen ? tp('files') : activeSummary?.title || chatTitle;

  /* ── 对话区（Bot 栏与项目共用） ── */

  const conversation = filesOpen ? (project && <div className="bh-files"><ProjectFiles key={project.id} project={project} /></div>) : <>
    <div className="bh-scroll-wrap">
      <div
        ref={scrollRef}
        className="bot-messages"
        data-sync-status={history.syncStatus}
        onScroll={(event) => {
          const el = event.currentTarget;
           stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
           if (el.querySelector('[data-chat-positioned="false"]')) return;
           const top = el.getBoundingClientRect().top;
           const first = [...el.querySelectorAll<HTMLElement>('[data-message-key]')].find(row => row.getBoundingClientRect().bottom > top + 80);
           history.setReading(stickRef.current, el.scrollTop, first ? { key: first.dataset.messageKey!, offset: first.getBoundingClientRect().top - top } : undefined);
           if (!stickRef.current && el.scrollTop < 80 && !history.historyError) void history.loadOlder();
        }}
      >
        {listLoading ? <div className="bot-center">{embedded ? <Spinner color="current" /> : <PageLoader contained />}</div> : landing ? (
          <div className="bh-hello">
            {projectId && !availableAgents.length ? <p className="bh-hello__note">{tp('noAgent')}</p> : <>
              <BotAvatar agent={currentAgent} size={72} className="bh-hello__avatar" />
              <p className="bh-hello__name">{currentAgent?.name}</p>
            </>}
          </div>
        ) : !active ? (
          <div className="bot-center">{detailError ? <div className="bh-inline-error" role="alert">{projectError(new Error(detailError))}<Button size="sm" variant="secondary" onPress={history.retry}>{tp('retry')}</Button></div> : embedded ? <Spinner color="current" /> : <PageLoader contained />}</div>
        ) : (
          <>
          {history.hasOlder && <div className="bot-history-control"><Button size="sm" variant="ghost" isDisabled={history.loadingOlder} onPress={() => { stickRef.current = false; void history.loadOlder(); }}>{history.loadingOlder ? t('botHome.loadingHistory') : history.historyError ? t('botHome.retryHistory') : t('botHome.loadHistory')}</Button></div>}
          <VirtualMessages items={rows} scrollRef={scrollRef} onResize={followEnd} key={active.id} positionEmpty initialAnchor={history.reading?.follow ? undefined : history.reading?.anchor}>
            {(row) => (
              <Bubble
                row={row}
                approval={approvalByMessage.get(row.message.id)}
                question={questionByMessage.get(row.message.id)}
                onReact={react}
                onResolve={resolveApproval}
                onAnswer={answerQuestion}
                projectId={projectId}
                rich={Boolean(projectId)}
              />
            )}
          </VirtualMessages>
          </>
        )}
      </div>
       {(history.hasNewer || !stickRef.current) && (
         <button
           type="button"
           className="bot-jump-latest"
           aria-label={t('botHome.jumpLatest')}
           onClick={() => { void history.jumpLatest().then(ok => { if (ok) { stickRef.current = true; followEnd(); } }); }}
         >
           <Sym name="arrow_downward" />
         </button>
       )}
      {history.syncStatus === 'offline' && <span className="bot-sync-status" role="status">{t('botHome.reconnecting')}</span>}
      {history.syncStatus === 'error' && <span className="bot-sync-status" role="alert">{t('botHome.syncError')}</span>}
      <span className="sr-only" aria-live="polite" aria-atomic="true">{history.announcement ? `${history.announcement} · ${t('botHome.newMessage')}` : ''}</span>
    </div>

    <MessageComposer
      key={draftKey}
      className="bot-composer"
      ariaLabel={t('botHome.composer')}
      placeholder={project?.archived ? tp('readOnly') : t('botHome.taskPlaceholder')}
      value={draft}
      onChange={setDraft}
      onSubmit={() => void send()}
      disabled={!canChat || Boolean(activeId && !active)}
      sending={sendBusy}
      attachmentsPending={attachmentsPending}
      hasAttachments={draftFiles.length > 0}
       busy={activeRunning}
       onStop={() => void stop()}
      onFiles={addFiles}
      onFocus={followEnd}
      onScope={active && !projectId ? () => setMcpOpen(true) : undefined}
      onSettings={() => projectId ? setSettingsOpen(true) : openSettings('bot')}
      attachLabel={t('botHome.attach')}
        accessory={<>
          <TaskModelPicker sessionId={activeId} />
         {messageTarget && <div className="imsg-composer__target" role="status">
           <span>{messageTarget.kind === 'question' ? t('botHome.answerTarget') : t('botHome.continueTarget')}</span>
           <Button size="sm" variant="tertiary" onPress={clearTarget}>{t('botHome.clearTarget')}</Button>
         </div>}
         {activeRunTarget && !messageTarget && <div className="imsg-composer__target">
           <Button size="sm" variant="tertiary" onPress={continueRun}>{t('botHome.continueCurrent')}</Button>
         </div>}
          {draftFiles.length ? <BotAttachmentDraft files={draftFiles} sending={sendBusy}
            onReplace={replaceDraftFile}
            onRetry={id => { const item = draftFiles.find(file => file.id === id); if (item) void uploadDraftFile(item); }}
            onRemove={id => setAttachmentDrafts(old => ({ ...old, [draftKey]: (old[draftKey] ?? []).filter(file => file.id !== id) }))} /> : null}
       </>}
    />
  </>;

  const modals = <>
    {settingsOpen && project && <ProjectSettings project={project} agents={agents} onChange={next => { setProject(next); const first = next.grants.find(g => agents.some(a => a.id === g.agentId && a.enabled)); if (!next.grants.some(g => g.agentId === agentId)) setAgentId(first?.agentId ?? ''); }} onClose={() => setSettingsOpen(false)} />}
    <Modal.Root isOpen={mcpOpen} onOpenChange={setMcpOpen}><Modal.Backdrop><Modal.Container size="md" className={MODAL_CONTAINER_CLASS}><Modal.Dialog>
      <Modal.Header><Modal.Heading>{ts('mcp.scope')}</Modal.Heading></Modal.Header>
      <Modal.Body>{mcpOpen && activeId ? <BotMcpScope key={activeId} threadId={activeId} /> : null}</Modal.Body>
      <Modal.Footer><Button onPress={() => setMcpOpen(false)}>{ts('mcp.save')}</Button></Modal.Footer>
    </Modal.Dialog></Modal.Container></Modal.Backdrop></Modal.Root>
  </>;

  /* ── Bot 栏：标题即会话切换器（HIG pull-down），右侧「新对话」「更多」「关闭」 ── */

  if (embedded) {
    const recentThreads = listRows.filter(row => !row.thread.archived);
    const historyMenu = (
      <Dropdown>
        <Button variant="ghost" className="bot-panel__switcher" aria-label={t('botHome.history')} data-testid="bot-panel-history">
          <BotAvatar agent={currentAgent} size={28} />
          <span className="bot-panel__switcher-name" title={landing ? currentAgent?.name || 'Bot' : fullChatTitle}>{landing ? currentAgent?.name || 'Bot' : chatTitle}</span>
          <Sym name="keyboard_arrow_down" aria-hidden="true" />
        </Button>
        <Dropdown.Popover placement="bottom start" className="bot-panel__history">
          <Dropdown.Menu
            aria-label={t('botHome.history')}
            selectionMode="single"
            selectedKeys={activeId ? [activeId] : []}
             onAction={(key) => {
               if (key === 'load-more-threads') { void loadMoreThreads(); return; }
              const hit = threads.find(thread => thread.id === String(key));
              if (hit) openThread(hit);
            }}
          >
            {recentThreads.map(({ thread, time }) => (
              <Dropdown.Item key={thread.id} id={thread.id} textValue={compactThreadTitle(thread.title) || tp('newTitle')}>
                <span className="min-w-0 flex-1 truncate" title={thread.title ?? undefined}>{compactThreadTitle(thread.title) || tp('newTitle')}</span>
                <time className="shrink-0 text-xs text-muted" dateTime={time}>{formatListTime(time, locale)}</time>
              </Dropdown.Item>
             ))}
             {listCursor && <Dropdown.Item id="load-more-threads" textValue={t('botHome.moreConversations')} isDisabled={listMoreBusy}>{t(listMoreError ? 'botHome.retryHistory' : 'botHome.moreConversations')}</Dropdown.Item>}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    );
    return (
      <section className="bot-panel" data-landing={landing || undefined} aria-label="Bot" data-testid="bot-panel">
        <BotTopBar className="bot-panel__bar">
          <div className="bot-panel__identity">
            {recentThreads.length > 0 || listCursor ? historyMenu : (
              <h2 className="bot-panel__switcher bot-panel__switcher--static">
                <BotAvatar agent={currentAgent} size={28} />
                <span className="bot-panel__switcher-name" title={currentAgent?.name || 'Bot'}>{currentAgent?.name || 'Bot'}</span>
              </h2>
            )}
            <BotActivity active={activeBusy} activity={history.reading?.activity} progress={activeWaiting ? t('botHome.waitingBackground') : activeProgress} />
          </div>
          <div className="bot-panel__actions">
            <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.compose')} data-testid="bot-panel-new"
              isDisabled={landing || sendBusy} onPress={() => { newDraft(); }}>
              <Sym name="edit" />
            </Button>
            <MoreMenu label={t('botHome.more')} actions={activeSummary ? threadMenu : runActions} testId="bot-panel-more" />
            <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.close')} data-testid="bot-panel-close" onPress={onClose}>
              <Sym name="close" />
            </Button>
          </div>
        </BotTopBar>
        {conversation}
        {modals}
      </section>
    );
  }

  /* ── 项目：左边会话列表，右边对话或文件，外面是全应用同一个 PageShell ── */

  const listMenu: MenuAction[] = [
    { key: 'archived', label: t(showArchived ? 'botHome.hideArchived' : 'botHome.showArchived'), icon: <Sym name="archive" />, onAction: () => setShowArchived(v => !v) },
  ];

  const listPane = (
    <aside className="bh-list" aria-label={t('botHome.listLabel')} inert={narrow && pane === 'chat'}>
      <div className="bh-segment" role="group">
        <Button size="sm" variant="ghost" className="bh-segment__item" aria-pressed={!filesOpen} data-active={!filesOpen || undefined} onPress={() => { navigate(`/library/folders/${projectId}/chat${activeId ? `?thread=${activeId}` : ''}`); setPane('chat'); }}>{tp('chat')}</Button>
        <Button size="sm" variant="ghost" className="bh-segment__item" aria-pressed={filesOpen} data-active={filesOpen || undefined} onPress={() => navigate(`/library?folder=${projectId}`)}>{tp('files')}</Button>
      </div>

      {availableAgents.length > 1 && (
        <div className="bh-pins" role="group" aria-label={t('botHome.contacts')}>
          {availableAgents.map(agent => (
            <Button key={agent.id} variant="ghost" className="bh-pin" aria-pressed={!activeId && !filesOpen && agent.id === agentId}
              data-current={agent.id === currentAgentId || undefined} onPress={() => startWith(agent.id)}>
              <BotAvatar agent={agent} size={52} />
              <span className="bh-pin__name">{agent.name}</span>
            </Button>
          ))}
        </div>
      )}

      <div className="bh-list__scroll">
        {listError ? (
          <div className="bh-inline-error" role="alert">{listError}<Button size="sm" variant="secondary" onPress={() => void refresh()}>{tp('retry')}</Button></div>
        ) : listLoading ? (
          <div className="bh-list__loading"><Spinner size="sm" color="current" /></div>
        ) : listRows.length > 0 && (
          <ListBox
            aria-label={t('botHome.listLabel')}
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={activeId && !filesOpen && !narrow ? [activeId] : []}
            onSelectionChange={(keys) => {
              const id = [...keys][0];
              const hit = threads.find(thread => thread.id === String(id));
              if (hit) openThread(hit);
            }}
            className="bh-threads"
          >
            {listRows.map(({ thread, preview, time }) => {
              const agent = agentOf(thread);
              const title = compactThreadTitle(thread.title) || tp('newTitle');
              return (
                <ListBox.Item key={thread.id} id={thread.id} textValue={title} className="bh-thread" data-archived={thread.archived || undefined}>
                  <BotAvatar agent={agent} size={40} />
                  <span className="bh-thread__body">
                    <span className="bh-thread__top">
                      <span className="bh-thread__name">{title}</span>
                      {thread.archived && <span className="bh-thread__flag" aria-label={t('botHome.archived')}><Sym name="archive" /></span>}
                      <time className="bh-thread__time" dateTime={time}>{formatListTime(time, locale)}</time>
                    </span>
                    <span className="bh-thread__preview">{preview || agent?.name}</span>
                  </span>
                </ListBox.Item>
              );
            })}
          </ListBox>
        )}
        {listCursor && <Button size="sm" variant="ghost" isDisabled={listMoreBusy} onPress={() => void loadMoreThreads()}>{t(listMoreError ? 'botHome.retryHistory' : 'botHome.moreConversations')}</Button>}
      </div>
    </aside>
  );

  const chatPane = (
    <section className="bh-chat" data-landing={landing || undefined} aria-label={chatTitle ? t('botHome.conversation', { name: chatTitle }) : undefined} inert={narrow && pane === 'list'}>
      {!landing && (
        <BotTopBar className="bh-chat__bar">
          <h2 className="bh-chat__who">
            {!filesOpen && <BotAvatar agent={currentAgent} size={28} />}
            <span className="bh-chat__identity">
              <span className="bh-chat__name" title={fullChatTitle}>{chatTitle}</span>
              <BotActivity active={activeBusy && !filesOpen} activity={history.reading?.activity} progress={activeWaiting ? t('botHome.waitingBackground') : activeProgress} />
            </span>
          </h2>
          {threadMenu.length > 0 && !filesOpen && <MoreMenu label={t('botHome.more')} actions={threadMenu} testId="bh-thread-more" />}
        </BotTopBar>
      )}
      {conversation}
    </section>
  );

  return (
    <PageShell
      title={project?.name ?? tp('title')}
      fill
      rootClassName="page-project"
      onBack={() => (narrow && pane === 'chat' ? setPane('list') : navigate(`/library?folder=${projectId}`))}
      actions={<>
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={tp('settings')} isDisabled={!project} onPress={() => setSettingsOpen(true)}>
          <Sym name="tune" />
        </Button>
        <MoreMenu label={t('botHome.more')} actions={listMenu} testId="bh-list-more" />
        <Button isIconOnly variant="ghost" className="rounded-full" aria-label={t('botHome.compose')} isDisabled={sendBusy || project?.archived || !availableAgents.length} onPress={() => startWith(currentAgentId || availableAgents[0]?.id || '')}>
          <Sym name="edit" />
        </Button>
      </>}
    >
      <div className="bh" data-pane={pane} data-narrow={narrow || undefined}>
        {listPane}
        {chatPane}
        {modals}
      </div>
    </PageShell>
  );
}
