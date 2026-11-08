import type { ResourceCommand, ResourceDirectory, ResourceOperation } from '@wangke/contracts/resources';
import type { ProjectDto } from '@wangke/contracts/projects';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { cloudTransaction } from '../cloud/transactions';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import { enqueueResourceCommand } from './resource-commands';
import Dexie from 'dexie';
import type { OutboxRow } from '../cloud/cache';
import { encodeRecoveryValue } from '../cloud/recovery-export';
import { serverClient } from '../api/serverClient';

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
    await cloudTransaction(database, [database.table('_cloudOutbox'), database.table('_cloudMeta')], async () => {
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
  await recordCourseFact({ kind: 'recordMediaDuration', courseId, duration });
}
export async function recordPlayback(courseId: string, position: number, finished?: boolean) {
  await recordCourseFact({ kind: 'recordPlayback', courseId, position, ...(finished === undefined ? {} : { finished }) });
}
export async function recordReadingPosition(courseId: string, unit: number) {
  await recordCourseFact({ kind: 'recordReadingPosition', courseId, unit });
}
export async function setReadingView(courseId: string, view: 'raw' | 'blocks') {
  await recordCourseFact({ kind: 'setReadingView', courseId, view });
}
async function recordCourseFact(operation: Extract<ResourceOperation, { kind: 'recordMediaDuration' | 'recordPlayback' | 'recordReadingPosition' | 'setReadingView' }>) {
  // The committed records projection owns cache revision/order. Do not replace
  // an entire course with a potentially late command response.
  await enqueueResourceCommand(operation, undefined, undefined, true);
}

export async function uploadResource(projectId: string, path: string, blob: Blob): Promise<{ path: string; size: number }> {
  const owner = cloud.userId, database = db;
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())), byte => byte.toString(16).padStart(2, '0')).join('');
  if (owner !== cloud.userId || database !== db) throw new Error('client_account_changed');
  return await dispatchResourceCommand({ kind: 'upload', projectId, path, size: blob.size, sha256, contentType: blob.type }, blob) as unknown as { path: string; size: number };
}

async function dispatchResourceCommand(operation: ResourceOperation, blob?: Blob, operationId?: string) {
  return enqueueResourceCommand(operation, blob, operationId);
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
  let document: { text: string; revision?: string } | undefined;
  if (operation.kind !== 'legacyReview' && 'text' in operation) {
    try {
      if (operation.kind === 'saveProjectText') document = await serverClient.projectText(operation.projectId, operation.path);
      else if ('courseId' in operation) {
        const value = (await runtime.read({ kind: 'courseDocument', courseId: operation.courseId })).value as { content?: string; text?: string };
        const text = value.content ?? value.text;
        if (typeof text === 'string') document = { text };
      }
    } catch { /* Missing/inaccessible targets must not hide the retained draft. */ }
  }
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
  const detail = { owner, stored, receipt, directories, directoryErrors, trash, document };
  inspections.set(detail, () => database === db && owner === cloud.userId && isCurrentServerRuntime(runtime));
  return detail;
}

export async function archiveResourceCommand(detail: Awaited<ReturnType<typeof inspectResourceCommand>>) {
  const database = db;
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const archive = () => cloudTransaction(database, [database.table('_cloudMeta')], async () => {
    const stored = await database.table('_cloudMeta').get(detail.stored.id);
    if (!current()) throw new Error('client_account_changed');
    if (!stored || JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(stored))) !== JSON.stringify(await Dexie.waitFor(encodeRecoveryValue(detail.stored)))) throw new Error('resource_command_changed');
    await database.table('_cloudMeta').put({ id: `resource-archived:${detail.stored.value.request.operationId}`, value: detail });
    if (!current()) throw new Error('client_account_changed');
    await database.table('_cloudMeta').delete(detail.stored.id);
    if (!current()) throw new Error('client_account_changed');
  });
  // Archival must not race a queued automatic send. It neither cancels an
  // already-dispatched request nor authorizes another one.
  if (navigator.locks) await navigator.locks.request(`resource-commands:${detail.owner}`, archive);
  else await archive();
}

/** Only an explicit merge from a current inspection may create a successor.
 * Reusing the failed operation ID would violate its immutable original intent. */
export async function saveResourceConflict(detail: Awaited<ReturnType<typeof inspectResourceCommand>>, text: string) {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  if (!detail.document || detail.stored.value.state !== 'conflict') throw new Error('resource_conflict_changed');
  const operation = detail.stored.value.request.operation as ResourceOperation;
  let successor: ResourceOperation;
  if (operation.kind === 'saveProjectText' && detail.document.revision) successor = { ...operation, text, expectedRevision: detail.document.revision };
  else if (operation.kind === 'saveCourseText' || operation.kind === 'saveMarkdown') successor = { ...operation, text, expected: detail.document.text, ...(operation.kind === 'saveMarkdown' ? { createOnly: false } : {}) };
  else throw new Error('resource_conflict_not_editable');
  await resourceCommand(successor);
  if (!current()) throw new Error('client_account_changed');
  await archiveResourceCommand(detail);
}

export async function exportResourceCommand(detail: Awaited<ReturnType<typeof inspectResourceCommand>>) {
  const current = inspections.get(detail);
  if (!current?.()) throw new Error('client_account_changed');
  const value = JSON.stringify(await encodeRecoveryValue(detail), null, 2);
  if (!current()) throw new Error('client_account_changed');
  return value;
}
