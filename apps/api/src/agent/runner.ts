import crypto from 'node:crypto';
import { WorkspaceHandoff } from './workspace-handoff.js';
import type { DatabaseStore } from '../storage/database.js';
import { cancelSandbox, executeSandbox, type SandboxExecutor, type SandboxCleanup } from './sandbox.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { type ModelMessage as Message, type ModelCall as Call } from './model.js';
import { createModelGateway } from './model-gateway-factory.js';
import { freezeTaskModel } from './task-model.js';
import { McpManager } from '../mcp/manager.js';
import { UsageLedger } from './budget.js';
import { TaskStepBudget } from './task-step-budget.js';
import { ContextGovernor } from './context-governor.js';
import { BotArtifacts } from './artifacts.js';
import { settleWithin } from '../lifecycle.js';
import { publishBotEvent } from './events.js';
import { ProjectRepository, type ProjectThread } from '../projects/repository.js';
import { ProjectTools } from '../projects/tools.js';
import { importBotAttachments } from '../projects/attachments.js';
import { BotSettingsTools } from './settings.js';
import { WECHAT_FORMAT_REPAIR, hasWechatLatex, wechatToolHasLatex } from './wechat-replies.js';
import { TOOL_BATCH_GUIDANCE } from '@wangke/study-core/tool-batch';
import { sql } from '../storage/sql.js';
import { systemResourcePolicy } from './runner-tool-defs.js';
import { authorizeThread, executionProjectIdOf, initialContextOf, policyOf, workspaceContextOf } from './runner-context.js';
import { appendMessage, childWaits, consumeRunInputs, finishRun, hasPendingForegroundTasks, saveRun } from './runner-persist.js';
import { runSandboxTool } from './runner-sandbox.js';
import { executeToolBatchTurn, type ToolTurn } from './runner-tools.js';
import { completePersistedEnvelope, injectApprovalDecisions } from './runner-recovery.js';
import { prepareAndRequest } from './runner-round.js';
import { settleRunFailure } from './runner-failure.js';
import { runStudyTool } from './runner-study.js';
import { now, queuedRunRows, type Run, type RunnerOptions } from './runner-state.js';
import { config as startupConfig, getConfig } from '../config.js';

/** 工具 schema、提示词片段、上下文组装、工具分发、持久化与沙箱执行已拆到同目录
 * runner-*.ts;本类保留调度编排(认领/退避/恢复/排空)并作为对外的唯一门面,
 * 公开方法名与签名不变。 */

export class BotRunner {
  freezeModel(id: string, owner: string, explicit?: unknown, sessionDefault?: unknown) {
    const gateway = createModelGateway(this.store, this.options.configuration, this.fetcher);
    const snapshot = freezeTaskModel(this.store, owner, gateway.resolver.config(owner), 'bot', explicit, sessionDefault);
    this.store.db.prepare('UPDATE runs SET model_snapshot=? WHERE id=? AND model_snapshot IS NULL').run(JSON.stringify(snapshot), id);
    return snapshot;
  }
  readonly active = new Map<string, { threadId: string; scope: string; controller: AbortController }>();
  readonly tasks = new Set<Promise<void>>();
  private timer?: ReturnType<typeof setInterval>;
  stopped = false;
  quiescing = false;
  drainTask?: Promise<void>;
  draining = false;
  scheduled = false;
  recoverNeeded = true;
  retryAt = 0;
  failures = 0;
  readonly fetcher: typeof fetch;
  readonly sandbox: SandboxExecutor;
  readonly sandboxCleanup: SandboxCleanup;
  readonly configuration?: CloudConfiguration;
  readonly mcp?: McpManager;
  readonly projects?: ProjectRepository;
  readonly projectTools?: ProjectTools;
  readonly settingsTools?: BotSettingsTools;
  constructor(readonly store: DatabaseStore, readonly options: RunnerOptions = {}) {
    this.mcp = options.mcp;
    this.configuration = options.configuration;
    this.fetcher = options.fetch ?? fetch;
    this.sandbox = options.sandbox ?? executeSandbox;
    this.sandboxCleanup = options.sandboxCleanup ?? (options.sandbox ? async () => {} : cancelSandbox);
    this.projects = options.projects;
    this.projectTools = options.projects ? new ProjectTools(options.projects) : undefined;
    this.settingsTools = options.projects && options.configuration ? new BotSettingsTools(options.configuration, options.projects) : undefined;
  }

