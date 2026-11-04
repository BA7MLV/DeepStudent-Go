import { db } from '../store/db';
import { normalizeUserName, useSettings, type Settings } from '../store/settings';
import { cloud } from './state';
import { normalizeUiLanguage } from '../i18n/locale';
import { normalizeAgentInstructions } from '../harness/agentInstructions';
import { markCloudApply, type OutboxRow } from './cache';
import { DurableCommands, type DurableCommand } from '@wangke/client-core';
import type { PreferencesCommand, PreferencesProjection, RuntimeJson } from '@wangke/contracts/client-runtime';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';

// Account preferences only. Credentials, device relays and legacy sync endpoints
// are deliberately absent from the data protocol.
const keys = ['contextWindow', 'asrConcurrency', 'thinkingEnabled', 'thinkingEffort', 'captionScale',
  'agentRounds', 'agentInstructions', 'danmakuEnabled', 'customRates', 'shortcuts', 'theme', 'uiLanguage', 'accentColor', 'fontScale',
  'dynamicColor', 'studyTrackingEnabled', 'studyIdleMinutes', 'htmlRemoteAssets', 'favorites', 'savedModels', 'userName'] as const;
export const libraryPreferenceKeys: readonly string[] = keys;
let applying = false;
let unsubscribe: (() => void) | undefined;
let writing: Promise<unknown> = Promise.resolve();
let stopProjection: (() => void) | undefined;
let commands: { owner: string; drain: DurableCommands<PreferencesCommand> } | undefined;
let generation = 0;
const prefix = 'preferences-command:';
const inspections = new WeakMap<object, () => boolean>();

async function preferenceCommands() {
  const owner = cloud.userId, database = db;
  if (commands?.owner === owner) return commands.drain;
  commands?.drain.dispose();
  const runtime = await serverRuntime(owner);
  if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  const drain = new DurableCommands<PreferencesCommand>({
    list: async () => (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix)).map(row => row.value as DurableCommand<PreferencesCommand>).sort((a, b) => a.request.operationId.localeCompare(b.request.operationId)),
    save: async command => { await database.table('_cloudMeta').put({ id: prefix + command.operationId, value: command }); },
    remove: async operationId => { await database.table('_cloudMeta').delete(prefix + operationId); },
  }, { receipt: runtime.receipt, send: runtime.setPreferences, replaySafe: true,
    current: () => database === db && cloud.enabled && cloud.userId === owner && isCurrentServerRuntime(runtime) });
  commands = { owner, drain };
  return drain;
}
let commandSequence = 0;
async function persistPreferences(rows: { id: typeof keys[number]; value: any }[]) {
  const database = db;
  const operationId = `preferences-${Date.now()}-${String(commandSequence++).padStart(8, '0')}-${crypto.randomUUID()}`;
  await database.transaction('rw', database.table('preferences'), database.table('_cloudMeta'), async () => {
    markCloudApply();
    const changes = [];
    for (const row of rows) changes.push({ key: row.id, value: row.value, expected: (await database.table('preferences').get(row.id))?.value ?? null });
    await database.table('_cloudMeta').put({ id: prefix + operationId, value: { operationId, request: { operationId, changes }, state: 'queued' } satisfies DurableCommand<PreferencesCommand> });
    await database.table('preferences').bulkPut(rows);
  });
}
async function applyProjection(value: PreferencesProjection, database = db) {
  const current = generation, owner = cloud.userId;
  if (database !== db) return;
  // Pending drafts win only in the UI cache, never as server authority. Keep the
  // original expected values and IDs for CAS/reconciliation, including reload.
  await database.transaction('rw', database.table('preferences'), database.table('_cloudMeta'), async () => {
    if (current !== generation || owner !== cloud.userId || database !== db) return;
    markCloudApply();
    const pending = (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix));
    if (!pending.length) await database.table('_cloudMeta').delete('preferences-sync-error');
    const dirty = new Set(pending.flatMap(row => (row.value as DurableCommand<PreferencesCommand>).request.changes.map(change => change.key)));
    const rows = Object.entries(value.values).filter(([id]) => keys.includes(id as typeof keys[number]) && !dirty.has(id as typeof keys[number])).map(([id, value]) => ({ id, value }));
    await database.table('preferences').bulkPut(rows);
  });
  if (database === db && current === generation && owner === cloud.userId) await loadPreferences();
}

/** A direct system-file save is already committed; do not enqueue it as a second write. */
export async function applySystemAgentInstructions(text: string) {
  await db.transaction('rw', db.table('preferences'), async () => {
    markCloudApply();
    await db.table('preferences').put({ id: 'agentInstructions', value: text });
  });
  applying = true;
  try { useSettings.setState({ agentInstructions: text }); } finally { applying = false; }
}

