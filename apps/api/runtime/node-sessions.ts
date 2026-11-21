/** 服务端 chat / qa / 续写的会话编排与历史投影。
 * 从 runtime/node.ts 原样搬出(仅补导出):历史裁剪、检查点指纹与
 * 用户行只在请求数变化时重写,这些规则与同步层去重直接相关。 */
import { CONTINUE_INSTRUCTION, createContinuationFilter } from '@wangke/study-core/continuation';
import { chatStream, textOf, type ChatMessage, type ChatOptions } from '@wangke/study-core/model/client';
import { replayTrace, messageTokens, runtimeContext, splitSystemPrompt, historyFingerprint, modelTrace } from '@wangke/study-core/model/transcript';
import type { ModelRequestRecord } from '@wangke/study-core/model/usage';
import { beginResponseSegment, type ResponseSegment } from '@wangke/study-core/response-order';
import { attachmentMessage } from '@wangke/study-core/chat/attachments';
import { compareChatRows, nextChatTurnTimes } from '@wangke/study-core/chat-order';
import { SERVER_WIDGET_RULE } from '@wangke/study-core/widget-tool';
import type { WidgetPayload } from '@wangke/study-core/widgets';
import { commitTask, newRecordId, recordMutation, taskRows, type TaskContext } from '../src/cloud/execution.js';
import { sessionSkills, skillHistoryBudget, assertSkillRequestBudget } from './skills.js';
import { sessionMcp } from './mcp.js';
import { sessionShell } from './chat-shell.js';
import { refineSessionTitle } from './session-title.js';
import { taskChatAttachments, resolveAttachmentMessages } from './chat-attachments.js';
import { effectiveCompressionRows } from './context-compression.js';
import { chatOutputTokens } from './chat-output-budget.js';
import { prepareModelImages } from '../src/agent/image-preparation.js';
import { modelSettings } from '../src/agent/model-settings.js';
import { qaSystemPrompt, modelFetch, responseFields, safeImageParts, targetFor, taskThinkingLevel, widgetFields, type ServerAgentResult } from './node-common.js';
import { runServerAgent } from './node-agent-loop.js';
import { qaExecutor, libraryExecutor, libraryTools } from './node-library-tools.js';
import { rowsFor, videoFor, materialKindOf, qaTools } from './node-course-access.js';

/** 资料库助手在 chats.videoId 里的固定伪课程 id;与客户端投影约定绑死。 */
export const LIBRARY_ASSISTANT_ID = '__library_assistant__';

export function chatHistory(context: TaskContext, sessionId: number) {
  return taskRows(context, 'chats', 'sessionId', sessionId)
    .filter(row => row.role === 'user' || row.role === 'assistant')
    .sort(compareChatRows);
}

export async function modelHistory(history: Record<string, any>[], session: Record<string, any>, budget: number) {
  const checkpoint = session.contextCheckpoint;
  let index = checkpoint ? history.findIndex(r => r.id === checkpoint.fromId && r.content === checkpoint.source) : 0;
  if (index > 0 && checkpoint?.prefixHash && await historyFingerprint(history.slice(0, index) as Array<{ content: string }>) !== checkpoint.prefixHash) index = 0;
  const afterCheckpoint = new Set(history.slice(Math.max(0, index)));
  const rows = effectiveCompressionRows(history, session.contextOmissions).filter(row => afterCheckpoint.has(row));
  const messages = rows.map(row => replayTrace(row as { content: string }) ?? [attachmentMessage({ role: row.role, content: String(row.content ?? ''), attachments: row.attachments })]);
  const costs = messages.map(messageTokens);
  let total = costs.reduce((a, b) => a + b, 0), cut = 0;
  if (total > budget) while (cut < rows.length && total > budget * 0.8) {
    let next = cut + 1;
    while (next < rows.length && (rows[next].role !== 'user' || messages[next].length === 0)) next++;
    if (next === rows.length) break;
    while (cut < next) total -= costs[cut++];
  }
  return { messages: messages.slice(cut).flat(), ...(cut > 0 ? { checkpoint: { fromId: rows[cut].id, source: rows[cut].content, prefixHash: await historyFingerprint(history.slice(0, history.indexOf(rows[cut])) as Array<{ content: string }>) } } : {}) };
}

