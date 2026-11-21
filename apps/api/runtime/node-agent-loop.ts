/** 运行时中立的服务端工具循环:流式答案、工具批执行、断点与等待恢复。
 * 从 runtime/node.ts 原样搬出(仅补导出);循环顺序、节流间隔与断点字段
 * 决定崩溃恢复行为,不做重排。 */
import { CONTINUE_INSTRUCTION, createContinuationFilter } from '@wangke/study-core/continuation';
import { chatStream, textOf, type ChatMessage, type ChatOptions, type ToolDef } from '@wangke/study-core/model/client';
import { reconcileSkillMessages } from '@wangke/study-core/model/transcript';
import { cachePolicy, stableTools } from '@wangke/study-core/model/cache';
import type { ModelRequestRecord } from '@wangke/study-core/model/usage';
import type { ModelTarget } from '@wangke/study-core/model/types';
import { beginResponseSegment, nextResponseRound, type ResponseSegment } from '@wangke/study-core/response-order';
import { PLUGINS_TOOL } from '@wangke/contracts/plugins';
import { widgetReference, type WidgetPayload } from '@wangke/study-core/widgets';
import { parseWebSearchResult } from '@wangke/contracts/web-search';
import { validateAskUser, askAnswerText } from '@wangke/study-core/ask-user';
import type { TaskContext } from '../src/cloud/execution.js';
import { BOARD_TOOL, executeBoardTool, executePluginsTool } from './board.js';
import { createTaskWidgetExecutor, SERVER_SHOW_WIDGET_TOOL } from './widgets.js';
import { awaitTaskAnswer } from './task-interactions.js';
import { delegationTool, TaskWaitSuspended } from './delegation.js';
import { DELEGATION_TOOLS } from '../src/agent/delegation-tools.js';
import { TaskStepBudget } from '../src/agent/task-step-budget.js';
import { modelSettings } from '../src/agent/model-settings.js';
import { prepareModelImages } from '../src/agent/image-preparation.js';
import { chatOutputTokens, truncationRetryTokens } from './chat-output-budget.js';
import { resolveAttachmentMessages } from './chat-attachments.js';
import { assertSkillRequestBudget } from './skills.js';
import { clip, modelFetch, parseArgs, taskThinkingLevel, traceResult, type ServerAgentResult, type ServerToolTrace } from './node-common.js';

/**
 * Runtime-neutral tool loop for server tasks. Progress is throttled into the
 * durable task row, while the browser renders the latest server-side stream
 * and synced records remain the durable source of truth.
 */
