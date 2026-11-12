import { create } from 'zustand';
import { db, useCloudDatabase } from '../store/db';
import { markCloudApply } from './cache';
import { cloud, cloudRequest } from './state';
import { CLOUD_TABLES, type CloudRecord, type CloudConfig } from '@wangke/contracts/cloud';
import { useSettings } from '../store/settings';
import { flushPreferences, loadPreferences, startPreferences, stopPreferences, migratePreferenceOutbox } from './preferences';
import { apiUrl } from '../api/base';
import { cloudTransaction, cloudRetry, isLostCloudTransaction } from './transactions';
import { reasoningProviderOf } from '@wangke/study-core/model/reasoning';
import Dexie from 'dexie';
import { serverRuntime, isCurrentServerRuntime, disposeServerRuntime } from '../client/bootstrap';
import type { ProjectionTable, RuntimeRecord, RuntimeRecordHead } from '@wangke/contracts/client-runtime';
import { migrateResourceOutbox } from '../client/resources';
import { drainLearning, type LearningCommandRow } from '../client/learning';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { startResourceCommands } from '../client/resource-commands';

/**
 * Sync is background maintenance and stays silent. `error` is reserved for
 * problems the user must act on (record conflict, broken local database).
 * Network/server hiccups only set `degradedSince` + `detail` while the loops
 * retry by themselves; the UI surfaces them only once they persist.
 * `healthySince` is when the connection last became usable (0 while degraded),
 * so "taking too long" thresholds measure time the client could actually confirm.
 */
export const useCloudSync = create<{ pending: number; error: string; syncedAt: number; recordsRevision: number;
  conversationsRevision: number; degradedSince: number; detail: string; healthySince: number;
  queued: number; uncertain: number; conflicts: number; oldestPendingAt: number; cursor: number; highWater: number; rebuildReason: string;
}>()(() => ({ pending: 0, error: '', syncedAt: 0, recordsRevision: 0, conversationsRevision: 0, degradedSince: 0, detail: '', healthySince: Date.now(),
  queued: 0, uncertain: 0, conflicts: 0, oldestPendingAt: 0, cursor: 0, highWater: 0, rebuildReason: '' }));
function actionableMessage(error: unknown) {
  const detail = (error as { detail?: { table?: string; key?: unknown } }).detail;
  if ((error as Error)?.message === 'sync_conflict') return `同步冲突：${detail?.table}/${String(detail?.key)}。本机修改已保留，请在云端管理中处理。`;
  if (isLostCloudTransaction(error)) return '浏览器本地数据库连接异常，同步正在自动恢复，无需任何操作，请不要清除网站数据。';
  return '';
}
// Which loop raised the current `error`, so the other loop's success does not hide it.
let errorSource: 'flush' | 'follow' | '' = '';
function reportSyncFailure(error: unknown, source: 'flush' | 'follow') {
  if ((error as Error)?.message === 'client_account_changed') return;
  const actionable = actionableMessage(error), detail = error instanceof Error ? error.message : String(error);
  if (actionable) { errorSource = source; useCloudSync.setState({ error: actionable, detail }); }
  else useCloudSync.setState(state => ({ degradedSince: state.degradedSince || Date.now(), healthySince: 0, detail }));
}
function reportSyncHealthy(source: 'flush' | 'follow') {
  const clearError = source === 'flush' || errorSource === source;
  if (clearError) errorSource = '';
  useCloudSync.setState(state => ({ degradedSince: 0, detail: '', healthySince: navigator.onLine ? state.healthySince || Date.now() : 0, ...(clearError && state.error ? { error: '' } : {}) }));
}
let stopChanges: (() => void) | undefined;
let retryRecords: (() => void) | undefined;
let flight: Promise<boolean> | undefined;
let repeatFlight = false;
let syncPhase: { name: string; since: number } = { name: 'idle', since: Date.now() };
const phase = (name: string) => { syncPhase = { name, since: Date.now() }; };
export const cloudSyncDiagnostics = () => {
  const { pending, queued, uncertain, conflicts, oldestPendingAt, cursor, highWater, rebuildReason } = useCloudSync.getState();
  return { phase: syncPhase.name, phaseAgeMs: Date.now() - syncPhase.since, flight: !!flight,
    pending, queued, uncertain, conflicts, oldestPendingAgeMs: oldestPendingAt ? Date.now() - oldestPendingAt : 0,
    cursor, highWater, revisionDistance: Math.max(0, highWater - cursor), rebuildReason };
};
async function publishCommandDiagnostics(database = db) {
  const lifetime = accountLifetime(cloud.userId);
  const rows = await cloudRetry(database, () => database.table<LearningCommandRow>('_learningCommands').toArray());
  if (database !== db || !lifetime.current()) return;
  useCloudSync.setState({ pending: rows.length, queued: rows.filter(row => row.state === 'queued').length,
    uncertain: rows.filter(row => row.state === 'uncertain').length, conflicts: rows.filter(row => row.state === 'conflict').length,
    oldestPendingAt: rows.length ? Math.min(...rows.map(row => row.createdAt)) : 0 });
}
let configSignature = '';
let configCheckedAt = 0;

