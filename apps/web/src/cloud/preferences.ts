import { db } from '../store/db';
import { normalizeUserName, useSettings, type Settings } from '../store/settings';
import { cloud } from './state';
import { cloudTransaction } from './transactions';
import { normalizeUiLanguage } from '../i18n/locale';
import { normalizeAgentInstructions } from '../harness/agentInstructions';
import { markCloudApply, type OutboxRow } from './cache';
import type { DurableCommand, DurableCommands } from '@wangke/client-core';
import type { PreferencesCommand, PreferencesProjection, RuntimeJson } from '@wangke/contracts/client-runtime';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';

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
let commands: { lifetime: AccountLifetime; drain: DurableCommands<PreferencesCommand> } | undefined;
// Local subscription incarnation only; account invalidation belongs to lifetime.
let generation = 0;
let detachLifetime: (() => void) | undefined;
const prefix = 'preferences-command:';
const inspections = new WeakMap<object, () => boolean>();
const localIntent = new Map<string, unknown>();

async function preferenceCommands() {
  const owner = cloud.userId, database = db;
  const lifetime = accountLifetime(owner);
  if (commands?.lifetime === lifetime) return commands.drain;
  commands?.drain.dispose();
  const runtime = await serverRuntime(owner);
  lifetime.assertCurrent();
  if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  if (commands?.lifetime === lifetime) return commands.drain;
  const { DurableCommands } = await import('@wangke/client-core');
  const mutateJournal = (write: () => Promise<unknown>) => cloudTransaction(database, [database.table('_cloudMeta')], async () => {
    lifetime.assertCurrent();
    await write();
    lifetime.assertCurrent();
  });
  const drain = new DurableCommands<PreferencesCommand>({
    list: async () => (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix)).map(row => row.value as DurableCommand<PreferencesCommand>).sort((a, b) => a.request.operationId.localeCompare(b.request.operationId)),
    save: command => mutateJournal(() => database.table('_cloudMeta').put({ id: prefix + command.operationId, value: command })),
    remove: operationId => mutateJournal(() => database.table('_cloudMeta').delete(prefix + operationId)),
    acknowledge: async (operationId, value) => {
      // Install this command's confirmed values before removing its overlay.
      // Otherwise another quick edit can still read the pre-ack cache as its CAS
      // baseline while the preferences subscription is catching up.
      await cloudTransaction(database, [database.table('preferences'), database.table('_cloudMeta')], async () => {
        lifetime.assertCurrent();
        const command = (await database.table('_cloudMeta').get(prefix + operationId))?.value as DurableCommand<PreferencesCommand> | undefined;
        const projection = value as PreferencesProjection;
        markCloudApply();
        for (const change of command?.request.changes ?? []) {
          const cached = (await database.table('preferences').get(change.key))?.value ?? null;
          // A newer server projection may already have arrived. Do not roll it
          // back with an older receipt recovered after a disconnect.
          if (JSON.stringify(cached) === JSON.stringify(change.expected))
            await database.table('preferences').put({ id: change.key, value: projection.values[change.key] ?? null });
        }
        await database.table('_cloudMeta').delete(prefix + operationId);
        lifetime.assertCurrent();
      });
    },
  }, { receipt: runtime.receipt, send: runtime.setPreferences, replaySafe: true,
    current: () => lifetime.current() && database === db && cloud.enabled && cloud.userId === owner && isCurrentServerRuntime(runtime) });
  commands = { lifetime, drain };
  lifetime.own(() => { drain.dispose(); if (commands?.drain === drain) commands = undefined; });
  return drain;
}
let commandSequence = 0;
async function persistPreferences(rows: { id: typeof keys[number]; value: any }[], database = db, lifetime = accountLifetime(cloud.userId)) {
  lifetime.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  const operationId = `preferences-${Date.now()}-${String(commandSequence++).padStart(8, '0')}-${crypto.randomUUID()}`;
  await cloudTransaction(database, [database.table('preferences'), database.table('_cloudMeta')], async () => {
    lifetime.assertCurrent();
    const changes = [];
    // Queue edits against their predecessor's intended value. Each command
    // keeps its original CAS; a failed predecessor still blocks the chain.
    const pending = (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id));
    const expected = new Map<string, RuntimeJson>();
    for (const command of pending) for (const change of (command.value as DurableCommand<PreferencesCommand>).request.changes) expected.set(change.key, change.value);
    for (const row of rows) changes.push({ key: row.id, value: row.value,
      expected: expected.has(row.id) ? expected.get(row.id)! : (await database.table('preferences').get(row.id))?.value ?? null });
    lifetime.assertCurrent();
    await database.table('_cloudMeta').put({ id: prefix + operationId, value: { operationId, request: { operationId, changes }, state: 'queued' } satisfies DurableCommand<PreferencesCommand> });
    lifetime.assertCurrent();
  });
}
async function applyProjection(value: PreferencesProjection, database = db) {
  const current = generation, owner = cloud.userId;
  const lifetime = accountLifetime(owner);
  if (database !== db) return;
  // Pending drafts win only in the UI cache, never as server authority. Keep the
  // original expected values and IDs for CAS/reconciliation, including reload.
  await cloudTransaction(database, [database.table('preferences'), database.table('_cloudMeta')], async () => {
    if (!lifetime.current() || current !== generation || owner !== cloud.userId || database !== db) throw new Error('client_account_changed');
    markCloudApply();
    const pending = (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix));
    if (!pending.length) await database.table('_cloudMeta').delete('preferences-sync-error');
    const rows = Object.entries(value.values).filter(([id]) => keys.includes(id as typeof keys[number])).map(([id, value]) => ({ id, value }));
    lifetime.assertCurrent();
    await database.table('preferences').bulkPut(rows);
    lifetime.assertCurrent();
  });
  if (lifetime.current() && database === db && current === generation && owner === cloud.userId) await loadPreferences();
}

