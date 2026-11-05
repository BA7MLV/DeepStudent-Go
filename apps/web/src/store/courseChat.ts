import { create } from 'zustand';
import { patchConversationSession, reviseConversationSession } from './conversationProducts';
import { learningEdit, learningId, submitLearning } from '../client/learning';
import { removeConversationMessages, deleteServerSession, forkServerSession } from '../client/conversations';
import { syncTaskWidgets } from '../cloud/tasks';
import type { CloudTask } from '@wangke/contracts/cloud';
import { useChatNotifications } from './chatNotifications';
import { readChatPage, readChatHistory } from './chatHistory';
import type { ProcessPhase } from '../utils/responseProcess';
import { getSettings } from './settings';
import { taskModelChoice, taskModelKey, useTaskModel } from './taskModel';
import { db, type AskUserState, type ChatRow, type ChatSessionRow, type ChatToolCall, type FolderPlanState } from './db';
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
import { SessionTimelineModel, SessionQueueModel, type SessionQueueItem } from '@wangke/client-core';
import { followServerSession } from '../client/session';
import { browserChatQueue, beginChatDraft } from '../client/chat-queue';
import { stopServerChat, commandServerChat } from '../client/chat-server-execution';
import { accountLifecycle } from '../client/account-lifecycle';

/** Server commands + durable private drafts + disposable page projections.
 * No browser model execution or authoritative conversation writes live here. */
export interface CourseChatMessage {
  operationId?: string; pendingOperationId?: string; taskId?: string;
  syncPending?: boolean; committedRowId?: number;
  responseSegments?: ResponseSegment[]; processPhase?: ProcessPhase; processStartedAt?: number;
  key: string; rowId?: number; role: 'user' | 'ai'; content: string;
  attachments?: ChatAttachment[]; createdAt?: number; reasoning?: string;
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
  setArchived(id: number, archived: boolean): Promise<boolean>; refreshArchived(): Promise<void>;
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
  messages: [], hasOlder: false, loadingOlder: false, historyError: null, loaded: false, loading: false,
  queued: [], pendingAsk: null, pendingPlan: null, planApplying: false, skillIds: undefined,
  turnSkillIds: [], mcpServerIds: undefined, contextCourses: [], project: null,
};
const DRAFT_STATE = { ...EMPTY_VIEW, activeId: null, loaded: true };
const parked = new Map<number, SessionView>();
const pendingCloudSubmissions = new Map<string, number>();
const finishedCloudTasks = new Set<string>();
const historyLoads = new Map<number, symbol>();
const serverSessions = new Map<number, () => void>();
const timelines = new Map<number, SessionTimelineModel<CourseChatMessage, ChatRow>>();
let cloudReflection = 0;
let accountGeneration = 0;
let queueBinding: { adapter: ReturnType<typeof browserChatQueue>; model: SessionQueueModel<ChatAttachment> } | undefined;