export function applyCloudConfig(config: CloudConfig) {
  configSignature = JSON.stringify(config);
  configCheckedAt = Date.now();
  useSettings.setState({
    providers: config.providers.map(p => ({ id: p.id, name: p.name, catalogId: p.catalogId, protocol: p.protocol, serves: p.serves,
      deploymentProtocols: Object.fromEntries((p.deployments ?? []).map(d => [d.model, d.protocol])),
      reasoningProvider: reasoningProviderOf(p),
      deploymentReasoningProviders: Object.fromEntries((p.deployments ?? []).map(d => [d.model, reasoningProviderOf({ baseUrl: d.baseUrl ?? p.baseUrl, catalogId: p.catalogId })])),
      stateScope: config.modelRevision ? `configuration:${config.modelRevision}` : undefined,
      baseUrl: apiUrl(`/api/v1/cloud/model-gateway/providers/${encodeURIComponent(p.id)}`), apiKey: p.configured ? 'server-managed' : 'server-local', gatewayManaged: true })),
    llmModel: config.llmModel, visionModel: config.visionModel, asrModel: config.asrModel,
    ...decisionPatch(config),
    syncEnabled: false,
  });
}

/**
 * 决策模型只认服务器配置：旧本机安装留下的决策凭据不能绕过服务器。
 * 选了决策模型也不会自动打开技能路由 / 上下文压缩，仍需用户在设置里单独开启。
 */
function decisionPatch(config: CloudConfig) {
  const ref = config.decisionModel;
  const state = useSettings.getState();
  if (!ref?.model || !config.providers.some(p => p.id === ref.providerId)) {
    return { jev: { skillRouting: false, contextCompression: false }, decisionModel: { providerId: '', model: '' } };
  }
  const saved = state.savedModels ?? [];
  const known = saved.some(m => m.providerId === ref.providerId && m.model === ref.model && m.slots.includes('decision'));
  return {
    decisionModel: { providerId: ref.providerId, model: ref.model },
    ...(known ? {} : { savedModels: [...saved, { ...ref, name: '', slots: ['decision' as const], modelType: 'decision', toolCalling: false, decisionProtocol: 'typesafe-systemone' as const }] }),
  };
}

const recordMetaId = (record: CloudRecord) => `revision:${record.table}:${JSON.stringify(record.key)}`;
const projectionTables = (database: typeof db) => [...Object.keys(CLOUD_TABLES), '_cloudMeta', '_learningCommands', '_projectionStage'].map(name => database.table(name));

/** Generations are incomparable. Discard only reproducible projections, never
 * journals, originals, preferences or task admission/recovery evidence. */
async function acceptRecordEpoch(database: typeof db, epoch: string, guard: () => void, expected?: { epoch: unknown }) {
  guard();
  await cloudTransaction(database, projectionTables(database), async () => {
    guard();
    const meta = database.table('_cloudMeta');
    const previous = (await meta.get('records-epoch'))?.value;
    if (previous === epoch) return;
    if (expected && previous !== expected.epoch) throw new Error('records_generation_changed');
    markCloudApply();
    for (const name of Object.keys(CLOUD_TABLES)) if (name !== 'preferences') await database.table(name).clear();
    await meta.where('id').startsWith('revision:').delete();
    await meta.delete('cursor');
    await database.table('_projectionStage').clear();
    await meta.put({ id: 'records-epoch', value: epoch });
    guard();
  });
}

