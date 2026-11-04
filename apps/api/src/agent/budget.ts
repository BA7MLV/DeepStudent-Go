import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';
import { publishBotEvent } from './events.js';
import { modelSettings } from './model-settings.js';

export interface BotBudget {
  runTokens?: number; dayTokens?: number; activeMs?: number; contextTokens: number;
  runCost?: number;
  prices: Array<{ provider: string; model: string; inputPerMillion: number; outputPerMillion: number; source: string }>;
}
export const DEFAULT_BOT_BUDGET: BotBudget = { contextTokens: 131072, prices: [] };
export class BudgetBlocked extends Error {
  constructor(readonly code: string) { super(code); this.name = 'BudgetBlocked'; }
}
/** Native executors are bundled separately and have a different constructor
 * identity. This is an internal exception boundary, never client input. */
export function isBudgetBlocked(error: unknown): error is BudgetBlocked {
  return error instanceof BudgetBlocked || error instanceof Error && error.name === 'BudgetBlocked' && typeof (error as BudgetBlocked).code === 'string';
}
export interface RequestAttribution { owner: string; run?: string; step?: string; task?: string; purpose: string; provider: string; model: string }
export function validateBudget(value: BotBudget): BotBudget {
  if (!value || typeof value !== 'object') throw new Error('invalid_bot_budget');
  for (const field of ['runTokens', 'dayTokens', 'activeMs', 'contextTokens'] as const) if (value[field] !== undefined && (!Number.isSafeInteger(value[field]) || value[field]! < (field === 'contextTokens' ? 1 : 100) || value[field]! > 1000000000)) throw new Error('invalid_bot_budget');
  if (value.runCost !== undefined && (!Number.isFinite(value.runCost) || value.runCost <= 0 || value.runCost > 100000)) throw new Error('invalid_bot_cost_budget');
  if (!Array.isArray(value.prices) || value.prices.length > 100) throw new Error('invalid_bot_prices');
  for (const price of value.prices) if (!price || typeof price.provider !== 'string' || typeof price.model !== 'string' || typeof price.source !== 'string' || price.source.length > 200 || ![price.inputPerMillion, price.outputPerMillion].every(p => Number.isFinite(p) && p >= 0)) throw new Error('invalid_bot_price');
  return { runTokens: value.runTokens, dayTokens: value.dayTokens, activeMs: value.activeMs, contextTokens: value.contextTokens ?? DEFAULT_BOT_BUDGET.contextTokens, ...(value.runCost === undefined ? {} : { runCost: value.runCost }), prices: value.prices.map(p => ({ ...p })) };
}
export class UsageLedger {
  constructor(readonly store: DatabaseStore, readonly configuration?: CloudConfiguration) {}
  rootRun(owner: string, run?: string) {
    return run ? (this.store.db.prepare('SELECT r.root_run_id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(run, owner) as { root_run_id: string | null } | undefined)?.root_run_id ?? run : undefined;
  }
  limits(owner: string, run?: string): BotBudget {
    run = this.rootRun(owner, run);
    const stored = { ...this.configuration?.get(owner).botBudget };
    // Retire the old UI defaults; explicit non-default API quotas remain compatible.
    if (stored.runTokens === 250000) delete stored.runTokens;
    if (stored.dayTokens === 1000000) delete stored.dayTokens;
    if (stored.activeMs === 900000) delete stored.activeMs;
    if (stored.contextTokens === 32000) delete stored.contextTokens;
    const defaults = { ...DEFAULT_BOT_BUDGET, contextTokens: this.model(owner).contextTokens, ...stored };
    const row = run ? this.store.db.prepare('SELECT budget_json FROM runs WHERE id=?').get(run) as { budget_json: string | null } | undefined : undefined;
    const override = row?.budget_json ? JSON.parse(row.budget_json) : {};
    // Older Continue actions copied the entire default budget into the run.
    for (const [field, value] of Object.entries({ runTokens: 250000, dayTokens: 1000000, activeMs: 900000, contextTokens: 32000 })) if (override[field] === value) delete override[field];
    return validateBudget({ ...defaults, ...override });
  }
  model(owner: string, ref?: { providerId: string; model: string }) { return modelSettings(this.store, owner, this.configuration?.get(owner), ref); }
  observation(a: RequestAttribution, reservedTokens: number): import('./model-observations.js').ObservationAttribution | undefined {
    if (!a.task) return undefined;
    this.checkAdmission(a);
    if (!Number.isSafeInteger(reservedTokens) || reservedTokens < 1) throw new Error('invalid_request_reservation');
    const price = this.limits(a.owner, a.run).prices.find(p => p.provider === a.provider && p.model === a.model);
    return { task: a.task, reservedTokens, ...(price ? { price } : {}) };
  }
  taskBudgeted(owner: string, task?: string) {
    if (!task) return false;
    const limits = this.limits(owner);
    return limits.runTokens !== undefined || limits.dayTokens !== undefined || limits.runCost !== undefined
      || Boolean(this.store.db.prepare('SELECT 1 FROM task_delegations WHERE owner_id=? AND (task_id=? OR parent_task_id=?) UNION SELECT 1 FROM cloud_tasks WHERE owner_id=? AND id=? AND root_task_id IS NOT NULL LIMIT 1').get(owner, task, task, owner, task));
  }
  checkAdmission(a: RequestAttribution) {
    if (a.run) {
      const row = this.store.db.prepare('SELECT r.status FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=?').get(a.run, a.owner) as { status: string } | undefined;
      if (!row) throw new Error('request_run_not_owned');
      const allowed = a.purpose === 'memory' ? ['completed'] : a.purpose.startsWith('study:') && a.task ? ['running', 'queued', 'waiting_user', 'waiting_event', 'completed'] : ['running'];
      if (!allowed.includes(row.status)) throw new Error('request_run_not_active');
    }
    if (a.task && !this.store.db.prepare("SELECT 1 FROM cloud_tasks WHERE id=? AND owner_id=? AND parent_run_id IS ? AND status IN ('running','waiting_user')").get(a.task, a.owner, a.run ?? null)) throw new Error('request_task_not_active_or_owned');
  }
  reserve(a: RequestAttribution, attempt: number, tokens: number) {
    return this.store.transaction(() => {
      if (!Number.isSafeInteger(tokens) || tokens < 1 || !Number.isSafeInteger(attempt) || attempt < 1) throw new Error('invalid_request_reservation');
      this.checkAdmission(a);
      const limits = this.limits(a.owner, a.run);
      const rootRun = this.rootRun(a.owner, a.run);
      const root = a.task ? (this.store.db.prepare('SELECT root_id FROM task_delegations WHERE task_id=? AND owner_id=?').get(a.task, a.owner) as { root_id: string } | undefined)?.root_id ?? (this.store.db.prepare('SELECT root_task_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(a.task, a.owner) as { root_task_id: string | null } | undefined)?.root_task_id ?? a.task : undefined;
      const sum = (where: string, params: string[]) => (this.store.db.prepare(`SELECT COALESCE(SUM(COALESCE(input_tokens+output_tokens,reserved_tokens)),0) AS tokens FROM bot_requests WHERE ${where}`).get(...params) as { tokens: number }).tokens;
      // Ordinary pre-delegation calls stay in the original observation table.
      // Attach physical request evidence there, then include it in admission;
      // never copy it into bot_requests (which would double-count usage reports).
      const observedDay = limits.dayTokens === undefined ? 0 : (this.store.db.prepare('SELECT COALESCE(SUM(COALESCE(input_tokens+output_tokens,reserved_tokens)),0) AS tokens FROM model_observations WHERE owner_id=? AND task_id IS NOT NULL AND started_at>=?').get(a.owner, new Date().toISOString().slice(0, 10)) as { tokens: number }).tokens;
      if (limits.dayTokens !== undefined && sum('owner_id=? AND started_at>=?', [a.owner, new Date().toISOString().slice(0, 10)]) + observedDay + tokens > limits.dayTokens) throw new BudgetBlocked('owner_daily_token_budget');
      const runScope = 'owner_id=? AND (run_id=? OR run_id IN (SELECT id FROM runs WHERE root_run_id=?))';
      const taskScope = 'owner_id=? AND (task_id=? OR task_id IN (SELECT task_id FROM task_delegations WHERE root_id=? AND owner_id=?) OR task_id IN (SELECT id FROM cloud_tasks WHERE root_task_id=? AND owner_id=?))';
      const runParams = [a.owner, rootRun!, rootRun!], taskParams = [a.owner, root!, root!, a.owner, root!, a.owner];
      const observationScope = root && !a.run ? taskScope : 'owner_id=? AND task_id IN (SELECT id FROM cloud_tasks WHERE parent_run_id=? OR parent_run_id IN (SELECT id FROM runs WHERE root_run_id=?))';
      const observationParams = root && !a.run ? taskParams : [a.owner, rootRun!, rootRun!];
      const observed = a.run || root ? this.store.db.prepare(`SELECT input_tokens,output_tokens,cache_creation_tokens,reserved_tokens,provider,model,price_json FROM model_observations WHERE ${observationScope}`).all(...observationParams) as Array<{ input_tokens: number | null; output_tokens: number | null; cache_creation_tokens: number | null; reserved_tokens: number | null; provider: string; model: string; price_json: string | null }> : [];
      const observedTokens = observed.reduce((n, r) => n + (r.input_tokens !== null && r.output_tokens !== null ? r.input_tokens + r.output_tokens : r.reserved_tokens ?? 0), 0);
      if (a.run && limits.runTokens !== undefined && sum(runScope, runParams) + observedTokens + tokens > limits.runTokens) throw new BudgetBlocked('run_token_budget');
      if (!a.run && root && limits.runTokens !== undefined && sum(taskScope, taskParams) + observedTokens + tokens > limits.runTokens) throw new BudgetBlocked('root_task_token_budget');
      const price = limits.prices.find(p => p.provider === a.provider && p.model === a.model);
      if (limits.runCost !== undefined) {
        if (!price) throw new BudgetBlocked('model_price_required');
        const current = (a.run ? this.store.db.prepare(`SELECT cost,input_tokens,output_tokens,reserved_tokens,provider,model,price_json FROM bot_requests WHERE ${runScope}`).all(...runParams)
          : root ? this.store.db.prepare(`SELECT cost,input_tokens,output_tokens,reserved_tokens,provider,model,price_json FROM bot_requests WHERE ${taskScope}`).all(...taskParams) : []) as Array<{ cost: number | null; input_tokens: number | null; output_tokens: number | null; reserved_tokens: number; provider: string; model: string; price_json: string | null }>;
        let cost = 0;
        for (const row of [...current, ...observed.map(row => ({ ...row, input_tokens: row.input_tokens === null ? null : row.input_tokens + (row.cache_creation_tokens ?? 0), cost: null }))]) {
          const p = row.price_json ? JSON.parse(row.price_json) as BotBudget['prices'][number] : limits.prices.find(p => p.provider === row.provider && p.model === row.model);
          if (!p) throw new BudgetBlocked('model_price_required');
          cost += row.cost ?? (row.input_tokens !== null && row.output_tokens !== null ? row.input_tokens * p.inputPerMillion + row.output_tokens * p.outputPerMillion : (row.reserved_tokens ?? 0) * Math.max(2 * p.inputPerMillion, p.outputPerMillion)) / 1000000;
        }
        if (cost + tokens * Math.max(2 * price.inputPerMillion, price.outputPerMillion) / 1000000 > limits.runCost) throw new BudgetBlocked('run_cost_budget');
      }
      const id = crypto.randomUUID();
      this.store.db.prepare('INSERT INTO bot_requests(id,owner_id,run_id,step_id,task_id,purpose,provider,model,attempt,started_at,status,reserved_tokens,pricing_source,price_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id, a.owner, a.run ?? null, a.step ?? null, a.task ?? null, a.purpose, a.provider, a.model, attempt, new Date().toISOString(), 'inflight', tokens, price?.source ?? null, price ? JSON.stringify(price) : null);
      publishBotEvent(this.store, { owner: a.owner, run: a.run, step: a.step, requestId: id, type: 'model.started' });
      return id;
    });
  }
  settle(id: string, status: string, usage?: import('@wangke/study-core/model/usage').ModelUsage) {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT * FROM bot_requests WHERE id=? AND ended_at IS NULL").get(id) as (RequestAttribution & { owner_id: string; run_id: string | null; price_json: string | null; reserved_tokens: number; started_at: string }) | undefined;
      if (!row) return false;
      const price = row.price_json ? JSON.parse(row.price_json) as BotBudget['prices'][number] : undefined;
      this.store.db.prepare('UPDATE bot_requests SET ended_at=?,status=?,input_tokens=?,output_tokens=?,cache_tokens=?,cost=?,usage_source=? WHERE id=? AND ended_at IS NULL').run(new Date().toISOString(), status, usage?.input ?? null, usage?.output ?? null, usage?.cache ?? null, usage && price ? ((usage.input + (usage.cacheCreation ?? 0)) * price.inputPerMillion + usage.output * price.outputPerMillion) / 1000000 : null, usage ? usage.cacheCreation ? 'provider_tokens:cache_write_2x_estimate' : 'provider' : 'unknown_reserved', id);
      this.store.db.prepare('UPDATE bot_requests SET cache_creation_tokens=?,reasoning_tokens=? WHERE id=?').run(usage?.cacheCreation ?? null, usage?.reasoning ?? null, id);
      recordModelMetric(this.store, row.owner_id, { requestId: id, provider: row.provider, model: row.model, status, durationMs: Math.max(0, Date.now() - Date.parse(row.started_at)) }, usage);
      publishBotEvent(this.store, { owner: row.owner_id, run: row.run_id ?? undefined, requestId: id, type: 'model.finished', status });
      // Provider usage is authoritative, even when it violates the estimate.
      // Preserve the full overage and stop future tools/requests (not a refund
      // or an impossible promise to undo already billed provider tokens).
      const exceeded = !!usage && usage.input + usage.output > row.reserved_tokens;
      if (exceeded && row.run_id) this.store.db.prepare("UPDATE runs SET status='paused',error_code='model_usage_exceeded_reservation' WHERE id=? AND status IN ('running','queued','waiting_user')").run(row.run_id);
      return exceeded;
    });
  }
}
import { recordModelMetric } from './model-metrics.js';
