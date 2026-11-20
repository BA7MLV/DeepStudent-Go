/** run 终态落盘:预算暂停、取消、失败三类的状态迁移与用户可读提示。
 * 从 runner.ts 的 execute() catch 分支原样搬出;分支顺序、错误码白名单
 * 与提示文案都保持不变(它们决定 run 是否可被恢复调度)。 */
import { botPauseMessage } from '@wangke/contracts/cloud';
import { BudgetBlocked } from './budget.js';
import { ModelFailure } from './model-client.js';
import { sandboxFailureCodes } from './sandbox.js';
import { publishBotEvent } from './events.js';
import { ProjectError } from '../projects/files.js';
import { ImageInputFailure } from './image-input.js';
import { now, type BotFacade, type Run } from './runner-state.js';
import type { ModelMessage as Message } from './model.js';

export interface FailureState {
  signal: AbortSignal;
  externalSignal: AbortSignal;
  timeLimit?: AbortSignal;
  context: () => Message[];
}

export function settleRunFailure(deps: BotFacade, run: Run, error: unknown, state: FailureState) {
  const context = state.context();
  const { signal } = state;
  const status = (deps.store.db.prepare('SELECT status FROM runs WHERE id=?').get(run.id) as { status: string } | undefined)?.status;
  if (status !== 'running') {
    deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result=COALESCE(result,'Task suspended; not replayed.'),completed_at=? WHERE run_id=? AND status IN ('queued','running')").run(now(), run.id);
    return;
  }
  if (error instanceof BudgetBlocked || state.timeLimit?.aborted && !state.externalSignal.aborted) {
    const code = error instanceof BudgetBlocked ? error.code : 'run_active_time_budget';
    deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result='Budget paused; inspect effects before retrying.',completed_at=? WHERE run_id=? AND status IN ('running','queued')").run(now(), run.id);
    const next = code === 'context_capacity_exceeded' ? 'failed' : 'paused';
    deps.store.db.prepare("UPDATE runs SET status=?,error_code=?,completed_at=? WHERE id=? AND status='running'").run(next, code, next === 'failed' ? now() : null, run.id);
    const identity = deps.store.db.prepare('SELECT owner_id FROM threads WHERE id=?').get(run.thread_id) as { owner_id: string };
    publishBotEvent(deps.store, { owner: identity.owner_id, thread: run.thread_id, run: run.id, type: next === 'failed' ? 'run.finished' : 'run.paused', status: code }, deps.options.onEvent);
    deps.save(run, context);
    deps.append(run.thread_id, 'text', botPauseMessage(code));
    return;
  }
  if (signal.aborted) {
    deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result=?,completed_at=? WHERE run_id=? AND status IN ('running','queued')").run('Interrupted. Inspect workspace before retrying; side effects may have occurred.', now(), run.id);
    if (deps.stopped) deps.store.db.prepare("UPDATE runs SET status='queued' WHERE id=? AND status='running'").run(run.id);
    return;
  }
  const code = error instanceof ImageInputFailure ? error.message : error instanceof ModelFailure || error instanceof ProjectError ? error.code : error instanceof Error && ['model_not_configured', ...sandboxFailureCodes, 'invalid_structured_response', 'model_incomplete_or_refused', 'wechat_reply_format_failed'].includes(error.message) ? error.message : 'model_request_failed';
  deps.store.db.prepare("UPDATE run_steps SET status='failed',result=?,completed_at=? WHERE run_id=? AND status='running'").run(code, now(), run.id);
  deps.store.db.prepare("UPDATE run_steps SET status='interrupted',result='Not executed: task failed.',completed_at=? WHERE run_id=? AND status='queued'").run(now(), run.id);
  if (code === 'sandbox_unavailable') deps.append(run.thread_id, 'text', '暂时无法完成这次处理，执行服务当前不可用。');
  const sandboxNotices: Record<string, string> = {
    workspace_cleanup_pending: '工作区仍有未确认清理的命令，未交接执行权。请先核对已有操作结果，不要重复执行。',
    workspace_handoff_unsettled: '工作区还有未结算操作，本次等待交接或恢复已停止，未重放命令。',
    workspace_revision_too_large: '工作区超过安全版本复核范围，本次等待交接或恢复已停止，未重放命令。',
    workspace_revision_unstable: '工作区版本复核期间发生变化，本次等待交接或恢复已停止，未重放命令。',
    sandbox_not_configured: '执行服务尚未配置，暂时无法运行命令。',
    sandbox_busy: '工作区当前有命令正在运行，本次命令未执行。',
    sandbox_cleanup_pending: '上一次执行的容器尚未确认清理完成，工作区暂时保持锁定。操作可能已部分完成，请先检查结果，不要重复执行。',
    sandbox_start_failed: '执行容器启动失败，本次命令未能正常启动。',
    sandbox_unauthorized: '执行服务认证失败，需要检查服务器配置。',
    sandbox_invalid_request: '执行请求或工作区配置不符合要求，本次命令未执行。',
    sandbox_protocol_error: '执行结果传输不完整或格式异常，操作可能已发生，请先检查结果，不要直接重试。',
    sandbox_workspace_quota_exceeded: '工作区文件已超过磁盘配额，本次命令未执行。请先删除工作区中不需要的文件再重试。',
  };
  if (sandboxNotices[code]) deps.append(run.thread_id, 'text', sandboxNotices[code]);
  if (code === 'wechat_reply_format_failed') deps.append(run.thread_id, 'text', '这次回复的公式没能转换成微信可读的格式，请重试。');
  if (error instanceof ImageInputFailure) deps.append(run.thread_id, 'text', error.notice);
  deps.store.db.prepare("UPDATE runs SET status='failed',completed_at=?,error_code=? WHERE id=? AND status='running'").run(now(), code, run.id);
}