async function readHead(runtime: Awaited<ReturnType<typeof serverRuntime>>, database: typeof db, guard: () => void) {
  const before = (await database.table('_cloudMeta').get('records-epoch'))?.value;
  const head = (await runtime.read({ kind: 'recordHead' })).value as unknown as RuntimeRecordHead;
  guard();
  if (typeof head.epoch !== 'string' || !Number.isSafeInteger(head.version)) throw new Error('protocol_record_head');
  const now = (await database.table('_cloudMeta').get('records-epoch'))?.value;
  if (now !== before && now !== head.epoch) throw new Error('records_generation_changed');
  await acceptRecordEpoch(database, head.epoch, guard, { epoch: before });
  return head;
}

/** Explicit task/view fallback. Only a named parent collection is replaced;
 * absent pages, quota or version errors leave its previous projection intact. */
export async function refreshRecordScope(table: ProjectionTable, parent: string | number) {
  const fields: Partial<Record<ProjectionTable, string>> = { cards: 'videoId', comments: 'videoId', danmakus: 'videoId',
    segments: 'videoId', subtitleTracks: 'videoId', frames: 'videoId', handouts: 'videoId', materialBlocks: 'materialId', materialInk: 'materialId', chats: 'sessionId', skillRefs: 'skillId' };
  const field = fields[table];
  if (!field) throw new Error('unsupported_record_scope');
  const database = db, owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => { lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  const head = await readHead(runtime, database, guard);
  const { readCollection } = await import('../client/collections');
  const snapshot = await readCollection(runtime, table, parent, guard);
  if (snapshot.epoch !== head.epoch) throw new Error('records_generation_changed');
  const keys = new Set(snapshot.records.map(row => JSON.stringify(row.key)));
  const obsolete = (await database.table(table).where(field).equals(parent).primaryKeys()).filter(key => !keys.has(JSON.stringify(key)));
  if (obsolete.length > 20000) throw new Error('collection_snapshot_budget_exceeded');
  const missing: RuntimeRecord[] = [];
  for (let offset = 0; offset < obsolete.length; offset += 100) {
    const batch = obsolete.slice(offset, offset + 100) as (string | number)[];
    const result = (await runtime.read({ kind: 'recordKeys', keys: batch.map(key => ({ table, key })) })).value as unknown as { records: RuntimeRecord[]; epoch: string };
    guard();
    if (result.epoch !== head.epoch || result.records.length !== batch.length || result.records.some((row, index) => row.table !== table || row.key !== batch[index])) throw new Error('invalid_collection_projection');
    missing.push(...result.records);
  }
  await cloudTransaction(database, [database.table(table), database.table('_cloudMeta')], async () => {
    guard();
    const metadata = database.table('_cloudMeta');
    if ((await metadata.get('records-epoch'))?.value !== snapshot.epoch) throw new Error('records_generation_changed');
    // A late scope read cannot delete/overwrite a newer exact receipt publish.
    const known = await metadata.bulkGet(snapshot.records.map(recordMetaId));
    if (known.some((row, index) => row?.value > snapshot.records[index].revision)) throw new Error('collection_snapshot_changed');
    markCloudApply();
    await putRecords(database, [...snapshot.records, ...missing], true); guard();
  });
}

/** File references stay in the projection. Image/document consumers fetch bytes
 * only when visible or explicitly opened, never while holding a sync lock. */
async function putRecords(database: typeof db, records: CloudRecord[], checkVersions: boolean) {
  const metadata = database.table('_cloudMeta');
  const known = checkVersions ? await metadata.bulkGet(records.map(recordMetaId)) : [];
  const groups = new Map<string, { puts: Record<string, unknown>[]; deletes: (string | number)[] }>();
  const versions: { id: string; value: number }[] = [];
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!Object.hasOwn(CLOUD_TABLES, record.table)) throw new Error('服务器返回了未知数据表');
    if (record.table === 'preferences' || record.revision < (known[index]?.value ?? 0)) continue;
    let group = groups.get(record.table);
    if (!group) { group = { puts: [], deletes: [] }; groups.set(record.table, group); }
    if (record.value === null) group.deletes.push(record.key);
    else group.puts.push(record.value);
    versions.push({ id: recordMetaId(record), value: record.revision });
  }
  for (const [name, group] of groups) {
    if (group.deletes.length) await database.table(name).bulkDelete(group.deletes);
    if (group.puts.length) await database.table(name).bulkPut(group.puts);
  }
  if (versions.length) await metadata.bulkPut(versions);
}

