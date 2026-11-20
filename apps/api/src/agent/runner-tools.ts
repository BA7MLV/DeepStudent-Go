/** 工具分发:批量执行、审批暂停、MCP/托管工具/学习插件/shell/wait/消息类工具的落地。
 * 从 runner.ts 搬出;判断顺序、拒绝文案、审计事件名与审批行写入都保持原样。
 * 模型给出的 `function.arguments` 是外部数据:先解析成对象形状,再按字段类型取用,
 * 非预期类型一律当缺省,与原先「undefined 即未提供」的判断等价。 */
import crypto from 'node:crypto';
import { parseWebSearchResult } from '@wangke/contracts/web-search';
import { mcpToolDefinition } from '@wangke/contracts/mcp';
import { ToolRegistry } from './tools/registry.js';
import { BudgetBlocked } from './budget.js';
import { publishBotEvent } from './events.js';
import { ProjectError } from '../projects/files.js';
import { shellDecision } from './permissions.js';
import { shellApprovalText } from './approval-copy.js';
import { WorkspaceHandoff } from './workspace-handoff.js';
import { ContextGovernor } from './context-governor.js';
import { BotArtifacts } from './artifacts.js';
import { SandboxFailure, sandboxFailureCodes, shellToolTimeoutMs } from './sandbox.js';
import { mcpError } from '../mcp/manager.js';
import { webError } from '../web-search/service.js';
import type { McpCatalog } from '@wangke/contracts/mcp';
import { executeToolBatch, recordToolResult } from '@wangke/study-core/tool-batch';
import { now, booleanField, numberField, stringField, toolArguments, type BotFacade, type Run } from './runner-state.js';
import { policyOf } from './runner-context.js';
import { runSandboxTool } from './runner-sandbox.js';
import { tools } from './runner-tool-defs.js';
import type { ModelCall as Call, ModelMessage as Message } from './model.js';
import type { TaskStepBudget } from './task-step-budget.js';
import type { AgentPolicy } from '@wangke/contracts/cloud';

/** 一次 execute() 内工具分发需要的全部依赖,由 runner 门面按 run 构造。 */
export interface ToolTurn {
  deps: BotFacade;
  run: Run;
  signal: AbortSignal;
  maxSteps: number;
  stepBudget: TaskStepBudget;
  /** 本轮 MCP 目录;项目线程没有目录。 */
  mcpCatalog?: McpCatalog;
  checkActive(): void;
  appendActive(kind: string, text: string, nonce?: string): { id: string } | null;
  appendVisibleIfCurrent(kind: string, text: string, nonce?: string): { id: string } | null;
  save(context: Message[]): void;
  policyOfThread(): AgentPolicy;
}

/** 重启后完成「已等待审批」的持久化工具调用,不重放命令。暂停时把 run 置为
 * waiting_user 并返回;其余情况把结果写回 run_steps 与上下文。 */
