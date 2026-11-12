import { createSessionStore } from '../client/session-store';
import { cloud } from '../cloud/state';
import { patchConversationSession, reviseConversationSession, readConversationSession, readConversationMessage } from './conversationProducts';
import { learningEdit, learningId, submitLearning } from '../client/learning';
import { removeConversationMessages, deleteServerSession, forkServerSession } from '../client/conversations';
import type { CloudTask } from '@wangke/contracts/cloud';
import { isTaskUnfinished } from '@wangke/contracts/task-status';
import { useChatNotifications } from './chatNotifications';
import { ChatCompletionTracker } from './chatCompletion';
import { readChatPage, readChatHistory } from './chatHistory';
import { responsePhase, type ProcessPhase } from '../utils/responseProcess';
import { getSettings } from './settings';
import { taskModelChoice, taskModelKey, useTaskModel } from './taskModel';
import { db, type AskUserState, type ChatRow, type ChatSessionRow, type ChatToolCall, type FolderPlanState, type VideoRow, type FolderRow } from './db';
import { type CourseContextItem, LIBRARY_ASSISTANT_ID } from '../harness/libraryAssistant';
import type { AppliedPlanResult } from '../pipelines/folderPlan';
import { explicitSkillIds } from '../skills/activation';
import type { ChatMessage } from '../api/siliconflow';
import type { AskUserAnswer } from '../harness/askUser';
import type { ResponseSegment } from '../utils/responseOrder';
import type { WidgetPayload } from '../harness/widgetRuntime';
import type { ChatAttachment } from '../chat/attachments';
import { ATTACHMENTS_PENDING_ERROR, useChatAttachments } from './chatAttachments';
import { normalizeCourseContextIds } from '../harness/courseContext';
import type { ChatProject } from '../projects/chatProjects';
import { SessionQueueModel, type SessionQueueItem } from '@wangke/client-core';
import { followServerSession } from '../client/session';
import { idleSessionVictims, sessionPayloadBytes } from '../client/session-cache';
import { browserChatQueue, beginChatDraft } from '../client/chat-queue';
import { stopServerChat, commandServerChat } from '../client/chat-server-execution';
import { accountLifecycle } from '../client/account-lifecycle';
import { chatTaskActive, chatTaskState } from './chatTaskState';
import type { RuntimeTask } from '@wangke/contracts/client-runtime';
import type { SessionIndexPage } from '@wangke/contracts/client-runtime';
import { serverRuntime } from '../client/bootstrap';
import i18n from '../i18n';
import { readRecordKeys } from '../cloud/sync';
import { displayChatError } from '../utils/chatError';
import { taskFailure } from '../utils/taskFailure';
import { toast } from '../ui/toast';

/** Server commands + durable private drafts + disposable page projections.
 * No browser model execution or authoritative conversation writes live here. */
export interface CourseChatMessage {
  operationId?: string; pendingOperationId?: string; taskId?: string;
  syncPending?: boolean; committedRowId?: number;
  responseSegments?: ResponseSegment[]; processPhase?: ProcessPhase; processStartedAt?: number;
  key: string; rowId?: number; role: 'user' | 'ai'; content: string;
  attachments?: ChatAttachment[]; createdAt?: number; reasoning?: string;
  explicitSkillIds?: number[];
  reasoningMs?: number; reasoningStartedAt?: number; hint?: string; tools?: ChatToolCall[];
  streaming?: boolean; error?: boolean; interrupted?: boolean; interruptReason?: string;
  ask?: AskUserState; folderPlan?: FolderPlanState; widget?: WidgetPayload; widgets?: WidgetPayload[];
  widgetPreview?: { html: string };
}
export interface ResumeSeed {
  sessionId: number; rowId: number; toolName: 'ask_user' | 'propose_folder_plan';
  toolCallId: string; midTurn: ChatMessage[];
}
export interface ResumeRequest extends ResumeSeed {
  askAnswer?: AskUserAnswer; toolResult: string; userContent?: string; planApplied?: 0 | 1 | 2;
}
export interface PendingAsk {
  messageKey: string; resolve: (picked: AskUserAnswer | string) => void;
  restored?: boolean; resume?: ResumeSeed;
}
export interface PendingPlan {
  messageKey: string; resolve: (answer: { ok: boolean; result: AppliedPlanResult | null }) => void;
  restored?: boolean; resume?: ResumeSeed;
}
export type SendMode = 'queue' | 'steer';
export type QueuedMessage = SessionQueueItem<ChatAttachment>;
interface SessionView {
  tasks: RuntimeTask[];
  messages: CourseChatMessage[]; hasOlder: boolean; loadingOlder: boolean; historyError: string | null;
  loaded: boolean; loading: boolean; queued: QueuedMessage[];
  pendingAsk: PendingAsk | null; pendingPlan: PendingPlan | null; planApplying: boolean;
  skillIds: number[] | undefined; turnSkillIds: number[]; mcpServerIds: string[] | undefined;
  contextCourses: CourseContextItem[]; project: ChatProject | null;
}
export interface CourseChatStore extends SessionView {
  ready: boolean; sessions: ChatSessionRow[]; activeId: number | null;
  runningIds: number[]; awaitingIds: number[]; draft: string; sendMode: SendMode; courseCount: number | null;
  archivedSessions: ChatSessionRow[];
  bootstrap(): Promise<void>; refreshCourseCount(): Promise<void>; loadOlder(): Promise<void>;
  loadSession(id: number): Promise<void>; createSession(): Promise<void>;
  deleteSessionById(id: number): Promise<boolean>; deleteSession(): Promise<boolean>;
  renameSession(id: number, title: string): Promise<void>; setPinned(id: number, pinned: boolean): Promise<void>;
  setArchived(id: number, archived: boolean, expected?: ChatSessionRow): Promise<boolean>; refreshArchived(): Promise<void>;
  setDraft(text: string): void;
  send(text: string, mode?: SendMode, target?: number, resume?: ResumeRequest, attachments?: ChatAttachment[], skills?: number[], queuedCommand?: QueuedMessage & { explicitRetry?: boolean }): Promise<void>;
  setSkillIds(ids: number[] | undefined): void; setTurnSkillIds(ids: number[]): void;
  setMcpServerIds(ids: string[] | undefined): Promise<void>; clearCourseContext(): void;
  setCourseContext(ids: string[]): Promise<void>; setProject(project: ChatProject | null): Promise<void>;
  answerAsk(answer: AskUserAnswer | string): Promise<void>; stop(): void;
  setSendMode(mode: SendMode): void; enqueue(text: string, attachments?: ChatAttachment[], skills?: number[]): void;
  removeQueued(id: string): void; updateQueued(id: string, text: string): void; clearQueue(): void;
  sendQueuedNow(id: string): Promise<void>;
  steer(text: string, attachments?: ChatAttachment[], skills?: number[], queuedCommand?: QueuedMessage): Promise<void>;
  retryMessage(key: string): Promise<void>; deleteMessage(key: string, sessionId: number | null): Promise<boolean>;
  forkSession(id: number, uptoRowId?: number): Promise<number | null>;
  confirmPlan(): Promise<{ ok: boolean; error?: string }>; cancelPlan(): Promise<void>;
}
const EMPTY_VIEW: SessionView = {
  tasks: [],
  messages: [], hasOlder: false, loadingOlder: false, historyError: null, loaded: false, loading: false,
  queued: [], pendingAsk: null, pendingPlan: null, planApplying: false, skillIds: undefined,
  turnSkillIds: [], mcpServerIds: undefined, contextCourses: [], project: null,
};
const DRAFT_STATE = { ...EMPTY_VIEW, activeId: null, loaded: true };
const pendingCloudSubmissions = new Map<string, number>();
const completions = new ChatCompletionTracker();
const historyLoads = new Map<number, Promise<void>>();
const serverSessions = new Map<number, ReturnType<typeof followServerSession>>();
const retainedSessions = new Map<number, ReturnType<typeof followServerSession>>();
const sessionUse = new Map<number, number>();
let sessionUseSequence = 0;
let accountGeneration = 0;
let queueBinding: { adapter: ReturnType<typeof browserChatQueue>; model: SessionQueueModel<ChatAttachment> } | undefined;