export async function loadPreferences() {
  const database = db, owner = cloud.userId, current = generation;
  const rows = await database.table('preferences').toArray();
  if (database !== db || owner !== cloud.userId || current !== generation) return;
  const values = Object.fromEntries(rows.filter(r => keys.includes(r.id)).map(r => [r.id, r.value]));
  // 云偏好直接 setState，不经过 Settings.update 的输入校验。
  if (Object.hasOwn(values, 'uiLanguage')) values.uiLanguage = normalizeUiLanguage(values.uiLanguage);
  if (Object.hasOwn(values, 'userName')) values.userName = normalizeUserName(values.userName);
  if (Object.hasOwn(values, 'agentInstructions')) values.agentInstructions = normalizeAgentInstructions(values.agentInstructions);
  applying = true;
  try { useSettings.setState(values); } finally { applying = false; }
}

export async function startPreferences() {
  stopPreferences();
  const current = generation, owner = cloud.userId, database = db;
  await loadPreferences();
  if (cloud.worker || current !== generation) return;
  const runtime = await serverRuntime(owner);
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  const initial = await runtime.read({ kind: 'preferences' });
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  await applyProjection(initial.value as unknown as PreferencesProjection, database);
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  // 首次登录/旧账号尚无该字段时，把登录前的选择作为账号偏好；不是设备解析出的 locale。
  const language = await database.table('preferences').get('uiLanguage');
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  if (!language) await persistPreferences([{ id: 'uiLanguage', value: useSettings.getState().uiLanguage }]);
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  const model = runtime.preferences();
  const apply = () => {
    const snapshot = model.getSnapshot();
      if (snapshot.status === 'ready' && snapshot.data && current === generation && database === db && cloud.userId === owner && isCurrentServerRuntime(runtime)) void applyProjection(snapshot.data as unknown as PreferencesProjection, database).catch(error => {
        if (current === generation && database === db && cloud.userId === owner && isCurrentServerRuntime(runtime)) void database.table('_cloudMeta').put({ id: 'preferences-sync-error', value: String(error) }).catch(() => {});
      });
  };
  const off = model.subscribe(apply), release = model.acquire();
  stopProjection = () => { off(); release(); };
  apply();
  unsubscribe = useSettings.subscribe((next, previous) => {
    if (applying || current !== generation || owner !== cloud.userId || database !== db) return;
    const changes = keys.filter(key => JSON.stringify(next[key]) !== JSON.stringify(previous[key]));
    if (!changes.length) return;
    const rows = changes.map(id => ({ id, value: next[id as keyof Settings] ?? null }));
    writing = writing.catch(() => {}).then(async () => {
      if (database !== db || cloud.userId !== owner || current !== generation) return;
      await persistPreferences(rows);
      void drainPreferences().catch(error => {
        if (current === generation && database === db && cloud.userId === owner && isCurrentServerRuntime(runtime)) void database.table('_cloudMeta').put({ id: 'preferences-sync-error', value: String(error) }).catch(() => {});
      });
    }).catch(error => {
      if (current !== generation || database !== db || cloud.userId !== owner) return;
      void database.table('_cloudMeta').put({ id: 'preferences-sync-error', value: String(error) }).catch(() => {});
    });
  });
}

export async function flushPreferences() {
  await writing;
  if (cloud.enabled && !cloud.worker) await drainPreferences();
}

async function drainPreferences() {
  const owner = cloud.userId, database = db;
  const drain = async () => {
    if (database !== db || cloud.userId !== owner) throw new Error('client_account_changed');
    await (await preferenceCommands()).drain();
  };
  if (navigator.locks) await navigator.locks.request(`preferences-sync:${owner}`, drain);
  else await drain();
}

export function stopPreferences() { generation++; unsubscribe?.(); unsubscribe = undefined; stopProjection?.(); stopProjection = undefined; commands?.drain.dispose(); commands = undefined; }

