import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfig } from '@wangke/contracts/cloud';
import { getModelMeta } from '@wangke/study-core/model/meta';
import type { ModelTarget } from '@wangke/study-core/model/types';

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 1_000_000_000;
/** The same account preferences used by the main model picker/editor. No second Bot window. */
export function modelSettings(store: DatabaseStore, owner: string, config?: CloudConfig, ref: CloudConfig['llmModel'] & Partial<Pick<ModelTarget, 'catalogId' | 'capabilities'>> | undefined = config?.llmModel) {
  const preference = (id: string) => {
    const row = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='preferences' AND record_key=?").get(owner, JSON.stringify(id)) as { value: string | null } | undefined;
    if (!row?.value) return undefined;
    try { return JSON.parse(row.value)?.value; } catch { return undefined; }
  };
  const models = preference('savedModels');
  const saved = Array.isArray(models) ? models.find(m => m?.providerId === ref?.providerId && m?.model === ref?.model) : undefined;
  const main = ref?.providerId === config?.llmModel.providerId && ref?.model === config?.llmModel.model;
  const configured = main ? preference('contextWindow') : undefined;
  const meta = getModelMeta(ref?.catalogId ?? '', ref?.model ?? '', { ...ref?.capabilities, ...saved });
  const knownContext = positive(meta?.declaredContext) ? meta.declaredContext : undefined;
  const knownOutput = positive(meta?.declaredOutput) ? meta.declaredOutput : undefined;
  const contextSource = positive(saved?.contextWindow) || positive(ref?.capabilities?.contextWindow) || positive(configured) ? 'configured' : knownContext ? 'model' : 'fallback';
  const outputSource = positive(saved?.maxOutputTokens) || positive(ref?.capabilities?.maxOutputTokens) ? 'configured' : knownOutput ? 'model' : 'fallback';
  const contextTokens = positive(saved?.contextWindow) ? saved.contextWindow : positive(ref?.capabilities?.contextWindow) ? ref.capabilities.contextWindow : positive(configured) ? configured : knownContext ?? 131072;
  const outputTokens = Math.min(knownOutput ?? 8192, Math.max(1, contextTokens - 1024));
  return { contextTokens, outputTokens, contextSource, outputSource, ...(knownOutput ? { knownOutputTokens: knownOutput } : {}), model: ref?.model ?? '' };
}