/** Hydrate only explicit keys atomically; never advance a stream cursor or treat
 * an unrequested/missing local row as an authoritative server deletion. */
export async function readRecordKeys<T>(table: ProjectionTable, keys: (string | number)[]): Promise<(T | undefined)[]> {
  if (!keys.length) return [];
  const database = db, owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  };
  guard();
  const unique = [...new Set(keys)];
  const head = await readHead(runtime, database, guard);
  const prior = await database.table('_cloudMeta').bulkGet(unique.map(key => `revision:${table}:${JSON.stringify(key)}`));
  const records: RuntimeRecord[] = [];
  for (let index = 0; index < unique.length; index += 100) {
    const batch = unique.slice(index, index + 100);
    const response = await runtime.read({ kind: 'recordKeys', keys: batch.map(key => ({ table, key })) });
    guard();
    const page = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
    if (page.epoch !== head.epoch) throw new Error('records_generation_changed');
    if (page.records.length !== batch.length || page.records.some((row, offset) => row.table !== table || row.key !== batch[offset])) throw new Error('protocol_record_keys');
    records.push(...page.records);
  }
  const absent = records.filter(record => record.value === null && record.revision === 0);
  if (absent.length) {
    const verified = (await runtime.read({ kind: 'recordHead' })).value as unknown as RuntimeRecordHead;
    guard();
    if (verified.epoch !== head.epoch || verified.version !== head.version) throw new Error('collection_snapshot_changed');
  }
  return cloudTransaction(database, [database.table(table), database.table('_cloudMeta')], async () => {
    guard();
    const epoch = (await database.table('_cloudMeta').get('records-epoch'))?.value;
    if (epoch !== head.epoch) throw new Error('records_generation_changed');
    markCloudApply();
    await putRecords(database, records, true);
    // Physical absence has revision zero, unlike a durable tombstone. It is
    // authoritative only behind the unchanged-head barrier and if no newer
    // point publisher changed this key since capture.
    for (const record of absent) {
      const id = recordMetaId(record), index = unique.indexOf(record.key);
      const known = (await database.table('_cloudMeta').get(id))?.value;
      if (known !== (prior[index]?.value ?? (known === 0 ? 0 : undefined))) throw new Error('collection_snapshot_changed');
      await database.table(table).delete(record.key);
      await database.table('_cloudMeta').put({ id, value: 0 });
    }
    guard();
    // Return the accepted projection, not an older HTTP value superseded by WS.
    return database.table<T>(table).bulkGet(keys);
  });
}

/**
 * Reconcile exactly the record versions a completed task touched (its terminal
 * `effects` receipt) — never advance the account cursor, never pull unrelated
 * tables. Admission epoch evidence is mandatory; a generation race returns
 * false so callers explicitly refresh the task's bounded named scope.
 */