export async function inspectPreferenceCommand(operationId: string) {
  const database = db, owner = cloud.userId, current = generation, runtime = await serverRuntime(owner);
  const [stored, receipt, projection] = await Promise.all([
    database.table('_cloudMeta').get(prefix + operationId), runtime.receipt(operationId), runtime.read({ kind: 'preferences' }),
  ]);
  if (current !== generation || database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  if (!stored) throw new Error('preference_command_not_found');
  const detail = { owner, generation: current, command: stored.value as DurableCommand<PreferencesCommand> & { legacy?: unknown }, receipt, server: projection.value as unknown as PreferencesProjection };
  inspections.set(detail, () => current === generation && database === db && owner === cloud.userId && isCurrentServerRuntime(runtime));
  return detail;
}

/** Explicit recovery creates one successor CAS command. The original draft and
 * receipt stay archived; a dropped response cannot manufacture another retry. */
export async function resolvePreferenceCommand(operationId: string, inspected: Awaited<ReturnType<typeof inspectPreferenceCommand>>, action: 'retry' | 'discard') {
  const database = db, owner = cloud.userId;
  const current = inspections.get(inspected);
  if (!current?.()) throw new Error('client_account_changed');
  const runtime = await serverRuntime(owner);
  if (inspected.owner !== owner || inspected.generation !== generation || inspected.command.operationId !== operationId || database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  if (action === 'retry' && (inspected.command.legacy || !['missing', 'completed'].includes(inspected.receipt.status))) throw new Error('preference_command_requires_reconciliation');
  const successor = `preferences-${Date.now()}-${crypto.randomUUID()}`;
  await database.transaction('rw', database.table('_cloudMeta'), async () => {
    if (!current()) throw new Error('client_account_changed');
    const prior = await database.table('_cloudMeta').get(`preferences-resolved:${operationId}`);
    if (prior) return;
    const stored = await database.table('_cloudMeta').get(prefix + operationId);
    if (!current()) throw new Error('client_account_changed');
    if (!stored || JSON.stringify(stored.value) !== JSON.stringify(inspected.command)) throw new Error('preference_command_changed');
    await database.table('_cloudMeta').put({ id: `preferences-resolved:${operationId}`, value: { ...inspected, action, successor: action === 'retry' ? successor : null } });
    if (action === 'retry') {
      const request: PreferencesCommand = { operationId: successor, changes: inspected.command.request.changes.map(change => ({ ...change, expected: inspected.server.values[change.key] ?? null })) };
      await database.table('_cloudMeta').put({ id: prefix + successor, value: { operationId: successor, request, state: 'queued' } satisfies DurableCommand<PreferencesCommand> });
    }
    await database.table('_cloudMeta').delete(prefix + operationId);
    if (!current()) throw new Error('client_account_changed');
  });
  if (!isCurrentServerRuntime(runtime) || owner !== cloud.userId || database !== db) throw new Error('client_account_changed');
  await applyProjection(inspected.server, database);
  if (action === 'retry') await drainPreferences();
}

export async function migratePreferences(snapshot = localStorage.getItem('wangke-settings'), legacyRows: { id: string; value: RuntimeJson }[] = []) {
  const saved = { ...JSON.parse(snapshot ?? 'null')?.state, ...Object.fromEntries(legacyRows.map(row => [row.id, row.value])) };
  if (!saved || typeof saved !== 'object') return;
  const existing = new Set(await db.table('preferences').toCollection().primaryKeys());
  const rows = keys.filter(id => !existing.has(id) && saved[id] !== undefined)
    .map(id => ({ id, value: id === 'uiLanguage' ? normalizeUiLanguage(saved[id]) : saved[id] }));
  if (rows.length) await persistPreferences(rows);
}

/** Convert unacknowledged legacy preference transactions once, in the same IDB
 * transaction as removing their old protocol rows. Mixed transactions remain
 * intact and require review; never silently split an atomic user operation. */
export async function migratePreferenceOutbox() {
  const database = db, owner = cloud.userId;
  const runtime = await serverRuntime(owner);
  const groups = new Map<string, OutboxRow[]>();
  for (const row of await database.table<OutboxRow>('_cloudOutbox').orderBy('sequence').toArray()) {
    const group = groups.get(row.transaction) ?? []; group.push(row); groups.set(row.transaction, group);
  }
  for (const [transaction, rows] of groups) {
    if (!rows.some(row => row.table === 'preferences')) continue;
    const receipt = await runtime.receipt(transaction);
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    await database.transaction('rw', database.table('_cloudOutbox'), database.table('_cloudMeta'), async () => {
      const current = await database.table<OutboxRow>('_cloudOutbox').where('transaction').equals(transaction).toArray();
      if (JSON.stringify(current) !== JSON.stringify(rows)) throw new Error('preference_migration_changed');
      if (receipt.status === 'completed') {
        await database.table('_cloudOutbox').bulkDelete(rows.map(row => row.sequence!));
        return;
      }
      const safe = receipt.status === 'missing' && rows.every(row => row.table === 'preferences' && row.after && keys.includes(row.key as typeof keys[number]));
      const operationId = `pref-migrate-${transaction}`;
      const changes = new Map<string, PreferencesCommand['changes'][number]>();
      for (const row of rows.filter(row => row.table === 'preferences')) {
        const prior = changes.get(String(row.key));
        changes.set(String(row.key), { key: row.key as typeof keys[number], value: (row.after?.value ?? null) as RuntimeJson, expected: prior ? prior.expected : (row.before?.value ?? null) as RuntimeJson });
      }
      await database.table('_cloudMeta').put({ id: prefix + operationId, value: {
        operationId, request: { operationId, changes: [...changes.values()] }, state: safe ? 'queued' : 'conflict',
        ...(!safe ? { error: 'legacy_preferences_require_review' } : {}),
        legacy: { transaction, rows, receipt },
      } });
      // Retain all original IDs and bodies, including mixed-domain edits, in
      // durable recovery storage instead of leaving an automatic second writer.
      await database.table('_cloudMeta').put({ id: `preferences-migration:${transaction}`, value: { transaction, rows, receipt, state: safe ? 'converted' : 'review' } });
      await database.table('_cloudOutbox').bulkDelete(rows.map(row => row.sequence!));
    });
  }
}
