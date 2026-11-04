import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { BudgetBlocked } from './budget.js';

type Scope = { kind: 'run' | 'task'; id: string };

/** Bot run_steps/step_count remain authoritative. Only native Chat tools need
 * an additive journal; neither this class nor that journal schedules work. */
export class TaskStepBudget {
  constructor(readonly store: DatabaseStore, readonly configuration?: CloudConfiguration) {}
  private runScope(owner: string, run: string): Scope {
    const row = this.store.db.prepare('SELECT r.root_run_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(run, owner) as { root_run_id: string | null } | undefined;
    if (!row) throw new Error('request_run_not_owned');
    return { kind: 'run', id: row.root_run_id ?? run };
  }
  private taskScope(owner: string, task: string): Scope {
    const row = this.store.db.prepare('SELECT t.parent_run_id,t.root_task_id,d.root_id FROM cloud_tasks t LEFT JOIN task_delegations d ON d.task_id=t.id AND d.owner_id=t.owner_id WHERE t.id=? AND t.owner_id=?').get(task, owner) as { parent_run_id: string | null; root_task_id: string | null; root_id: string | null } | undefined;
    if (!row) throw new Error('request_task_not_owned');
    if (row.parent_run_id) return this.runScope(owner, row.parent_run_id);
    return { kind: 'task', id: row.root_id ?? row.root_task_id ?? task };
  }
  private used(owner: string, scope: Scope): number {
    const native = (this.store.db.prepare('SELECT COUNT(*) AS n FROM task_tool_steps WHERE owner_id=? AND root_kind=? AND root_id=?').get(owner, scope.kind, scope.id) as { n: number }).n;
    if (scope.kind === 'task') return native;
    const bot = (this.store.db.prepare('SELECT COALESCE(SUM(r.step_count),0) AS n FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.owner_id=? AND (r.id=? OR r.root_run_id=?)').get(owner, scope.id, scope.id) as { n: number }).n;
    return native + bot;
  }
  private limit(owner: string) {
    return this.configuration?.get(owner).policy.maxSteps ?? Math.max(1, Math.min(1000, Number(process.env.BOT_MAX_STEPS) || 100));
  }
  private check(owner: string, scope: Scope, additional: number) {
    if (this.used(owner, scope) + additional > this.limit(owner)) throw new BudgetBlocked(scope.kind === 'run' ? 'run_step_budget' : 'root_task_step_budget');
  }
  assertRunAvailable(owner: string, run: string) { this.check(owner, this.runScope(owner, run), 1); }
  assertRunWithinLimit(owner: string, run: string) { this.check(owner, this.runScope(owner, run), 0); }
  /** Charge before tool execution, atomically with the existing attempted state.
   * Approval resume never charges the same operation a second time. */
  startRunStep(owner: string, run: string, step: string) {
    return this.store.transaction(() => {
      const scope = this.runScope(owner, run);
      const current = this.store.db.prepare('SELECT status FROM run_steps WHERE id=? AND run_id=?').get(step, run) as { status: string } | undefined;
      if (current?.status !== 'queued') throw new Error('run_step_not_queued');
      this.check(owner, scope, 1);
      this.store.db.prepare("UPDATE run_steps SET status='running' WHERE id=? AND run_id=? AND status='queued'").run(step, run);
      this.store.db.prepare('UPDATE runs SET step_count=step_count+1 WHERE id=?').run(run);
    });
  }
  /** Rejected format batches are attempts too, even though no tool runs. */
  chargeRunRepair(owner: string, run: string, units: number) {
    if (!Number.isSafeInteger(units) || units < 1) throw new Error('invalid_step_charge');
    this.store.transaction(() => {
      this.check(owner, this.runScope(owner, run), units);
      this.store.db.prepare('UPDATE runs SET step_count=step_count+? WHERE id=?').run(units, run);
    });
  }
  chargeTaskTool(owner: string, task: string, operationId: string) {
    this.store.transaction(() => {
      const scope = this.taskScope(owner, task);
      if (!this.store.db.prepare("SELECT 1 FROM cloud_tasks WHERE id=? AND owner_id=? AND status='running'").get(task, owner)) throw new Error('request_task_not_active_or_owned');
      // This is an accounting receipt, never permission to replay the operation.
      if (this.store.db.prepare('SELECT 1 FROM task_tool_steps WHERE task_id=? AND operation_id=?').get(task, operationId)) return;
      this.check(owner, scope, 1);
      this.store.db.prepare('INSERT INTO task_tool_steps(task_id,operation_id,owner_id,root_kind,root_id) VALUES(?,?,?,?,?)').run(task, operationId, owner, scope.kind, scope.id);
    });
  }
}
