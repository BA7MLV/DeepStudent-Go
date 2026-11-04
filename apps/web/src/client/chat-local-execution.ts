import { runAgentLoop } from '../harness/agent';
import { createResourceExecutor, libraryResourceTools } from '../harness/resources';
import { getSettings, decisionConfigOf } from '../store/settings';
import { db as browserDatabase } from '../store/db';
import { readChatHistory } from '../store/chatHistory';
import { loadSessionSkillMeta, skillMetaBlock } from '../skills/store';
import { activateSkills, assertSkillBudget, assertSkillRequestBudget } from '../skills/activation';
import { libraryAssistantSystemPrompt, type CourseContextItem } from '../harness/libraryAssistant';
import { estimateTokens } from '../harness/context';
import { prepareSessionHistory } from '../store/contextCompression';
import { fitModelHistory, sessionCacheKey } from '../store/modelHistory';
import { attachmentText, type ChatAttachment } from '../chat/attachments';
import { attachmentsForModel, messageForModel } from '../chat/attachmentModel';
import { reconcileSkillMessages, messageTokens, runtimeContext, splitSystemPrompt, replayTrace } from '@wangke/study-core/model/transcript';
import { displayEnvironmentPrompt } from '../harness/displayEnvironment';
import type { ChatMessage } from '../api/siliconflow';
import type { ChatRow } from '../store/db';
import type { ResumeRequest } from '../store/courseChat';
import type { ChatProject } from '../projects/chatProjects';
import { CONTINUE_INSTRUCTION } from '@wangke/study-core/continuation';
import { messageWidgets } from '../harness/widgetLayout';
import { validateWidgetPayload } from '../harness/widgetProtocol';
import { cloud } from '../cloud/state';
import { appendConversationMessage, patchConversationMessage, reviseConversationSession } from '../store/conversationProducts';

type LoopOptions = Parameters<typeof runAgentLoop>[3];
type ResourceOptions = Parameters<typeof createResourceExecutor>[0];

/** Capture the database, not the live account's mutable db binding. */
export function localChatPersistence(database = browserDatabase) {
  return { snapshot: async (snapshot: Omit<ChatRow, 'id'>, rowId?: number): Promise<number> => {
    for (const widget of messageWidgets(snapshot)) validateWidgetPayload(widget);
    return database.transaction('rw', database.chats, async () => {
      if (rowId == null) return await database.chats.add(snapshot) as number;
      const previous = await database.chats.get(rowId);
      if (!previous || previous.role !== 'assistant' || previous.sessionId !== snapshot.sessionId || previous.videoId !== snapshot.videoId) throw new Error('原回答已删除或会话已变化，作品未保存');
      await database.chats.update(rowId, { ...snapshot, createdAt: previous.createdAt, interrupted: snapshot.interrupted, interruptReason: snapshot.interruptReason, resume: snapshot.resume });
      return rowId;
    });
  } };
}

/** Browser Local execution carrier. No cloud state, transport selection, React,
 * Zustand or UI store access. Tool IO is supplied through the resource port. */
export function runLocalChat(messages: ChatMessage[], hasCourses: boolean, resources: ResourceOptions, options: LoopOptions, maxRounds: number) {
  options?.signal?.throwIfAborted();
  return runAgentLoop(messages, libraryResourceTools(hasCourses), createResourceExecutor(resources), options, maxRounds);
}
export function runLocalContinuation(messages: ChatMessage[], options: LoopOptions) {
  options?.signal?.throwIfAborted();
  return runAgentLoop(messages, [], async () => '（续写中不需要调用工具）', options, 2);
}

export async function prepareLocalContinuation(sessionId: number, rowId: number, partial: string, view: { skillIds?: number[]; contextCourses: CourseContextItem[] }, signal: AbortSignal) {
  const db = browserDatabase;
  const check = () => { signal.throwIfAborted(); if (db !== browserDatabase) throw new Error('client_account_changed'); };
  signal.throwIfAborted();
  const settings = getSettings();
  const courseCount = await db.videos.count();
  const rows = await readChatHistory(sessionId);
  check();
  const idx = rows.findIndex(row => row.id === rowId);
  const history = idx >= 0 ? rows.slice(0, idx + 1) : rows;
  const skillMetas = await loadSessionSkillMeta(view.skillIds);
  const systemPrompt = libraryAssistantSystemPrompt(skillMetas.length ? skillMetaBlock(skillMetas) : undefined, view.contextCourses, courseCount > 0, settings.agentInstructions);
  const origin = [...history].reverse().find(row => row.role === 'user' && row.explicitSkillIds !== undefined);
  const activated = await activateSkills(origin?.explicitSkillIds ?? [], view.skillIds, sessionId);
  check();
  const budget = settings.contextWindow - estimateTokens(systemPrompt) - messageTokens(activated.messages) - estimateTokens(CONTINUE_INSTRUCTION) - 4096;
  assertSkillBudget(budget, activated);
  const recent = await fitModelHistory(sessionId, history.map(row => ({ ...row, originalContent: row.content, content: attachmentText(row.content, row.attachments) })), Math.max(2000, budget));
  const original = rows.find(row => row.id === rowId);
  const priorTrace = original && replayTrace(original) || [{ role: 'assistant' as const, content: partial }];
  const chatMessages = reconcileSkillMessages([
    ...splitSystemPrompt(systemPrompt), ...await historyMessagesWithAttachments(recent, signal, db),
    ...activated.messages, { role: 'user', content: CONTINUE_INSTRUCTION },
  ], skillMetas);
  assertSkillRequestBudget(settings.contextWindow, chatMessages, activated);
  check();
  return { settings, courseCount, priorTrace, chatMessages };
}