export function addConversationMutations(
  context: TaskContext,
  sessionId: number,
  userRow: Record<string, any>,
  assistantRow: Record<string, any>,
  sessionPatch?: Record<string, unknown>,
  requireExisting = false,
  writeUser = true,
) {
  // Read the latest committed timeline at commit time, not before the model request.
  // IDs remain identities, never ordering keys for a new question/answer pair.
  const previousUser = context.records.get(context.owner, 'chats', userRow.id);
  const previousAssistant = context.records.get(context.owner, 'chats', assistantRow.id);
  if (requireExisting && (!previousUser || !previousAssistant)) throw new Error('原回答已删除，生成已停止');
  // A delivered widget may already have local state (or a newer source revision)
  // synced by another device while this same server turn is still writing.
  if (previousAssistant) {
    for (const key of ['widgetState', 'widgetStates']) {
      if (previousAssistant[key] !== undefined) assistantRow[key] = previousAssistant[key];
    }
    if (Array.isArray(assistantRow.widgets) && Array.isArray(previousAssistant.widgets)) {
      assistantRow.widgets = assistantRow.widgets.map((widget: WidgetPayload) => {
        const current = previousAssistant.widgets.find((item: WidgetPayload) => item.ref === widget.ref);
        return current && (current.revision ?? 1) > (widget.revision ?? 1) ? current : widget;
      });
      assistantRow.widget = assistantRow.widgets.at(-1);
    }
  }
  const times = nextChatTurnTimes(chatHistory(context, sessionId).filter(row => row.id !== userRow.id && row.id !== assistantRow.id), Number(userRow.createdAt), Date.now());
  userRow.createdAt = previousUser?.createdAt ?? times.user;
  assistantRow.createdAt = previousAssistant?.createdAt ?? times.assistant;
  const mutations = [
    ...(writeUser ? [recordMutation('chats', userRow.id, previousUser, { ...userRow, taskId: context.task.id })] : []),
    recordMutation('chats', assistantRow.id, previousAssistant, { ...assistantRow, taskId: context.task.id }),
  ];
  if (sessionPatch) {
    const current = context.records.get(context.owner, 'chatSessions', sessionId);
    if (current) mutations.push(recordMutation('chatSessions', sessionId, current, { ...current, ...sessionPatch }));
  }
  commitTask(context, mutations);
}

export async function qa(context: TaskContext) {
  const input = context.task.input as Record<string, any>;
  const videoId = String(input.videoId ?? '');
  const sessionId = Number(input.sessionId);
  const video = videoFor(context, videoId);
  if (!video || !Number.isSafeInteger(sessionId)) throw new Error('问答上下文不存在');
  const session = context.records.get(context.owner, 'chatSessions', sessionId);
  if (!session) throw new Error('问答会话不存在');
  const mcp = await sessionMcp(context);
  const skills = sessionSkills(context, session, input.explicitSkillIds, mcp.serverNames);
  const kind = materialKindOf(video);
  const text = String(input.text ?? '').trim();
  if (!text) throw new Error('问题不能为空');
  const history = chatHistory(context, sessionId).filter(row => row.taskId !== context.task.id);
  const checkpoint = context.store.db.prepare('SELECT 1 FROM task_agent_checkpoints WHERE task_id=?').get(context.task.id);
  const userId = checkpoint && typeof context.task.progress?.userRowId === 'number' ? context.task.progress.userRowId : newRecordId();
  const assistantId = checkpoint && typeof context.task.progress?.rowId === 'number' ? context.task.progress.rowId : newRecordId();
  const userRow = { id: userId, videoId, sessionId, role: 'user', explicitSkillIds: skills.ids, content: String(input.displayText ?? text), createdAt: Date.now(), ...(Array.isArray(input.chatImages) && input.chatImages.length ? { images: input.chatImages.slice(0, 12) } : {}) };
  const target = targetFor(context);
  const system = `${qaSystemPrompt(video, kind, input)}\n\n${SERVER_WIDGET_RULE}${skills.prompt}`;
  const currentText = runtimeContext({ courseId: videoId, courseName: input.videoName ?? video.name, shotCount: input.shotCount ?? 0, refsCount: input.refsCount ?? 0 }) + text;
  const images = safeImageParts(input.images);
  const current: ChatMessage = images.length ? { role: 'user', content: [...images, { type: 'text', text: currentText }] } : { role: 'user', content: currentText };
  const recent = await modelHistory(history, session, skillHistoryBudget(target.capabilities?.contextWindow ?? 131072, [{ role: 'system', content: system }, current], skills.messages));
  const messages: ChatMessage[] = skills.reconcile([...splitSystemPrompt(system), ...recent.messages, ...skills.messages, current]);
  assertSkillRequestBudget(target.capabilities?.contextWindow ?? 131072, messages, skills.messages.length > 0);
  const title = session.title === '新会话' ? text.slice(0, 18) || '新会话' : undefined;
  let checkpointed = Boolean(checkpoint);
  let writtenRequests = -1;
  const persist = (result: ServerAgentResult, interrupted = true) => {
    // The user row only changes when the turn starts or accumulates a model
    // request. Rewriting it on every checkpoint clones the whole skill prompt.
    const writeUser = !checkpointed || writtenRequests !== result.requests.length;
    const assistantRow = { id: assistantId, videoId, sessionId, role: 'assistant', content: result.content, modelTrace: modelTrace(result.content, result.transcript), createdAt: Date.now(), ...(interrupted ? { interrupted: true } : {}), ...(result.reasoning ? { reasoning: result.reasoning } : {}), ...(result.tools.length ? { tools: result.tools } : {}), ...responseFields(result) };
    const user = writeUser ? { ...userRow, modelTrace: modelTrace(userRow.content, [...skills.messages, current]), modelRequests: result.requests } : userRow;
    addConversationMutations(context, sessionId, user, assistantRow, checkpointed ? undefined : { ...(title ? { title } : {}), ...(recent.checkpoint ? { contextCheckpoint: recent.checkpoint } : {}) }, checkpointed, writeUser);
    checkpointed = true;
    if (writeUser) writtenRequests = result.requests.length;
    result.widgets = assistantRow.widgets ?? [];
    return { rowId: assistantId, userRowId: userId, ...widgetFields(result) };
  };
  const result = await runServerAgent(context, target, messages, [...qaTools(kind), ...mcp.tools], mcp.wrap(skills.wrap(qaExecutor(context, videoId, kind))), persist, [...skills.traces, ...mcp.traces], mcp.label);
  persist(result, false);
  if (title) await refineSessionTitle(context, sessionId, title, target, text, result.content, modelFetch(context));
  return { content: result.content, reasoning: result.reasoning, tools: result.tools, rowId: assistantId, userRowId: userId, ...responseFields(result) };
}

