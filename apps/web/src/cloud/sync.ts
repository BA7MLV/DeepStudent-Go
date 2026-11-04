import { create } from 'zustand';
import { db, useCloudDatabase } from '../store/db';
import { markCloudApply, type OutboxRow } from './cache';
import { cloud, cloudRequest } from './state';
import { CLOUD_TABLES, type CloudRecord, type CloudConfig } from '@wangke/contracts/cloud';
import { useSettings } from '../store/settings';
import { flushPreferences, loadPreferences, startPreferences, stopPreferences, migratePreferenceOutbox } from './preferences';
import { apiUrl } from '../api/base';
import { cloudTransaction, isLostCloudTransaction } from './transactions';
import { reasoningProviderOf } from '@wangke/study-core/model/reasoning';
import Dexie from 'dexie';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import type { RuntimeRecordsPage } from '@wangke/contracts/client-runtime';
import { migrateResourceOutbox } from '../client/resources';

export const useCloudSync = create<{ pending: number; error: string; syncedAt: number; recordsRevision: number }>()(() => ({ pending: 0, error: '', syncedAt: 0, recordsRevision: 0 }));
let stopChanges: (() => void) | undefined;
let retryRecords: (() => void) | undefined;
let flight: Promise<boolean> | undefined;
let syncPhase: { name: string; since: number } = { name: 'idle', since: Date.now() };
const phase = (name: string) => { syncPhase = { name, since: Date.now() }; };
export const cloudSyncDiagnostics = () => ({ phase: syncPhase.name, phaseAgeMs: Date.now() - syncPhase.since, flight: !!flight });
const fileCache = new Map<string, Blob>();
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