function captureScope() {
  const generation = accountGeneration, database = db, owner = accountLifecycle.current();
  return () => generation === accountGeneration && database === db && (!owner || owner.current());
}
function activeKey() { return useCourseChat.getState().activeId ?? 0; }
function readView(id: number): SessionView { return useCourseChat.model(id).getSnapshot(); }
function writeView(id: number, patch: Partial<SessionView>, deferred = false) {
  useCourseChat.model(id).set(patch, deferred);
  const ids = new Set(useCourseChat.models.keys());
  const awaitingIds = [...ids].filter((key): key is number => key != null && key !== 0 && !!(readView(key).pendingAsk || readView(key).pendingPlan));
  const before = useCourseChat.getState().awaitingIds;
  if (before.length !== awaitingIds.length || before.some(id => !awaitingIds.includes(id))) useCourseChat.setState({ awaitingIds });
}
function parkActive() {
  // Views already belong to their session model, independent of selection.
}
function markRunning(id: number, running: boolean) {
  if (useCourseChat.getState().runningIds.includes(id) !== running) useCourseChat.setState(state => ({ runningIds: running ? [...state.runningIds, id] : state.runningIds.filter(key => key !== id) }));
}
function timeline(id: number) {
  return useCourseChat.model(id).timeline;
}
function followSession(id: number) {
  if (serverSessions.has(id)) return;
  const current = captureScope();
  const handle = followServerSession(id, {
    changed: page => current() ? applySessionPage(id, page) : Promise.resolve(),
    failed: error => { if (current()) writeView(id, { historyError: `消息同步失败：${error}` }); },
  });
  serverSessions.set(id, handle); retainedSessions.set(id, handle);
}
function releaseIdleSessions() {
  const state = useCourseChat.getState();
  for (const [id, stop] of serverSessions) if (id !== state.activeId && !state.runningIds.includes(id) && !readView(id).loading && !historyLoads.has(id)) { stop(); serverSessions.delete(id); }
  const pending = new Set(pendingCloudSubmissions.values());
  const victims = idleSessionVictims([...useCourseChat.models].map(([id, model]) => {
    const view = model.getSnapshot();
    const protectedWork = id === 0 || id === state.activeId || serverSessions.has(id) || pending.has(id)
      || historyLoads.has(id) || state.runningIds.includes(id) || view.loading || view.loadingOlder
      || !!view.pendingAsk || !!view.pendingPlan || view.queued.length > 0
      || view.messages.some(message => message.streaming || message.syncPending || message.rowId == null);
    return { id, protected: protectedWork, used: sessionUse.get(id) ?? 0,
      bytes: protectedWork ? 0 : sessionPayloadBytes(view) + (retainedSessions.get(id)?.retainedBytes() ?? 0) };
  }));
  for (const id of victims) {
    useCourseChat.models.get(id)?.dispose(); useCourseChat.models.delete(id);
    retainedSessions.get(id)?.evict(); retainedSessions.delete(id); sessionUse.delete(id);
  }
}
function sessionQueue() {
  if (queueBinding?.adapter.current()) return queueBinding.model;
  const adapter = browserChatQueue();
  const model = new SessionQueueModel<ChatAttachment>({
    persistence: adapter,
    failed: error => { if (adapter.current()) writeView(activeKey(), { historyError: `待发消息保存失败，已阻止派发，请勿刷新：${error instanceof Error ? error.message : String(error)}` }); },
    read: readView, replace: (id, queued) => {
      if (!adapter.current()) return;
      const messages = [...readView(id).messages];
      for (const item of queued) {
        if (item.state !== 'uncertain') continue;
        const operationId = item.operationId ?? item.id;
        const reason = displayChatError(item.error);
        if (item.action === 'continue') {
          const index = messages.findIndex(message => message.rowId === item.rowId && !message.streaming);
          if (index >= 0) messages[index] = { ...messages[index], pendingOperationId: operationId, interrupted: true, interruptReason: reason };
          continue;
        }
        const userKey = `cloud-pending-user-${operationId}`, answerKey = `cloud-pending-answer-${operationId}`;
        if (!messages.some(message => message.key === userKey)) messages.push({ key: userKey, role: 'user', content: item.text, attachments: item.attachments, explicitSkillIds: item.explicitSkillIds, createdAt: item.createdAt });
        if (!messages.some(message => message.key === answerKey)) messages.push({ key: answerKey, operationId, role: 'ai', content: i18n.t('chat.failed', { reason }), error: true, createdAt: item.createdAt });
      }
      writeView(id, { queued, messages });
    },
    nextId: () => crypto.randomUUID(),
    send: (id, item) => {
      if (!adapter.current()) return Promise.reject(new Error('client_account_changed'));
      return useCourseChat.getState().send(item.text, undefined, id, undefined, item.attachments ?? [], item.explicitSkillIds ?? [], item);
    },
    steer: (id, item) => {
      if (!adapter.current()) return Promise.reject(new Error('client_account_changed'));
      return useCourseChat.getState().send(item.text, 'steer', id, undefined, item.attachments ?? [], item.explicitSkillIds ?? [], { ...item, explicitRetry: true });
    },
    attachmentId: file => file.id,
    releaseAttachment: file => useChatAttachments.getState().items.some(item => item.value?.id === file.id) ? Promise.resolve() : adapter.releaseAttachment(file),
  });
  queueBinding = { adapter, model };
  return model;
}
export async function flushChatQueue() { await sessionQueue().flush(); }
function clearAccountView() {
  accountGeneration++;
  completions.clear();
  useChatNotifications.getState().bindOwner(null);
  toast.clear();
  for (const stop of serverSessions.values()) stop(); serverSessions.clear();
  retainedSessions.clear(); sessionUse.clear(); sessionUseSequence = 0;
  useCourseChat.clearModels(); historyLoads.clear(); pendingCloudSubmissions.clear(); queueBinding = undefined;
  useCourseChat.setState({ ...DRAFT_STATE, ready: false, loaded: false, sessions: [], archivedSessions: [], runningIds: [], awaitingIds: [], draft: '' });
}
accountLifecycle.onDisposed(clearAccountView);
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', clearAccountView);