/** A direct system-file save is already committed; do not enqueue it as a second write. */
export async function applySystemAgentInstructions(text: string, database = db) {
  const lifetime = accountLifetime(cloud.userId);
  if (database !== db) throw new Error('client_account_changed');
  await cloudTransaction(database, [database.table('preferences')], async () => {
    lifetime.assertCurrent();
    if (database !== db) throw new Error('client_account_changed');
    markCloudApply();
    await database.table('preferences').put({ id: 'agentInstructions', value: text });
    lifetime.assertCurrent();
  });
  lifetime.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  applying = true;
  try { useSettings.setState({ agentInstructions: text }); } finally { applying = false; }
}

export async function loadPreferences() {
  const database = db, owner = cloud.userId, current = generation;
  const lifetime = accountLifetime(owner);
  const { rows, pending } = await database.transaction('r', database.table('preferences'), database.table('_cloudMeta'), async () => ({
    rows: await database.table('preferences').toArray(),
    pending: (await database.table('_cloudMeta').toArray()).filter(row => row.id.startsWith(prefix)).sort((a, b) => a.id.localeCompare(b.id)),
  }));
  if (!lifetime.current() || database !== db || owner !== cloud.userId || current !== generation) return;
  const values = Object.fromEntries(rows.filter(r => keys.includes(r.id)).map(r => [r.id, r.value]));
  // Pending preference intent is an explicit UI overlay, not committed storage.
  for (const row of pending) for (const change of (row.value as DurableCommand<PreferencesCommand>).request.changes) values[change.key] = change.value;
  // Settings edits precede their asynchronous journal transaction. Do not let a
  // projection in that small window roll a slider back before intent is saved.
  for (const [key, value] of localIntent) values[key] = value;
  if (!lifetime.current() || database !== db || owner !== cloud.userId || current !== generation) return;
  // 云偏好直接 setState，不经过 Settings.update 的输入校验。
  if (Object.hasOwn(values, 'uiLanguage')) values.uiLanguage = normalizeUiLanguage(values.uiLanguage);
  if (Object.hasOwn(values, 'userName')) values.userName = normalizeUserName(values.userName);
  if (Object.hasOwn(values, 'agentInstructions')) values.agentInstructions = normalizeAgentInstructions(values.agentInstructions);
  const state = useSettings.getState();
  for (const key of Object.keys(values)) if (JSON.stringify(values[key]) === JSON.stringify(state[key as keyof Settings])) delete values[key];
  if (!Object.keys(values).length) return;
  applying = true;
  try { useSettings.setState(values); } finally { applying = false; }
}

export async function startPreferences() {
  stopPreferences();
  const current = generation, owner = cloud.userId, database = db;
  const lifetime = accountLifetime(owner);
  detachLifetime = lifetime.own(stopPreferences);
  await loadPreferences();
  if (current !== generation) return;
  const runtime = await serverRuntime(owner);
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  const initial = await runtime.read({ kind: 'preferences' });
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  await applyProjection(initial.value as unknown as PreferencesProjection, database);
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  // 首次登录/旧账号尚无该字段时，把登录前的选择作为账号偏好；不是设备解析出的 locale。
  const language = await database.table('preferences').get('uiLanguage');
  if (current !== generation || owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) return;
  if (!language) await persistPreferences([{ id: 'uiLanguage', value: useSettings.getState().uiLanguage }], database, lifetime);
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
    for (const row of rows) localIntent.set(row.id, row.value);
    writing = writing.catch(() => {}).then(async () => {
      if (database !== db || cloud.userId !== owner || current !== generation) return;
      await persistPreferences(rows, database, lifetime);
      for (const row of rows) if (localIntent.get(row.id) === row.value) localIntent.delete(row.id);
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
  const lifetime = accountLifetime(cloud.userId);
  await writing;
  lifetime.assertCurrent();
  if (cloud.enabled) await drainPreferences();
}

async function drainPreferences() {
  const owner = cloud.userId, database = db;
  const lifetime = accountLifetime(owner);
  const drain = async () => {
    lifetime.assertCurrent();
    if (database !== db || cloud.userId !== owner) throw new Error('client_account_changed');
    await (await preferenceCommands()).drain();
  };
  if (navigator.locks) await navigator.locks.request(`preferences-sync:${owner}`, drain);
  else await drain();
}

export function stopPreferences() {
  generation++;
  detachLifetime?.(); detachLifetime = undefined;
  unsubscribe?.(); unsubscribe = undefined;
  stopProjection?.(); stopProjection = undefined;
  commands?.drain.dispose(); commands = undefined;
  // A hung write for the retired subscription must not block a new account.
  writing = Promise.resolve();
  localIntent.clear();
}

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
  await cloudTransaction(database, [database.table('_cloudMeta')], async () => {
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
    await cloudTransaction(database, [database.table('_cloudOutbox'), database.table('_cloudMeta')], async () => {
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