async function uploadBlob(blob: Blob): Promise<{ $file: string; type: string }> {
  const hash = await blobHash(blob);
  const cached = await db.table('_cloudBlobs').get(hash);
  if (cached) return { $file: cached.id, type: blob.type };
  const response = await fetch(apiUrl('/api/v1/files'), { method: 'POST', credentials: 'include', headers: {
    'content-type': 'application/octet-stream', 'x-file-name': 'cache-blob', 'x-file-mime': blob.type || 'application/octet-stream',
  }, body: blob });
  if (!response.ok) throw new Error(`文件同步失败（${response.status}）`);
  const file = await response.json();
  await db.table('_cloudBlobs').put({ hash, id: file.id });
  return { $file: file.id, type: blob.type };
}
async function blobHash(blob: Blob) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join('');
}
async function encode(value: any): Promise<any> {
  if (value instanceof Blob) return uploadBlob(value);
  if (Array.isArray(value)) return Promise.all(value.map(encode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).filter(([,v]) => v !== undefined).map(async ([k,v]) => [k, await encode(v)])));
  return value;
}
async function decode(value: any): Promise<any> {
  if (value && typeof value.$file === 'string') {
    const cached = fileCache.get(value.$file);
    if (cached) return cached;
    const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(value.$file)}`), { credentials: 'include' });
    if (!response.ok) throw new Error(`无法同步文件（${response.status}）`);
    const blob = new Blob([await response.blob()], { type: value.type });
    await db.table('_cloudBlobs').put({ hash: await blobHash(blob), id: value.$file, origin: 'download' });
    // Bounded cache; IndexedDB remains the durable cache after decoding.
    if (fileCache.size >= 50) fileCache.delete(fileCache.keys().next().value!);
    fileCache.set(value.$file, blob);
    return blob;
  }
  if (Array.isArray(value)) return Promise.all(value.map(decode));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([k,v]) => [k, await decode(v)])));
  return value;
}

async function applyRecordsPage(page: RuntimeRecordsPage, signal?: AbortSignal) {
  const database = db;
  const decoded: CloudRecord[] = [];
  for (const record of page.records) decoded.push({ ...record, value: await decode(record.value) });
  signal?.throwIfAborted();
  return cloudTransaction(database, database.tables, async () => {
    markCloudApply();
    signal?.throwIfAborted();
    // Never overwrite an unacknowledged UI transaction, even if it was created
    // while decoding file references. The durable cursor remains unchanged.
    if (await database.table('_cloudOutbox').count()) return false;
    const cursor = (await database.table('_cloudMeta').get('cursor'))?.value ?? 0;
    if (page.cursor <= cursor) return true;
    for (const record of decoded) {
      if (!Object.hasOwn(CLOUD_TABLES, record.table)) throw new Error('服务器返回了未知数据表');
      if (record.table === 'preferences') continue;
      const metaId = `revision:${record.table}:${JSON.stringify(record.key)}`;
      const known = (await database.table('_cloudMeta').get(metaId))?.value ?? 0;
      // A queued stream page can predate a just-acknowledged local command.
      // Advance its global cursor, but never roll that key back to its old echo.
      if (record.revision < known) continue;
      const table = database.table(record.table);
      if (record.value === null) await table.delete(record.key);
      else await table.put(record.value);
      await database.table('_cloudMeta').put({ id: metaId, value: record.revision });
    }
    await database.table('_cloudMeta').put({ id: 'cursor', value: page.cursor });
    return true;
  });
}

async function syncCycle(pull = true) {
  phase('cycle:begin');
  const database = db;
  if (Date.now() - configCheckedAt > 15000) {
    const config = await cloudRequest<CloudConfig>('/config');
    configCheckedAt = Date.now();
    if (JSON.stringify(config) !== configSignature) applyCloudConfig(config);
  }
  let changed = false;
  const outbox = database.table<OutboxRow>('_cloudOutbox');
  // One original transaction per POST; acknowledged operations are removed only after commit.
  for (;;) {
    const first = await outbox.orderBy('sequence').first();
    if (!first) break;
    const rows = await outbox.where('transaction').equals(first.transaction).toArray();
    useCloudSync.setState({ pending: await outbox.count() });
    const mutations = [];
    phase('cycle:encode-outbox');
    for (const row of rows) mutations.push({ id: row.id, table: row.table, key: row.key, permissionId: row.permissionId,
      baseRevision: (await database.table('_cloudMeta').get(`revision:${row.table}:${JSON.stringify(row.key)}`))?.value,
      before: await encode(row.before), after: await encode(row.after) });
    phase('cycle:commit-records');
    const result = await (await serverRuntime(cloud.userId)).commitRecords({ operationId: first.transaction, mutations });
    phase('cycle:commit-cache');
    await cloudTransaction(database, [outbox, database.table('_cloudMeta')], async () => {
      await outbox.bulkDelete(rows.map(r => r.sequence!));
      await database.table('_cloudMeta').bulkPut(result.versions.map(r => ({ id: `revision:${r.table}:${JSON.stringify(r.key)}`, value: r.revision })));
    });
  }
  if (!pull) { useCloudSync.setState({ pending: await outbox.count(), error: '', syncedAt: Date.now() }); return; }
  let cursor = (await database.table('_cloudMeta').get('cursor'))?.value ?? 0;
  for (;;) {
    phase('cycle:read-page');
    const page = await (await serverRuntime(cloud.userId)).recordsPage(cursor);
    if (page.records.length) changed = true;
    phase('cycle:apply-page');
    const applied = await applyRecordsPage(page);
    if (!applied) return;
    cursor = page.cursor;
    if (!page.more) break;
  }
  useCloudSync.setState({ pending: await outbox.count(), error: '', syncedAt: Date.now() });
  if (changed) useCloudSync.setState(state => ({ recordsRevision: state.recordsRevision + 1 }));
  if (changed) { phase('cycle:load-preferences'); await loadPreferences(); }
}

export function flushCloud(background = false): Promise<void> {
  if (!cloud.enabled) return Promise.resolve();
  if (flight) return flight.then(async completed => {
    // An explicit caller joining a skipped background attempt must still pull
    // a baseline, even when there are no local edits to push.
    if (!background && (!completed || await db.table('_cloudOutbox').count())) await flushCloud();
  });
  if (!flight) flight = (async () => {
    const drain = async () => { phase('drain:preferences'); await flushPreferences(); do { await syncCycle(!background); } while (await db.table('_cloudOutbox').count()); };
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
    const detail = (error as { detail?: { table?: string; key?: unknown } }).detail;
    useCloudSync.setState({ error: (error as Error).message === 'sync_conflict'
      ? `同步冲突：${detail?.table}/${String(detail?.key)}。本机修改已保留，请在云端管理中处理。`
      : isLostCloudTransaction(error)
        ? '浏览器本地数据库事务异常，同步尚未完成。请关闭其他同站点标签页后刷新重试，不要清除网站数据。'
        : (error as Error).message });
    throw error;
  }).finally(() => { flight = undefined; phase('idle'); });
  return flight.then(() => { if (!background) retryRecords?.(); });
}

export async function resolveCloudConflict() {
  if (navigator.locks) return navigator.locks.request(`cloud-sync:${cloud.userId}`, resolveConflictLocked);
  return resolveConflictLocked();
}
async function resolveConflictLocked() {
  const rows = await db.table<OutboxRow>('_cloudOutbox').orderBy('sequence').toArray();
  if (!rows.length) return;
  const encoded = [];
  for (const row of rows) encoded.push({ ...row, before: await encode(row.before), after: await encode(row.after) });
  const url = URL.createObjectURL(new Blob([JSON.stringify(encoded, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `wangke-conflict-${Date.now()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  const records: CloudRecord[] = [];
  for (const row of rows) {
    const result = await cloudRequest<{ value: Record<string, unknown> | null }>(`/record?table=${encodeURIComponent(row.table)}&key=${encodeURIComponent(JSON.stringify(row.key))}`);
    records.push({ table: row.table, key: row.key, value: await decode(result.value), revision: 0 });
  }
  await db.transaction('rw', db.tables, async () => {
    if (await db.table('_cloudOutbox').count() !== rows.length) throw new Error('下载期间有新的修改，请停止编辑后重试处理冲突');
    markCloudApply();
    for (const record of records) {
      if (record.value) await db.table(record.table).put(record.value);
      else await db.table(record.table).delete(record.key);
    }
    await db.table('_cloudOutbox').bulkDelete(rows.map(r => r.sequence!));
  });
  await syncCycle();
  retryRecords?.();
}

export async function startCloud(owner: string) {
  cloud.enabled = true; cloud.userId = owner;
  useCloudDatabase(owner);
  await db.open();
  await migrateResourceOutbox(); await migratePreferenceOutbox();
  useSettings.persist.setOptions({ name: `wangke-cloud-settings-${owner}` });
  // 登录前的语言不随模型配置重置；有账号语言偏好时，后续 loadPreferences 再覆盖。
  const uiLanguage = useSettings.getState().uiLanguage;
  useSettings.setState({ ...useSettings.getInitialState(), uiLanguage });
  const config = await cloudRequest<CloudConfig>('/config');
  applyCloudConfig(config);
  try { await flushCloud(); }
  catch (error) {
    // Existing local edits must remain reachable through conflict recovery after reload.
    if (!(await db.table('_cloudOutbox').count())) throw error;
  }
  await startPreferences();
  stopChanges?.();
  const database = db;
  let closed = false;
  let follow: { dispose(): void; restart(): void } | undefined;
  // Dexie's committed mutation notification crosses tabs; no polling of either
  // IndexedDB or HTTP. Reads alone never generate another wakeup.
  const changed = (parts: Record<string, unknown>) => {
    if (closed || !Object.keys(parts).some(key => key.startsWith(`idb://${database.name}/`))) return;
    void database.table('_cloudOutbox').count().then(count => {
      // An actual committed edit is a durable write, not idle maintenance. It
      // waits once for the lock (coalesced by flight), otherwise a skipped wake
      // could strand the only local edit forever after removing the timer.
      if (!closed && count) void flushCloud().catch(() => {});
    });
  };
  Dexie.on('storagemutated', changed);
  const online = () => { void flushCloud().then(() => follow?.restart()).catch(() => {}); };
  window.addEventListener('online', online);
  stopChanges = () => { closed = true; follow?.dispose(); retryRecords = undefined; Dexie.on('storagemutated').unsubscribe(changed); window.removeEventListener('online', online); };
  {
    const runtime = await serverRuntime(owner);
    if (closed) return;
    follow = runtime.followRecords({
      cursor: async () => (await database.table('_cloudMeta').get('cursor'))?.value ?? 0,
      apply: async (page, signal) => {
        const apply = async () => {
          if (closed || !isCurrentServerRuntime(runtime)) return;
          signal.throwIfAborted();
          if (!await applyRecordsPage(page, signal)) throw new Error('records_pending_local_transaction');
          if (page.records.length) {
            useCloudSync.setState(state => ({ recordsRevision: state.recordsRevision + 1 }));
            await loadPreferences();
          }
        };
        // Drain local transactions first. Applying under the same lock closes
        // the multi-tab push/remote-echo race without stealing a writer's lock.
        if (await database.table('_cloudOutbox').count()) await flushCloud(true);
        if (navigator.locks) await navigator.locks.request(`cloud-sync:${owner}`, apply);
        else await apply();
      },
      failed: error => { if (!closed) useCloudSync.setState({ error: error instanceof Error ? error.message : String(error) }); },
    });
    retryRecords = follow.restart;
    const { reconcileTaskAdmissions } = await import('./tasks');
    // Admission uncertainty has its own persisted command UI. Do not overwrite
    // a records conflict with a transient command warning that survives retry.
    await reconcileTaskAdmissions();
  }
}

export function stopCloud() {
  stopPreferences();
  void import('../client/bootstrap').then(module => module.disposeServerRuntime());
  stopChanges?.(); stopChanges = undefined; fileCache.clear();
  // Re-enter through the auth gate on a fresh JS realm: no parked conversations or model
  // settings from a previous identity remain visible after logout/session expiry.
  window.location.reload();
}

/** Discard this browser's cloud cache after a server-side account reset. */
export async function clearCloudLocalData() {
  stopPreferences();
  (await import('../client/bootstrap')).disposeServerRuntime();
  stopChanges?.(); stopChanges = undefined;
  fileCache.clear();
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
  await db.delete();
}