export async function reconcileTaskEffects(effects: { table: string; key: string | number; revision: number }[], expectedEpoch?: string): Promise<boolean> {
  if (!effects.length) return true;
  const database = db, owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  };
  guard();
  const head = await readHead(runtime, database, guard);
  if (!expectedEpoch || head.epoch !== expectedEpoch) throw new Error('task_effects_generation_unproven');
  const unique = new Map(effects.map(effect => [JSON.stringify([effect.table, effect.key]), effect]));
  const versions = [...unique.values()], records: RuntimeRecord[] = [];
  let epoch: string | undefined;
  for (let index = 0; index < versions.length; index += 100) {
    const keys = versions.slice(index, index + 100).map(({ table, key }) => ({ table: table as ProjectionTable, key }));
    const response = await runtime.read({ kind: 'recordKeys', keys }); guard();
    const value = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
    if (value.epoch !== expectedEpoch || (epoch !== undefined && value.epoch !== epoch)) throw new Error('records_generation_changed');
    epoch = value.epoch;
    if (value.records.length !== keys.length) throw new Error('protocol_task_effects_projection');
    for (let offset = 0; offset < keys.length; offset++) {
      const row = value.records[offset], key = keys[offset];
      if (row.table !== key.table || row.key !== key.key || row.revision < versions[index + offset].revision) throw new Error('task_effects_projection_unavailable');
      records.push(row);
    }
  }
  guard();
  return cloudTransaction(database, [...new Set(records.map(row => row.table)), '_cloudMeta'].map(name => database.table(name)), async () => {
    guard(); markCloudApply();
    const localEpoch = (await database.table('_cloudMeta').get('records-epoch'))?.value;
    if (localEpoch !== expectedEpoch) return false;
    await putRecords(database, records, true);
    guard();
    return true;
  });
}

/** Confirm only receipt keys, never advance the account/collection cursor.
 * Journals and attachment originals survive every failed or stale point read. */
export async function reconcileLearningProjection(command: LearningCommandRow) {
  if (command.state !== 'confirmed' || !command.receipt) return false;
  const database = db, owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  };
  guard();
  const head = await readHead(runtime, database, guard);
  // Historic receipts without an epoch cannot prove what generation their
  // revisions belong to. Preserve their full user intent for recovery.
  if (!command.receipt.epoch || command.receipt.epoch !== head.epoch) {
    await database.table<LearningCommandRow>('_learningCommands').where('operationId').equals(command.operationId)
      .modify({ state: 'conflict', error: 'learning_receipt_generation_unproven' });
    guard(); return false;
  }
  const unique = new Map(command.receipt.versions.map(version => [JSON.stringify([version.table, version.key]), version]));
  const versions = [...unique.values()], records: RuntimeRecord[] = [];
  let epoch: string | undefined;
  for (let index = 0; index < versions.length; index += 100) {
    const keys = versions.slice(index, index + 100).map(({ table, key }) => ({ table: table as ProjectionTable, key }));
    const response = await runtime.read({ kind: 'recordKeys', keys }); guard();
    const value = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
    if (value.epoch !== command.receipt.epoch || (epoch !== undefined && value.epoch !== epoch)) throw new Error('records_generation_changed');
    epoch = value.epoch;
    if (value.records.length !== keys.length) throw new Error('protocol_receipt_projection');
    for (let offset = 0; offset < keys.length; offset++) {
      const row = value.records[offset], key = keys[offset];
      if (row.table !== key.table || row.key !== key.key || row.revision < versions[index + offset].revision) throw new Error('learning_receipt_projection_unavailable');
      records.push(row);
    }
  }
  guard();
  return cloudTransaction(database, [...new Set(records.map(row => row.table)), '_cloudMeta', '_learningCommands'].map(name => database.table(name)), async () => {
    guard(); markCloudApply();
    // Generations are not comparable. A changed head cannot authorize retiring
    // this receipt; its complete journal remains recoverable.
    const localEpoch = (await database.table('_cloudMeta').get('records-epoch'))?.value;
    if (localEpoch !== command.receipt!.epoch) return false;
    await putRecords(database, records, true);
    guard();
    await database.table('_cloudMeta').put({ id: `learning-completed:${command.operationId}`, value: {
      receipt: command.receipt, inputDigest: command.inputDigest, confirmedAt: Date.now(),
    } });
    await database.table('_learningCommands').where('operationId').equals(command.operationId).delete();
    return true;
  });
}

async function syncCycle(lifetime: AccountLifetime) {
  lifetime.assertCurrent();
  phase('cycle:begin');
  const database = db;
  const owner = cloud.userId;
  const runtime = await serverRuntime(owner);
  const guard = () => { lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  guard();
  if (Date.now() - configCheckedAt > 15000) {
    const config = await cloudRequest<CloudConfig>('/config', { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) });
    guard();
    configCheckedAt = Date.now();
    if (JSON.stringify(config) !== configSignature) applyCloudConfig(config);
  }
  await readHead(runtime, database, guard);
  await drainLearning();
  guard();
  useCloudSync.setState({ syncedAt: Date.now() });
  reportSyncHealthy('flush');
  await publishCommandDiagnostics(database);
  guard();
}

