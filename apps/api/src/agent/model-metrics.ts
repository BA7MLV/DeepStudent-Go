import type { DatabaseStore } from '../storage/database.js';
import type { ModelUsage } from '@wangke/study-core/model/usage';
import { appendAudit } from '../storage/audit.js';

/** Bounded audit metadata attached to an existing physical request, NOT a ledger.
 * Budget cost remains in bot_requests; provider dollars never alter admission. */
export function recordModelMetric(store: DatabaseStore, owner: string, detail: { requestId: string; provider: string; model: string; status: string; durationMs?: number; firstByteMs?: number | null }, usage?: ModelUsage) {
  try { appendAudit(store, owner, 'model.metric', { ...detail, ...(usage?.billing ? { providerBilling: usage.billing } : {}), costSource: usage?.billing ? 'provider_reported' : 'unknown' }); }
  catch { /* Observational failure must not retry a paid request. */ }
}
