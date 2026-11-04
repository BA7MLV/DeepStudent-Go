import type { ResourceCommand, ResourceDirectory, ResourceOperation } from '@wangke/contracts/resources';
import type { ProjectDto } from '@wangke/contracts/projects';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { request as binaryRequest } from '../api/serverClient';
import Dexie from 'dexie';
import type { OutboxRow } from '../cloud/cache';
import { encodeRecoveryValue } from '../cloud/recovery-export';

// Inspection authority is local and ephemeral; never serialize a Runtime (or
// accept an imported JSON export) as permission to archive the live outbox.
const inspections = new WeakMap<object, () => boolean>();

/** Unknown legacy filesystem effects cannot safely be inferred from records.
 * Move the WHOLE original transaction (including non-resource rows and Blobs)
 * out of the automatic writer into the same inspect/export/archive workflow. */
export async function migrateResourceOutbox() {
  const owner = cloud.userId, database = db, runtime = await serverRuntime(owner);
  const groups = new Map<string, OutboxRow[]>();
  for (const row of await database.table<OutboxRow>('_cloudOutbox').orderBy('sequence').toArray()) {
    const rows = groups.get(row.transaction) ?? []; rows.push(row); groups.set(row.transaction, rows);
  }
  for (const [transaction, rows] of groups) {
    if (!rows.some(row => ['videos', 'folders', 'files', 'courseFiles', 'segments', 'subtitleTracks', 'materialBlocks', 'frames', 'covers', 'comments', 'danmakus'].includes(row.table))) continue;
    const receipt = await runtime.receipt(transaction);
    const expected = JSON.stringify(await encodeRecoveryValue(rows));
    if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    await database.transaction('rw', database.table('_cloudOutbox'), database.table('_cloudMeta'), async () => {
      const current = await database.table<OutboxRow>('_cloudOutbox').where('transaction').equals(transaction).toArray();
      if (JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(current))) !== expected) throw new Error('resource_migration_changed');
      if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      const operationId = `legacy-${transaction}`;
      await database.table('_cloudMeta').put({ id: `resource-command:${operationId}`, value: {
        request: { operationId, operation: { kind: 'legacyReview' } }, state: 'review',
        legacy: { transaction, rows, receipt }, error: 'legacy_resource_transaction_requires_review',
      } });
      await database.table('_cloudOutbox').bulkDelete(rows.map(row => row.sequence!));
    });
  }
}

