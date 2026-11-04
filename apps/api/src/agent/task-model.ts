import type { FrozenTaskModel, ModelGatewayRequest, TaskModelSelection } from '@wangke/contracts/cloud';
import type { CloudConfig } from '@wangke/contracts/cloud';
import type { DatabaseStore } from '../storage/database.js';
import { ModelTargetResolver } from './model-target-resolver.js';
import { modelThinkingLevel } from './model-preferences.js';

export function validateTaskModelSelection(value: unknown): TaskModelSelection | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_model_selection');
  const v = value as any;
  if (Object.keys(v).some(k => !['modelRef', 'presetId', 'fallbackPolicy'].includes(k)) || Boolean(v.modelRef) === Boolean(v.presetId)) throw new Error('invalid_model_selection');
  if (v.modelRef && (Object.keys(v.modelRef).some(k => !['providerId', 'model'].includes(k)) || ![v.modelRef.providerId, v.modelRef.model].every(s => typeof s === 'string' && s.trim() && s.length <= 200 && !/[\u0000-\u001f\u007f]/.test(s)))) throw new Error('invalid_model_selection');
  if (v.presetId && (typeof v.presetId !== 'string' || v.presetId.length > 200)) throw new Error('invalid_model_selection');
  if (v.fallbackPolicy !== undefined && !['strict', 'configured'].includes(v.fallbackPolicy) || v.modelRef && v.fallbackPolicy === 'configured') throw new Error('invalid_model_selection');
  return JSON.parse(JSON.stringify(v));
}

export function freezeTaskModel(store: DatabaseStore, owner: string, config: CloudConfig,
  purpose: ModelGatewayRequest['purpose'], explicit?: unknown, sessionDefault?: unknown, thinking?: unknown): FrozenTaskModel {
  const task = validateTaskModelSelection(explicit), session = validateTaskModelSelection(sessionDefault);
  const selection = task ?? session;
  const { candidates, preset } = new ModelTargetResolver(() => config).resolve({ owner, purpose, ...selection });
  const fallbackPolicy = selection ? selection.fallbackPolicy ?? 'strict' : 'configured';
  return {
    selectionSource: task ? 'task' : session ? 'session' : config.modelRoutes?.byPurpose[purpose] ? 'purpose' : 'account',
    fallbackPolicy, candidates: candidates.slice(0, fallbackPolicy === 'strict' ? 1 : undefined).map(c => ({ providerId: c.adapter.target.providerId, model: c.adapter.target.model })),
    ...(preset?.policy ? { policy: JSON.parse(JSON.stringify(preset.policy)) } : {}),
    configurationRevision: config.modelRevision, thinkingLevel: modelThinkingLevel(store, owner, thinking) ?? 'none',
  };
}

/** Native codecs cannot safely migrate an in-flight body across protocols yet. */
export function requireNativeTaskModel(snapshot: FrozenTaskModel) {
  if (snapshot.fallbackPolicy === 'configured' && snapshot.candidates.length > 1) throw new Error('task_fallback_not_supported');
}