// The session stream is the sole live writer. Journal projections include the
// retained loaded window, so deletion never consults a lagging account cache.
async function applySessionPage(id: number, page: { rows: ChatRow[]; hasOlder: boolean; tasks?: RuntimeTask[] }) {
  // Task acceptance can race its terminal journal frame. Keep the latest frame
  // in the retained remote model and replay it after binding optimistic IDs.
  if ([...pendingCloudSubmissions.values()].includes(id)) return;
  const before = readView(id);
  const tasks = page.tasks?.filter(task => task.input.action !== 'compressContext') ?? before.tasks;
  completions.observe(tasks.map(task => ({ ...task, input: { ...task.input, sessionId: id } })), sessionId => useChatNotifications.getState().complete(sessionId));
  useCourseChat.model(id).set({ tasks }, true);
  let messages = timeline(id).reconcile(before.messages, page.rows);
  for (const task of tasks) {
    const progress = task.progress;
    if (!chatTaskActive(task) || !progress) continue;
    const existing = messages.find(message => message.taskId === task.id && message.role === 'ai'
      || task.input.action === 'continue' && message.rowId === task.input.rowId);
    const widgets = Array.isArray(progress.widgets) ? progress.widgets as unknown as WidgetPayload[] : existing?.widgets;
    const answer: CourseChatMessage = { ...existing, key: existing?.key ?? `cloud-answer-${task.id}`, role: 'ai', taskId: task.id,
      content: typeof progress.content === 'string' ? progress.content : existing?.content ?? '',
      reasoning: typeof progress.reasoning === 'string' ? progress.reasoning : existing?.reasoning,
      rowId: typeof progress.rowId === 'number' ? progress.rowId : existing?.rowId,
      tools: Array.isArray(progress.tools) ? progress.tools as unknown as ChatToolCall[] : existing?.tools,
      responseSegments: Array.isArray(progress.responseSegments) ? progress.responseSegments as ResponseSegment[] : existing?.responseSegments,
      ask: (progress.ask as unknown as AskUserState | undefined) ?? existing?.ask,
      folderPlan: (progress.folderPlan as unknown as FolderPlanState | undefined) ?? existing?.folderPlan,
      widgets, widget: widgets?.at(-1), widgetPreview: progress.widgetPreview as unknown as { html: string } | undefined,
      streaming: true, error: false, interrupted: false,
      processPhase: responsePhase(progress.phase),
      processStartedAt: Date.parse(task.createdAt) || Date.now() };
    const text = typeof task.input.text === 'string' ? task.input.text.trim() : '';
    messages = timeline(id).progress(messages, task, text && task.input.action !== 'continue'
      ? { key: `cloud-user-${task.id}`, role: 'user', content: text, explicitSkillIds: Array.isArray(task.input.explicitSkillIds) ? task.input.explicitSkillIds as number[] : undefined, taskId: task.id, syncPending: true, createdAt: Date.parse(task.createdAt) } : undefined, answer);
  }
  // Even tasks failing before the first durable row must unlock the composer.
  messages = messages.map(message => {
    const task = tasks.find(task => task.id === message.taskId);
    if (!message.streaming || !task || chatTaskActive(task)) return message;
    const failed = ['failed', 'interrupted'].includes(task.status);
    return { ...message, streaming: false, syncPending: false, widgetPreview: undefined,
      error: failed && !message.content, interrupted: failed && !!message.content,
      content: failed && !message.content ? `回答失败：${task.error || '未获得回答，请重试'}` : message.content,
      interruptReason: failed ? task.error ?? undefined : undefined };
  });
  const loading = [...pendingCloudSubmissions.values()].includes(id) || tasks.some(chatTaskActive);
  const cards = pendingCards(messages, id);
  const deferred = before.loading && loading && cards.pendingAsk === before.pendingAsk && cards.pendingPlan === before.pendingPlan;
  writeView(id, { messages, loaded: true, loading, historyError: null, hasOlder: page.hasOlder, ...cards }, deferred);
  markRunning(id, loading);
  if (!loading) {
    // An idle snapshot is not permission to replay persisted drafts. Advance
    // only after an observed task finishes; restored drafts remain explicit.
    if (before.loading) sessionQueue().drain(id);
    releaseIdleSessions();
  }
}
function pendingCards(messages: CourseChatMessage[], id: number): Pick<SessionView, 'pendingAsk' | 'pendingPlan'> {
  const last = messages.at(-1);
  const previous = readView(id);
  return {
    pendingAsk: last?.streaming && last.ask && last.ask.picked == null ? previous.pendingAsk?.messageKey === last.key ? previous.pendingAsk : { messageKey: last.key, restored: true, resolve: () => {} } : null,
    pendingPlan: last?.streaming && last.folderPlan && (last.folderPlan.applied ?? 0) === 0 ? previous.pendingPlan?.messageKey === last.key ? previous.pendingPlan : { messageKey: last.key, restored: true, resolve: () => {} } : null,
  };
}
export async function retryChatSync(id: number) {
  const current = captureScope();
  const { serverRuntime } = await import('../client/bootstrap');
  const runtime = await serverRuntime(cloud.userId);
  if (current()) runtime.session(id).refresh();
}
export function reflectArtifactEdit(row: ChatRow) {
  writeView(row.sessionId, { messages: readView(row.sessionId).messages.map(message => message.rowId === row.id
    ? { ...message, content: row.content, responseSegments: row.responseSegments, widget: row.widget, widgets: row.widgets } : message) });
}
export async function reflectCloudTasks(tasks: CloudTask[], dataChanged = false) {
  // Global activity discovers background sessions, never replays message bodies.
  completions.observe(tasks.filter(task => task.kind === 'chat'), id => useChatNotifications.getState().complete(id));
  const runningIds = [...new Set([...tasks.filter(task => task.kind === 'chat' && task.input.action !== 'compressContext'
    && isTaskUnfinished(task.status)).map(task => Number(task.input.sessionId)), ...pendingCloudSubmissions.values()])].filter(Boolean);
  const previous = useCourseChat.getState().runningIds;
  if (previous.length !== runningIds.length || previous.some(id => !runningIds.includes(id))) useCourseChat.setState({ runningIds });
  for (const id of runningIds) followSession(id);
  releaseIdleSessions();
}