export async function runServerAgent(
  context: TaskContext,
  target: ModelTarget,
  messages: ChatMessage[],
  tools: ToolDef[],
  executeTool: (name: string, args: Record<string, unknown>) => Promise<string>,
  onSnapshot?: (result: ServerAgentResult) => { rowId: number; userRowId: number; widgets?: WidgetPayload[] },
  initialTraces: ServerToolTrace[] = [],
  toolLabel: (name: string) => string = name => name,
  webToolsEnabled = true,
): Promise<ServerAgentResult> {
  const savedCheckpoint = context.store.db.prepare('SELECT payload FROM task_agent_checkpoints WHERE task_id=?').get(context.task.id) as { payload: string } | undefined;
  const resumed = savedCheckpoint ? JSON.parse(savedCheckpoint.payload) : undefined;
  const out: ChatMessage[] = resumed?.out ?? [...messages];
  const initialCount = resumed?.initialCount ?? messages.length;
  const webPermitted = () => {
    context.checkActive();
    if (context.configuration.taskPolicy(context.owner, context.task.id).network !== 'allow') return false;
    const project = context.store.db.prepare('SELECT p.network_policy,p.archived FROM cloud_tasks c JOIN runs r ON r.id=c.parent_run_id JOIN threads t ON t.id=r.thread_id JOIN projects p ON p.id=t.project_id AND p.owner_id=c.owner_id WHERE c.id=? AND c.owner_id=?').get(context.task.id, context.owner) as { network_policy: string; archived: number } | undefined;
    return !project || !project.archived && project.network_policy === 'allow';
  };
  const webTools = webToolsEnabled ? context.webSearch?.definitions(context.owner, webPermitted()) ?? [] : [];
  const webNames = new Set(webTools.map(tool => tool.function.name));
  const builtin = executeTool;
  executeTool = async (name, args) => webNames.has(name) && context.webSearch
    ? JSON.stringify(await context.webSearch.call(context.owner, name, args, context.signal, webPermitted)) : builtin(name, args);
  const isDelegated = Boolean(context.store.db.prepare('SELECT 1 FROM task_delegations WHERE task_id=?').get(context.task.id));
  tools = stableTools([...tools, ...webTools, SERVER_SHOW_WIDGET_TOOL, ...(['chat', 'qa'].includes(context.task.kind) ? [BOARD_TOOL, PLUGINS_TOOL, ...(!isDelegated ? DELEGATION_TOOLS : [])] : [])]);
  const executeWidget = createTaskWidgetExecutor();
  if (resumed) out.push({ role: 'user', content: '任务已恢复；show_widget 分段组装的内存缓存没有保留，revision 重新从0开始；可 read 获取空基线，如需大页面请从 revision=0、offset=0 重新组装，勿重放旧补丁。已交付聊天页面不受影响。' });
  const requests: ModelRequestRecord[] = resumed?.requests ?? [];
  const cacheKey = `study:${context.owner}:${context.task.input.sessionId}`;
  const thinkingLevel = taskThinkingLevel(context);
  const onRequest = (record: ModelRequestRecord) => { requests.push(record); };
  const traces: ServerToolTrace[] = resumed?.traces ?? [...initialTraces];
  const widgets: WidgetPayload[] = resumed?.widgets ?? [];
  let ask: ServerAgentResult['ask'] = resumed?.ask;
  let pendingAsk = false;
  let reasoning = resumed?.reasoning ?? '';
  // `answer` is the current protocol message, not the UI transcript. Visible
  // text is cumulative and may also contain server-delivered widget references.
  let answer = '';
  let deliveredContent = resumed?.deliveredContent || resumed?.narration || '';
  const content = () => deliveredContent;
  let responseSegments: ResponseSegment[] = resumed?.responseSegments?.length ? resumed.responseSegments
    : [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0, startedAt: Date.now() }];
  const beginProcess = () => {
    responseSegments = beginResponseSegment(responseSegments, deliveredContent, reasoning, traces);
  };
  let continuationFilter: ReturnType<typeof createContinuationFilter> | undefined;
  let textContinuations = 0, truncatedTools = 0, raisedRetries = 0;
  let nextOutputTokens: number | undefined;
  let lastOutputTokens = 0;
  const appendAnswer = (delta: string) => { answer += delta; deliveredContent += continuationFilter ? continuationFilter.push(delta) : delta; };
  const finishAnswer = (text: string) => {
    // Some transports emit a final message as well as deltas. Only its unseen
    // suffix may be appended; never replace a prefix the user has already seen.
    if (text.startsWith(answer)) appendAnswer(text.slice(answer.length));
  };
  let streaming = false;
  const seen = new Set<string>(resumed?.seen ?? []);
  // Large works require more than eight small operations. Existing root task
  // step/request/time budgets remain authoritative; this is an additional cap.
  const maxRounds = Math.max(1, Math.min(64, Number(context.configuration.get(context.owner).policy.maxSteps) || 6));
  const stepBudget = new TaskStepBudget(context.store, context.configuration);
  let lastReportAt = 0;
  let lastReportPhase = '';
  let lastSnapshotAt = 0;
  let rowIdentity: { rowId: number; userRowId: number } | undefined;
  const report = (phase: string, round: number, force = false) => {
    const now = Date.now();
    // Do not turn every model token into a SQLite write.  100 ms is still
    // visibly streaming and keeps the task row from becoming the bottleneck.
    // The first answer token must not be swallowed by a just-finished tool or
    // thinking report; the next token may arrive much later.
    if (!force && phase === lastReportPhase && now - lastReportAt < 100) return;
    lastReportAt = now;
    lastReportPhase = phase;
    const tools = traceResult(traces);
    // The live checkpoint rewrites two chat rows and clones their modelTrace.
    // That is far heavier than the progress row, so keep it on tool/phase
    // boundaries and at most once a second. Every visible token still reaches
    // the browser through progress; only crash recovery loses the last second.
    if (force || !rowIdentity || now - lastSnapshotAt >= 1_000) {
      const transcript = [...out.slice(initialCount), ...(streaming && answer.trim() ? [{ role: 'assistant' as const, content: answer }] : [])];
      const identities = onSnapshot?.({ content: content(), reasoning: reasoning || undefined, responseSegments, tools, transcript, requests, widgets: [...widgets], ...(ask ? { ask } : {}) });
      if (identities) rowIdentity = { rowId: identities.rowId, userRowId: identities.userRowId };
      if (identities?.widgets) widgets.splice(0, widgets.length, ...identities.widgets);
      lastSnapshotAt = now;
    }
    context.report({
      // Progress and the saved answer must describe the same text. Clipping here
      // made long answers alternate between a full checkpoint and a short prefix.
      phase, round, content: content(), reasoning, responseSegments, tools,
      modelRequests: requests,
      ...(ask ? { ask, view: { pendingAsk: pendingAsk ? { messageKey: `row:${rowIdentity?.rowId}` } : null } } : {}),
      ...(rowIdentity ?? {}),
      widgets, widget: widgets.at(-1), widgetPreview: undefined,
    });
  };
  report('thinking', 0, true);

  for (let round = resumed?.round ?? 0; round < maxRounds; round++) {
    context.checkActive();
    answer = '';
    if (!continuationFilter) deliveredContent = nextResponseRound(deliveredContent);
    beginProcess();
    streaming = true;
    report('thinking', round + 1, true);
    let message: ChatMessage;
    try {
      const requestMessages = reconcileSkillMessages(out);
      assertSkillRequestBudget(target.capabilities?.contextWindow ?? 131072, requestMessages, false);
      const options: ChatOptions = {
        messages: await prepareModelImages(await resolveAttachmentMessages(context, requestMessages), target, context.signal),
        cacheKey, onRequest,
        tools,
        temperature: 0.3,
        signal: context.signal,
        thinkingLevel,
      };
      if (continuationFilter) { options.tools = undefined; }
      const available = chatOutputTokens(target, options, modelSettings(context.store, context.owner, context.configuration.get(context.owner), target));
      options.max_tokens = Math.min(nextOutputTokens ?? available, available);
      lastOutputTokens = options.max_tokens;
      nextOutputTokens = undefined;
      message = await chatStream(target, options,
      delta => { appendAnswer(delta); report('answer', round + 1); },
      delta => { beginProcess(); reasoning += delta; report('thinking', round + 1); },
      () => {
        beginProcess();
        report('tool', round + 1);
        // Field order is unknown until the complete envelope arrives. Never
        // preview raw tool deltas: code may precede action=patch/read/append.
        // Only a validated final payload can enter the chat preview chain.
      },
      modelFetch(context));
    } catch (error) {
      // A reader failure can happen between throttled progress reports. Flush
      // the current answer/reasoning and any validated widgets before letting
      // the task fail or cancel; otherwise the durable task row can appear to
      // contain no work even though the browser already showed a prefix.
      if (continuationFilter) deliveredContent += continuationFilter.flush();
      report('error', round + 1, true);
      streaming = false;
      throw error;
    }

    // A provider can encode a broken stream as a terminal assistant message
    // instead of rejecting fetch. Do not put that message back into the next
    // request. Persist the already streamed projection first so the task still
    // leaves a resumable checkpoint, then let the task become interrupted.
    if (message.finish_reason === 'error' || message.finish_reason === 'aborted') {
      if (continuationFilter) deliveredContent += continuationFilter.flush();
      report('error', round + 1, true);
      streaming = false;
      throw new Error('模型或网关没有正常结束这一轮回答');
    }
    context.checkActive();
    streaming = false;
    if (message.finish_reason === 'content_filter') {
      delete message.tool_calls;
      delete message.providerState;
      if (!textOf(message).trim()) {
        message.content = '模型服务因内容过滤停止了这次回答，请调整提问后重试。';
        appendAnswer(message.content);
      }
    }
    if (continuationFilter && message.tool_calls?.length) {
      report('error', round + 1, true);
      throw new Error('正文续写不允许执行工具；已保存断点');
    }
    out.push(message);
    const text = textOf(message);
    finishAnswer(text);
    if (continuationFilter) deliveredContent += continuationFilter.flush();

    // `length` with tool calls means the arguments may be only a valid-looking
    // prefix. Never execute that call; discard its envelope and ask the model
    // for a smaller complete operation instead of repairing arguments.
    if (message.finish_reason === 'length' && message.tool_calls?.length) {
      // Discard incomplete arguments/provider continuation, not repair them.
      // Replaying a huge partial call also needlessly consumes next input budget.
      out.pop();
      if (text) out.push({ role: 'assistant', content: text });
      const limits = modelSettings(context.store, context.owner, context.configuration.get(context.owner), target);
      const messages = await prepareModelImages(await resolveAttachmentMessages(context, reconcileSkillMessages(out)), target, context.signal);
      const available = chatOutputTokens(target, { messages, tools, signal: context.signal, thinkingLevel }, limits);
      const raised = truncationRetryTokens(lastOutputTokens, available, limits.outputSource, raisedRetries);
      if (raised) { nextOutputTokens = raised; raisedRetries++; }
      for (const call of message.tool_calls) {
        stepBudget.chargeTaskTool(context.owner, context.task.id, `${round}:${message.tool_calls.indexOf(call)}`);
        beginProcess();
        const failure = `工具「${call.function.name}」没有执行：这一轮达到 max_tokens 请求预算，参数可能截断。${limits.outputSource === 'fallback' ? '当前预算来自未知模型的保守回退，不代表模型硬上限。' : '当前预算受用户配置、模型声明或剩余上下文估计限制。'}${raised ? '有已知额度余量，下一轮仅提高一次预算，重新提交完整操作。' : '不要按同预算原样重试；show_widget 缩小完整 append 或 patch（search+replace 合计建议1000~2000字符），可 read 定位后提交小补丁，不必重写整页；其他工具缩小操作范围。'}禁止续接或修补截断 JSON；本轮整批未执行，已确认 revision/length 不变，必要时 read 获取基线，最后 complete。`;
        traces.push({ id: `${context.task.id}:${round}:${message.tool_calls.indexOf(call)}`, name: toolLabel(call.function.name), status: 'error', reasoningOffset: reasoning.length, result: failure });
        out.push({
          role: 'user',
          content: failure,
        });
      }
      report('tool', round + 1, true);
      if (++truncatedTools >= 3) throw new Error('工具输出连续截断，已停止自动重试；已交付聊天页面保留，未完成的内存组装不保留，请缩小操作后重新生成');
      continue;
    }
    if (message.tool_calls?.length) {
      const waitingIds: string[] = [];
      for (const call of message.tool_calls) {
        context.checkActive();
        // Server round/index identity cannot be reused by a provider-supplied
        // call ID. Charge outside the tool-error catch: exhaustion ends work,
        // not a recoverable tool result that invites another side effect.
        stepBudget.chargeTaskTool(context.owner, context.task.id, `${round}:${message.tool_calls.indexOf(call)}`);
        const args = parseArgs(call.function.arguments);
        const signature = `${call.function.name}:${JSON.stringify(args)}`;
        if (!(call.function.name === 'show_widget' && args.action !== undefined) && seen.has(signature)) {
          out.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: '相同参数已执行过，请直接根据已有结果回答。' });
          continue;
        }
        seen.add(signature);
        beginProcess();
        const trace: ServerToolTrace = { id: `${context.task.id}:${round}:${message.tool_calls.indexOf(call)}`, name: toolLabel(call.function.name), status: 'running', detail: JSON.stringify(args).slice(0, 300), reasoningOffset: reasoning.length };
        traces.push(trace);
        const started = Date.now();
        report('tool', round + 1, true);
        let result: string;
        try {
          if (!tools.some(tool => tool.function.name === call.function.name)) throw new Error('tool_not_available');
          if (['models_discover', 'task_delegate'].includes(call.function.name)) {
            const delegated = delegationTool(context, call.function.name, args, call.id ?? `${round}:${message.tool_calls.indexOf(call)}`);
            result = JSON.stringify(delegated.value);
            if (delegated.waiting) waitingIds.push(...delegated.ids);
          } else if (call.function.name === 'ask_user') {
            const validated = validateAskUser(args);
            if (!validated.ok) throw new Error(validated.error);
            ask = validated.ask; pendingAsk = true; report('waiting_user', round + 1, true);
            try { const answered = await awaitTaskAnswer(context, ask); ask = { ...ask, answer: answered.answer, picked: askAnswerText(answered.answer) }; result = answered.result; }
            finally { pendingAsk = false; }
          } else result = call.function.name === 'show_widget'
            ? executeWidget(args, payload => {
              context.checkActive();
              widgets.push(payload);
              // Place it now, not in an end-of-answer fallback that would move
              // and remount an already opened preview when the model echoes ref.
              deliveredContent = nextResponseRound(deliveredContent) + `${widgetReference(payload.ref!)}\n\n`;
            })
             : call.function.name === 'board' && ['chat', 'qa'].includes(context.task.kind) ? executeBoardTool(context, args)
             : call.function.name === 'plugins' && ['chat', 'qa'].includes(context.task.kind) ? await executePluginsTool(context, args)
            : await executeTool(call.function.name, args);
          trace.status = 'done';
        } catch (error) {
          result = `工具执行失败：${error instanceof Error ? error.message : String(error)}`;
          trace.status = 'error';
        }
        trace.ms = Date.now() - started;
        trace.result = clip(result, 4_000);
        if (call.function.name === 'websearch') {
          const search = parseWebSearchResult(result);
          if (search) { trace.webSearch = search; trace.result = `${search.sources.length} · ${search.provider}`; trace.detail = search.query; }
        }
        // Full Skill instructions must never become a plausible partial policy.
        // The next request checks the complete body against the context budget.
        out.push({ role: 'tool', tool_call_id: call.id, name: call.function.name,
          content: result.startsWith('<skill_content context=') ? result : clip(result, 24_000) });
        report('tool', round + 1, true);
      }
      if (waitingIds.length) {
        // All tool results and product writes are settled before releasing the slot.
        // The checkpoint stores protocol-neutral messages; no command is replayed on wake.
        context.store.db.prepare('INSERT INTO task_agent_checkpoints(task_id,payload,wait_ids) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET payload=excluded.payload,wait_ids=excluded.wait_ids').run(context.task.id,
          JSON.stringify({ out, initialCount, requests, traces, widgets, reasoning, deliveredContent, responseSegments, ask, seen: [...seen], round: round + 1 }), JSON.stringify([...new Set(waitingIds)]));
        throw new TaskWaitSuspended();
      }
      continue;
    }
    if (message.finish_reason === 'length') {
      if (text.trim() && textContinuations++ < 2 && round + 1 < maxRounds) {
        continuationFilter = createContinuationFilter(deliveredContent);
        out.push({ role: 'user', content: CONTINUE_INSTRUCTION });
        report('answer', round + 1, true);
        continue;
      }
      report('error', round + 1, true);
      throw new Error('正文达到本次输出预算；有限自动续写已停止，可从已保存断点继续回答');
    }
    if (answer.trim()) {
      report('answer', round + 1, true);
      return { content: content(), reasoning: reasoning || undefined, responseSegments, tools: traceResult(traces), transcript: out.slice(initialCount), requests, widgets, ...(ask ? { ask } : {}) };
    }
    // An empty assistant turn is not a successful answer.  Give the model a
    // bounded, tool-free chance to explain what it found.
    break;
  }

  context.checkActive();
  out.push({ role: 'user', content: '请停止调用工具，只用中文总结已经查到的资料和结论；如果证据不足，请明确说明。' });
  answer = '';
  deliveredContent = nextResponseRound(deliveredContent);
  beginProcess();
  streaming = true;
  report('thinking', maxRounds + 1, true);
  let final: ChatMessage;
  const finalMessages = reconcileSkillMessages(out);
  assertSkillRequestBudget(target.capabilities?.contextWindow ?? 131072, finalMessages, false);
  try {
    const options: ChatOptions = { messages: await prepareModelImages(await resolveAttachmentMessages(context, finalMessages), target, context.signal), cacheKey, onRequest, ...(cachePolicy(target) !== 'none' ? { tools, tool_choice: 'none' as const } : {}), temperature: 0.3, signal: context.signal, thinkingLevel };
    options.max_tokens = Math.min(4096, chatOutputTokens(target, options, modelSettings(context.store, context.owner, context.configuration.get(context.owner), target)));
    final = await chatStream(target, options,
      delta => { appendAnswer(delta); report('answer', maxRounds + 1); },
      delta => { beginProcess(); reasoning += delta; report('thinking', maxRounds + 1); },
      undefined,
      modelFetch(context));
    context.checkActive();
    if (final.finish_reason === 'error' || final.finish_reason === 'aborted') throw new Error('模型或网关没有正常结束这一轮回答');
    if (final.finish_reason === 'length') throw new Error('模型输出达到长度上限，可从断点继续回答');
  } catch (error) {
    report('error', maxRounds + 1, true);
    streaming = false;
    throw error;
  }
  streaming = false;
  if (final.finish_reason === 'content_filter') {
    delete final.tool_calls;
    delete final.providerState;
    if (!textOf(final).trim()) final.content = '模型服务因内容过滤停止了这次回答，请调整提问后重试。';
  }
  finishAnswer(textOf(final));
  out.push(final);
  if (!answer.trim()) {
    report('error', maxRounds + 1, true);
    throw new Error('模型没有返回正文，可重试或从断点继续回答');
  }
  report('answer', maxRounds + 1, true);
  return { content: content(), reasoning: reasoning || undefined, responseSegments, tools: traceResult(traces), transcript: out.slice(initialCount), requests, widgets, ...(ask ? { ask } : {}) };
}
