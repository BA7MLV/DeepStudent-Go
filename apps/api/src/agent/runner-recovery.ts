/** run 崩溃恢复与审批结果注入。
 * 从 runner.ts 的 execute() 里搬出:先补齐上一次已落盘的 tool-call envelope,
 * 再把非 pending 的审批结论作为 runtime_notice 附到上下文。
 * 不重放命令;只把持久化结果补回上下文,保证模型历史完整。 */
import { expectRow } from '../storage/row-schema.js';
import { recordToolResult } from '@wangke/study-core/tool-batch';
import { now, runStepRowSchema, toolArguments, type RunStepRow } from './runner-state.js';
import { resolveApprovedStep, type ToolTurn } from './runner-tools.js';
import type { ModelMessage as Message } from './model.js';

/** 补齐上一次已落盘的 tool-call envelope:等待审批的步骤重新授权一次,
 * 其余按「结果未知」标记为 interrupted,绝不重放命令。 */
export async function completePersistedEnvelope(turn: ToolTurn, context: Message[]): Promise<void> {
  const { deps, run } = turn;
  // Complete a persisted tool-call envelope after a crash, without re-executing the command.
  let envelopeIndex = context.length - 1;
  while (envelopeIndex >= 0 && !(context[envelopeIndex].role === 'assistant' && context[envelopeIndex].tool_calls?.length)) envelopeIndex--;
  const envelope = context[envelopeIndex];
  if (!envelope) return;
  const resolved = new Set(context.slice(envelopeIndex + 1).filter(m => m.role === 'tool').map(m => m.tool_call_id));
  const last = { ...envelope, tool_calls: envelope.tool_calls?.filter(c => !resolved.has(c.id)) };
  if (!last.tool_calls?.length) return;
  for (const call of last.tool_calls) {
    const step = expectRow<RunStepRow>(runStepRowSchema, deps.store.db.prepare('SELECT * FROM run_steps WHERE id=? AND run_id=?').get(call.id, run.id), 'run_step_row_invalid');
    if (step?.status === 'waiting_approval') await resolveApprovedStep(turn, step.id, step.tool, toolArguments(step.arguments), step, context, envelopeIndex, envelope, call);
    turn.checkActive();
    const interrupted = 'Interrupted before result was saved. Inspect workspace before retrying.';
    if (!step) deps.store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,result,created_at,completed_at) VALUES(?,?,?,?,'interrupted',?,?,?)").run(call.id, run.id, call.function.name, call.function.arguments, interrupted, now(), now());
    else if (['queued', 'running'].includes(step.status)) deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE id=?").run(interrupted, now(), step.id);
    recordToolResult(context, envelopeIndex + 1, envelope.tool_calls!, { role: 'tool', tool_call_id: call.id, content: step?.result ?? interrupted });
  }
  deps.save(run, context);
}

/** 审批结论必须在下一轮请求里可见;这里只读非 pending 的行。 */
export function injectApprovalDecisions(deps: { store: ToolTurn['deps']['store'] }, runId: string, context: Message[]) {
  const approvals = deps.store.db.prepare("SELECT status,resolution FROM approvals WHERE run_id=? AND status!='pending'").all(runId);
  if (approvals.length) context.push({ role: 'user', runtime_notice: true, content: `Approval decisions: ${JSON.stringify(approvals)}` });
}
