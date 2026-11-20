/** 学习插件(study tool)的执行与幂等。
 * 从 runner.ts 搬出:同一 step 的已落盘结果直接复用,bot_operations 负责去重;
 * 读取工作区文件时绑定执行租约,失败时保留租约直到清理确认。 */
import { BudgetBlocked } from './budget.js';
import { ToolRegistry } from './tools/registry.js';
import { importBotAttachments } from '../projects/attachments.js';
import { readSandboxFile } from './sandbox.js';
import { expectRow } from '../storage/row-schema.js';
import { now, runStatusSchema, type BotFacade, type Run } from './runner-state.js';

export async function runStudyTool(deps: BotFacade, name: string, args: Record<string, unknown> | null, owner: string, run: Run, step: string, signal: AbortSignal): Promise<string> {
  try {
    const plugin = deps.options.study!.plugins.get(name)!;
    const checkActive = () => {
      signal.throwIfAborted();
      if (expectRow<{ status: string }>(runStatusSchema, deps.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id), 'run_row_invalid')?.status !== 'running') throw new Error('run_not_active');
      const policy = deps.policy(deps.thread(run.thread_id));
      const approved = Boolean(deps.store.db.prepare("SELECT 1 FROM approvals WHERE run_id=? AND step_id=? AND status='approved'").get(run.id, step));
      const capabilities = plugin.permissions?.(args) ?? [plugin.capability(args)];
      if ((capabilities.includes('remove') || plugin.requiresApproval?.(args)) && !approved) throw new Error('learning_approval_required');
      if (capabilities.some(k => policy[k] === 'deny' || (!plugin.systemResource && policy[k] === 'ask' && !approved))) throw new Error('learning_permission_changed');
    };
    checkActive();
    const saved = deps.store.db.prepare('SELECT result FROM bot_operations WHERE step_id=? AND owner_id=?').get(step, owner) as { result: string } | undefined;
    if (saved) return saved.result;
    const registry = new ToolRegistry();
    registry.register(deps.options.study!.definitions(owner).find(d => d.function.name === name)!, ['read', 'grep', 'checkpoint_read', 'study_read'].includes(name) ? 'read' : 'uncertain');
    const outcome = await registry.execute(name, args, { owner, thread: run.thread_id, run: run.id, step, signal, checkActive }, async scoped => {
      return plugin.execute(args, { ...scoped,
        readWorkspaceFile: async (path, requestedProjectId) => {
          scoped.checkActive();
          const thread = deps.thread(run.thread_id);
          const workspaceId = deps.executionProjectId(thread, requestedProjectId, 'read');
          if (workspaceId) deps.projects!.beginExecution(workspaceId, step);
          try {
            const bytes = await (deps.options.sandboxFile ?? readSandboxFile)({ threadId: run.thread_id, projectId: workspaceId, executionId: step, path }, scoped.signal);
            if (workspaceId) deps.projects!.endExecution(step);
            scoped.checkActive();
            return bytes;
          } catch (error) {
            if (workspaceId) {
              try { await deps.sandboxCleanup(step); deps.projects!.endExecution(step); } catch { /* Keep lease until cleanup is confirmed. */ }
            }
            throw error;
          }
        },
        append: (kind, text) => deps.store.transaction(() => {
          scoped.checkActive();
          if (deps.store.db.prepare('SELECT 1 FROM run_inputs WHERE run_id=? AND consumed_at IS NULL LIMIT 1').get(run.id)) throw new Error('run_input_superseded');
          return deps.append(run.thread_id, kind, text, `bot:${step}:attachment`);
        }) });
    });
    if (!outcome.ok) { if (outcome.error.code === 'tool_timeout') throw new BudgetBlocked('tool_timeout'); return JSON.stringify(outcome); }
    const value = outcome.value;
    checkActive();
    const thread = deps.thread(run.thread_id), workspaceId = deps.workspaceId(thread);
    const attachmentProjectId = name === 'study_upload_file' && args?.projectId !== undefined ? deps.executionProjectId(thread, args.projectId, 'read') : workspaceId;
    if (name === 'study_upload_file' && attachmentProjectId && value && typeof value === 'object' && 'fileId' in value) {
      // Registration sends a snapshot of an existing real file, not a second
      // resource item at the top of Bot when the attachment is later sent.
      const path = typeof args?.path === 'string' ? args.path : '';
      const filename = path.startsWith('/workspace/') ? path.slice(11) : path;
      deps.store.db.prepare("INSERT OR IGNORE INTO resource_attachments VALUES(?,?,?,?,'done')").run(owner, value.fileId, attachmentProjectId, filename);
    }
    if (!thread.project_id && deps.projects && workspaceId && ['study_export', 'study_send_file'].includes(name)) importBotAttachments(deps.projects, deps.options.study!.filesDir, owner);
    deps.store.db.prepare('INSERT OR IGNORE INTO bot_operations(step_id,owner_id,result,created_at) VALUES(?,?,?,?)').run(step, owner, JSON.stringify(value), now());
    deps.options.configuration?.audit(owner, 'bot.study_tool', { run: run.id, step, name, capability: plugin.capability(args) });
    return JSON.stringify(value);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof BudgetBlocked) throw error;
    // Tool errors are actionable but do not expose upstream bodies, URLs or credentials.
    return JSON.stringify({ error: 'study_tool_failed', detail: error instanceof Error && /^[a-z_]{1,80}$/.test(error.message) ? error.message : 'invalid_input_or_resource_unavailable' });
  }
}