export async function resolveApprovedStep(turn: ToolTurn, stepId: string, stepTool: string, args: Record<string, unknown> | null, step: import('./runner-state.js').RunStepRow, context: Message[], envelopeIndex: number, envelope: Message, call: Call): Promise<void> {
  const { deps, run } = turn;
  const owner = deps.thread(run.thread_id).owner_id;
  const thread = deps.thread(run.thread_id);
  const toolArgs = args ?? {};
  // Pre-fix checkpoints could omit the approval admission charge.
  // Normalize once from durable attempted states, never increment a
  // previously charged approval again on each restart.
  deps.store.db.prepare("UPDATE runs SET step_count=MAX(step_count,(SELECT COUNT(*) FROM run_steps WHERE run_id=? AND status IN ('completed','running','waiting_approval','failed'))) WHERE id=?").run(run.id, run.id);
  run.step_count = (deps.store.db.prepare('SELECT step_count FROM runs WHERE id=?').get(run.id) as { step_count: number }).step_count;
  if (run.step_count > turn.maxSteps) throw new BudgetBlocked('run_step_budget');
  turn.stepBudget.assertRunWithinLimit(owner, run.id);
  const approval = deps.store.db.prepare('SELECT status FROM approvals WHERE step_id=? AND run_id=?').get(step.id, run.id) as { status: string } | undefined;
  if (!approval || approval.status === 'pending') { deps.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id); return; }
  const policy = turn.policyOfThread();
  const plugin = deps.options.study?.plugins.get(stepTool);
  const managed = deps.managedTool(stepTool);
  let allowed = false;
  try {
    if (stepTool.startsWith('mcp_') && deps.mcp) {
      // Keep main's persisted {arguments,serverId,revision} envelope
      // compatible with pending approvals created before this merge.
      const currentScope = () => {
        const current = deps.thread(run.thread_id);
        const serverId = stringField(toolArgs, 'serverId');
        const server = serverId === undefined ? undefined : deps.mcp!.repository.get(owner, serverId);
        const row = deps.store.db.prepare('SELECT mcp_server_ids FROM threads WHERE id=? AND owner_id=?').get(run.thread_id, owner) as { mcp_server_ids: string | null } | undefined;
        const scope: string[] | undefined = row?.mcp_server_ids === null ? undefined : row ? JSON.parse(row.mcp_server_ids!) : [];
        if (!current || current.archived || current.project_id || policyOf(deps, current).write === 'deny' || !server || server.revision !== stringField(toolArgs, 'revision') || (scope && !scope.includes(serverId!))) throw new Error('mcp_tool_unavailable');
        return scope;
      };
      let scope: string[] | undefined;
      allowed = approval.status === 'approved' && typeof toolArgs.serverId === 'string' && typeof toolArgs.revision === 'string' && Boolean(toolArgs.arguments && typeof toolArgs.arguments === 'object');
      try { if (allowed) scope = currentScope(); } catch { allowed = false; }
      if (allowed) {
        const catalog = await deps.mcp.catalog(owner, scope);
        turn.checkActive();
        const meta = catalog?.tools.find(t => t.name === stepTool);
        if (!meta) step.result = 'MCP operation unavailable after authorization changed.';
        else {
          deps.store.db.prepare("UPDATE run_steps SET status='running' WHERE id=? AND status='waiting_approval'").run(step.id);
          publishBotEvent(deps.store, { owner, run: run.id, step: step.id, type: 'tool.started' }, deps.options.onEvent);
          const registry = new ToolRegistry(); registry.register(mcpToolDefinition(meta), 'uncertain');
          const result = await registry.execute(stepTool, toolArgs.arguments as Record<string, unknown>, { owner, thread: run.thread_id, run: run.id, step: step.id, signal: turn.signal, checkActive: () => { turn.checkActive(); currentScope(); } }, async scoped => {
            try {
              const response = await deps.mcp!.call(owner, stepTool, toolArgs.arguments as Record<string, unknown>, currentScope(), scoped.signal);
              scoped.checkActive();
              return response.text;
            } catch (error) { scoped.signal.throwIfAborted(); return `Error: ${mcpError(error)}`; }
          });
          if (!result.ok && result.error.code === 'tool_timeout') throw new BudgetBlocked('tool_timeout');
          step.result = result.ok ? String(result.value) : JSON.stringify(result);
        }
      } else step.result = 'Command denied by user or current policy.';
    } else if (managed) {
      // Managed tools return a policy decision, not a capability name.
      // Revalidate the exact persisted arguments after approval; a
      // revision conflict becomes a tool result, not a failed run.
      const decision = managed.permission(stepTool, toolArgs, thread, policy);
      allowed = approval.status === 'approved' && decision !== 'deny';
      if (allowed) {
        deps.store.db.prepare("UPDATE run_steps SET status='running' WHERE id=? AND status='waiting_approval'").run(step.id);
        publishBotEvent(deps.store, { owner, run: run.id, step: step.id, type: 'tool.started' }, deps.options.onEvent);
        step.result = managed.execute(stepTool, toolArgs, thread);
        deps.observeWorkspaceResult(run.id, stepTool, step.result);
      }
    } else {
      const projectId = plugin ? undefined : deps.executionProjectId(thread, toolArgs.projectId);
      const operationPolicy = plugin ? policy : policyOf(deps, thread, projectId);
      const capability = plugin?.capability(toolArgs) ?? 'shell';
      const capabilities: Array<'read' | 'write' | 'remove' | 'shell'> = plugin?.permissions?.(toolArgs) ?? (toolArgs.systemWrite === true ? ['shell', 'read', 'write'] : [capability]);
      allowed = approval.status === 'approved' && capabilities.every(k => operationPolicy[k] !== 'deny') && (Boolean(plugin) || shellDecision(operationPolicy, stringField(toolArgs, 'command') ?? '', toolArgs.requiresApproval === true, toolArgs.systemWrite === true).permission !== 'deny' && (!toolArgs.network || operationPolicy.network === 'allow'));
      if (allowed) {
        deps.store.db.prepare("UPDATE run_steps SET status='running' WHERE id=? AND status='waiting_approval'").run(step.id);
        publishBotEvent(deps.store, { owner, run: run.id, step: step.id, type: 'tool.started' }, deps.options.onEvent);
        if (plugin) step.result = await deps.executeStudy(plugin.name, toolArgs, owner, run, step.id, turn.signal);
        else {
          const registry = new ToolRegistry(); registry.register(tools.find(t => t.function.name === 'shell')!, 'uncertain', shellToolTimeoutMs);
          const result = await registry.execute('shell', { command: toolArgs.command, systemWrite: toolArgs.systemWrite === true, timeoutSeconds: numberField(toolArgs, 'timeoutSeconds') }, { owner, thread: run.thread_id, run: run.id, step: step.id, signal: turn.signal, checkActive: turn.checkActive }, async scoped => JSON.stringify(await runSandboxTool(deps, { owner, threadId: run.thread_id, projectId, executionId: step.id, command: stringField(toolArgs, 'command')!, network: booleanField(toolArgs, 'network'), systemWrite: toolArgs.systemWrite === true, timeoutSeconds: numberField(toolArgs, 'timeoutSeconds') }, scoped.signal)));
          if (!result.ok && result.error.code === 'tool_timeout') throw new BudgetBlocked('tool_timeout');
          if (!result.ok && sandboxFailureCodes.includes(result.error.code as typeof sandboxFailureCodes[number])) throw new Error(result.error.code);
          step.result = result.ok ? String(result.value) : JSON.stringify(result);
        }
      }
    }
    if (!allowed) step.result = 'Command denied by user or current policy.';
  } catch (error) {
    if (!(error instanceof ProjectError)) throw error;
    step.result = error.code;
  }
  turn.checkActive();
  deps.store.db.prepare("UPDATE run_steps SET status='completed',result=?,completed_at=? WHERE id=?").run(step.result, now(), step.id);
  publishBotEvent(deps.store, { owner, run: run.id, step: step.id, type: 'tool.finished' }, deps.options.onEvent);
  deps.options.configuration?.audit(owner, 'shell.resolved', { step: step.id, allowed });
  recordToolResult(context, envelopeIndex + 1, envelope!.tool_calls!, { role: 'tool', tool_call_id: call.id, content: step.result ?? '' });
}