/** Context/skills/attachment preparation belongs to execution, not the view
 * store. Callbacks expose presentation updates only. */
export async function prepareLocalChat(input: {
  sessionId: number; text: string; attachments: ChatAttachment[]; selectedSkills: number[];
  skillIds?: number[]; contextCourses: CourseContextItem[]; project: ChatProject | null;
  resume?: ResumeRequest; requestOwnerId?: number; signal: AbortSignal;
}, events: {
  context(courseCount: number, courses: CourseContextItem[]): void;
  attachments(files: ChatAttachment[]): void;
  hint(text: string): void;
}) {
  const db = browserDatabase;
  const { sessionId, text, resume, signal } = input;
  const check = () => { signal.throwIfAborted(); if (db !== browserDatabase) throw new Error('client_account_changed'); };
  check();
  const settings = getSettings();
  const courseCount = await db.videos.count();
  check();
  const hasCourses = courseCount > 0;
  let contextCourses = input.contextCourses;
  if (!hasCourses && contextCourses.length) {
    contextCourses = [];
    await reviseConversationSession(sessionId, row => { delete row.contextCourseIds; });
  }
  events.context(courseCount, contextCourses);
  const [history, skillMetas] = await Promise.all([readChatHistory(sessionId), loadSessionSkillMeta(input.skillIds)]);
  check();
  let selectedSkills = input.selectedSkills;
  if (resume) {
    const index = history.findIndex(row => row.id === resume.rowId);
    const origin = history.slice(0, index < 0 ? history.length : index + 1).reverse().find(row => row.role === 'user' && row.explicitSkillIds !== undefined);
    selectedSkills = origin?.explicitSkillIds ?? selectedSkills;
  }
  const activated = await activateSkills(selectedSkills, input.skillIds, sessionId);
  check();
  const systemPrompt = libraryAssistantSystemPrompt(skillMetas.length ? skillMetaBlock(skillMetas) : undefined, contextCourses, hasCourses, settings.agentInstructions);
  assertSkillBudget(settings.contextWindow - estimateTokens(systemPrompt) - messageTokens(activated.messages) - estimateTokens(text) - 4096, activated);
  let attachments = input.attachments;
  if (input.requestOwnerId != null && attachments.some(file => file.dataUrl)) {
    events.hint('正在读取图片…');
    attachments = await attachmentsForModel(attachments, text, signal);
    check();
    await patchConversationMessage(input.requestOwnerId, { attachments });
    events.attachments(attachments);
  }
  const cut = resume ? history.findIndex(row => row.id === resume.rowId) : history.length - 1;
  const baseRows = history.slice(0, cut < 0 ? history.length : cut).map(row => ({ ...row, originalContent: row.content, content: attachmentText(row.content, row.attachments) }));
  const tail: ChatMessage = resume
    ? { role: 'tool', tool_call_id: resume.toolCallId, name: resume.toolName, content: resume.toolResult }
    : messageForModel({ role: 'user', content: runtimeContext({ courses: contextCourses, ...(input.project ? { project: input.project } : {}), layout: displayEnvironmentPrompt('course').split('\n').slice(1).join('\n') }) + text, attachments });
  const budget = settings.contextWindow - estimateTokens(systemPrompt) - messageTokens(activated.messages) - estimateTokens(resume ? resume.toolResult : attachmentText(text, attachments)) - attachments.filter(file => file.dataUrl).length * 1600 - 4096;
  assertSkillBudget(budget, activated);
  if (budget < 0) throw new Error('附件正文超过当前模型的上下文预算，请减少附件、改用更大上下文模型，或将文件导入课程库后检索');
  const recent = resume ? await fitModelHistory(sessionId, baseRows, Math.max(2000, budget))
    : await prepareSessionHistory(sessionId, baseRows, Math.max(2000, budget), text, decisionConfigOf(settings), {
      signal, onStart: () => events.hint('Jev 正在筛选历史上下文…'),
      onCompressed: turns => events.hint(`已省略 ${turns} 个旧轮次，原始记录保留`),
    });
  const chatMessages = reconcileSkillMessages([
    ...splitSystemPrompt(systemPrompt), ...await historyMessagesWithAttachments(recent, signal, db),
    ...activated.messages, ...(resume ? resume.midTurn : []), tail,
  ], skillMetas);
  assertSkillRequestBudget(settings.contextWindow, chatMessages, activated);
  check();
  return { settings, hasCourses, contextCourses, activated, attachments, tail, chatMessages, cacheKey: await sessionCacheKey(sessionId) };
}

export async function historyMessagesWithAttachments(rows: (ChatRow & { originalContent: string })[], signal: AbortSignal, db = browserDatabase): Promise<ChatMessage[]> {
  const messages: ChatMessage[] = [];
  for (const row of rows) {
    signal.throwIfAborted();
    if (db !== browserDatabase) throw new Error('client_account_changed');
    const raw = replayTrace(row);
    if (raw) { messages.push(...raw); continue; }
    const attachments = await attachmentsForModel(row.attachments ?? [], row.originalContent, signal);
    if (row.id != null && attachments.some((file, i) => file.description !== row.attachments?.[i]?.description)) await patchConversationMessage(row.id, { attachments });
    messages.push(messageForModel({ ...row, content: row.originalContent, attachments }));
  }
  return messages;
}
