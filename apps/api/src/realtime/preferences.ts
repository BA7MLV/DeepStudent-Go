import type { PreferencesCommand, PreferencesProjection, PreferenceKey, RuntimeJson } from '@wangke/contracts/client-runtime';
import { CloudRecords, CloudConflict } from '../cloud/records.js';
import type { DatabaseStore } from '../storage/database.js';
import { isDeepStrictEqual } from 'node:util';

export const PREFERENCE_KEYS: readonly PreferenceKey[] = ['contextWindow', 'asrConcurrency', 'thinkingEnabled', 'thinkingEffort', 'captionScale',
  'agentRounds', 'agentInstructions', 'danmakuEnabled', 'customRates', 'shortcuts', 'theme', 'uiLanguage', 'accentColor', 'fontScale',
  'dynamicColor', 'studyTrackingEnabled', 'studyIdleMinutes', 'htmlRemoteAssets', 'favorites', 'savedModels', 'userName'];

/** Account policy is here, never in a browser table name or a device setting. */
export function validatePreference(key: PreferenceKey, value: RuntimeJson) {
  if (!PREFERENCE_KEYS.includes(key) || JSON.stringify(value).length > 100000) throw new Error('invalid_preference');
  const enums: Record<string, readonly string[]> = { theme: ['light', 'dark', 'auto'], uiLanguage: ['auto', 'zh-CN', 'en-US'],
    fontScale: ['small', 'standard', 'large', 'xlarge'], thinkingEffort: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] };
  if (enums[key] && (typeof value !== 'string' || !enums[key].includes(value))) throw new Error('invalid_preference');
  if (['thinkingEnabled', 'danmakuEnabled', 'dynamicColor', 'studyTrackingEnabled', 'htmlRemoteAssets'].includes(key) && typeof value !== 'boolean') throw new Error('invalid_preference');
  if (['contextWindow', 'asrConcurrency', 'captionScale', 'agentRounds', 'studyIdleMinutes'].includes(key)
    && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10000000)) throw new Error('invalid_preference');
  if (['agentInstructions', 'userName', 'accentColor'].includes(key) && typeof value !== 'string') throw new Error('invalid_preference');
  if (key === 'userName' && (typeof value !== 'string' || value.length > 40 || /[\u0000-\u001f\u007f]/.test(value))) throw new Error('invalid_preference');
  if (['customRates', 'savedModels'].includes(key) && !Array.isArray(value)) throw new Error('invalid_preference');
  if (['shortcuts', 'favorites'].includes(key) && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('invalid_preference');
}
export function preferencesProjection(store: DatabaseStore, owner: string): PreferencesProjection {
  const records = new CloudRecords(store);
  records.agentInstructions(owner);
  return { values: Object.fromEntries(PREFERENCE_KEYS.flatMap(key => {
    const row = records.get(owner, 'preferences', key);
    return row ? [[key, row.value as RuntimeJson]] : [];
  })) };
}
export function applyPreferences(store: DatabaseStore, owner: string, command: PreferencesCommand) {
  if (!command.changes.length || command.changes.length > PREFERENCE_KEYS.length || new Set(command.changes.map(change => change.key)).size !== command.changes.length) throw new Error('invalid_preferences_command');
  const records = new CloudRecords(store);
  const mutations = command.changes.map((change, index) => {
    validatePreference(change.key, change.value);
    const before = records.get(owner, 'preferences', change.key);
    if (!isDeepStrictEqual(before?.value ?? null, change.expected) && !isDeepStrictEqual(before?.value, change.value)) throw new CloudConflict('preferences', change.key, ['value']);
    return { id: `${command.operationId}:${index}`, table: 'preferences', key: change.key, before, after: { id: change.key, value: change.value } };
  });
  records.apply(owner, mutations);
  return preferencesProjection(store, owner);
}