function captureScope() {
  const generation = accountGeneration, database = db, owner = accountLifecycle.current();
  return () => generation === accountGeneration && database === db && (!owner || owner.current());
}
function activeKey() { return useCourseChat.getState().activeId ?? 0; }
function readView(id: number): SessionView { return id === activeKey() ? useCourseChat.getState() : parked.get(id) ?? EMPTY_VIEW; }
function writeView(id: number, patch: Partial<SessionView>) {
  if (id === activeKey()) useCourseChat.setState(patch);
  else parked.set(id, { ...readView(id), ...patch });
  const ids = new Set([useCourseChat.getState().activeId, ...parked.keys()]);
  const awaitingIds = [...ids].filter((key): key is number => key != null && key !== 0 && !!(readView(key).pendingAsk || readView(key).pendingPlan));
  const before = useCourseChat.getState().awaitingIds;
  if (before.length !== awaitingIds.length || before.some(id => !awaitingIds.includes(id))) useCourseChat.setState({ awaitingIds });
}
function parkActive() {
  const state = useCourseChat.getState();
  if (state.activeId != null) {
    const { messages, hasOlder, loadingOlder, historyError, loaded, loading, queued, pendingAsk, pendingPlan,
      planApplying, skillIds, turnSkillIds, mcpServerIds, contextCourses, project } = state;
    parked.set(state.activeId, { messages, hasOlder, loadingOlder, historyError, loaded, loading, queued, pendingAsk,
      pendingPlan, planApplying, skillIds, turnSkillIds, mcpServerIds, contextCourses, project });
  }
}
function markRunning(id: number, running: boolean) {
  useCourseChat.setState(state => ({ runningIds: running ? [...new Set([...state.runningIds, id])] : state.runningIds.filter(key => key !== id) }));
}
function timeline(id: number) {
  let model = timelines.get(id);
  if (!model) { model = new SessionTimelineModel(id, toMessage); timelines.set(id, model); }
  return model;
}
function followSession(id: number) {
  if (serverSessions.has(id)) return;
  for (const [other, stop] of serverSessions) if (other !== id && !useCourseChat.getState().runningIds.includes(other)) { stop(); serverSessions.delete(other); }
  const current = captureScope();
  serverSessions.set(id, followServerSession(id, {
    changed: page => current() ? refreshCloudSession(id, cloudReflection, page) : Promise.resolve(),
    failed: error => { if (current()) writeView(id, { historyError: `消息同步失败：${error}` }); },
  }));
}
function sessionQueue() {
  if (queueBinding?.adapter.current()) return queueBinding.model;
  const adapter = browserChatQueue();
  const model = new SessionQueueModel<ChatAttachment>({
    persistence: adapter,
    failed: error => { if (adapter.current()) writeView(activeKey(), { historyError: `待发消息保存失败，已阻止派发，请勿刷新：${error instanceof Error ? error.message : String(error)}` }); },
    read: readView, replace: (id, queued) => { if (adapter.current()) writeView(id, { queued }); },
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
  accountGeneration++; cloudReflection++;
  for (const stop of serverSessions.values()) stop(); serverSessions.clear();
  for (const model of timelines.values()) model.dispose(); timelines.clear();
  parked.clear(); historyLoads.clear(); pendingCloudSubmissions.clear(); finishedCloudTasks.clear(); queueBinding = undefined;
  useCourseChat.setState({ ...DRAFT_STATE, ready: false, loaded: false, sessions: [], archivedSessions: [], runningIds: [], awaitingIds: [], draft: '' });
}
accountLifecycle.onDisposed(clearAccountView);
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', clearAccountView);

/** Revalidate all visible rows without losing pagination or optimistic identity. */
async function refreshCloudSession(id: number, reflection: number, remotePage?: { rows: ChatRow[]; hasOlder: boolean }) {
  const current = captureScope(), before = readView(id);
  const ids = before.messages.flatMap(message => message.rowId ?? message.committedRowId ?? []);
  try {
    const [page, visible] = await Promise.all([remotePage ?? readChatPage(id), db.chats.bulkGet(ids)]);
    if (!current() || reflection !== cloudReflection || readView(id).messages !== before.messages) return;
    const earlier = visible.filter((row): row is ChatRow => !!row && row.sessionId === id && (!remotePage || page.rows.length > 0 && row.createdAt < page.rows[0].createdAt));
    const messages = timeline(id).reconcile(before.messages, [...earlier, ...page.rows]);
    const includesEarlier = page.rows.length > 0 && messages.some(message => message.createdAt != null && message.createdAt < page.rows[0].createdAt);
    writeView(id, { messages, loaded: true, historyError: null, hasOlder: includesEarlier ? before.hasOlder : page.hasOlder, ...pendingCards(messages) });
  } catch (error) {
    if (current() && reflection === cloudReflection && readView(id).messages === before.messages) writeView(id, { historyError: `消息同步失败：${error instanceof Error ? error.message : String(error)}` });
  }
}
function pendingCards(messages: CourseChatMessage[]): Pick<SessionView, 'pendingAsk' | 'pendingPlan'> {
  const last = messages.at(-1);
  return {
    pendingAsk: last?.ask && last.ask.picked == null ? { messageKey: last.key, restored: true, resolve: () => {} } : null,
    pendingPlan: last?.folderPlan && (last.folderPlan.applied ?? 0) === 0 ? { messageKey: last.key, restored: true, resolve: () => {} } : null,
  };
}
export async function retryChatSync(id: number) {
  const current = captureScope();
  await (await import('../cloud/sync')).flushCloud();
  if (current()) await refreshCloudSession(id, cloudReflection);
}
export function reflectArtifactEdit(row: ChatRow) {
  writeView(row.sessionId, { messages: readView(row.sessionId).messages.map(message => message.rowId === row.id
    ? { ...message, content: row.content, responseSegments: row.responseSegments, widget: row.widget, widgets: row.widgets } : message) });
}
export async function reflectCloudTasks(tasks: CloudTask[], dataChanged = false) {
  const currentScope = captureScope(), reflection = ++cloudReflection;
  const sessions = await unarchivedSessions();
  if (!currentScope() || reflection !== cloudReflection) return;
  const terminal = tasks.filter(task => task.kind === 'chat' && task.input.action !== 'compressContext' && !['queued', 'running', 'waiting_user'].includes(task.status));
  for (const task of terminal) finishedCloudTasks.add(task.id);
  const active = tasks.filter(task => task.kind === 'chat' && task.input.action !== 'compressContext' && !finishedCloudTasks.has(task.id) && ['queued', 'running', 'waiting_user'].includes(task.status));
  const submittingIds = new Set(pendingCloudSubmissions.values());
  const runningIds = [...new Set([...active.map(task => Number(task.input.sessionId)), ...submittingIds].filter(id => id !== 0))];
  useCourseChat.setState({ runningIds, sessions });
  for (const task of active) {
    const id = Number(task.input.sessionId);
    followSession(id);
    if (submittingIds.has(id)) continue;
    if (!task.progress) { writeView(id, { loading: true }); continue; }
    if (!await syncTaskWidgets(task.progress) || !currentScope() || reflection !== cloudReflection) continue;
    const view = readView(id), progress = task.progress as Record<string, unknown>;
    const text = typeof task.input.text === 'string' ? task.input.text.trim() : '';
    const widgets = Array.isArray(progress.widgets) ? progress.widgets as WidgetPayload[] : undefined;
    const phase: ProcessPhase = progress.phase === 'thinking' || progress.phase === 'tool' || progress.phase === 'answer'
      ? (progress.phase === 'answer' ? 'answering' : progress.phase) : 'preparing';
    const answer: CourseChatMessage = {
      key: `cloud-answer-${task.id}`, taskId: task.id, syncPending: true, role: 'ai',
      content: typeof progress.content === 'string' ? progress.content : '',
      reasoning: typeof progress.reasoning === 'string' ? progress.reasoning : '',
      tools: Array.isArray(progress.tools) ? progress.tools as ChatToolCall[] : undefined,
      widgets, widget: widgets?.at(-1), widgetPreview: progress.widgetPreview as { html: string } | undefined,
      rowId: typeof progress.rowId === 'number' ? progress.rowId : undefined,
      ask: progress.ask as AskUserState | undefined, folderPlan: progress.folderPlan as FolderPlanState | undefined,
      streaming: true, error: false, interrupted: false, processPhase: phase, processStartedAt: Date.parse(task.createdAt) || Date.now(),
    };
    const messages = timeline(id).progress(view.messages, task as unknown as import('@wangke/contracts/client-runtime').RuntimeTask,
      text ? { key: `cloud-user-${task.id}`, taskId: task.id, syncPending: true, role: 'user', content: text, createdAt: Date.parse(task.createdAt) || Date.now() } : undefined, answer);
    writeView(id, { messages, loaded: true, loading: true, ...pendingCards(messages) });
  }
  const refreshIds = new Set<number>();
  for (const task of terminal) {
    const id = Number(task.input.sessionId);
    if (submittingIds.has(id)) continue;
    const view = readView(id);
    const result = (task.result ?? task.progress) as { content?: string; reasoning?: string; tools?: ChatToolCall[]; widgets?: WidgetPayload[]; widget?: WidgetPayload; rowId?: number; userRowId?: number } | null;
    let changed = false;
    const messages = view.messages.map(message => {
      if (message.taskId !== task.id && message.key !== `cloud-user-${task.id}` && message.key !== `cloud-answer-${task.id}`) return message;
      if (!message.streaming && message.role !== 'user') return message;
      if (message.role === 'user' && (task.status === 'completed'
        ? result?.userRowId == null || message.committedRowId === result.userRowId || message.rowId === result.userRowId : !message.syncPending)) return message;
      changed = true;
      if (message.role === 'user') return { ...message, committedRowId: result?.userRowId ?? message.committedRowId, syncPending: task.status === 'completed' ? message.syncPending : false };
      const content = result?.content ?? message.content;
      const useful = !!content.trim() || !!result?.widgets?.length || !!message.widgets?.length || !!result?.widget || !!message.widget;
      const failed = task.status !== 'completed' && task.status !== 'cancelled';
      return { ...message, streaming: false, hint: undefined, widgetPreview: undefined,
        syncPending: task.status === 'completed' ? message.syncPending : false, committedRowId: result?.rowId ?? message.committedRowId,
        rowId: result?.rowId ?? message.rowId, content: useful ? content : failed ? `回答失败：${task.error || '未获得回答，请重试'}` : content,
        error: failed && !useful, reasoning: result?.reasoning ?? message.reasoning, tools: result?.tools ?? message.tools,
        widgets: result?.widgets ?? message.widgets, widget: result?.widget ?? message.widget,
        interrupted: failed && useful, interruptReason: task.status === 'cancelled' ? undefined : task.error ?? undefined };
    });
    if (changed || view.loading && !runningIds.includes(id)) {
      writeView(id, { messages, loading: runningIds.includes(id), ...pendingCards(messages) }); refreshIds.add(id);
    }
  }
  const ids = new Set([useCourseChat.getState().activeId, ...parked.keys()]);
  await Promise.all([...ids].filter((id): id is number => id != null && !runningIds.includes(id) && (dataChanged || refreshIds.has(id))).map(id => refreshCloudSession(id, reflection)));
  if (currentScope() && reflection === cloudReflection) for (const id of ids) if (id != null && !runningIds.includes(id)) sessionQueue().drain(id);
}

export const useCourseChat = create<CourseChatStore>()((set, get) => ({
  ...EMPTY_VIEW, ready: false, sessions: [], activeId: null, runningIds: [], awaitingIds: [], draft: '',
  sendMode: 'queue', courseCount: null, archivedSessions: [],
  bootstrap: async () => {
    if (get().ready) return;
    const current = captureScope();
    const [sessions, count, pendingDraft] = await Promise.all([unarchivedSessions(), db.videos.count(), browserChatQueue().list(0)]);
    if (!current()) return;
    const selected = get().activeId;
    const activeId = selected != null && sessions.some(row => row.id === selected) ? selected : pendingDraft.length ? null : sessions.at(-1)?.id ?? null;
    set({ sessions, ready: true, courseCount: count, activeId });
    if (activeId == null) { set({ loaded: true }); await sessionQueue().restore(0); }
  },
  refreshCourseCount: async () => { const current = captureScope(), courseCount = await db.videos.count(); if (current()) set({ courseCount }); },
  loadOlder: async () => {
    const id = get().activeId;
    if (id == null) return;
    const current = captureScope(), view = readView(id), first = view.messages[0];
    if (!view.hasOlder || view.loadingOlder || first?.rowId == null || first.createdAt == null) return;
    writeView(id, { loadingOlder: true, historyError: null });
    try {
      const page = await readChatPage(id, { id: first.rowId, createdAt: first.createdAt, role: first.role === 'ai' ? 'assistant' : 'user' });
      if (!current() || readView(id).messages[0]?.key !== first.key) return;
      const latest = readView(id), keys = new Set(latest.messages.map(message => message.rowId));
      writeView(id, { messages: [...page.rows.filter(row => !keys.has(row.id)).map(toMessage), ...latest.messages], hasOlder: page.hasOlder, loadingOlder: false });
    } catch { if (current() && readView(id).messages[0]?.key === first.key) writeView(id, { loadingOlder: false, historyError: '历史消息加载失败，点击重试' }); }
  },
  loadSession: async id => {
    const queue = sessionQueue(), current = captureScope();
    try {
      followSession(id);
      if (get().activeId === id && get().loaded) return;
      if (get().activeId != null && get().activeId !== id) parkActive();
      const cached = parked.get(id);
      if (cached?.loaded) { parked.delete(id); set({ activeId: id, ...cached }); return; }
      parked.delete(id);
      const request = Symbol('history-load'); historyLoads.set(id, request);
      set({ activeId: id, ...EMPTY_VIEW });
      const [session, page] = await Promise.all([db.chatSessions.get(id), readChatPage(id)]);
      if (!current()) return;
      const contextIds = session?.contextCourseIds ?? [];
      const [courses, projectFolder] = await Promise.all([
        contextIds.length ? db.videos.where('id').anyOf(contextIds).toArray() : [],
        session?.projectFolderId == null ? undefined : db.folders.get(session.projectFolderId),
      ]);
      if (!current() || historyLoads.get(id) !== request) return;
      historyLoads.delete(id);
      if (readView(id).loaded) return;
      const byId = new Map(courses.map(course => [course.id, course.name])), messages = page.rows.map(toMessage);
      writeView(id, { ...EMPTY_VIEW, messages, hasOlder: page.hasOlder, loaded: true,
        skillIds: session?.skillIds, mcpServerIds: session?.mcpServerIds,
        project: session?.projectFolderId == null ? null : { folderId: session.projectFolderId, name: projectFolder?.name ?? '项目', color: projectFolder?.color },
        contextCourses: contextIds.filter(cid => byId.has(cid)).map(cid => ({ id: cid, name: byId.get(cid)! })), ...pendingCards(messages) });
    } finally { if (current()) await queue.restore(id); }
  },
  createSession: async () => {
    if (get().activeId == null) { await sessionQueue().restore(0); return; }
    const current = captureScope(); await sessionQueue().flush(); if (!current()) return;
    parkActive(); beginChatDraft(); queueBinding = undefined; set(DRAFT_STATE);
  },
  deleteSessionById: async id => {
    if (get().runningIds.includes(id)) return false;
    const current = captureScope(), wasActive = get().activeId === id;
    await deleteServerSession(id, await readChatHistory(id));
    if (!current()) return false;
    sessionQueue().clear(id); await sessionQueue().flush();
    void useChatAttachments.getState().discard(id);
    parked.delete(id); serverSessions.get(id)?.(); serverSessions.delete(id); timelines.get(id)?.dispose(); timelines.delete(id);
    useChatNotifications.getState().dismiss(id);
    const sessions = await unarchivedSessions(); if (!current()) return false;
    set({ sessions });
    if (wasActive) { set(DRAFT_STATE); const next = sessions.at(-1); if (next) await get().loadSession(next.id!); }
    return true;
  },
  deleteSession: async () => { const id = get().activeId; return id == null ? false : get().deleteSessionById(id); },
  renameSession: async (id, title) => { if (title.trim()) await patchSession(id, row => { row.title = title.trim(); }); },
  setPinned: async (id, pinned) => { await patchSession(id, row => { if (pinned) row.pinned = true; else delete row.pinned; }); },
  setArchived: async (id, archived) => {
    if (get().runningIds.includes(id)) return false;
    const current = captureScope(), wasActive = get().activeId === id;
    await patchSession(id, row => { if (archived) row.archived = true; else delete row.archived; });
    if (!current()) return false;
    if (archived) { parked.delete(id); serverSessions.get(id)?.(); serverSessions.delete(id); useChatNotifications.getState().dismiss(id); void useChatAttachments.getState().discard(id); }
    const sessions = await unarchivedSessions(); if (!current()) return false;
    set({ sessions });
    if (archived && wasActive) { set(DRAFT_STATE); const next = sessions.at(-1); if (next) await get().loadSession(next.id!); }
    return true;
  },
  refreshArchived: async () => { const current = captureScope(), rows = await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt'); if (current()) set({ archivedSessions: rows.filter(row => row.archived) }); },
  setDraft: draft => set({ draft }),
  setMcpServerIds: async ids => { const key = activeKey(), current = captureScope(); if (key) await reviseConversationSession(key, row => { if (ids === undefined) delete row.mcpServerIds; else row.mcpServerIds = ids; }); if (current()) writeView(key, { mcpServerIds: ids }); },
  setSkillIds: ids => { const key = activeKey(), current = captureScope(); writeView(key, { skillIds: ids }); if (key) void patchSession(key, row => { if (ids === undefined) delete row.skillIds; else row.skillIds = ids; }).catch(error => { if (current()) writeView(key, { historyError: String(error) }); }); },
  setTurnSkillIds: ids => { if (!get().loading) set({ turnSkillIds: explicitSkillIds(ids) }); },
  clearCourseContext: () => { const key = activeKey(), current = captureScope(); writeView(key, { contextCourses: [] }); if (key) void patchSession(key, row => { delete row.contextCourseIds; }).catch(error => { if (current()) writeView(key, { historyError: String(error) }); }); },
  setCourseContext: async ids => {
    const key = activeKey(), current = captureScope();
    const courses = (await db.videos.bulkGet(normalizeCourseContextIds(ids) ?? [])).filter(row => row != null).map(row => ({ id: row.id, name: row.name }));
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
    if (files.some(item => !item.value || !!item.error)) { useChatAttachments.setState({ error: ATTACHMENTS_PENDING_ERROR }); return; }
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
        if (activeKey() === key) set(s => ({ sessions: [...s.sessions, row], activeId: id, loaded: true }));
        else { set(s => ({ sessions: [...s.sessions, row] })); writeView(id, { ...view, loaded: true }); }
      }
      pendingCloudSubmissions.set(operationId, id); timeline(id).begin(operationId);
      const messages = [...readView(id).messages];
      if (!resume && text && !continuing && !messages.some(message => message.key === userKey)) messages.push({ key: userKey, role: 'user', content: text, attachments, createdAt: Date.now() });
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
      const turnKey = id ?? key, reason = error instanceof Error ? error.message : String(error);
      if (id != null) timeline(id).uncertain(operationId);
      writeView(turnKey, { messages: readView(turnKey).messages.map(message => message.key === answerKey
        ? continuing ? { ...message, streaming: false, interrupted: true, interruptReason: reason }
          : { ...message, content: `发送失败：${reason}`, streaming: false, error: true } : message), loading: view.loading && key !== 0, historyError: reason });
      markRunning(turnKey, view.loading && key !== 0);
      if (id != null) { consume(); if (fromComposer) writeView(id, { turnSkillIds: [] }); await sessionQueue().restore(id).catch(() => {}); }
    } finally { if (currentScope()) pendingCloudSubmissions.delete(operationId); }
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
    const row = await db.chats.get(message.rowId);
    if (!current() || !row || row.sessionId !== sessionId || readView(sessionId).loading) return false;
    await removeConversationMessages([message.rowId]); if (!current()) return false;
    writeView(sessionId, { messages: readView(sessionId).messages.filter(item => item.key !== key) }); return true;
  },
  retryMessage: async key => {
    const current = captureScope(), state = get(), message = state.messages.find(item => item.key === key), id = state.activeId;
    if (state.loading || !message) return;
    if (message.error && message.operationId && id != null) {
      const item = (await browserChatQueue().list(id)).find(item => (item.operationId ?? item.id) === message.operationId);
      if (current() && item) await get().send(item.text, undefined, id, undefined, item.attachments ?? [], item.explicitSkillIds ?? [], { ...item, explicitRetry: true });
      return;
    }
    if (id == null || message.rowId == null) return;
    if (message.interrupted) {
      const adapter = browserChatQueue(), operationId = message.pendingOperationId ?? crypto.randomUUID();
      pendingCloudSubmissions.set(operationId, id); markRunning(id, true);
      writeView(id, { loading: true, messages: readView(id).messages.map(item => item.key === key ? { ...item, pendingOperationId: operationId } : item) });
      try {
        const settings = getSettings(), selection = taskModelChoice(id);
        const task = await adapter.submit(id, { id: operationId, operationId, text: '继续回答', action: 'continue', rowId: message.rowId },
          { sessionId: id, rowId: message.rowId, action: 'continue', ...(selection ? { modelSelection: JSON.parse(JSON.stringify(selection)) } : {}), thinkingLevel: settings.thinkingEnabled ? settings.thinkingEffort : 'none' }, !!message.pendingOperationId);
        if (!current() || !adapter.current()) return;
        followSession(id);
        writeView(id, { messages: readView(id).messages.map(item => item.key === key ? { ...item, taskId: task.id, pendingOperationId: undefined, streaming: true, interrupted: false, interruptReason: undefined } : item) });
      } catch (error) {
        if (!current() || !adapter.current()) return;
        writeView(id, { loading: false, messages: readView(id).messages.map(item => item.key === key ? { ...item, streaming: false, interrupted: true, interruptReason: String(error) } : item) });
        markRunning(id, false); await sessionQueue().restore(id).catch(() => {});
      } finally { if (current()) pendingCloudSubmissions.delete(operationId); }
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
  },
  forkSession: async (id, uptoRowId) => {
    if (get().runningIds.includes(id)) return null;
    const current = captureScope(), source = await db.chatSessions.get(id);
    if (!current() || !source) return null;
    const rows = await readChatHistory(id); if (!current()) return null;
    const cut = uptoRowId == null ? rows.length : rows.findIndex(row => row.id === uptoRowId) + 1;
    if (cut <= 0) return null;
    const sid = await forkServerSession(source, rows.slice(0, cut)); if (!current()) return null;
    const sessions = await unarchivedSessions(); if (!current()) return null;
    set({ sessions }); await get().loadSession(sid); return sid;
  },
  answerAsk: async answer => { await commandServerChat(get().activeId, 'answerAsk', answer); },
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
  await submitLearning([learningEdit({ kind: 'conversationSession', expected: null, value } as any)], [`session:${value.id}`]);
  if (!current() || !adapter.current()) throw new Error('client_account_changed');
  await adapter.rekeyDraft(value.id!); return value;
}
async function unarchivedSessions() {
  return (await db.chatSessions.where('videoId').equals(LIBRARY_ASSISTANT_ID).sortBy('createdAt')).filter(row => !row.archived);
}
async function patchSession(id: number, mutate: (row: ChatSessionRow) => void) {
  const current = captureScope(); await reviseConversationSession(id, mutate); if (!current()) return;
  const fresh = await db.chatSessions.get(id); if (!current() || !fresh) return;
  useCourseChat.setState(state => {
    const archived = new Map(state.archivedSessions.map(row => [row.id, row]));
    if (fresh.archived) archived.set(id, fresh); else archived.delete(id);
    return { sessions: state.sessions.map(row => row.id === id ? fresh : row).filter(row => !row.archived), archivedSessions: [...archived.values()] };
  });
}
function toMessage(row: ChatRow): CourseChatMessage {
  const empty = !!row.interrupted && !row.content.trim() && !row.widget && !row.widgets?.length && !row.ask && !row.folderPlan;
  return { key: `stored-${row.id}`, rowId: row.id!, taskId: row.taskId, role: row.role === 'assistant' ? 'ai' : 'user',
    content: empty ? '回答失败：未获得回答，请重试' : row.content, ...(empty ? { error: true } : {}),
    attachments: row.attachments, createdAt: row.createdAt, reasoning: row.reasoning, responseSegments: row.responseSegments,
    reasoningMs: row.reasoningMs, tools: row.tools, interrupted: row.interrupted && !empty, interruptReason: row.interruptReason,
    ask: row.ask, folderPlan: row.folderPlan, widget: row.widget, widgets: row.widgets };
}