export function flushCloud(background = false): Promise<void> {
  if (!cloud.enabled) return Promise.resolve();
  const lifetime = accountLifetime(cloud.userId);
  if (flight) {
    repeatFlight = true;
    return flight.then(async completed => {
    lifetime.assertCurrent();
    // An explicit caller joining skipped maintenance still needs a durable
    // drain and head validation, even when there are no local edits to push.
    if (!background && !completed) await flushCloud();
    });
  }
  if (!flight) {
    repeatFlight = false;
    const database = db;
    const owner = cloud.userId;
    const attempt = (async () => {
    const drain = async () => {
      do {
      lifetime.assertCurrent();
      repeatFlight = false;
      phase('drain:preferences');
      // A preference conflict is local to its draft, never a global feed gate.
      await cloudRetry(database, () => flushPreferences()).catch(() => {});
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
       await cloudRetry(database, () => drainLearning());
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
       await cloudRetry(database, () => syncCycle(lifetime));
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
      lifetime.assertCurrent();
      } while (repeatFlight);
    };
    phase('lock:waiting');
    if (navigator.locks) return navigator.locks.request(`cloud-sync:${cloud.userId}`, { ifAvailable: background }, async lock => {
      // Periodic cache maintenance must not build a queue ahead of a new tab's
       // initial head validation or an explicit durable-write flush.
      if (!lock) return false;
      await drain();
      return true;
    });
    await drain();
    return true;
  })().catch(error => {
    if (lifetime.current() && database === db && owner === cloud.userId) reportSyncFailure(error, 'flush');
    throw error;
  }).finally(() => { if (flight === attempt) { flight = undefined; phase('idle'); } });
    flight = attempt;
  }
  return flight.then(() => { lifetime.assertCurrent(); if (!background) retryRecords?.(); });
}

