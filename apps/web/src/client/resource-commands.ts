import { liveQuery } from 'dexie';
import { create } from 'zustand';
import type { ResourceCommand, ResourceOperation } from '@wangke/contracts/resources';
import type { RuntimeJson } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { cloudTransaction } from '../cloud/transactions';
import { request as binaryRequest } from '../api/serverClient';
import { accountLifetime, type AccountLifetime } from './account-lifecycle';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';

export type ResourceDraft = {
  request: ResourceCommand; blob?: Blob; protocol?: 1;
  state: 'queued' | 'uncertain' | 'failed' | 'conflict' | 'review' | 'paused';
  sent?: boolean; createdAt?: number; sequence?: number; attempts?: number;
  nextAttemptAt?: number; lastError?: string; errorCode?: string;
  inputDigest?: string;
};
type Row = { id: string; value: ResourceDraft };
export type ResourceIssue = { id: string; label: string; message: string; hasDraft: boolean };
export const useResourceCommands = create<{ pending: number; issues: ResourceIssue[] }>(() => ({ pending: 0, issues: [] }));
const prefix = 'resource-command:';
const factKinds = new Set(['recordMediaDuration', 'recordPlayback', 'recordReadingPosition', 'setReadingView']);
const isFact = (operation: ResourceOperation) => factKinds.has(operation.kind);
const group = (operation: ResourceOperation) => isFact(operation) && 'courseId' in operation ? `${operation.kind}:${operation.courseId}` : undefined;
const message = (code: string) => {
  if (code === 'project_file_conflict' || code === 'client/conflict') return '文件已发生变化，未覆盖其他版本。你的内容已保留。';
  if (code === 'project_file_exists') return '目标位置已有同名文件，未覆盖原文件。';
  if (code === 'resource_scope_changed') return '服务器资料库已变更，已停止提交旧操作。未保存的内容仍保留在此浏览器。';
  if (/forbidden|denied|archived|trashed|not_found/.test(code)) return '文件不可用或当前没有修改权限。未保存的内容仍已保留。';
  if (/too_large|ENOSPC/.test(code)) return '文件过大或存储空间不足。未保存的内容仍已保留。';
  if (code === 'resource_uncertain') return '暂时无法确认这次操作的结果，已停止重复执行并保留原稿。';
  return '暂时无法完成保存。未保存的内容仍保留在此浏览器。';
};
export function resourceOperationLabel(operation: ResourceOperation) {
  if ('path' in operation) return operation.path || '文件夹';
  if ('name' in operation && operation.name) return operation.name;
  return operation.kind === 'moveLibrarySelection' || operation.kind === 'organizeCourses' ? '整理资料' : '资料操作';
}
function failureCode(error: unknown) {
  const value = error as { code?: string; detail?: { code?: string }; status?: number };
  return value?.detail?.code ?? value?.code ?? (value?.status ? `http_${value.status}` : 'transport_unavailable');
}
function permanent(code: string) {
  return !['resource_retryable', 'project_busy', 'transport_unavailable', 'gateway/internal', 'gateway/unavailable', 'gateway/timeout', 'client/uncertain', 'resource_upload_in_progress'].includes(code)
    && !/^http_(408|425|429|5\d\d)$/.test(code);
}
let active: { lifetime: AccountLifetime; flush(force?: boolean): Promise<void>; wake(): Promise<void>; stop(): void } | undefined;

/** One account-owned, cross-tab writer. No HTTP/IDB polling when idle. Only
 * pending transient failures schedule bounded exponential-backoff wakeups. */