export async function chat(context: TaskContext) {
  if (context.task.input.action === 'continue') return continueChat(context);
  const startedAt = Date.now();
  const input = context.task.input as Record<string, any>;
  const sessionId = Number(input.sessionId);
  if (!Number.isSafeInteger(sessionId)) throw new Error('聊天会话不存在');
  const session = context.records.get(context.owner, 'chatSessions', sessionId);
  if (!session) throw new Error('聊天会话不存在');
  const shell = sessionShell(context);
  const mcp = await sessionMcp(context);
  const skills = sessionSkills(context, session, input.explicitSkillIds, mcp.serverNames);
  const attachments = taskChatAttachments(context);
  const text = String(input.text ?? '').trim() || (attachments.length ? '请分析这些附件。' : '');
  if (!text) throw new Error('问题不能为空');
  const history = chatHistory(context, sessionId).filter(row => row.taskId !== context.task.id);
  const courses = rowsFor(context, 'videos');
  const courseReference = session.courseReferenceEnabled !== false;
  const webSearchEnabled = session.webSearchEnabled !== false;
  const courseRule = courseReference
    ? '规则：涉及用户课程、学习进度或课程内容时必须先调用工具，不能编造；引用课程内容时保留工具返回的课程名、courseId 和时间/页码。'
    : '规则：本会话已关闭课程引用，不要调用课程工具或读取课程内容；涉及课程内容时说明本会话未开启课程引用，基于通用知识回答。';
  const system = `你是 DeepStudent Go 学习资料库助手。服务器负责模型请求、检索、任务和数据保存；你可以通过工具读取用户自己的课程数据。\n\n${courseRule}通用问题直接回答。用简洁自然的中文回答。\n\n${SERVER_WIDGET_RULE}`;
  const project = session.projectFolderId == null ? undefined : context.records.get(context.owner, 'folders', session.projectFolderId);
  const current = attachmentMessage({ role: 'user', content: `${project ? runtimeContext({ project: { folderId: project.id, name: project.name } }) : ''}${text}`, attachments });
  const systemWithSkills = system + shell.prompt + skills.prompt;
  const target = targetFor(context);
  const recent = await modelHistory(history, session, skillHistoryBudget(target.capabilities?.contextWindow ?? 131072, [{ role: 'system', content: systemWithSkills }, current], skills.messages));
  const messages: ChatMessage[] = skills.reconcile([{ role: 'system', content: systemWithSkills }, ...recent.messages, ...skills.messages, current]);
  assertSkillRequestBudget(target.capabilities?.contextWindow ?? 131072, messages, skills.messages.length > 0);
  const checkpoint = context.store.db.prepare('SELECT 1 FROM task_agent_checkpoints WHERE task_id=?').get(context.task.id);
  const userId = checkpoint && typeof context.task.progress?.userRowId === 'number' ? context.task.progress.userRowId : newRecordId();
  const assistantId = checkpoint && typeof context.task.progress?.rowId === 'number' ? context.task.progress.rowId : newRecordId();
  const title = session.title === '新会话' ? text.slice(0, 18) || '新会话' : undefined;
  let checkpointed = Boolean(checkpoint);
  let writtenRequests = -1;
  const persist = (result: ServerAgentResult, interrupted = true) => {
    // The user row only changes when the turn starts or accumulates a model
    // request. Rebuilding it per checkpoint clones the skill prompt on every
    // stream tick even though no field changed.
    const writeUser = !checkpointed || writtenRequests !== result.requests.length;
    const userRow = { id: userId, videoId: LIBRARY_ASSISTANT_ID, sessionId, role: 'user', explicitSkillIds: skills.ids, content: text, ...(attachments.length ? { attachments } : {}), createdAt: startedAt,
      ...(writeUser ? { modelTrace: modelTrace(text, [...skills.messages, current]), modelRequests: result.requests } : {}) };
    const assistantRow = { id: assistantId, videoId: LIBRARY_ASSISTANT_ID, sessionId, role: 'assistant', content: result.content, modelTrace: modelTrace(result.content, result.transcript), createdAt: Date.now(), ...(interrupted ? { interrupted: true } : {}), ...(result.ask ? { ask: result.ask } : {}), ...(result.reasoning ? { reasoning: result.reasoning } : {}), ...(result.tools.length ? { tools: result.tools } : {}), ...responseFields(result) };
    addConversationMutations(context, sessionId, userRow, assistantRow, checkpointed ? undefined : { ...(title ? { title } : {}), ...(recent.checkpoint ? { contextCheckpoint: recent.checkpoint } : {}) }, checkpointed, writeUser);
    checkpointed = true;
    if (writeUser) writtenRequests = result.requests.length;
    result.widgets = assistantRow.widgets ?? [];
    return { rowId: assistantId, userRowId: userId, ...widgetFields(result) };
  };
  const result = await runServerAgent(context, target, messages, [...libraryTools(courseReference && courses.length > 0), ...shell.tools, ...mcp.tools], mcp.wrap(skills.wrap(shell.wrap(libraryExecutor(context, session, courseReference)))), persist, [...skills.traces, ...mcp.traces], mcp.label, webSearchEnabled);
  persist(result, false);
  if (title) await refineSessionTitle(context, sessionId, title, target, text, result.content, modelFetch(context));
  return { content: result.content, reasoning: result.reasoning, tools: result.tools, rowId: assistantId, userRowId: userId, ...(result.ask ? { ask: result.ask } : {}), ...responseFields(result) };
}