export async function refreshConversationIndex() {
  const current = captureScope(), sessions = await unarchivedSessions();
  if (!current()) return;
  const state = useCourseChat.getState();
  if (JSON.stringify(state.sessions) !== JSON.stringify(sessions)) useCourseChat.setState({ sessions });
}

export const useCourseChat = createSessionStore<SessionView, CourseChatStore, CourseChatMessage, ChatRow>(EMPTY_VIEW, toMessage, (set, get) => ({
  ...EMPTY_VIEW, ready: false, sessions: [], activeId: null, runningIds: [], awaitingIds: [], draft: '',
  sendMode: 'queue', courseCount: null, archivedSessions: [],
  bootstrap: async () => {
    if (get().ready) return;
    useChatNotifications.getState().bindOwner(cloud.userId ?? null);
    const current = captureScope();
    const [sessions, count, pendingDraft] = await Promise.all([unarchivedSessions(), readCourseCount(), browserChatQueue().list(0)]);
    if (!current()) return;
    const selected = get().activeId;
    const activeId = selected != null && sessions.some(row => row.id === selected) ? selected : pendingDraft.length ? null : sessions.at(-1)?.id ?? null;
    set({ sessions, ready: true, courseCount: count, activeId });
    if (activeId == null) { set({ loaded: true }); await sessionQueue().restore(0); }
  },
  refreshCourseCount: async () => { const current = captureScope(), courseCount = await readCourseCount(); if (current()) set({ courseCount }); },
  loadOlder: async () => {
    const id = get().activeId;
    if (id == null) return;
    const current = captureScope(), view = readView(id), first = view.messages[0];
    if (!view.hasOlder || view.loadingOlder || first?.rowId == null || first.createdAt == null) return;
    writeView(id, { loadingOlder: true, historyError: null });
    try {
      await readChatPage(id, { id: first.rowId, createdAt: first.createdAt, role: first.role === 'ai' ? 'assistant' : 'user' });
      if (!current()) return;
      // Pagination metadata is published only by an accepted journal merge;
      // a stale HTTP response must not overwrite a newer baseline's hasOlder.
      writeView(id, { loadingOlder: false });
    } catch { if (current()) writeView(id, { loadingOlder: false, historyError: '历史消息加载失败，点击重试' }); }
  },
  loadSession: (id): Promise<void> => {
    sessionUse.set(id, ++sessionUseSequence);
    const queue = sessionQueue(), current = captureScope();
    const pending = historyLoads.get(id);
    if (pending) {
      if (get().activeId !== id) set({ activeId: id });
      return pending;
    }
    followSession(id);
    if (get().activeId === id && get().loaded) return queue.restore(id);
    if (get().activeId != null && get().activeId !== id) parkActive();
    const cached = readView(id);
    if (cached.loaded) { set({ activeId: id }); releaseIdleSessions(); return queue.restore(id); }
    // Publish the shared flight before selection can trigger the page effect.
    // Every caller waits for the same metadata + journal-ready + draft restore.
    const request: Promise<void> = Promise.resolve().then(async () => {
      try {
        const session = await readConversationSession(id);
        if (!current()) return;
        if (!session) throw new Error(i18n.t('chatPanel.sessionUnavailable'));
        set(state => ({ sessions: [...state.sessions.filter(row => row.id !== id).slice(-50), session] }));
        const contextIds = normalizeCourseContextIds(session.contextCourseIds ?? []) ?? [];
        const [courses, projectFolder] = await Promise.all([
          cloud.enabled ? readRecordKeys<VideoRow>('videos', contextIds).then(rows => rows.filter(row => row != null)) : db.videos.bulkGet(contextIds).then(rows => rows.filter(row => row != null)),
          session.projectFolderId == null ? undefined : cloud.enabled ? readRecordKeys<FolderRow>('folders', [session.projectFolderId]).then(rows => rows[0]) : db.folders.get(session.projectFolderId),
        ]);
        if (!current() || historyLoads.get(id) !== request) return;
        const byId = new Map(courses.map(course => [course.id, course.name]));
        writeView(id, {
          skillIds: session?.skillIds, mcpServerIds: session?.mcpServerIds,
          project: session?.projectFolderId == null ? null : { folderId: session.projectFolderId, name: projectFolder?.name ?? '项目', color: projectFolder?.color },
          contextCourses: contextIds.filter(cid => byId.has(cid)).map(cid => ({ id: cid, name: byId.get(cid)! })) });
        await serverSessions.get(id)?.ready;
      } catch (error) {
        if (current() && get().activeId === id) writeView(id, { historyError: `消息同步失败：${error instanceof Error ? error.message : String(error)}` });
      } finally { if (current()) await queue.restore(id); }
    }).finally(() => {
      if (historyLoads.get(id) === request) historyLoads.delete(id);
      if (current()) releaseIdleSessions();
    });
    historyLoads.set(id, request);
    set({ activeId: id, ...EMPTY_VIEW });
    releaseIdleSessions();
    return request;
  },
  createSession: async () => {
    if (get().activeId == null) { await sessionQueue().restore(0); return; }
    const current = captureScope(); await sessionQueue().flush(); if (!current()) return;
    parkActive(); beginChatDraft(); queueBinding = undefined; set(DRAFT_STATE);
    releaseIdleSessions();
  },
  deleteSessionById: async id => {
    if (get().runningIds.includes(id)) return false;
    const current = captureScope(), wasActive = get().activeId === id;
    await deleteServerSession(id, await readChatHistory(id));
    if (!current()) return false;
    sessionQueue().clear(id); await sessionQueue().flush();
    void useChatAttachments.getState().discard(id);
    useCourseChat.models.get(id)?.dispose(); useCourseChat.models.delete(id); serverSessions.get(id)?.(); serverSessions.delete(id);
    retainedSessions.get(id)?.evict(); retainedSessions.delete(id); sessionUse.delete(id);
    useChatNotifications.getState().dismiss(id);
    const sessions = await unarchivedSessions(); if (!current()) return false;
    set({ sessions });
    if (wasActive) { set(DRAFT_STATE); const next = sessions.at(-1); if (next) await get().loadSession(next.id!); }
    releaseIdleSessions();
    return true;
  },
  deleteSession: async () => { const id = get().activeId; return id == null ? false : get().deleteSessionById(id); },
  renameSession: async (id, title) => { if (title.trim()) await patchSession(id, row => { row.title = title.trim(); }); },
  setPinned: async (id, pinned) => { await patchSession(id, row => { if (pinned) row.pinned = true; else delete row.pinned; }); },
  setArchived: async (id, archived, expected) => {
    if (get().runningIds.includes(id)) return false;
    const current = captureScope(), wasActive = get().activeId === id;
    await patchSession(id, row => {
      if (expected && JSON.stringify(row) !== JSON.stringify(expected)) throw new Error(i18n.t('interface:feedback.archivedChanged'));
      if (archived) row.archived = true; else delete row.archived;
    });
    if (!current()) return false;
    if (archived) { serverSessions.get(id)?.(); serverSessions.delete(id); useChatNotifications.getState().dismiss(id); void useChatAttachments.getState().discard(id); }
    const sessions = await unarchivedSessions(); if (!current()) return false;
    set({ sessions });
    if (archived && wasActive) { set(DRAFT_STATE); const next = sessions.at(-1); if (next) await get().loadSession(next.id!); }
    releaseIdleSessions();
    return true;
  },
  refreshArchived: async () => {
    // Server archive views own a paginated sessionIndex observation. This legacy
    // local-only action must never interpret a sparse point cache as an archive.
    if (cloud.enabled) return;
    const current = captureScope(), rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt');
    if (current()) set({ archivedSessions: rows.filter(row => row.archived) });
  },
  setDraft: draft => set({ draft }),
  setMcpServerIds: async ids => { const key = activeKey(), current = captureScope(); if (key) await reviseConversationSession(key, row => { if (ids === undefined) delete row.mcpServerIds; else row.mcpServerIds = ids; }); if (current()) writeView(key, { mcpServerIds: ids }); },
  setSkillIds: ids => { const key = activeKey(), current = captureScope(); writeView(key, { skillIds: ids }); if (key) void patchSession(key, row => { if (ids === undefined) delete row.skillIds; else row.skillIds = ids; }).catch(error => { if (current()) writeView(key, { historyError: String(error) }); }); },
  // Draft edits (cut/paste/undo included) affect the next submission only; a
  // running task already owns its frozen explicitSkillIds.
  setTurnSkillIds: ids => set({ turnSkillIds: explicitSkillIds(ids) }),
  clearCourseContext: () => { const key = activeKey(), current = captureScope(); writeView(key, { contextCourses: [] }); if (key) void patchSession(key, row => { delete row.contextCourseIds; }).catch(error => { if (current()) writeView(key, { historyError: String(error) }); }); },
  setCourseContext: async ids => {
    const key = activeKey(), current = captureScope();
    const contextIds = normalizeCourseContextIds(ids) ?? [];
    const courses = (await (cloud.enabled ? readRecordKeys<VideoRow>('videos', contextIds) : db.videos.bulkGet(contextIds))).filter(row => row != null).map(row => ({ id: row.id, name: row.name }));
    if (!current()) return;
    if (key) await patchConversationSession(key, { contextCourseIds: courses.map(course => course.id) });
    if (current()) writeView(key, { contextCourses: courses });
  },
  setProject: async project => {
    const key = activeKey(), current = captureScope(); if (readView(key).loading) throw new Error('回复完成后可修改项目');
    const changed = readView(key).project?.folderId !== project?.folderId;
    if (key) await patchSession(key, row => { if (project) row.projectFolderId = project.folderId; else delete row.projectFolderId; if (changed) delete row.contextCourseIds; });
    if (current()) writeView(key, { project, ...(changed ? { contextCourses: [] } : {}) });
  },
  send: async (rawText, mode, target, resume, suppliedAttachments, suppliedSkills, queuedCommand) => {
    const currentScope = captureScope(), state = get();
    const key = resume ? resume.sessionId : target ?? state.activeId ?? 0;
    const view = readView(key), isActive = key === activeKey();
    const composerSubmission = suppliedAttachments === undefined && target === undefined && !resume;
    const fromComposer = composerSubmission && !view.pendingAsk;
    const files = composerSubmission ? useChatAttachments.getState().items : [];
    if (files.some(item => !item.value || !!item.error || item.editing)) { useChatAttachments.setState({ error: ATTACHMENTS_PENDING_ERROR }); return; }
    const attachments = suppliedAttachments ?? (fromComposer ? files.flatMap(item => item.value ? [item.value] : []) : []);
    const text = rawText.trim() || (attachments.length ? '请分析这些附件。' : '');
    const consume = () => { if (fromComposer) useChatAttachments.getState().consume(attachments.map(file => file.id)); };
    if (!view.loaded || !resume && !text) return;
    const skills = explicitSkillIds(suppliedSkills ?? (fromComposer ? view.turnSkillIds : []));
    const modelSelection = queuedCommand?.modelSelection ?? taskModelChoice(target ?? state.activeId);
    const thinkingLevel = queuedCommand?.thinkingLevel ?? (getSettings().thinkingEnabled ? getSettings().thinkingEffort : 'none');
    if (view.pendingAsk && !resume) {
      if (await commandServerChat(key || null, 'answerAsk', text) && currentScope() && isActive) set({ draft: '' });
      return;
    }
    if (view.loading && !resume && !queuedCommand && (mode ?? state.sendMode) !== 'steer') {
      const operationId = crypto.randomUUID();
      sessionQueue().enqueue(key, text, attachments, skills, { id: operationId, operationId, text, modelSelection, thinkingLevel });
      consume(); if (fromComposer) writeView(key, { turnSkillIds: [] }); if (isActive && fromComposer) set({ draft: '' }); return;
    }
    let id = resume?.sessionId ?? (key || null);
    const adapter = browserChatQueue(), operationId = queuedCommand?.operationId ?? queuedCommand?.id ?? crypto.randomUUID();
    const userKey = `cloud-pending-user-${operationId}`, continuing = queuedCommand?.action === 'continue';
    const answerKey = (continuing ? view.messages.find(message => message.rowId === queuedCommand.rowId)?.key : undefined) ?? `cloud-pending-answer-${operationId}`;
    pendingCloudSubmissions.set(operationId, key);
    try {
      if (id == null) {
        writeView(0, { loading: true });
        const row = await newSessionRow(view.skillIds, view.contextCourses.map(course => course.id), view.mcpServerIds, view.project?.folderId);
        id = row.id!;
        if (!currentScope() || !adapter.current()) return;
        if (activeKey() === key) set(s => ({ sessions: [...s.sessions.slice(-50), row], activeId: id, loaded: true }));
        else { set(s => ({ sessions: [...s.sessions.slice(-50), row] })); writeView(id, { ...view, loaded: true }); }
      }
      pendingCloudSubmissions.set(operationId, id); timeline(id).begin(operationId);
      const messages = [...readView(id).messages];
      if (!resume && text && !continuing && !messages.some(message => message.key === userKey)) messages.push({ key: userKey, role: 'user', content: text, attachments, explicitSkillIds: skills, createdAt: Date.now() });
      const index = messages.findIndex(message => message.key === answerKey);
      if (index >= 0) messages[index] = { ...messages[index], streaming: true, error: false, interrupted: false, ...(continuing ? { pendingOperationId: operationId } : { content: '' }) };
      else messages.push({ key: answerKey, operationId, role: 'ai', content: '', streaming: true, processPhase: 'preparing', processStartedAt: Date.now() });
      writeView(id, { messages, loading: true, historyError: null }); markRunning(id, true);
      if (fromComposer && activeKey() === id) set({ draft: '' });
      const task = await adapter.submit(id, queuedCommand ?? { id: operationId, operationId, text, attachments, explicitSkillIds: skills, modelSelection, thinkingLevel },
        { sessionId: id, text, mode: mode ?? state.sendMode, resume, attachments, explicitSkillIds: skills, ...(modelSelection ? { modelSelection: JSON.parse(JSON.stringify(modelSelection)) } : {}), thinkingLevel }, queuedCommand?.explicitRetry);
      if (!currentScope() || !adapter.current()) return;
      if (!queuedCommand && taskModelChoice(target ?? state.activeId) === modelSelection) useTaskModel.getState().set(taskModelKey(target ?? state.activeId));
      timeline(id).accept(operationId, task.id); followSession(id); consume();
      if (fromComposer) writeView(id, { turnSkillIds: [] });
      writeView(id, { messages: readView(id).messages.map(message => message.key === userKey || message.key === answerKey ? { ...message, taskId: task.id, syncPending: true } : message) });
    } catch (error) {
      if (!currentScope() || !adapter.current()) return;
      const turnKey = id ?? key, reason = displayChatError(taskFailure(error).reason);
      if (id != null) timeline(id).uncertain(operationId);
      writeView(turnKey, { messages: readView(turnKey).messages.map(message => message.key === answerKey
        ? continuing ? { ...message, streaming: false, interrupted: true, interruptReason: reason }
          : { ...message, content: i18n.t('chat.failed', { reason }), streaming: false, error: true } : message), loading: view.loading && key !== 0, historyError: null });
      markRunning(turnKey, view.loading && key !== 0);
      if (id != null) { consume(); if (fromComposer) writeView(id, { turnSkillIds: [] }); await sessionQueue().restore(id).catch(() => {}); }
    } finally {
      if (currentScope()) {
        pendingCloudSubmissions.delete(operationId);
        // A very short task can finish before submitTask returns. Reconcile
        // once after releasing the submission guard so its terminal state wins.
        if (id != null) serverSessions.get(id)?.refresh();
      }
    }
  },
  setSendMode: sendMode => set({ sendMode }),
  enqueue: (text, attachments = [], skills = []) => { sessionQueue().enqueue(activeKey(), text, attachments, skills); },
  removeQueued: id => { sessionQueue().remove(activeKey(), id); },
  updateQueued: (id, text) => { sessionQueue().update(activeKey(), id, text); },
  clearQueue: () => { sessionQueue().clear(activeKey()); },
  sendQueuedNow: async id => { await sessionQueue().sendNow(activeKey(), id); },
  steer: async (text, attachments = [], skills = [], command) => { await get().send(text, 'steer', activeKey(), undefined, attachments, skills, command); },
  stop: () => { const id = activeKey(), current = captureScope(); void stopServerChat(id).catch(error => { if (current()) writeView(id, { historyError: String(error) }); }); },
  deleteMessage: async (key, sessionId) => {
    if (sessionId == null || get().activeId !== sessionId) return false;
    const current = captureScope(), view = readView(sessionId), message = view.messages.find(item => item.key === key);
    if (view.loading || !message || message.streaming || message.rowId == null) return false;
    const row = await readConversationMessage(message.rowId);
    if (!current() || !row || row.sessionId !== sessionId || readView(sessionId).loading) return false;
    await removeConversationMessages([message.rowId]); if (!current()) return false;
    writeView(sessionId, { messages: readView(sessionId).messages.filter(item => item.key !== key) }); return true;
  },
  retryMessage: async key => {
    const current = captureScope(), state = get(), message = state.messages.find(item => item.key === key), id = state.activeId;
    try {
      if (state.loading || !message) return;
      if (message.error && message.operationId && id != null) {
        const item = (await browserChatQueue().list(id)).find(item => (item.operationId ?? item.id) === message.operationId);
        if (current() && item) await get().send(item.text, undefined, id, undefined, item.attachments ?? [], item.explicitSkillIds ?? [], { ...item, modelSelection: taskModelChoice(id), explicitRetry: true });
        return;
      }
      if (id == null || message.rowId == null) return;
      if (message.interrupted) {
        const adapter = browserChatQueue(), operationId = message.pendingOperationId ?? crypto.randomUUID();
        pendingCloudSubmissions.set(operationId, id); markRunning(id, true);
        writeView(id, { loading: true, messages: readView(id).messages.map(item => item.key === key ? { ...item, pendingOperationId: operationId } : item) });
        try {
          const settings = getSettings(), selection = taskModelChoice(id);
          const task = await adapter.submit(id, { id: operationId, operationId, text: '继续回答', action: 'continue', rowId: message.rowId, modelSelection: selection },
            { sessionId: id, rowId: message.rowId, action: 'continue', ...(selection ? { modelSelection: JSON.parse(JSON.stringify(selection)) } : {}), thinkingLevel: settings.thinkingEnabled ? settings.thinkingEffort : 'none' }, !!message.pendingOperationId);
          if (!current() || !adapter.current()) return;
          followSession(id);
          writeView(id, { messages: readView(id).messages.map(item => item.key === key ? { ...item, taskId: task.id, pendingOperationId: undefined, streaming: true, interrupted: false, interruptReason: undefined } : item) });
        } catch (error) {
          if (!current() || !adapter.current()) return;
          writeView(id, { loading: false, messages: readView(id).messages.map(item => item.key === key ? { ...item, streaming: false, interrupted: true, interruptReason: displayChatError(taskFailure(error).reason) } : item) });
          markRunning(id, false); await sessionQueue().restore(id).catch(() => {});
        } finally { if (current()) { pendingCloudSubmissions.delete(operationId); serverSessions.get(id)?.refresh(); } }
        return;
      }
      const rows = await readChatHistory(id); if (!current()) return;
      const index = rows.findIndex(row => row.id === message.rowId);
      if (index < 0) return;
      let userIndex = index;
      if (message.role === 'user') {
        const position = state.messages.findIndex(item => item.key === key);
        if (position !== state.messages.length - 2 || state.messages[position + 1]?.role !== 'ai') return;
      } else {
        if (index !== rows.length - 1) return;
        userIndex--;
        while (userIndex >= 0 && rows[userIndex].role !== 'user') userIndex--;
        if (userIndex < 0) return;
      }
      const removed = rows.slice(userIndex), user = rows[userIndex];
      await removeConversationMessages(removed.flatMap(row => row.id == null ? [] : [row.id])); if (!current()) return;
      const ids = new Set(removed.map(row => row.id));
      writeView(id, { messages: readView(id).messages.filter(item => item.rowId != null && !ids.has(item.rowId)) });
      await get().send(user.content, undefined, id, undefined, user.attachments ?? [], user.explicitSkillIds ?? []);
    } catch (error) {
      // Page buttons intentionally discard this promise. Handle failures here,
      // before they can become unhandled rejections or trigger an implicit send.
      if (current() && get().activeId === id) toast.error(i18n.t('dataDelivery.retryFailed', {
        reason: displayChatError(error instanceof Error ? error.message : String(error)),
      }));
    }
  },
  forkSession: async (id, uptoRowId) => {
    if (get().runningIds.includes(id)) return null;
    const current = captureScope(), source = await readConversationSession(id);
    if (!current() || !source) return null;
    const rows = await readChatHistory(id); if (!current()) return null;
    const cut = uptoRowId == null ? rows.length : rows.findIndex(row => row.id === uptoRowId) + 1;
    if (cut <= 0) return null;
    const sid = await forkServerSession(source, rows.slice(0, cut)); if (!current()) return null;
    const sessions = await unarchivedSessions(); if (!current()) return null;
    set({ sessions }); await get().loadSession(sid); return sid;
  },
  answerAsk: async answer => {
    const state = get(), message = state.messages.find(item => item.key === state.pendingAsk?.messageKey);
    if (!message?.taskId || !await commandServerChat(state.activeId, 'answerAsk', answer, message.taskId))
      throw new Error('本次提问已结束，请刷新后查看当前问题');
  },
  confirmPlan: async () => {
    const id = get().activeId, current = captureScope(); if (id == null) return { ok: false };
    writeView(id, { planApplying: true });
    try { return { ok: await commandServerChat(id, 'confirmPlan') }; }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    finally { if (current()) writeView(id, { planApplying: false }); }
  },
  cancelPlan: async () => { await commandServerChat(get().activeId, 'cancelPlan'); },
}));