export function startResourceCommands() {
  const owner = cloud.userId, lifetime = accountLifetime(owner), database = db;
  if (active?.lifetime === lifetime) return;
  active?.stop();
  const metadata = database.table('_cloudMeta');
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined;
  let repeat = false;
  let completions = 0;
  const current = () => !stopped && lifetime.current() && database === db && owner === cloud.userId;
  const guard = () => { if (!current()) throw new Error('client_account_changed'); };
  const update = async (id: string, patch: Partial<ResourceDraft>) => {
    guard();
    await cloudTransaction(database, [metadata], async () => {
      guard(); const row = await metadata.get(id); if (!row) return;
      await metadata.put({ ...row, value: { ...row.value, ...patch } }); guard();
    });
    guard();
  };
  const complete = async (row: Row, result: RuntimeJson) => {
    guard();
    await cloudTransaction(database, [metadata], async () => {
      guard();
      await metadata.put({ id: `resource-completed:${row.value.request.operationId}`, value: {
        operationId: row.value.request.operationId, kind: row.value.request.operation.kind, result, confirmedAt: Date.now(), state: 'completed',
        inputDigest: row.value.inputDigest,
      } });
      await metadata.delete(row.id); guard();
    });
    if (++completions % 50 === 0) void compactCompletedResources(database, lifetime).catch(() => {});
  };
  const fail = async (row: Row, code: string, review = false) => {
    await update(row.id, { state: review ? 'review' : /conflict|file_exists/.test(code) ? 'conflict' : 'failed', errorCode: code, lastError: message(code), nextAttemptAt: undefined });
  };
  const defer = async (row: Row, code: string) => {
    const attempts = row.value.attempts ?? 1;
    await update(row.id, { state: attempts >= 6 ? 'paused' : row.value.sent ? 'uncertain' : 'queued', errorCode: code,
      lastError: '等待连接后继续确认保存结果。', nextAttemptAt: Date.now() + Math.min(30000, 500 * 2 ** Math.min(attempts, 6)) + Math.floor(Math.random() * 500) });
  };
  const process = async (id: string) => {
    guard();
    // Claim before external IO. A coalescing producer may change only an unsent
    // queued command; its identity/payload become immutable after this commit.
    const row = await cloudTransaction(database, [metadata], async () => {
      guard(); const row = await metadata.get(id) as Row | undefined;
      if (!row || ['failed', 'conflict', 'review', 'paused'].includes(row.value.state)) return;
      row.value = { ...row.value, state: 'uncertain', attempts: (row.value.attempts ?? 0) + 1 };
      await metadata.put(row); guard(); return row;
    });
    if (!row) return;
    try {
      const runtime = await serverRuntime(owner); guard();
      const assertRuntime = () => { guard(); if (!isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
      const receipt = await runtime.receipt(row.value.request.operationId); assertRuntime();
      if (receipt.resourceScope) { await metadata.put({ id: 'resource-server-scope', value: receipt.resourceScope }); assertRuntime(); }
      if (row.value.request.scope && receipt.resourceScope !== row.value.request.scope) { await fail(row, 'resource_scope_changed', true); return; }
      if (receipt.status === 'completed') {
        // A caller-supplied identity can already exist on another tab/device.
        // Verify its payload via the idempotent endpoint before accepting an
        // unfamiliar receipt; a raw operation ID is not proof of intent.
        const value = row.value.protocol === 1 && !row.value.sent ? await runtime.resourceCommand({ ...row.value.request, ...(receipt.resourceScope ? { scope: receipt.resourceScope } : {}) }) : receipt.value;
        assertRuntime(); await complete(row, value); return;
      }
      if (receipt.status === 'failed' && receipt.code !== 'resource_retryable') { await fail(row, receipt.code); return; }
      // Old drafts can be retired using their authoritative receipt, but are
      // NEVER upgraded into new automatic writes without their original scope.
      if (row.value.protocol !== 1) { await fail(row, 'resource_uncertain', true); return; }
      if (!receipt.resourceScope) { await defer(row, 'transport_unavailable'); return; }
      if (receipt.status !== 'missing' && receipt.status !== 'failed' && !(row.value.blob && row.value.request.operation.kind === 'upload')) {
        await fail(row, 'resource_uncertain', true); return;
      }
      if (!row.value.request.scope) {
        row.value.request = { ...row.value.request, scope: receipt.resourceScope };
        await update(row.id, { request: row.value.request });
      }
      row.value.sent = true;
      await update(row.id, { sent: true }); assertRuntime();
      let result = await runtime.resourceCommand(row.value.request); assertRuntime();
      if (row.value.blob && row.value.request.operation.kind === 'upload') {
        // Admission can itself return an already committed upload after a lost
        // response. Never retransmit bytes in that case.
        if (!(result && typeof result === 'object' && !Array.isArray(result) && result.kind === 'resourceUpload')) {
          result = await binaryRequest(`/projects/${encodeURIComponent(row.value.request.operation.projectId)}/uploads?operationId=${encodeURIComponent(row.value.request.operationId)}`,
            { method: 'POST', body: row.value.blob, headers: { 'Content-Type': 'application/octet-stream' }, signal: lifetime.signal });
          assertRuntime();
        }
      }
      await complete(row, result);
    } catch (error) {
      if (!current()) return;
      const code = failureCode(error);
      if (code === 'client_account_changed' || code === 'client_runtime_disposed') return;
      // First resolve a lost response, without sending a second write. This is
      // the common success path on flaky networks, including installed uploads.
      if (row.value.sent) {
        try {
          const runtime = await serverRuntime(owner); guard();
          const receipt = await runtime.receipt(row.value.request.operationId); guard();
          if (row.value.request.scope && receipt.resourceScope !== row.value.request.scope) { await fail(row, 'resource_scope_changed', true); return; }
          if (receipt.status === 'completed' && code !== 'client/conflict') { await complete(row, receipt.value); return; }
          if (receipt.status === 'failed' && receipt.code !== 'resource_retryable') { await fail(row, receipt.code); return; }
          if (receipt.status === 'uncertain' && !(row.value.blob && row.value.request.operation.kind === 'upload')) { await fail(row, 'resource_uncertain', true); return; }
        } catch { if (!current()) return; }
      }
      if (permanent(code)) await fail(row, code);
      else await defer(row, code);
    }
  };
  const drain = async (force: boolean) => {
    guard();
    const rows = await metadata.where('id').startsWith(prefix).toArray() as Row[]; guard();
    rows.sort((a, b) => (a.value.sequence ?? a.value.createdAt ?? 0) - (b.value.sequence ?? b.value.createdAt ?? 0));
    for (const row of rows) {
      guard(); if (typeof navigator !== 'undefined' && navigator.onLine === false) break;
      if (!force && (row.value.nextAttemptAt ?? 0) > Date.now()) continue;
      await process(row.id);
    }
  };
  const flush = (force = false): Promise<void> => {
    if (!current()) return Promise.resolve();
    if (flight) { repeat ||= force; return flight; }
    flight = (async () => {
      do {
        repeat = false;
        if (navigator.locks) await navigator.locks.request(`resource-commands:${owner}`, { signal: lifetime.signal }, () => drain(force));
        else await drain(force);
        force = repeat;
      } while (repeat && current());
    })().finally(() => { flight = undefined; });
    return flight;
  };
  const wake = async (force = true) => {
    guard();
    await cloudTransaction(database, [metadata], async () => {
      const rows = await metadata.where('id').startsWith(prefix).toArray() as Row[];
      for (const row of rows) if (row.value.state === 'paused') {
        guard(); await metadata.put({ ...row, value: { ...row.value, state: row.value.sent ? 'uncertain' : 'queued', attempts: 0, nextAttemptAt: 0 } });
      }
    });
    await flush(force);
  };
  const online = () => { void wake().catch(() => {}); };
  const subscription = liveQuery(() => metadata.where('id').startsWith(prefix).toArray()).subscribe({ next: (rows: Row[]) => {
    if (!current()) return;
    const waiting = rows.filter(row => !['failed', 'conflict', 'review'].includes(row.value.state));
    const issues = rows.filter(row => ['failed', 'conflict', 'review'].includes(row.value.state) && row.value.protocol === 1 && !isFact(row.value.request.operation)).map(row => ({
      id: row.id, label: resourceOperationLabel(row.value.request.operation), message: row.value.lastError ?? message(row.value.errorCode ?? ''), hasDraft: 'text' in row.value.request.operation || !!row.value.blob,
    }));
    useResourceCommands.setState({ pending: waiting.length, issues });
    clearTimeout(timer);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const due = waiting.filter(row => row.value.state !== 'paused').map(row => row.value.nextAttemptAt ?? 0);
    if (due.length) timer = setTimeout(() => { void flush().catch(() => {}); }, Math.max(100, Math.min(...due) - Date.now()));
  }, error: () => { /* A closed account database cannot wake another lifetime. */ } });
  window.addEventListener('online', online);
  const controller = { lifetime, flush, wake, stop() {
    if (stopped) return; stopped = true; clearTimeout(timer); subscription.unsubscribe(); window.removeEventListener('online', online);
    if (active === controller) { active = undefined; useResourceCommands.setState({ pending: 0, issues: [] }); }
  } };
  active = controller; lifetime.own(controller.stop);
  // A fresh signed-in page is a new bounded opportunity, not an infinite retry
  // loop. Normal queued progress still respects its debounce on this wakeup.
  void wake(false).catch(() => {});
  void compactCompletedResources(database, lifetime).catch(() => {});
}

export async function flushResourceCommands() { startResourceCommands(); await active!.flush(true); }
export async function resumeResourceCommands() { startResourceCommands(); await active!.wake(); }

/** Successful journals retain a bounded receipt, not another copy of every
 * document/video Blob. Pending/uncertain originals never participate in GC. */
async function compactCompletedResources(database: typeof db, lifetime: AccountLifetime) {
  const metadata = database.table('_cloudMeta');
  await cloudTransaction(database, [metadata], async () => {
    lifetime.assertCurrent(); if (database !== db) return;
    const rows = await metadata.where('id').startsWith('resource-completed:').toArray();
    rows.sort((a, b) => (b.value.confirmedAt ?? 0) - (a.value.confirmedAt ?? 0));
    for (const [index, row] of rows.entries()) {
      lifetime.assertCurrent();
      if (index >= 500 || row.value.confirmedAt && row.value.confirmedAt < Date.now() - 7 * 86400000) await metadata.delete(row.id);
      else if (row.value.request || row.value.blob) await metadata.put({ id: row.id, value: { operationId: row.value.request?.operationId, kind: row.value.request?.operation.kind, result: row.value.result, state: 'completed', confirmedAt: row.value.confirmedAt ?? Date.now() } });
    }
  });
}

export async function enqueueResourceCommand(operation: ResourceOperation, blob?: Blob, operationId?: string, coalesce = false) {
  const owner = cloud.userId, database = db, lifetime = accountLifetime(owner), metadata = database.table('_cloudMeta');
  const stableId = operationId === undefined ? crypto.randomUUID() : Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(operationId))), byte => byte.toString(16).padStart(2, '0')).join('');
  const canonical = JSON.stringify(operation, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  const inputDigest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical))), byte => byte.toString(16).padStart(2, '0')).join('');
  lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  let id = `${prefix}resource-${stableId}`;
  await cloudTransaction(database, [metadata], async () => {
    lifetime.assertCurrent();
    const key = group(operation);
    const scope = (await metadata.get('resource-server-scope'))?.value as string | undefined;
    if (coalesce && key) {
      const rows = await metadata.where('id').startsWith(prefix).toArray() as Row[];
      const same = rows.filter(row => row.value.protocol === 1 && row.value.request.scope === scope && group(row.value.request.operation) === key)
        .sort((a, b) => (b.value.sequence ?? 0) - (a.value.sequence ?? 0));
      if (operation.kind === 'recordPlayback' && operation.finished === undefined) {
        const explicit = same.find(row => row.value.request.operation.kind === 'recordPlayback' && row.value.request.operation.finished !== undefined)?.value.request.operation;
        if (explicit?.kind === 'recordPlayback') operation = { ...operation, finished: explicit.finished };
      }
      const previous = same.find(row => row.value.state === 'queued' && !row.value.sent);
      if (previous) {
        id = previous.id;
        let next = operation;
        if (next.kind === 'recordPlayback' && previous.value.request.operation.kind === 'recordPlayback' && next.finished === undefined && previous.value.request.operation.finished !== undefined) next = { ...next, finished: previous.value.request.operation.finished };
        // Coalesced replacements have no caller-supplied replay identity. Their
        // digest is optional until claimed; never reuse one for a new payload.
        await metadata.put({ ...previous, value: { ...previous.value, inputDigest: undefined, request: { ...previous.value.request, operation: next }, nextAttemptAt: Math.min((previous.value.createdAt ?? Date.now()) + 1000, Date.now() + 400) } });
        return;
      }
      // New-protocol progress has server-side per-field sequence fences. The
      // latest durable replacement safely supersedes older network attempts,
      // even one already in flight. Never apply this to documents, uploads,
      // historical records, or a different database scope.
      for (const row of same) if (['queued', 'uncertain', 'paused', 'failed'].includes(row.value.state)) await metadata.delete(row.id);
    }
    const existing = await metadata.get(id);
    if (existing) {
      if (JSON.stringify(existing.value.request.operation) !== JSON.stringify(operation)) throw new Error('resource_operation_id_reused');
      return;
    }
    const completed = await metadata.get(`resource-completed:resource-${stableId}`);
    if (completed) {
      if (completed.value.inputDigest && completed.value.inputDigest !== inputDigest) throw new Error('resource_operation_id_reused');
      return;
    }
    const sequence = ((await metadata.get('resource-sequence'))?.value ?? 0) + 1;
    const stream = (await metadata.get('resource-stream'))?.value ?? crypto.randomUUID();
    await metadata.bulkPut([{ id: 'resource-sequence', value: sequence }, { id: 'resource-stream', value: stream }]);
    const request: ResourceCommand = { operationId: `resource-${stableId}`, operation, ...(scope ? { scope } : {}), ...(key && operationId === undefined ? { delivery: { stream, sequence } } : {}) };
    await metadata.put({ id, value: { request, inputDigest: coalesce ? undefined : inputDigest, ...(blob ? { blob } : {}), protocol: 1, state: 'queued', sequence, createdAt: Date.now(), attempts: 0, nextAttemptAt: coalesce ? Date.now() + 400 : 0 } satisfies ResourceDraft });
    lifetime.assertCurrent();
  });
  startResourceCommands();
  // Progress is durably queued, not a per-scroll toast or a manual recovery task.
  if (coalesce) return;
  await active!.flush(true); lifetime.assertCurrent();
  const pending = await metadata.get(id) as Row | undefined;
  if (pending) throw Object.assign(new Error(pending.value.lastError ?? '正在确认保存结果，原稿已保留，请勿重复提交。'), { code: pending.value.errorCode ?? 'resource_pending', operationId: pending.value.request.operationId });
  return (await metadata.get(`resource-completed:${id.slice(prefix.length)}`))?.value.result as RuntimeJson;
}
