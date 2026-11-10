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
import type { ProjectionTable, RuntimeRecord, RuntimeRecordsPage } from '@wangke/contracts/client-runtime';
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
let fullPullRequested = false;
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

async function applyRecordsPage(page: RuntimeRecordsPage, signal: AbortSignal | undefined, database: typeof db, lifetime: AccountLifetime) {
  lifetime.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  const owner = cloud.userId;
  signal?.throwIfAborted();
  return cloudTransaction(database, projectionTables(database), async () => {
    markCloudApply();
    lifetime.assertCurrent();
    signal?.throwIfAborted();
    if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
    const cursor = (await database.table('_cloudMeta').get('cursor'))?.value ?? 0;
    if (page.cursor <= cursor) return true;
    // A late stream page cannot roll back a just-acknowledged local command.
    await putRecords(database, page.records, true);
    await database.table('_cloudMeta').put({ id: 'cursor', value: page.cursor });
    await retireConfirmedCommands(database);
    lifetime.assertCurrent();
    return true;
  });
}

async function retireConfirmedCommands(database = db) {
  for (const command of await database.table<LearningCommandRow>('_learningCommands').toArray()) {
    if (command.state !== 'confirmed' || !command.receipt) continue;
    let present = true;
    for (const version of command.receipt.versions) {
      const known = (await database.table('_cloudMeta').get(`revision:${version.table}:${JSON.stringify(version.key)}`))?.value ?? 0;
      if (known < version.revision) present = false;
    }
    if (present) {
      await database.table('_cloudMeta').put({ id: `learning-completed:${command.operationId}`, value: { receipt: command.receipt, inputDigest: command.inputDigest, confirmedAt: Date.now() } });
      await database.table('_learningCommands').delete(command.sequence!);
    }
  }
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
  const response = await runtime.read({ kind: 'recordKeys', keys: unique.map(key => ({ table, key })) });
  guard();
  const page = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
  if (page.records.length !== unique.length || page.records.some((row, index) => row.table !== table || row.key !== unique[index])) throw new Error('protocol_record_keys');
  return cloudTransaction(database, [database.table(table), database.table('_cloudMeta')], async () => {
    guard();
    const epoch = (await database.table('_cloudMeta').get('records-epoch'))?.value;
    if (epoch && epoch !== page.epoch) throw new Error('records_generation_changed');
    markCloudApply();
    await putRecords(database, page.records, true);
    guard();
    // Return the accepted projection, not an older HTTP value superseded by WS.
    return database.table<T>(table).bulkGet(keys);
  });
}

/**
 * Reconcile exactly the record versions a completed task touched (its terminal
 * `effects` receipt) — never advance the account cursor, never pull unrelated
 * tables. Returns false when the server generation changed mid-read: during
 * this rollout the legacy mirror still owns generation switches, so the
 * caller falls back to a full sync instead of mixing epochs.
 */
export async function reconcileTaskEffects(effects: { table: string; key: string | number; revision: number }[]): Promise<boolean> {
  if (!effects.length) return true;
  const database = db, owner = cloud.userId, lifetime = accountLifetime(owner);
  const runtime = await serverRuntime(owner);
  const guard = () => {
    lifetime.assertCurrent();
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  };
  guard();
  const unique = new Map(effects.map(effect => [JSON.stringify([effect.table, effect.key]), effect]));
  const versions = [...unique.values()], records: RuntimeRecord[] = [];
  let epoch: string | undefined;
  for (let index = 0; index < versions.length; index += 100) {
    const keys = versions.slice(index, index + 100).map(({ table, key }) => ({ table: table as ProjectionTable, key }));
    const response = await runtime.read({ kind: 'recordKeys', keys }); guard();
    const value = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
    if (epoch !== undefined && value.epoch !== epoch) throw new Error('records_generation_changed');
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
    if (localEpoch && epoch && localEpoch !== epoch) return false;
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
  const unique = new Map(command.receipt.versions.map(version => [JSON.stringify([version.table, version.key]), version]));
  const versions = [...unique.values()], records: RuntimeRecord[] = [];
  let epoch: string | undefined;
  for (let index = 0; index < versions.length; index += 100) {
    const keys = versions.slice(index, index + 100).map(({ table, key }) => ({ table: table as ProjectionTable, key }));
    const response = await runtime.read({ kind: 'recordKeys', keys }); guard();
    const value = response.value as unknown as { records: RuntimeRecord[]; epoch: string };
    if (epoch !== undefined && value.epoch !== epoch) throw new Error('records_generation_changed');
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
    // Generations are not comparable. During this intermediate rollout the
    // legacy mirror still owns generation changes; don't corrupt it with a
    // different epoch's point read. The confirmed journal remains recoverable.
    const localEpoch = (await database.table('_cloudMeta').get('records-epoch'))?.value;
    if (localEpoch && epoch && localEpoch !== epoch) return false;
    await putRecords(database, records, true);
    guard();
    await database.table('_cloudMeta').put({ id: `learning-completed:${command.operationId}`, value: {
      receipt: command.receipt, inputDigest: command.inputDigest, confirmedAt: Date.now(),
    } });
    await database.table('_learningCommands').where('operationId').equals(command.operationId).delete();
    return true;
  });
}