async function newSessionRow(skillIds?: number[], contextCourseIds: string[] = [], mcpServerIds?: string[], projectFolderId?: number): Promise<ChatSessionRow> {
  const current = captureScope(), adapter = browserChatQueue();
  const value: ChatSessionRow = { id: learningId(), videoId: LIBRARY_ASSISTANT_ID, title: '新会话', createdAt: Date.now(),
    ...(skillIds !== undefined ? { skillIds } : {}), ...(mcpServerIds !== undefined ? { mcpServerIds } : {}),
    ...(contextCourseIds.length ? { contextCourseIds } : {}), ...(projectFolderId != null ? { projectFolderId } : {}) };
  await sessionQueue().flush(); if (!current() || !adapter.current()) throw new Error('client_account_changed');
  await submitLearning([learningEdit({ kind: 'conversationSession', expected: null, value } as any)], [`session:${value.id}`], undefined, false);
  if (!current() || !adapter.current()) throw new Error('client_account_changed');
  await adapter.rekeyDraft(value.id!); return value;
}
async function readCourseCount() {
  if (!cloud.enabled) return db.videos.count();
  const current = captureScope(), runtime = await serverRuntime(cloud.userId);
  if (!current()) throw new Error('client_account_changed');
  const response = await runtime.read({ kind: 'courseCount' });
  if (!current()) throw new Error('client_account_changed');
  return (response.value as unknown as { count: number }).count;
}
async function unarchivedSessions() {
  if (cloud.enabled) {
    const current = captureScope(), runtime = await serverRuntime(cloud.userId);
    if (!current()) throw new Error('client_account_changed');
    const response = await runtime.read({ kind: 'sessionIndex', videoId: LIBRARY_ASSISTANT_ID, archived: false, recentOnly: false });
    if (!current()) throw new Error('client_account_changed');
    const page = response.value as unknown as SessionIndexPage;
    const activeId = useCourseChat.getState().activeId;
    let active = activeId == null ? undefined : await readConversationSession(activeId);
    if ((!active || active.archived) && page.latestId != null && !page.sessions.some(row => row.id === page.latestId)) active = await readConversationSession(page.latestId);
    if (!current()) throw new Error('client_account_changed');
    const rows: ChatSessionRow[] = page.sessions.map(row => ({ id: row.id, videoId: row.videoId, title: row.title, createdAt: row.createdAt, pinned: row.pinned, archived: row.archived }));
    // The store is a bounded landing/active metadata projection, not all sessions.
    if (active && !active.archived) {
      const position = rows.findIndex(row => row.id === active.id);
      if (position >= 0) rows[position] = active; else rows.push(active);
    }
    return rows.sort((a, b) => a.createdAt - b.createdAt || a.id! - b.id!);
  }
  return (await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt')).filter(row => !row.archived);
}
async function patchSession(id: number, mutate: (row: ChatSessionRow) => void) {
  const current = captureScope();
  if (!await reviseConversationSession(id, mutate)) throw new Error(i18n.t('chatPanel.sessionUnavailable'));
  if (!current()) return;
  const fresh = await readConversationSession(id); if (!current() || !fresh) return;
  useCourseChat.setState(state => {
    const archived = new Map(state.archivedSessions.map(row => [row.id, row]));
    if (fresh.archived) archived.set(id, fresh); else archived.delete(id);
    return { sessions: state.sessions.map(row => row.id === id ? fresh : row).filter(row => !row.archived), archivedSessions: [...archived.values()] };
  });
}
const convertedRows = new WeakMap<ChatRow, { task?: RuntimeTask; message: CourseChatMessage }>();
function toMessage(row: ChatRow): CourseChatMessage {
  const task = readView(row.sessionId).tasks.find(task => task.id === row.taskId);
  const cached = convertedRows.get(row);
  if (cached && cached.task === task) return cached.message;
  const message: CourseChatMessage = { key: `stored-${row.id}`, rowId: row.id!, taskId: row.taskId, role: row.role === 'assistant' ? 'ai' : 'user',
    content: row.content, ...(row.role === 'assistant' ? chatTaskState(row, task) : {}),
    attachments: row.attachments, explicitSkillIds: row.explicitSkillIds, createdAt: row.createdAt, reasoning: row.reasoning, responseSegments: row.responseSegments,
    reasoningMs: row.reasoningMs, tools: row.tools,
    ask: row.ask, folderPlan: row.folderPlan, widget: row.widget, widgets: row.widgets,
    ...(task && chatTaskActive(task) && task.progress?.widgetPreview ? { widgetPreview: task.progress.widgetPreview as unknown as { html: string } } : {}) };
  convertedRows.set(row, { task, message });
  return message;
}