/** Explicit continuation changes one existing answer, never creates another
 * question or executes tools from an incomplete former turn. */
export async function continueChat(context: TaskContext) {
  const sessionId = Number(context.task.input.sessionId);
  const rowId = Number(context.task.input.rowId);
  if (!Number.isSafeInteger(sessionId) || !Number.isSafeInteger(rowId)) throw new Error('续写消息不存在');
  const session = context.records.get(context.owner, 'chatSessions', sessionId);
  const original = context.records.get(context.owner, 'chats', rowId);
  if (!session || !original || original.sessionId !== sessionId || original.role !== 'assistant'
    || original.videoId !== LIBRARY_ASSISTANT_ID || !original.interrupted) throw new Error('原回答不存在或不需要续写');
  const history = chatHistory(context, sessionId);
  const index = history.findIndex(row => row.id === rowId);
  if (index < 0) throw new Error('原回答已删除');
  const userRow = history.slice(0, index).reverse().find(row => row.role === 'user');
  const mcp = await sessionMcp(context);
  const skills = sessionSkills(context, session, userRow?.explicitSkillIds, mcp.serverNames);
  const target = targetFor(context);
  const recent = await modelHistory(history.slice(0, index + 1), session, skillHistoryBudget(target.capabilities?.contextWindow ?? 131072, [], skills.messages));
  const instruction: ChatMessage = { role: 'user', content: CONTINUE_INSTRUCTION };
  const messages: ChatMessage[] = skills.reconcile([{ role: 'system', content: '你是学习助手。用户要求接着原回答继续写，不要重复已有内容，不调用工具。' }, ...recent.messages, ...skills.messages, instruction]);
  assertSkillRequestBudget(target.capabilities?.contextWindow ?? 131072, messages, skills.messages.length > 0);
  const priorTrace = replayTrace(original as { content: string }) ?? [{ role: 'assistant' as const, content: original.content }];
  const filter = createContinuationFilter(original.content);
  const requests: ModelRequestRecord[] = [];
  let content = String(original.content ?? '');
  let lastContent = content;
  let reasoning = String(original.reasoning ?? '');
  let responseSegments: ResponseSegment[] = original.responseSegments?.length ? original.responseSegments
    : [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }];
  let phase = 'answer';
  let pending = '';
  let final: ChatMessage | undefined;
  let lastReportAt = 0;
  let lastCommitAt = 0;
  const snapshot = (interrupted: boolean, interruptReason?: string, force = false) => {
    const now = Date.now();
    if (!force && now - lastReportAt < 100) return;
    lastReportAt = now;
    context.checkActive();
    const current = context.records.get(context.owner, 'chats', rowId);
    if (!current || current.sessionId !== sessionId || current.content !== lastContent) throw new Error('原回答已删除或修改，续写已停止');
    // Re-serializing modelTrace every 100 ms is pure checkpoint work. Live
    // progress below already carries the new text; persist on boundaries and
    // at most once a second so crash recovery loses no more than that.
    if (force || now - lastCommitAt >= 1_000) {
      const next: Record<string, any> = { ...current, content, reasoning: reasoning || undefined, responseSegments, taskId: context.task.id,
        modelTrace: modelTrace(content, [...priorTrace, instruction, ...(final ? [final] : pending ? [{ role: 'assistant' as const, content: pending }] : [])]),
        modelRequests: [...(original.modelRequests ?? []), ...requests] };
      delete next.interrupted; delete next.interruptReason;
      if (interrupted) { next.interrupted = true; next.interruptReason = interruptReason; }
      commitTask(context, [recordMutation('chats', rowId, current, next)]);
      lastContent = content;
      lastCommitAt = now;
    }
    context.report({ phase: interruptReason ? 'error' : phase, content, reasoning, responseSegments, rowId, userRowId: userRow?.id,
      tools: current.tools, widgets: current.widgets, widget: current.widget });
  };
  snapshot(true, undefined, true);
  try {
    const options: ChatOptions = { messages: await prepareModelImages(await resolveAttachmentMessages(context, messages), target, context.signal), signal: context.signal, thinkingLevel: taskThinkingLevel(context),
      cacheKey: `study:${context.owner}:${sessionId}`, onRequest: request => { requests.push(request); } };
    options.max_tokens = chatOutputTokens(target, options, modelSettings(context.store, context.owner, context.configuration.get(context.owner), target));
    const message = await chatStream(target, options,
    delta => {
      const changed = phase !== 'answer';
      pending += delta; content += filter.push(delta); phase = 'answer'; snapshot(true, undefined, changed);
    },
    delta => {
      const previous = responseSegments;
      responseSegments = beginResponseSegment(responseSegments, content, reasoning, original.tools ?? []);
      const changed = previous !== responseSegments || phase !== 'thinking';
      reasoning += delta; phase = 'thinking'; snapshot(true, undefined, changed);
    }, undefined, modelFetch(context));
    context.checkActive();
    content += filter.flush();
    if (message.finish_reason === 'error' || message.finish_reason === 'aborted') throw new Error('模型或网关没有正常结束这一轮回答');
    if (message.finish_reason === 'length') throw new Error('模型输出达到长度上限，可从断点继续回答');
    if (message.tool_calls?.length || !textOf(message).trim()) throw new Error('模型未能完成续写，请重试');
    final = message;
    snapshot(false, undefined, true);
    return { content, reasoning, responseSegments, rowId, userRowId: userRow?.id, tools: original.tools, widgets: original.widgets, widget: original.widget };
  } catch (error) {
    content += filter.flush();
    // Cancellation revokes commit authority. Previously saved checkpoints stay
    // intact; a failure while still active flushes even the final held chunk.
    if (!context.signal.aborted) snapshot(true, error instanceof Error ? error.message : String(error), true);
    throw error;
  }
}