  start() {
    if (this.timer || this.stopped || this.quiescing) return;
    // One runtime owns this database. Recover all interrupted runs immediately.
    // A command interrupted by process death has uncertain side effects: do not replay it.
    try { this.recover(); } catch { this.schedulerFailure(); }
    this.timer = setInterval(() => this.enqueue(), 1000);
    this.timer.unref();
    this.enqueue();
  }

  enqueue(_runId?: string) {
    if (this.stopped || this.quiescing || this.scheduled || this.drainTask || Date.now() < this.retryAt) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      const task = this.drain().catch(() => this.schedulerFailure()).finally(() => {
        if (this.drainTask === task) this.drainTask = undefined;
      });
      this.drainTask = task;
    });
  }
  isThreadActive(id: string) { return [...this.active.values()].some(task => task.threadId === id); }
  isProjectActive(id: string) { return [...this.active.values()].some(task => task.scope === `project:${id}`); }
  schedulerFailure() {
    this.recoverNeeded = true;
    this.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(5, this.failures++));
    // Never log upstream exception text, arguments or credentials. Even error
    // persistence may be unavailable, so this boundary must not use SQLite.
    console.error('bot_scheduler_unavailable');
  }
  recover() {
    this.store.transaction(() => {
      const interrupted = this.store.db.prepare("SELECT id FROM runs WHERE mode='bot' AND status='running'").all() as Array<{ id: string }>;
      for (const { id } of interrupted) {
        if (this.active.has(id)) continue;
        this.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE run_id=? AND status='running'").run('Execution interrupted. Side effects may have happened; inspect evidence before retrying.', now(), id);
        this.store.db.prepare("UPDATE runs SET status='queued',started_at=NULL WHERE id=?").run(id);
      }
      // Recover legacy context pauses once, without reviving superseded work or
      // replaying operations whose outcome is uncertain. New context failures
      // are terminal and cannot loop back through this startup recovery.
      this.store.db.prepare(sql`UPDATE runs SET status='queued',error_code=NULL,wake_at=NULL WHERE mode='bot' AND status='paused' AND error_code='context_capacity_exceeded'
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.thread_id=runs.thread_id AND m.role='user'
          AND m.seq>COALESCE((SELECT seq FROM messages WHERE id=runs.trigger_message_id),0))
        AND NOT EXISTS (SELECT 1 FROM run_steps s WHERE s.run_id=runs.id AND s.status!='completed')
        AND NOT EXISTS (SELECT 1 FROM cloud_tasks c WHERE c.parent_run_id=runs.id AND c.status IN ('queued','running','waiting_user'))
        AND EXISTS (SELECT 1 FROM threads t WHERE t.id=runs.thread_id AND t.archived=0)`.sql).run();
    });
    this.recoverNeeded = false;
  }
  cancel(id: string) {
    const continuations = this.store.db.prepare("SELECT id FROM runs WHERE root_run_id=? AND status IN ('queued','running','waiting_user','waiting_event','paused')").all(id) as { id: string }[];
    this.store.db.prepare("UPDATE runs SET status='cancelled',completed_at=? WHERE root_run_id=? AND status IN ('queued','running','waiting_user','waiting_event','paused')").run(now(), id);
    for (const continuation of continuations) this.cancel(continuation.id);
    const owner = this.store.db.prepare('SELECT t.owner_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=?').get(id) as { owner_id: string } | undefined;
    if (owner) this.store.db.prepare('INSERT OR IGNORE INTO task_root_cancellations VALUES(?,?)').run(owner.owner_id, id);
    this.active.get(id)?.controller.abort();
    this.store.db.prepare("UPDATE run_steps SET status='interrupted',result=COALESCE(result,'Task cancelled; effects may be uncertain.'),completed_at=? WHERE run_id=? AND status IN ('queued','running','waiting_approval')").run(now(), id);
    this.store.db.prepare("UPDATE cloud_tasks SET status='cancelled',updated_at=? WHERE parent_run_id=? AND status IN ('queued','running','waiting_user','waiting_event')").run(now(), id);
    this.store.db.prepare("UPDATE cloud_permissions SET status='expired' WHERE task_id IN (SELECT id FROM cloud_tasks WHERE parent_run_id=?) AND status IN ('pending','approved','consumed')").run(id);
    this.store.db.prepare("UPDATE approvals SET status='rejected',resolved_at=?,resolution='Run cancelled' WHERE status='pending' AND (run_id=? OR cloud_permission_id IN (SELECT p.id FROM cloud_permissions p JOIN cloud_tasks t ON t.id=p.task_id WHERE t.parent_run_id=?))").run(now(), id, id);
  }
  async reset() {
    this.recoverNeeded = true;
    for (const task of this.active.values()) task.controller.abort();
    await Promise.allSettled([...this.tasks]);
  }
  /** Stop admission immediately; existing runs may finish until the deadline. */
  async quiesce(milliseconds: number) {
    this.quiescing = true;
    clearInterval(this.timer);
    return settleWithin([...(this.drainTask ? [this.drainTask] : []), ...this.tasks], milliseconds);
  }
  async close() {
    this.quiescing = true;
    this.stopped = true;
    clearInterval(this.timer);
    for (const task of this.active.values()) task.controller.abort();
    await this.drainTask;
    await Promise.allSettled([...this.tasks]);
  }

  private async drain() {
    if (this.stopped || this.quiescing || this.draining) return;
    this.draining = true;
    try {
      if (this.recoverNeeded) this.recover();
      try { new BotArtifacts(this.store).cleanup(); } catch { console.error('bot_artifact_cleanup_failed'); }
      await Promise.all((this.projects?.executions() ?? []).filter(e => !this.isProjectActive(e.projectId)).map(async execution => {
        try { await this.sandboxCleanup(execution.executionId); this.projects!.endExecution(execution.executionId); }
        catch { /* Keep the durable lease until the old sandbox is confirmed gone. */ }
      }));
      // Cleanup yields to shutdown: never claim a run after admission was closed.
      if (this.stopped || this.quiescing) return;
      this.syncChildren();
      // 并发是测试用例级开关(见 config.ts 惰性清单),必须每次调度重读。
      const concurrency = getConfig().botConcurrency;
      // 认领前提是这些列存在;缺列即库结构漂移,直接失败而不是跑一个半截 run。
      const rows = queuedRunRows(this.store.db.prepare("SELECT * FROM runs WHERE mode='bot' AND status='queued' AND (wake_at IS NULL OR wake_at<=?) ORDER BY created_at").all(now()));
      for (const run of rows) {
        if (this.stopped || this.quiescing) break;
        if (this.active.size >= concurrency) break;
        const thread = this.thread(run.thread_id);
        if (this.store.db.prepare("SELECT 1 FROM runs WHERE thread_id=? AND id!=? AND status IN ('waiting_user','waiting_event','paused') AND created_at<=?").get(run.thread_id, run.id, run.created_at)) continue;
        const workspaceId = this.workspaceId(thread);
        const scope = workspaceId ? `project:${workspaceId}` : `thread:${run.thread_id}`;
        if (workspaceId && this.projects?.hasExecution(workspaceId)) continue;
        if ([...this.active.values()].some((task) => task.scope === scope)) continue;
        const claimed = this.store.db.prepare("UPDATE runs SET status='running',started_at=?,wake_at=NULL WHERE id=? AND status='queued'").run(now(), run.id);
        if (!claimed.changes) continue;
        const controller = new AbortController();
        this.active.set(run.id, { threadId: run.thread_id, scope, controller });
        const task = this.execute(run, controller.signal).catch(() => this.schedulerFailure()).finally(() => {
          this.active.delete(run.id); this.tasks.delete(task); this.enqueue();
        });
        this.tasks.add(task);
      }
      this.failures = 0; this.retryAt = 0;
    } catch (error) {
      // 排空流程抛错不能无声吞掉:run 会停在 queued 无限等待,且没有任何痕迹。
      // 记录后走既有退避路径,运维至少能从日志看到第一现场。
      console.error('bot_drain_failed', error);
      this.schedulerFailure();
    } finally { this.draining = false; }
  }

  thread(id: string): ProjectThread {
    if (this.projects) return this.projects.thread(id);
    return this.store.db.prepare('SELECT id,owner_id,project_id,agent_id,archived FROM threads WHERE id=?').get(id) as ProjectThread;
  }
  workspaceId(thread: ProjectThread) { return this.projects?.workspaceId(thread) ?? thread.project_id ?? undefined; }
  executionProjectId(thread: ProjectThread, requested?: unknown, capability: 'read' | 'write' = 'write') {
    return executionProjectIdOf(this, thread, requested, capability);
  }
  async runSandbox(request: Parameters<SandboxExecutor>[0], signal: AbortSignal) { return runSandboxTool(this, request, signal); }
  policy(thread: ProjectThread, projectId?: string) { return policyOf(this, thread, projectId); }
  /** 初始上下文只依赖 run 与持久化历史;保留同名方法是因为既有测试与嵌入方
   * 直接构造 BotRunner 检查系统提示词。 */
  initialContext(run: Run, modelKey?: string) { return initialContextOf(this, run, modelKey); }
  /** 工作区说明文本;同样被工具循环之外的调用方按需读取。 */
  workspaceContext(thread: ProjectThread) { return workspaceContextOf(this, thread); }
  managedTool(name: string) {
    if (this.projectTools?.handles(name)) return this.projectTools;
    if (this.settingsTools?.handles(name)) return this.settingsTools;
    return undefined;
  }

  private async execute(run: Run, signal: AbortSignal) {
    let context: Message[] = [];
    const started = Date.now();
    const externalSignal = signal;
    const lifecycle = new AbortController();
    const imageProgress = { timer: undefined as ReturnType<typeof setTimeout> | undefined, sent: false };
    const checkActive = () => {
      signal.throwIfAborted();
      if ((this.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string } | undefined)?.status !== 'running') {
        lifecycle.abort(new Error('run_not_active'));
        throw new Error('run_not_active');
      }
    };
    const hasUnconsumedInput = () => Boolean(this.store.db.prepare('SELECT 1 FROM run_inputs WHERE run_id=? AND consumed_at IS NULL LIMIT 1').get(run.id));
    const appendActive = (kind: string, text: string, nonce?: string) => this.store.transaction(() => { checkActive(); return this.append(run.thread_id, kind, text, nonce); });
    const appendVisibleIfCurrent = (kind: string, text: string, nonce?: string) => this.store.transaction(() => {
      checkActive();
      return hasUnconsumedInput() ? null : this.append(run.thread_id, kind, text, nonce);
    });
    // External child/proxy budget pauses do not call this runner's cancel().
    // Abort outstanding model/tool I/O as well as checking every commit gate.
    const monitor = setInterval(() => {
      try { checkActive(); }
      catch {
        // Expected pause/cancel/timeouts already abort one of these signals.
        // A failed DB read needs bounded scheduler recovery as well, otherwise
        // the aborted task leaves an unclaimed status=running row indefinitely.
        if (!signal.aborted && !lifecycle.signal.aborted) this.schedulerFailure();
        lifecycle.abort();
      }
    }, 25);
    monitor.unref();
    let timeLimit: AbortSignal | undefined;
    try {
      const thread = this.thread(run.thread_id);
      authorizeThread(this, thread);
      const owner = thread.owner_id;
      this.store.systemSkills.directory(owner);
      publishBotEvent(this.store, { owner, thread: run.thread_id, run: run.id, type: 'run.started' }, this.options.onEvent);
      const config = this.options.configuration?.get(owner);
      const ledger = new UsageLedger(this.store, this.options.configuration);
      const stepBudget = new TaskStepBudget(this.store, this.options.configuration);
      const gateway = createModelGateway(this.store, this.options.configuration, this.fetcher);
      const savedSelection = this.store.db.prepare('SELECT model_snapshot FROM runs WHERE id=?').get(run.id) as { model_snapshot: string | null };
      const sessionModel = (this.store.db.prepare('SELECT default_model FROM threads WHERE id=?').get(run.thread_id) as { default_model: string | null }).default_model;
      const frozenModel = savedSelection.model_snapshot ? JSON.parse(savedSelection.model_snapshot) : this.freezeModel(run.id, owner, undefined, sessionModel ? JSON.parse(sessionModel) : undefined);
      const thinkingLevel = frozenModel.thinkingLevel;
      const elapsed = (this.store.db.prepare('SELECT active_ms FROM runs WHERE id=?').get(run.id) as { active_ms: number }).active_ms;
      const activeMs = ledger.limits(owner, run.id).activeMs;
      if (activeMs !== undefined) timeLimit = AbortSignal.timeout(Math.max(1, activeMs - elapsed));
      signal = AbortSignal.any([signal, ...(timeLimit ? [timeLimit] : []), lifecycle.signal]);
      checkActive();
      let selected = gateway.target({ owner, purpose: 'bot', frozenModel });
      const maxSteps = config?.policy.maxSteps ?? startupConfig().botMaxSteps;
      const modelKey = JSON.stringify([selected.providerId, selected.protocol, selected.model, config?.modelRevision]);
      this.store.transaction(() => {
        checkActive();
        const notice = new WorkspaceHandoff(this.store, this.projects).resume(run.id, thread);
        // Recheck before attachment import can mutate the reacquired scope.
        // Persist the notice and consume the checkpoint in this transaction.
        if (!thread.project_id && this.projects && this.options.study && thread.agent_id) importBotAttachments(this.projects, this.options.study.filesDir, owner);
        context = run.context_json ? JSON.parse(run.context_json) : initialContextOf(this, run, modelKey);
        this.consumeInputs(run, context);
        if (notice) context.push({ role: 'user', runtime_notice: true, content: notice });
        this.save(run, context);
      });
      // Persisted runs may still carry the previous all-system-writes-ask rule.
      if (context[0]?.role === 'system' && !context[0].content?.includes(systemResourcePolicy)) {
        context[0] = { ...context[0], content: `${context[0].content ?? ''}\nCurrent system-resource policy (supersedes earlier system-resource approval wording): ${systemResourcePolicy} Use shell systemWrite=true for creates/edits/installs without approval, and requiresApproval=true for deletion, including scripts. Other scopes and external-impact approvals are unchanged.` };
      }
      if (context[0]?.role === 'system' && !context[0].content?.includes(TOOL_BATCH_GUIDANCE)) {
        context[0] = { ...context[0], content: `${context[0].content ?? ''}\n${TOOL_BATCH_GUIDANCE}` };
      }
      const savedModel = this.store.db.prepare('SELECT context_model FROM runs WHERE id=?').get(run.id) as { context_model: string | null };
      if (run.context_json && savedModel.context_model !== modelKey) context = context.map(({ response_items: _native, providerState: _state, ...message }) => message);
      this.store.db.prepare('UPDATE runs SET context_model=?,context_end_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE thread_id=? AND role=\'user\'),(SELECT seq FROM messages WHERE id=trigger_message_id)) WHERE id=?').run(modelKey, run.thread_id, run.id);
      const toolTurn: ToolTurn = { deps: this, run, signal, maxSteps, stepBudget, checkActive, appendActive, appendVisibleIfCurrent, save: contextNow => this.save(run, contextNow), policyOfThread: () => this.policy(thread) };
      const governor = new ContextGovernor(this.store);
      await completePersistedEnvelope(toolTurn, context);
      injectApprovalDecisions(this, run.id, context);
      while (!signal.aborted) {
        checkActive();
        const round = await prepareAndRequest({ turn: toolTurn, thread, owner, context, selected, ledger, gateway, governor, checkActive, appendActive, startedAt: started, frozenModel, thinkingLevel, imageProgress });
        context = round.context;
        const { result, registry } = round;
        // 回退到待读图的 study_file 调用:图片批次没有模型请求的本轮,
        // 这批调用就是本轮的工具批次(与拆分前逐字一致)。
        const { calls, text } = result?.response ?? { calls: round.imageCalls, text: '' };
        if (result) {
          if (!result.continuationReusable) context = context.map(({ response_items: _native, providerState: _state, ...message }) => message);
          selected = { ...selected, providerId: result.providerId, model: result.model, protocol: result.protocol };
          this.store.db.prepare('UPDATE runs SET context_model=? WHERE id=?').run(JSON.stringify([selected.providerId, selected.protocol, selected.model, config?.modelRevision]), run.id);
        }
        checkActive();
        if (calls.length > 16 || calls.some(c => !c?.function || typeof c.function.name !== 'string' || typeof c.function.arguments !== 'string' || c.function.arguments.length > 128000)) throw new Error('invalid_structured_response');
        const batch: Call[] = calls.map(c => ({ id: crypto.randomUUID(), ...(c.id ? { provider_id: c.id } : {}), type: 'function', function: { ...c.function } }));
        // A follow-up accepted while the request was in flight wins before
        // any tool call from the stale response is committed or executed.
        if (hasUnconsumedInput()) {
          this.consumeInputs(run, context);
          continue;
        }
        // Tool-round text stays in model context, not the Web/IM conversation.
        // Explicit message/file tools deliver parts; a lone finish_turn may accompany a direct reply.
        const directReply = !batch.length || batch.length === 1 && batch[0].function.name === 'finish_turn';
        // Completion dependencies must be checked before *any* visible text
        // is appended. A lone finish_turn still carries model text in the
        // same response, so checking only the no-tool path is insufficient.
        const blockedByTask = this.pendingForegroundTasks(run.id) &&
          (directReply || batch.some(call => call.function.name === 'finish_turn' || call.function.name === 'send_message'));
        signal.throwIfAborted();
        context.push({ role: 'assistant', content: text || null, ...(batch.length ? { tool_calls: batch } : {}),
          ...(result?.response.reasoning ? { reasoning_content: result.response.reasoning } : {}), providerState: result?.response.providerState });
        if (round.wechat && (directReply && hasWechatLatex(text) || batch.some(call => wechatToolHasLatex(call.function.name, call.function.arguments)))) {
          // Reject before *any* effect in this batch. Return every tool result
          // so Responses/Anthropic/Chat histories remain valid on retry/restart.
          const repair = `${WECHAT_FORMAT_REPAIR}\nFormat check run: ${run.id}`;
          for (const call of batch) context.push({ role: 'tool', tool_call_id: call.id, content: repair });
          context.push({ role: 'user', runtime_notice: true, content: repair });
          this.store.transaction(() => {
            checkActive();
            stepBudget.chargeRunRepair(owner, run.id, Math.max(1, batch.length));
            for (const call of batch) this.store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,result,created_at,completed_at) VALUES(?,?,?,?,?,?,?,?)')
              .run(call.id, run.id, call.function.name, call.function.arguments, 'interrupted', repair, now(), now());
            run.step_count = (this.store.db.prepare('SELECT step_count FROM runs WHERE id=?').get(run.id) as { step_count: number }).step_count;
            this.save(run, context);
          });
          // Two bounded repair attempts, charged to the normal model/step budgets.
          if (context.filter(m => m.runtime_notice && m.content === repair).length >= 3) throw new Error('wechat_reply_format_failed');
          continue;
        }
        const settled = this.commitTurn(toolTurn, batch, context, directReply, blockedByTask, text, governor);
        if (settled.delivered === 'finished') return;
        if (settled.supersededByInput) {
          this.consumeInputs(run, context, settled.skippedPreviews, settled.skippedPreviews ? batch : undefined);
          continue;
        }
        if (settled.blockedByTask) {
          context.push({ role: 'user', runtime_notice: true, content: 'A required foreground study task is still running. Do not claim completion; call study_task.wait with its task ID or clearly state only background work was started.' });
          this.save(run, context);
          continue;
        }
        const batchStopped = await executeToolBatchTurn(toolTurn, batch, context, registry, hasUnconsumedInput);
        if (batchStopped) return;
        if (hasUnconsumedInput()) {
          // Preserve completed tool results, explicitly account for queued
          // calls from the stale response, consume the follow-up, and let
          // the next model turn re-plan before any old delivery occurs.
          this.consumeInputs(run, context, 'Not executed: superseded by new input.', batch);
          continue;
        }
      }
    } catch (error) {
      settleRunFailure(this, run, error, { signal, externalSignal, timeLimit, context: () => context });
    } finally {
      if (imageProgress.timer) clearTimeout(imageProgress.timer);
      clearInterval(monitor);
      this.store.db.prepare('UPDATE runs SET active_ms=active_ms+? WHERE id=?').run(Date.now() - started, run.id);
    }
  }

  /** 没有工具调用的收尾:投递直接回复、写入 queued 步骤,或在没有后续工作时结束 run。
   * 事务内的顺序(先投递可见文本再登记步骤)与旧实现一致。 */
  private commitTurn(toolTurn: ToolTurn, batch: Call[], context: Message[], directReply: boolean, blockedByTask: boolean, text: string, governor: ContextGovernor) {
    const { run } = toolTurn;
    const deps = toolTurn.deps;
    const hasUnconsumedInput = () => Boolean(deps.store.db.prepare('SELECT 1 FROM run_inputs WHERE run_id=? AND consumed_at IS NULL LIMIT 1').get(run.id));
    let supersededByInput = false;
    deps.store.transaction(() => {
      toolTurn.checkActive();
      if (directReply && text.trim() && !blockedByTask) {
        if (hasUnconsumedInput()) supersededByInput = true;
        else deps.append(run.thread_id, 'text', text, `bot:${run.id}:reply:${context.length}`);
      }
      deps.save(run, context);
      for (const call of batch) deps.store.db.prepare('INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,?,?,?,?)').run(call.id, run.id, call.function.name, call.function.arguments, 'queued', now());
      if (!batch.length && hasUnconsumedInput()) supersededByInput = true;
      if (!batch.length && !blockedByTask && !supersededByInput) { deps.finish(run.id, 'completed'); governor.completed(run.id, context); }
    });
    if (batch.length) return { supersededByInput: false, blockedByTask: false, delivered: undefined as undefined | 'finished', skippedPreviews: undefined as string | undefined };
    if (supersededByInput) return { supersededByInput: true, blockedByTask: false, delivered: undefined, skippedPreviews: 'Not executed: superseded by new input.' };
    if (blockedByTask) return { supersededByInput: false, blockedByTask: true, delivered: undefined, skippedPreviews: undefined };
    publishBotEvent(deps.store, { owner: deps.thread(run.thread_id).owner_id, thread: run.thread_id, run: run.id, type: 'run.finished', status: 'completed' }, deps.options.onEvent);
    return { supersededByInput: false, blockedByTask: false, delivered: 'finished' as const, skippedPreviews: undefined };
  }

  observeWorkspaceResult(runId: string, tool: string, result: string) {
    if (!['workspace', 'projects'].includes(tool)) return;
    const value = JSON.parse(result);
    if (typeof value?.projectId === 'string') new WorkspaceHandoff(this.store, this.projects).observe(runId, value.projectId);
  }

  save(run: Run, context: Message[]) { saveRun(this, run, context); }
  consumeInputs(run: Run, context: Message[], supersededToolResult?: string, skippedCalls: Array<{ id: string }> = []) {
    consumeRunInputs(this, run, context, supersededToolResult, skippedCalls);
  }
  async executeStudy(name: string, args: Record<string, unknown> | null, owner: string, run: Run, step: string, signal: AbortSignal) {
    return runStudyTool(this, name, args, owner, run, step, signal);
  }
  private syncChildren() { childWaits(this); }
  pendingForegroundTasks(runId: string) { return hasPendingForegroundTasks(this, runId); }
  finish(id: string, status: string) { finishRun(this, id, status); }
  append(threadId: string, kind: string, content: string, nonce?: string) {
    return appendMessage(this, threadId, kind, content, nonce);
  }
}
