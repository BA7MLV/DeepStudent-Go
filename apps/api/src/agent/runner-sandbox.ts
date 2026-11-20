/** shell 执行前的防线与工作区租约。
 * 从 runner.ts 搬出:systemWrite 与落盘参数逐字段核对、执行租约的开始/结束、
 * 产出捕获。顺序与拒绝码都保持原样。 */
import { WorkspaceHandoff } from './workspace-handoff.js';
import { executeSandbox, SandboxFailure, type SandboxExecutor } from './sandbox.js';
import { ProjectError } from '../projects/files.js';
import { BotArtifacts } from './artifacts.js';
import { shellDecision } from './permissions.js';
import { sql } from '../storage/sql.js';
import { policyOf } from './runner-context.js';
import type { BotFacade } from './runner-state.js';

export async function runSandboxTool(deps: BotFacade, request: Parameters<SandboxExecutor>[0], signal: AbortSignal) {
  if (request.systemWrite) {
    const step = deps.store.db.prepare(sql`SELECT s.arguments,
      EXISTS(SELECT 1 FROM approvals a WHERE a.step_id=s.id AND a.run_id=r.id AND a.status='approved') AS approved
      FROM run_steps s JOIN runs r ON r.id=s.run_id
      JOIN threads t ON t.id=r.thread_id WHERE s.id=? AND s.tool='shell' AND s.status='running'
      AND r.status='running' AND t.id=? AND t.owner_id=?`.sql).get(request.executionId, request.threadId, request.owner) as { arguments: string; approved: number } | undefined;
    const args = step ? JSON.parse(step.arguments) : undefined;
    if (args?.systemWrite !== true || args.command !== request.command || args.projectId !== request.projectId || args.network !== request.network || args.timeoutSeconds !== request.timeoutSeconds) throw new ProjectError('system_write_scope_mismatch', 403);
    const policy = policyOf(deps, deps.thread(request.threadId), request.projectId);
    const decision = shellDecision(policy, request.command, args.requiresApproval === true, true);
    if (decision.permission === 'deny' || request.network && policy.network !== 'allow') throw new ProjectError('system_write_denied', 403);
    if (decision.permission === 'ask' && !step?.approved) throw new ProjectError('system_write_approval_required', 403);
  }
  if (deps.sandbox === executeSandbox && (!process.env.SANDBOX_URL || !process.env.SANDBOX_TOKEN)) throw new SandboxFailure('sandbox_not_configured');
  if (request.projectId) {
    const step = deps.store.db.prepare('SELECT run_id FROM run_steps WHERE id=?').get(request.executionId) as { run_id: string } | undefined;
    if (step) new WorkspaceHandoff(deps.store, deps.projects).observe(step.run_id, request.projectId);
    deps.projects!.beginExecution(request.projectId, request.executionId);
  }
  try {
    const step = deps.sandbox === executeSandbox ? deps.store.db.prepare('SELECT run_id FROM run_steps WHERE id=?').get(request.executionId) as { run_id: string } | undefined : undefined;
    const result = step
      ? await new BotArtifacts(deps.store).captureShell(request.owner, step.run_id, request.executionId, output => deps.sandbox(request, signal, output))
      : await deps.sandbox(request, signal);
    if (request.projectId) deps.projects!.endExecution(request.executionId);
    return result;
  } catch (error) {
    if (request.projectId) {
      try { await deps.sandboxCleanup(request.executionId); deps.projects!.endExecution(request.executionId); }
      catch { /* Preserve the lease when cleanup cannot be confirmed. */ }
    }
    throw error;
  }
}