/** Build separately while the previous committed view remains readable, then
 * publish all business rows/revisions/cursor in one IDB commit. Journals survive. */
async function rebuildRecords(database: typeof db, runtime: Awaited<ReturnType<typeof serverRuntime>>, reason: string, lifetime: AccountLifetime, firstPage?: RuntimeRecordsPage) {
  const owner = cloud.userId;
  const guard = () => { lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
  const stage = database.table('_projectionStage');
  guard(); useCloudSync.setState({ rebuildReason: reason });
  await cloudTransaction(database, [stage], async () => { guard(); await stage.clear(); guard(); });
  let cursor = 0, epoch = '', highWater = 0;
  for (;;) {
    const page = firstPage ?? await runtime.recordsPage(cursor); firstPage = undefined; guard();
    if (epoch && epoch !== page.epoch) throw new Error('records_generation_changed');
    epoch = page.epoch;
    highWater = page.highWater;
    const records: { id: string; record: CloudRecord }[] = [];
    for (const record of page.records) records.push({ id: `${record.table}:${JSON.stringify(record.key)}`, record });
    guard();
    await cloudTransaction(database, [stage], async () => { guard(); await stage.bulkPut(records); guard(); });
    cursor = page.cursor;
    if (!page.more) break;
  }
  await cloudTransaction(database, projectionTables(database), async () => {
    guard(); markCloudApply();
    for (const name of Object.keys(CLOUD_TABLES)) if (name !== 'preferences') await database.table(name).clear();
    const metadata = database.table('_cloudMeta');
    await metadata.where('id').startsWith('revision:').delete();
    // Keep atomic publication, but don't materialize the entire account staging
    // table as one JS array. Only one 200-record batch lives in this reducer.
    let lastStageId: string | undefined;
    for (;;) {
      const rows = await (lastStageId === undefined ? stage.orderBy('id') : stage.where('id').above(lastStageId)).limit(200).toArray();
      if (!rows.length) break;
      await putRecords(database, rows.map(row => row.record), false);
      lastStageId = rows.at(-1)!.id;
    }
    await metadata.bulkPut([{ id: 'cursor', value: cursor }, { id: 'records-epoch', value: epoch }]);
    await stage.clear(); await retireConfirmedCommands(database);
    guard();
  });
  guard(); useCloudSync.setState({ cursor, highWater });
}

async function syncCycle(pull: boolean, lifetime: AccountLifetime) {
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
  let changed = false;
  let conversationsChanged = false;
  await drainLearning();
  guard();
  const commands = database.table('_learningCommands');
  if (!pull) { const pending = await commands.count(); guard(); useCloudSync.setState({ pending }); return; }
  let cursor = (await database.table('_cloudMeta').get('cursor'))?.value ?? 0;
  for (;;) {
    phase('cycle:read-page');
    const page = await runtime.recordsPage(cursor);
    guard();
    if (page.reset || (await database.table('_cloudMeta').get('records-epoch'))?.value !== page.epoch) {
      await rebuildRecords(database, runtime, page.reset ? 'future-cursor' : 'server-generation', lifetime, cursor === 0 && !page.reset ? page : undefined); changed = true; conversationsChanged = true; break;
    }
    if (page.records.length) changed = true;
    conversationsChanged ||= page.records.some(record => record.table === 'chatSessions');
    phase('cycle:apply-page');
    guard();
    const applied = await applyRecordsPage(page, undefined, database, lifetime);
    guard();
    if (!applied) return;
    cursor = page.cursor;
    useCloudSync.setState({ cursor, highWater: page.highWater });
    if (!page.more) break;
  }
  await cloudTransaction(database, [commands, database.table('_cloudMeta')], async () => { guard(); await retireConfirmedCommands(database); guard(); });
  const pending = await commands.count(); guard();
  useCloudSync.setState({ pending, syncedAt: Date.now() });
  reportSyncHealthy('flush');
  await publishCommandDiagnostics(database);
  guard();
  if (changed) useCloudSync.setState(state => ({ recordsRevision: state.recordsRevision + 1, conversationsRevision: state.conversationsRevision + (conversationsChanged ? 1 : 0) }));
}

export function flushCloud(background = false): Promise<void> {
  if (!cloud.enabled) return Promise.resolve();
  const lifetime = accountLifetime(cloud.userId);
  if (flight) {
    repeatFlight = true;
    fullPullRequested ||= !background;
    return flight.then(async completed => {
    lifetime.assertCurrent();
    // An explicit caller joining a skipped background attempt must still pull
    // a baseline, even when there are no local edits to push.
    if (!background && !completed) await flushCloud();
    });
  }
  if (!flight) {
    repeatFlight = false;
    fullPullRequested = !background;
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
       await cloudRetry(database, () => syncCycle(fullPullRequested, lifetime));
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
      lifetime.assertCurrent();
      } while (repeatFlight);
    };
    phase('lock:waiting');
    if (navigator.locks) return navigator.locks.request(`cloud-sync:${cloud.userId}`, { ifAvailable: background }, async lock => {
      // Periodic cache maintenance must not build a queue ahead of a new tab's
      // initial baseline or an explicit durable-write flush. Never steal a lock.
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
   * true：本地阶段（打开数据库、迁移、账号隔离）完成即返回，配置拉取、
   * 基线对账、订阅这些网络往返在后台自息（退避重试 + degraded 状态），
   * 仅冲突类错误通过 reportSyncFailure 醒目地报给用户。登录后的首帧
   * 不再等网络 —— 页面直接从 IndexedDB 读历史数据先渲染。
   * 缺省 false：等远端阶段全部完成（或抛错），供 e2e 与诊断使用。
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
    repeatFlight = false; fullPullRequested = false;
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
  // 本地阶段到此完成。远端阶段（config / 基线对账 / 订阅）要么在后台跑，
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

/** Recovery is installed before the first request, not after the baseline. */
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
  const baseline = recover(async () => {
    try { await flushCloud(); }
    catch (error) {
      // Existing local edits must remain reachable through conflict recovery after reload.
      guard();
      if (!(await cloudRetry(databaseAtStart, () => databaseAtStart.table('_learningCommands').count()))) throw error;
    }
  });
  // Retry only the failed stage: a records outage must not tear down successful
  // preference subscriptions or abandon an in-flight local preference write.
  const results = await Promise.allSettled([preferences, baseline]);
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
    follow = runtime.followRecords({
      cursor: async () => await cloudRetry(database, async () => (await database.table('_cloudMeta').get('cursor'))?.value ?? 0),
      apply: async (page, signal) => {
        const runApply = async () => {
          guard();
          if (closed || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
          signal.throwIfAborted();
           const rebuilding = page.reset || (await database.table('_cloudMeta').get('records-epoch'))?.value !== page.epoch;
            if (rebuilding) await rebuildRecords(database, runtime, page.reset ? 'future-cursor' : 'server-generation', lifetime);
           else await applyRecordsPage(page, signal, database, lifetime);
            guard(); signal.throwIfAborted();
            if (rebuilding || page.records.length) {
              useCloudSync.setState(state => ({ recordsRevision: state.recordsRevision + 1,
                conversationsRevision: state.conversationsRevision + (rebuilding || page.records.some(record => record.table === 'chatSessions') ? 1 : 0) }));
           }
            const pending = await database.table('_learningCommands').count();
            if (closed || database !== db || !isCurrentServerRuntime(runtime)) return;
            useCloudSync.setState({ pending, syncedAt: Date.now() });
            reportSyncHealthy('follow');
            await publishCommandDiagnostics(database);
        };
        // A lost read/write transaction retries as a whole: the apply is
        // cursor-driven and idempotent, so replaying it cannot skip a frame.
        const apply = () => cloudRetry(database, runApply);
        // Drain local transactions first. Applying under the same lock closes
        // the multi-tab push/remote-echo race without stealing a writer's lock.
        if (navigator.locks) await navigator.locks.request(`cloud-sync:${owner}`, apply);
        else await apply();
      },
      // The follower backs off and resumes by itself; only conflicts need the user.
      failed: error => { if (!closed && lifetime.current()) reportSyncFailure(error, 'follow'); },
    });
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