export async function resolveCloudConflict() {
  const lifetime = accountLifetime(cloud.userId), database = db;
  const resolve = () => resolveConflictLocked(database, lifetime);
  if (navigator.locks) return navigator.locks.request(`cloud-sync:${lifetime.account}`, resolve);
  return resolve();
}
async function resolveConflictLocked(database: typeof db, lifetime: AccountLifetime) {
  lifetime.assertCurrent();
  const rows = await cloudRetry(database, () => database.table('_learningCommands').toArray());
  if (!rows.length) return;
  const encoded = await (await import('./recovery-export')).encodeRecoveryValue(rows);
  lifetime.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  const url = URL.createObjectURL(new Blob([JSON.stringify(encoded, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `wangke-conflict-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export interface StartCloudOptions {
  /**
   * Return after local database/account setup. Configuration, preferences,
   * durable journal drain and the scalar record head retry in the background.
   * Views independently request their authoritative scopes; no account body
   * baseline is downloaded in either mode. Default waits for these small
   * remote startup stages, useful for diagnostics and integration tests.
   */
  background?: boolean;
}

export async function startCloud(owner: string, options: StartCloudOptions = {}) {
  disposeServerRuntime();
  flight = undefined;
  cloud.enabled = true; cloud.userId = owner;
  useCloudSync.setState({ ...useCloudSync.getInitialState(), healthySince: Date.now() });
  errorSource = '';
  useCloudDatabase(owner);
  const lifetime = accountLifetime(owner);
  lifetime.own(() => {
    stopPreferences();
    stopChanges?.(); stopChanges = undefined;
    retryRecords = undefined; flight = undefined;
     repeatFlight = false;
    configSignature = ''; configCheckedAt = 0;
  });
  const databaseAtStart = db;
  const guard = () => { lifetime.assertCurrent(); if (databaseAtStart !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  await databaseAtStart.open(); guard();
  await cloudRetry(databaseAtStart, () => migrateResourceOutbox()); guard(); await cloudRetry(databaseAtStart, () => migratePreferenceOutbox()); guard();
  useSettings.persist.setOptions({ name: `wangke-cloud-settings-${owner}` });
  // 登录前的语言不随模型配置重置；有账号语言偏好时，后续 loadPreferences 再覆盖。
  const uiLanguage = useSettings.getState().uiLanguage;
  useSettings.setState({ ...useSettings.getInitialState(), uiLanguage });
  await loadPreferences(); guard();
  // 本地阶段到此完成。远端阶段（config / 偏好 / 标量失效订阅）要么在后台跑，
  // 要么按调用方要求等它跑完。
  const remote = cloudRemotePhase(owner, lifetime, databaseAtStart, guard, !!options.background);
  if (options.background) {
    remote.catch(error => {
      if (lifetime.current()) reportSyncFailure(error, 'flush');
    });
    return;
  }
  await remote;
}

/** Recovery is installed before the first lightweight startup request. */
async function retryCloudStartup<T>(operation: () => Promise<T>, lifetime: AccountLifetime, guard: () => void): Promise<T> {
  let attempt = 0;
  for (;;) {
    guard();
    try { return await operation(); }
    catch (error) {
      guard();
      reportSyncFailure(error, 'flush');
      const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5)) * (0.8 + Math.random() * 0.4);
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); window.removeEventListener('online', wake); lifetime.signal.removeEventListener('abort', wake); resolve(); };
        const timer = setTimeout(wake, delay);
        window.addEventListener('online', wake, { once: true });
        lifetime.signal.addEventListener('abort', wake, { once: true });
        if (lifetime.signal.aborted) wake();
      });
    }
  }
}

async function cloudRemotePhase(
  owner: string,
  lifetime: AccountLifetime,
  databaseAtStart: typeof db,
  guard: () => void,
  background: boolean,
) {
  const recover = <T>(operation: () => Promise<T>) => background ? retryCloudStartup(operation, lifetime, guard) : operation();
  const config = await recover(() => cloudRequest<CloudConfig>('/config', { signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]) }));
  guard();
  applyCloudConfig(config);
  // Settings are independent of the bulk records projection.
  const preferences = recover(() => startPreferences());
  const durableDrain = recover(async () => {
    try { await flushCloud(); }
    catch (error) {
      // Existing local edits must remain reachable through conflict recovery after reload.
      guard();
      if (!(await cloudRetry(databaseAtStart, () => databaseAtStart.table('_learningCommands').count()))) throw error;
    }
  });
  // Retry only the failed stage: a records outage must not tear down successful
  // preference subscriptions or abandon an in-flight local preference write.
  const results = await Promise.allSettled([preferences, durableDrain]);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  guard();
  startResourceCommands();
  const database = databaseAtStart;
  guard();
  let closed = false;
  let lastLearningWake = 0;
  let follow: { dispose(): void; restart(): void } | undefined;
  // Dexie's committed mutation notification crosses tabs; no polling of either
  // IndexedDB or HTTP. Reads alone never generate another wakeup.
  const changed = (parts: Record<string, unknown>) => {
    if (closed || !lifetime.current() || !Object.keys(parts).some(key => key.startsWith(`idb://${database.name}/`))) return;
    void database.table<LearningCommandRow>('_learningCommands').orderBy('sequence').last().then(row => {
      // An actual committed edit is a durable write, not idle maintenance. It
      // waits once for the lock (coalesced by flight), otherwise a skipped wake
      // could strand the only local edit forever after removing the timer.
      if (!closed && lifetime.current() && row?.state === 'queued' && row.sequence! > lastLearningWake) {
        lastLearningWake = row.sequence!;
        void flushCloud().catch(() => {});
      }
    }).catch(() => { /* A disposed database cannot wake another generation. */ });
  };
  Dexie.on('storagemutated', changed);
  const online = () => { if (lifetime.current()) void flushCloud().then(() => { if (lifetime.current()) follow?.restart(); }).catch(() => {}); };
  // Maintain healthySince: 0 while offline/degraded, the recovery time otherwise.
  const health = () => {
    if (closed || !lifetime.current()) return;
    const { degradedSince, healthySince } = useCloudSync.getState(), healthy = navigator.onLine && !degradedSince;
    if (healthy && !healthySince) useCloudSync.setState({ healthySince: Date.now() });
    else if (!healthy && healthySince) useCloudSync.setState({ healthySince: 0 });
  };
  const offHealth = useCloudSync.subscribe((state, previous) => { if (state.degradedSince !== previous.degradedSince) health(); });
  window.addEventListener('online', online);
  window.addEventListener('online', health);
  window.addEventListener('offline', health);
  health();
  stopChanges = () => { closed = true; follow?.dispose(); retryRecords = undefined; Dexie.on('storagemutated').unsubscribe(changed); window.removeEventListener('online', online);
    window.removeEventListener('online', health); window.removeEventListener('offline', health); offHealth(); };
  {
    const runtime = await recover(() => serverRuntime(owner));
    guard(); if (closed) return;
    const model = runtime.recordHead();
    let headWork = Promise.resolve(), last = '';
    const observe = () => {
      const snapshot = model.getSnapshot();
      if (closed || !lifetime.current()) return;
      if (snapshot.status === 'error') { reportSyncFailure(new Error(snapshot.error), 'follow'); return; }
      if (snapshot.status !== 'ready' || !snapshot.data) return;
      const head = snapshot.data as unknown as RuntimeRecordHead;
      const signature = JSON.stringify(head);
      if (signature === last) return;
      last = signature;
      // This is an invalidation identity, NOT a cursor. No record body or
      // inferred table range is published and no global feed is filtered.
      headWork = headWork.then(async () => {
        guard(); if (closed) return;
        if (JSON.stringify(model.getSnapshot().data) !== signature) return;
        await acceptRecordEpoch(database, head.epoch, () => {
          guard();
          if ((model.getSnapshot().data as unknown as RuntimeRecordHead | undefined)?.epoch !== head.epoch) throw new Error('records_generation_changed');
        });
        guard();
        useCloudSync.setState(state => ({ recordsRevision: state.recordsRevision + 1, conversationsRevision: state.conversationsRevision + 1, syncedAt: Date.now() }));
        reportSyncHealthy('follow');
      }).catch(error => { last = ''; if (!closed && lifetime.current()) reportSyncFailure(error, 'follow'); });
    };
    const unsubscribe = model.subscribe(observe), release = model.acquire();
    follow = { dispose: () => { unsubscribe(); release(); }, restart: () => model.refresh() };
    observe();
    retryRecords = follow.restart;
    const { reconcileTaskAdmissions } = await import('./tasks');
    guard();
    // Admission uncertainty has its own persisted command UI. Do not overwrite
    // a records conflict with a transient command warning that survives retry.
    void reconcileTaskAdmissions().catch(error => { if (lifetime.current()) reportSyncFailure(error, 'follow'); });
  }
}

export function stopCloud() {
  disposeServerRuntime();
  stopChanges?.(); stopChanges = undefined;
  // Re-enter through the auth gate on a fresh JS realm: no parked conversations or model
  // settings from a previous identity remain visible after logout/session expiry.
  window.location.reload();
}

/** Discard this browser's cloud cache after a server-side account reset. */
export async function clearCloudLocalData() {
  const database = db;
  disposeServerRuntime();
  stopChanges?.(); stopChanges = undefined;
  flight = undefined;
  configSignature = '';
  configCheckedAt = 0;
  const owner = cloud.userId;
  cloud.enabled = false;
  cloud.userId = '';
  useSettings.persist.setOptions({ name: 'wangke-settings' });
  if (owner) localStorage.removeItem(`wangke-cloud-settings-${owner}`);
  useSettings.setState(useSettings.getInitialState());
  await useSettings.persist.clearStorage();
  // Only confirmed projections are disposable. Keep command journals, drafts,
  // upload bytes and recovery evidence even after a server-side account reset.
  if (database !== db) throw new Error('client_account_changed');
  await cloudTransaction(database, database.tables, async () => {
    markCloudApply();
    for (const name of Object.keys(CLOUD_TABLES)) await database.table(name).clear();
    await database.table('_projectionStage').clear();
    await database.table('_fileCache').clear();
    await database.table('_fileCacheMeta').clear();
    await database.table('_cloudMeta').where('id').startsWith('revision:').delete();
    await database.table('_cloudMeta').bulkDelete(['cursor', 'records-epoch']);
  });
}