export async function readResources(projectId?: string, path = '', archived = true): Promise<ResourceDirectory> {
  const owner = cloud.userId, runtime = await serverRuntime(owner);
  const value = await runtime.read({ kind: 'resources', ...(projectId ? { projectId } : {}), path, archived });
  if (owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  return value.value as unknown as ResourceDirectory;
}

export async function readResourceFolder(folderId?: number): Promise<ResourceDirectory> {
  const owner = cloud.userId, runtime = await serverRuntime(owner);
  const value = await runtime.read({ kind: 'resources', path: '', archived: true, ...(folderId === undefined ? {} : { folderId }) });
  if (owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  return value.value as unknown as ResourceDirectory;
}

export async function resourceCommand(operation: ResourceOperation, operationId?: string) {
  return dispatchResourceCommand(operation, undefined, operationId);
}

/** Static mode keeps local storage. Server mode never falls back to a local
 * authoritative write when the domain command is offline or rejected. */
export async function recordMediaDuration(courseId: string, duration: number) {
  if (!cloud.enabled) { await db.videos.update(courseId, { duration }); return; }
  await recordCourseFact({ kind: 'recordMediaDuration', courseId, duration });
}
export async function recordPlayback(courseId: string, position: number, finished?: boolean) {
  if (!cloud.enabled) { await db.videos.update(courseId, { lastPosition: position, ...(finished === undefined ? {} : { finished: finished ? 1 : 0 }) }); return; }
  await recordCourseFact({ kind: 'recordPlayback', courseId, position, ...(finished === undefined ? {} : { finished }) });
}
export async function recordReadingPosition(courseId: string, unit: number) {
  if (!cloud.enabled) { await db.videos.update(courseId, { lastUnit: unit }); return; }
  await recordCourseFact({ kind: 'recordReadingPosition', courseId, unit });
}
export async function setReadingView(courseId: string, view: 'raw' | 'blocks') {
  if (!cloud.enabled) { await db.videos.update(courseId, { htmlView: view }); return; }
  await recordCourseFact({ kind: 'setReadingView', courseId, view });
}
async function recordCourseFact(operation: Extract<ResourceOperation, { kind: 'recordMediaDuration' | 'recordPlayback' | 'recordReadingPosition' | 'setReadingView' }>) {
  // The committed records projection owns cache revision/order. Do not replace
  // an entire course with a potentially late command response.
  await resourceCommand(operation);
}

export async function uploadResource(projectId: string, path: string, blob: Blob): Promise<{ path: string; size: number }> {
  const owner = cloud.userId, database = db;
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  if (owner !== cloud.userId || database !== db) throw new Error('client_account_changed');
  return await dispatchResourceCommand({ kind: 'upload', projectId, path, size: blob.size, sha256, contentType: blob.type }, blob) as unknown as { path: string; size: number };
}

async function dispatchResourceCommand(operation: ResourceOperation, blob?: Blob, operationId?: string) {
  const owner = cloud.userId, database = db;
  // Guest operations retain their identity across reconnects; hash arbitrary
  // protocol IDs into the bounded command ID alphabet, never create a new write.
  const stableId = operationId === undefined ? crypto.randomUUID() : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId))), byte => byte.toString(16).padStart(2, '0')).join('');
  if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  const request: ResourceCommand = { operationId: `resource-${stableId}`, operation };
  const key = `resource-command:${request.operationId}`;
  // Retain the exact revision, path, text and operation id before any request.
  // Unlike SQL preferences, filesystem operations are never auto-replayed.
  const draft = { request, ...(blob ? { blob } : {}) };
  await database.table('_cloudMeta').put({ id: key, value: { ...draft, state: 'queued' } });
  try {
    const runtime = await serverRuntime(owner);
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    await database.table('_cloudMeta').put({ id: key, value: { ...draft, state: 'uncertain' } });
    let result = await runtime.resourceCommand(request);
    if (blob && operation.kind === 'upload') {
      if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      result = await binaryRequest(`/projects/${encodeURIComponent(operation.projectId)}/uploads?operationId=${encodeURIComponent(request.operationId)}`,
        { method: 'POST', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
    }
    if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
    await database.transaction('rw', database.table('_cloudMeta'), async () => {
      await database.table('_cloudMeta').put({ id: `resource-completed:${request.operationId}`, value: { ...draft, result, state: 'completed' } });
      await database.table('_cloudMeta').delete(key);
    });
    return result;
  } catch (error) {
    if (database === db && owner === cloud.userId) await database.table('_cloudMeta').update(key, { 'value.lastError': String(error) });
    throw error;
  }
}

export function followResources(projectId: string | undefined, path: string, changed: (directory: ResourceDirectory) => void, failed: (error: unknown) => void) {
  return followResourceProjection({ kind: 'resources', ...(projectId ? { projectId } : {}), path, archived: true }, changed, failed);
}

export function followResourceTrash(changed: (value: { projects: (ProjectDto & { deletedAt: string })[] }) => void, failed: (error: unknown) => void) {
  return followResourceProjection({ kind: 'resourceTrash' }, changed, failed);
}

/** Shared multiplexed document query/watch; reconnect always reads a fresh baseline. */
export function followDocument<T = { content?: string; text?: string }>(request: Extract<import('@wangke/contracts/client-runtime').RuntimeRead, { kind: 'courseDocument' | 'systemDocument' | 'systemDirectory' }>, changed: (document: T) => void, failed: (error: unknown) => void) {
  const owner = cloud.userId;
  let stopped = false, off: (() => void) | undefined, release: (() => void) | undefined;
  void serverRuntime(owner).then(runtime => {
    if (stopped || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
    const model = runtime.document(request);
    const refresh = () => {
      if (stopped || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
      const snapshot = model.getSnapshot();
      if (snapshot.status === 'ready' && snapshot.data) changed(snapshot.data as T);
      else if (snapshot.status === 'error') failed(snapshot.error);
    };
    off = model.subscribe(refresh); release = model.acquire(); refresh();
  }).catch(error => { if (!stopped && owner === cloud.userId) failed(error); });
  return () => { stopped = true; off?.(); release?.(); };
}

function followResourceProjection<Value>(request: Extract<import('@wangke/contracts/client-runtime').RuntimeRead, { kind: 'resources' | 'resourceTrash' }>, changed: (value: Value) => void, failed: (error: unknown) => void) {
  const owner = cloud.userId;
  let stopped = false, off: (() => void) | undefined, release: (() => void) | undefined;
  void serverRuntime(owner).then(runtime => {
    if (stopped || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
    const model = runtime.resources(request);
    const refresh = () => {
      if (stopped || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
      const snapshot = model.getSnapshot();
      if (snapshot.status === 'ready' && snapshot.data) changed(snapshot.data as unknown as Value);
      else if (snapshot.status === 'error') failed(snapshot.error);
    };
    off = model.subscribe(refresh); release = model.acquire(); refresh();
  }).catch(error => { if (!stopped && owner === cloud.userId) failed(error); });
  return () => { stopped = true; off?.(); release?.(); };
}

export async function inspectResourceCommand(operationId: string) {
  const owner = cloud.userId, database = db, runtime = await serverRuntime(owner);
  const stored = await database.table('_cloudMeta').get(`resource-command:${operationId}`);
  if (!stored) throw new Error('resource_command_not_found');
  const request = stored.value.request as ResourceCommand | { operationId: string; operation: { kind: 'legacyReview' } };
  const operation = request.operation;
  const receipt = await runtime.receipt(stored.value.legacy?.transaction ?? operationId);
  const trash = (await runtime.read({ kind: 'resourceTrash' })).value;
  const directories: ResourceDirectory[] = [];
  const directoryErrors: { projectId?: string; error: string }[] = [];
  const inspectDirectory = async (projectId?: string) => {
    try { directories.push(await readResources(projectId)); }
    catch (error) {
      if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      // A removed directory or revoked project permission must not prevent the
      // user from exporting the original intent and the authoritative receipt.
      directoryErrors.push({ projectId, error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (operation.kind !== 'deleteTrash' && operation.kind !== 'restore' && operation.kind !== 'trash') {
    const projectId = 'projectId' in operation ? operation.projectId : undefined;
    await inspectDirectory(projectId);
    if (operation.kind === 'move' && operation.targetProjectId !== projectId) await inspectDirectory(operation.targetProjectId);
  }
  if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
  const detail = { owner, stored, receipt, directories, directoryErrors, trash };
  inspections.set(detail, () => database === db && owner === cloud.userId && isCurrentServerRuntime(runtime));
  return detail;
}

export async function archiveResourceCommand(detail: Awaited<ReturnType<typeof inspectResourceCommand>>) {
  const database = db;
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  await database.transaction('rw', database.table('_cloudMeta'), async () => {
    const stored = await database.table('_cloudMeta').get(detail.stored.id);
    if (!current()) throw new Error('client_account_changed');
    if (!stored || JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(stored))) !== JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(detail.stored)))) throw new Error('resource_command_changed');
    await database.table('_cloudMeta').put({ id: `resource-archived:${detail.stored.value.request.operationId}`, value: detail });
    if (!current()) throw new Error('client_account_changed');
    await database.table('_cloudMeta').delete(detail.stored.id);
    if (!current()) throw new Error('client_account_changed');
  });
}

export async function exportResourceCommand(detail: Awaited<ReturnType<typeof inspectResourceCommand>>) {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const value = JSON.stringify(await encodeRecoveryValue(detail), null, 2);
  if (!current()) throw new Error('client_account_changed');
  return value;
}