/** 一个模型响应里的工具调用批次。返回 true 表示应当结束本次 run 的循环
 * (暂停/终止/等待),由调用方负责 return。 */
export async function executeToolBatchTurn(
  turn: ToolTurn,
  batch: Call[],
  context: Message[],
  registry: ToolRegistry,
  hasUnconsumedInput: () => boolean,
): Promise<boolean> {
  const { deps, run } = turn;
  const owner = deps.thread(run.thread_id).owner_id;
  const thread = deps.thread(run.thread_id);
  const resultStart = context.length;
  let batchStopped = false;
  await executeToolBatch(batch, {
    signal: turn.signal,
    shouldStop: () => batchStopped || hasUnconsumedInput(),
    canParallel: call => {
      try {
        const name = call.function.name, args = toolArguments(call.function.arguments);
        if (!args || !registry.validate(name, args).ok) return false;
        const policy = policyOf(deps, deps.thread(run.thread_id));
        if (['websearch', 'webfetch'].includes(name)) return policy.network === 'allow';
        const managed = deps.managedTool(name);
        if (managed) return managed.parallelSafe(name, args) && managed.permission(name, args, thread, policy) === 'allow';
        const plugin = deps.options.study?.plugins.get(name);
        return plugin?.parallelSafe?.(args) === true &&
          (plugin.permissions?.(args) ?? [plugin.capability(args)]).every(capability => capability === 'read' && policy[capability] === 'allow');
      } catch { return false; }
    },
    execute: async call => {
      turn.checkActive();
      if (run.step_count >= turn.maxSteps) throw new BudgetBlocked('run_step_budget');
      deps.store.transaction(() => {
        turn.checkActive();
        turn.stepBudget.startRunStep(owner, run.id, call.id);
        run.step_count = (deps.store.db.prepare('SELECT step_count FROM runs WHERE id=?').get(run.id) as { step_count: number }).step_count;
      });
      publishBotEvent(deps.store, { owner, thread: run.thread_id, run: run.id, step: call.id, type: 'tool.started' }, deps.options.onEvent);
      // 模型参数先收窄成对象形状;后续每个字段都按类型读取。
      const args = toolArguments(call.function.arguments) ?? {};
      let result = 'Unknown tool or invalid arguments.';
      let state: 'completed' | 'waiting_user' | 'waiting_event' | 'queued' | undefined;
      let wake: string | null = null;
      let suspended = false;
      const hiddenManaged = deps.managedTool(call.function.name);
      const hiddenValidation = hiddenManaged ? registry.validate(call.function.name, args) : undefined;
      let outcome: Awaited<ReturnType<ToolRegistry['execute']>>;
      if (hiddenManaged && hiddenValidation && !hiddenValidation.ok) {
        // Keep project/settings capabilities out of the model's advertised
        // tool list in scoped sessions, and let their domain validators
        // produce precise denial/conflict codes instead of generic registry
        // validation errors.
        try {
          hiddenManaged.permission(call.function.name, args, thread, policyOf(deps, thread));
          result = 'Operation unavailable in this session.';
        } catch (error) {
          if (!(error instanceof ProjectError)) throw error;
          result = error.code;
        }
        outcome = { ok: true, value: result };
      } else outcome = await registry.execute(call.function.name, args, { owner, thread: run.thread_id, run: run.id, step: call.id, signal: turn.signal, checkActive: turn.checkActive }, async scoped => {
        const signal = scoped.signal;
        const toolArgs = args;
        const managed = deps.managedTool(call.function.name);
        const studyPlugin = managed ? undefined : deps.options.study?.plugins.get(call.function.name);
        if (['websearch', 'webfetch'].includes(call.function.name) && deps.options.webSearch) {
          try {
            const response = await deps.options.webSearch.call(owner, call.function.name, toolArgs, signal, () => policyOf(deps, deps.thread(run.thread_id)).network === 'allow');
            result = JSON.stringify(response);
          } catch (error) { signal.throwIfAborted(); result = `Error: ${webError(error).code}`; }
        } else if (managed) {
          try {
            const permission = managed.permission(call.function.name, toolArgs, thread, policyOf(deps, thread));
            if (permission === 'deny') result = 'Operation denied by current policy.';
            else if (permission === 'ask') {
              deps.store.transaction(() => {
                scoped.checkActive();
                deps.store.db.prepare("UPDATE run_steps SET status='waiting_approval' WHERE id=?").run(call.id);
                const description = call.function.name === 'settings' ? deps.settingsTools!.approval(toolArgs, thread) : `请求项目操作：${call.function.name}\n${JSON.stringify(toolArgs).slice(0, 10000)}`;
                const message = turn.appendActive('approval', description)!;
                deps.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, call.id, 'pending', now());
                deps.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id);
                suspended = true;
              });
              return result;
            } else {
              result = managed.execute(call.function.name, toolArgs, thread);
              deps.observeWorkspaceResult(run.id, call.function.name, result);
            }
          } catch (error) { if (!(error instanceof ProjectError)) throw error; result = `Error: ${error.code}`; }
        } else if (studyPlugin) {
          const capability = studyPlugin.capability(toolArgs);
          const policy = policyOf(deps, thread);
          const capabilities = studyPlugin.permissions?.(toolArgs) ?? [capability];
          if (capabilities.some(k => policy[k] === 'deny')) result = 'Denied by current learning policy.';
          else if (capabilities.includes('remove') || (!studyPlugin.systemResource && capabilities.some(k => policy[k] === 'ask')) || studyPlugin.requiresApproval?.(toolArgs)) {
            deps.store.transaction(() => {
              scoped.checkActive();
              deps.store.db.prepare("UPDATE run_steps SET status='waiting_approval' WHERE id=?").run(call.id);
              const message = turn.appendActive('approval', studyPlugin.approval?.(toolArgs, owner) ?? `学习权限 ${capability}：${call.function.name}\n${JSON.stringify(toolArgs)}`)!;
              deps.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, call.id, 'pending', now());
              deps.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id);
              suspended = true;
              publishBotEvent(deps.store, { owner, thread: run.thread_id, run: run.id, step: call.id, type: 'approval.waiting' }, deps.options.onEvent);
            });
            return result;
          } else result = await deps.executeStudy(studyPlugin.name, toolArgs, owner, run, call.id, signal);
        } else if (call.function.name.startsWith('mcp_') && deps.mcp) {
          const meta = turn.mcpCatalog?.tools.find(t => t.name === call.function.name);
          const server = meta && deps.mcp.repository.get(owner, meta.serverId);
          if (!meta || !server || thread.project_id) result = 'Error: mcp_tool_unavailable';
          else if (policyOf(deps, thread).write === 'deny') result = 'Operation denied by current policy.';
          else {
            deps.store.transaction(() => {
              scoped.checkActive();
              deps.store.db.prepare("UPDATE run_steps SET status='waiting_approval',arguments=? WHERE id=?").run(JSON.stringify({ arguments: toolArgs, serverId: meta.serverId, revision: server.revision }), call.id);
              const message = turn.appendActive('approval', `请求调用外部 MCP 工具：${meta.serverName} / ${meta.originalName}\n${JSON.stringify(toolArgs).slice(0, 10000)}`)!;
              deps.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, call.id, 'pending', now());
              deps.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id);
              suspended = true;
            });
            return result;
          }
        } else if (call.function.name === 'shell' && typeof toolArgs?.command === 'string' && toolArgs.command.trim() && toolArgs.command.length <= 16000) {
          const command = toolArgs.command;
          let projectId: string | undefined, projectError = false;
          try { projectId = deps.executionProjectId(thread, toolArgs.projectId); } catch (error) { if (error instanceof ProjectError) { projectError = true; result = `Error: ${error.code}`; } else throw error; }
          const policy = projectError ? { ...policyOf(deps, thread), shell: 'deny' as const } : projectId ? policyOf(deps, thread, projectId) : policyOf(deps, thread);
          const network = policy.network === 'allow';
          const decision = projectError ? { permission: 'deny' as const } : shellDecision(policy, command, toolArgs.requiresApproval === true, toolArgs.systemWrite === true);
          const permission = decision.permission;
          if (permission !== 'deny') deps.store.db.prepare('UPDATE run_steps SET arguments=? WHERE id=?').run(JSON.stringify({ command, network, projectId, systemWrite: toolArgs.systemWrite === true, requiresApproval: toolArgs.requiresApproval === true, timeoutSeconds: toolArgs.timeoutSeconds }), call.id);
          if (permission === 'ask') {
            deps.store.transaction(() => {
              scoped.checkActive();
              deps.store.db.prepare("UPDATE run_steps SET status='waiting_approval' WHERE id=?").run(call.id);
              const message = turn.appendActive('approval', shellApprovalText({ description: stringField(toolArgs, 'description'), reason: decision.reason, command, systemWrite: toolArgs.systemWrite === true }))!;
              deps.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,step_id,status,created_at) VALUES(?,?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, call.id, 'pending', now());
              deps.store.db.prepare("UPDATE runs SET status='waiting_user' WHERE id=?").run(run.id);
              suspended = true;
            });
            deps.options.configuration?.audit(owner, 'shell.requested', { step: call.id, command, network, projectId, systemWrite: toolArgs.systemWrite === true, timeoutSeconds: numberField(toolArgs, 'timeoutSeconds') });
            return result;
          }
          if (permission === 'deny') { if (!projectError) result = 'Command denied by policy.'; }
          else {
            try { result = JSON.stringify(await runSandboxTool(deps, { owner, threadId: run.thread_id, projectId, executionId: call.id, command, network, ...(toolArgs.systemWrite === true ? { systemWrite: true } : {}), timeoutSeconds: numberField(toolArgs, 'timeoutSeconds') }, signal)); }
            catch (error) { if (error instanceof ProjectError) result = `Error: ${error.code}`; else if (signal.aborted) throw new Error('cancelled'); else if (error instanceof SandboxFailure) throw error; else throw new Error('sandbox_unavailable'); }
          }
        } else if (call.function.name === 'wait' && typeof numberField(toolArgs, 'seconds') === 'number' && Number.isInteger(numberField(toolArgs, 'seconds')) && numberField(toolArgs, 'seconds')! >= 1 && numberField(toolArgs, 'seconds')! <= 86400 && typeof toolArgs.reason === 'string') {
          const seconds = numberField(toolArgs, 'seconds')!, reason = toolArgs.reason;
          wake = new Date(Date.now() + seconds * 1000).toISOString();
          result = `Scheduled wake: ${wake}`; state = 'queued';
          turn.appendActive('progress', `${reason.slice(0, 2000)}（下次运行：${wake}）`);
        } else if (call.function.name === 'send_message' && typeof toolArgs?.kind === 'string' && ['text', 'progress', 'question', 'approval', 'attachment'].includes(toolArgs.kind) && typeof toolArgs.text === 'string' && toolArgs.text.length > 0 && toolArgs.text.length <= 12000) {
          const kind = toolArgs.kind, text = toolArgs.text, complete = toolArgs.complete;
          let fileAttachment = false;
          if (kind === 'attachment') {
            try {
              const value: unknown = JSON.parse(text);
              const parsed = value && typeof value === 'object' ? value as { fileId?: unknown; attachments?: unknown } : null;
              fileAttachment = Boolean(parsed?.fileId || parsed?.attachments !== undefined);
            } catch { /* historical plain-text attachments remain supported */ }
          }
          if (fileAttachment) result = 'File attachments must use study_send_file with the owned fileId; send_message cannot bypass read policy or approval.';
          else {
            const premature = !['progress', 'question', 'approval'].includes(kind) && complete !== false && deps.pendingForegroundTasks(run.id);
            const message = premature ? null
              : ['question', 'approval'].includes(kind)
                ? turn.appendActive(kind, text, `bot:${call.id}:message`)
                : turn.appendVisibleIfCurrent(kind, text, `bot:${call.id}:message`);
            result = premature
              ? 'A required foreground task is still running. The message was not delivered; wait for its terminal result before claiming completion.'
              : !message ? 'A newer user input superseded this delivery; the message was not sent.'
              : kind === 'progress' ? 'Progress recorded internally; not shown to the user.' : 'Message delivered.';
            if (premature || !message) { /* Do not create a terminal delivery for a superseded response. */ }
            else if (kind === 'approval') {
              deps.store.db.prepare('INSERT INTO approvals(id,thread_id,message_id,run_id,status,created_at) VALUES(?,?,?,?,?,?)').run(crypto.randomUUID(), run.thread_id, message.id, run.id, 'pending', now());
              state = 'waiting_user';
            } else if (kind === 'question') {
              deps.store.db.prepare('INSERT OR IGNORE INTO run_questions(id,run_id,message_id,status,created_at) VALUES(?,?,?,?,?)').run(call.id, run.id, message.id, 'pending', now());
              state = 'waiting_user';
            } else if (kind !== 'progress' && complete !== false) {
              if (deps.pendingForegroundTasks(run.id)) result = 'A required foreground task is still running. Wait for its terminal result before claiming completion.';
              else state = 'completed';
            }
          }
        } else if (call.function.name === 'finish_turn') {
          const sent = deps.store.db.prepare("SELECT 1 FROM messages m WHERE m.thread_id=? AND m.role='assistant' AND m.kind IN ('text','attachment','question') AND (m.client_nonce LIKE ? OR EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id=? AND m.client_nonce IN ('bot:' || s.id || ':message','bot:' || s.id || ':attachment'))) LIMIT 1").get(run.thread_id, `bot:${run.id}:reply:%`, run.id);
          if (deps.pendingForegroundTasks(run.id)) result = 'A required foreground task is still running; do not finish the turn yet. Use study_task.wait and verify its terminal result.';
          else if (sent) { result = 'Turn finished; previously sent messages are the reply.'; state = 'completed'; }
          else result = 'Send a reply or file to the user before finishing the turn.';
        }
        scoped.checkActive();
        return result;
      });
      if (suspended) {
        batchStopped = true;
        publishBotEvent(deps.store, { owner, thread: run.thread_id, run: run.id, step: call.id, type: 'approval.waiting', status: 'waiting_user' }, deps.options.onEvent);
        turn.save(context);
        return;
      }
      turn.checkActive();
      if (!outcome.ok && outcome.error.code === 'tool_timeout') throw new BudgetBlocked('tool_timeout');
      if (!outcome.ok && sandboxFailureCodes.includes(outcome.error.code as typeof sandboxFailureCodes[number])) throw new Error(outcome.error.code);
      result = outcome.ok ? String(outcome.value) : JSON.stringify(outcome);
      if (['study_task', 'task_delegate'].includes(call.function.name)) {
        try { if (JSON.parse(result)?.waiting === true) state = 'waiting_event'; } catch { /* preserve ordinary tool result */ }
      }
      // An async operation may have accepted input before it returned a
      // scheduled wait. Record its real result, but do not park the run
      // before the accepted follow-up has had a model turn.
      if (hasUnconsumedInput()) { state = undefined; wake = null; }
      let visibleResult = result;
      if (result.length > 12000) {
        try { visibleResult = JSON.stringify(new BotArtifacts(deps.store).put(owner, run.id, call.id, result)); }
        catch (error) {
          if (!(error instanceof Error) || !['artifact_quota_exceeded', 'artifact_too_large'].includes(error.message)) throw error;
          // Persisting an optional context artifact must not convert a
          // completed side effect into a failed/replayable command.
          visibleResult = JSON.stringify({ truncated: true, outputStorageError: error.message, preview: result.slice(0, 1500), hint: 'Only a partial preview is available. Inspect workspace files before retrying; the command may have completed.' });
        }
      }
      recordToolResult(context, resultStart, batch, { role: 'tool', tool_call_id: call.id, content: visibleResult });
      deps.store.transaction(() => {
        turn.checkActive();
        deps.store.db.prepare("UPDATE run_steps SET result=?,status='completed',completed_at=? WHERE id=?").run(result, now(), call.id);
        if (call.function.name === 'websearch' && parseWebSearchResult(result)) deps.append(run.thread_id, 'web_sources', result, `bot:${call.id}:sources`);
        turn.save(context);
        if (state === 'waiting_event') new WorkspaceHandoff(deps.store, deps.projects).capture(run.id, thread, call.id);
        if (state) deps.store.db.prepare("UPDATE runs SET status=?,wake_at=?,completed_at=? WHERE id=? AND status='running'").run(state, wake, state === 'completed' ? now() : null, run.id);
        if (state === 'completed') new ContextGovernor(deps.store).completed(run.id, context);
      });
      if (state) {
        batchStopped = true;
        publishBotEvent(deps.store, { owner, thread: run.thread_id, run: run.id, step: call.id, type: state === 'waiting_user' ? 'approval.waiting' : 'run.finished', status: state }, deps.options.onEvent);
        for (const skipped of batch.slice(batch.indexOf(call) + 1)) {
          context.push({ role: 'tool', tool_call_id: skipped.id, content: 'Not executed: an earlier call ended or suspended this task.' });
          deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE id=?").run('Not executed: task suspended.', now(), skipped.id);
        }
        turn.save(context);
        return;
      }
      publishBotEvent(deps.store, { owner, thread: run.thread_id, run: run.id, step: call.id, type: 'tool.finished' }, deps.options.onEvent);
    },
  });
  return batchStopped;
}
