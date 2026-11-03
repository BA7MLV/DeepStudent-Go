import type { DatabaseStore } from '../storage/database.js';
import type { ModelOverrides } from '@wangke/study-core/model/meta';
import { normalizeThinkingLevel } from '@wangke/study-core/model/reasoning';

function preference(store: DatabaseStore, owner: string, key: string): unknown {
  const row = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='preferences' AND record_key=?")
    .get(owner, JSON.stringify(key)) as { value: string | null } | undefined;
  try { return row?.value ? JSON.parse(row.value)?.value : undefined; } catch { return undefined; }
}

/** Same snapshot/fallback semantics for Bot, Chat and older task payloads. */
export function modelThinkingLevel(store: DatabaseStore, owner: string, explicit?: unknown) {
  const level = normalizeThinkingLevel(explicit);
  if (level) return level;
  const enabled = preference(store, owner, 'thinkingEnabled');
  return enabled === false ? 'none' : enabled === true ? normalizeThinkingLevel(preference(store, owner, 'thinkingEffort')) ?? 'high' : undefined;
}

export function savedModelOverrides(store: DatabaseStore, owner: string, providerId: string, model: string): ModelOverrides | undefined {
  const models = preference(store, owner, 'savedModels');
  return Array.isArray(models) ? models.find(row => row?.providerId === providerId && row?.model === model) : undefined;
}
