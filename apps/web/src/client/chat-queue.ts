import { SessionQueueModel, type SessionQueueItem } from '@wangke/client-core';
import type { RuntimeTaskSubmit } from '@wangke/contracts/client-runtime';
import type { CloudTask } from '@wangke/contracts/cloud';
import type { ChatAttachment } from '../chat/attachments';
import { db } from '../store/db';
import { cloudTransaction } from '../cloud/transactions';
import { cloud } from '../cloud/state';
import { createServerChatExecution } from './chat-server-execution';
import { API_BASE_URL } from '../api/base';
import { accountLifecycle } from './account-lifecycle';

type Item = SessionQueueItem<ChatAttachment>;
type Journal = Parameters<typeof SessionQueueModel.commands<ChatAttachment, RuntimeTaskSubmit, CloudTask>>[0];
type Record = NonNullable<Parameters<Parameters<Journal['atomic']>[1]>[0]>;
function readDraftOwner() {
  try {
    const previous = sessionStorage.getItem('wangke-chat-draft-owner');
    if (previous) return previous;
    const id = crypto.randomUUID(); sessionStorage.setItem('wangke-chat-draft-owner', id); return id;
  } catch { return crypto.randomUUID(); }
}
let draftOwner = readDraftOwner();
let accountLifetime = 0;
if (typeof window !== 'undefined') window.addEventListener('wangke:bot-session-ended', () => { accountLifetime++; });
export function beginChatDraft() {
  draftOwner = crypto.randomUUID();
  try { sessionStorage.setItem('wangke-chat-draft-owner', draftOwner); } catch { /* storage may be denied */ }
}

/** Private local metadata, NOT records/outbox data and never uploaded. The
 * existing task-command:* records remain the only task receipt journal. */
export function browserChatQueue() {
  const database = db;
  const owner = accountLifecycle.current();
  const lifetime = accountLifetime;
  const account = cloud.userId;
  const server = API_BASE_URL || (typeof location === 'undefined' ? 'local' : location.origin);
  const serverExecution = createServerChatExecution();
  const namespace = JSON.stringify([server, account, 'server', 'interactive']);
  const draft = draftOwner;
  const draftId = `session-draft:${namespace}:${draft}`;
  const prefix = `session-queue:${namespace}:`;
  const current = () => lifetime === accountLifetime && database === db && account === cloud.userId && (!owner || owner.current());
  const check = () => { if (!current()) throw new Error('client_account_changed'); };
  const table = database.table('_cloudMeta');
  const journal: Journal = {
    atomic: (operationId, change) => cloudTransaction(database, [table], async () => {
      check();
      const id = prefix + operationId;
      const saved = await table.get(id);
      if (saved?.removed) throw new Error('session_queue_removed');
      const receiptId = `task-command:${operationId}`;
      const receipt = await table.get(receiptId);
      const previous = saved?.record ? { ...saved.record, ...(receipt?.command ? { request: receipt.command } : {}) } : undefined;
      const result = change(previous);
      if (result.record) {
        const { request, ...record } = result.record;
        // The canonical task-command record owns the frozen request; queue
        // metadata stores only its operationId/reference, never a second receipt.
        if (request && !receipt) await table.put({ id: receiptId, command: request, status: 'pending', createdAt: Date.now() });
        await table.put({ id, record });
      }
      return result.value;
    }),
  };
  const commands = SessionQueueModel.commands<ChatAttachment, RuntimeTaskSubmit, CloudTask>(journal, {
    current,
    prepare: (request, item) => request.input.action === 'continue' ? request : {
      ...request, input: { ...request.input, text: item.text, attachments: JSON.parse(JSON.stringify(item.attachments ?? [])), explicitSkillIds: item.explicitSkillIds ?? [], ...(item.modelSelection ? { modelSelection: JSON.parse(JSON.stringify(item.modelSelection)) } : {}), ...(item.thinkingLevel ? { thinkingLevel: item.thinkingLevel } : {}) },
    },
    receipt: operationId => { check(); return serverExecution.receipt(operationId); },
    submit: request => {
      check();
      return serverExecution.submit(request);
    },
  });
  return {
    current,
    async save(sessionId: number, item: Item) {
      check();
      await cloudTransaction(database, [table], async () => {
        const target = sessionId === 0 ? (await table.get(draftId))?.sessionId ?? 0 : sessionId;
        await journal.atomic(item.operationId ?? item.id, old => ({
          record: old && old.state !== 'pending' ? old : { sessionId: target, item: sessionId === 0 ? { ...item, draftOwner: draft } : item, state: 'pending' }, value: undefined,
        }));
      });
    },
    async rekeyDraft(sessionId: number) {
      await cloudTransaction(database, [table], async () => {
        check();
        await table.put({ id: draftId, sessionId });
        const rows = await table.where('id').startsWith(prefix).toArray();
        for (const row of rows) if (!row.removed && row.record.sessionId === 0 && row.record.item.draftOwner === draft) await table.put({ ...row, record: { ...row.record, sessionId } });
      });
    },
    async remove(sessionId: number, ids: string[]) {
      await cloudTransaction(database, [table], async () => {
        check();
        for (const operationId of ids) {
          const id = prefix + operationId, row = await table.get(id);
          if (row?.record.sessionId === sessionId && row.record.state === 'pending') await table.put({ ...row, removed: true });
        }
      });
    },
    async list(sessionId: number): Promise<Item[]> {
      check();
      const rows = await table.where('id').startsWith(prefix).toArray();
      // Only read admission. A missing receipt for a claimed item is NOT proof
      // that the original command never arrived at the Host.
      for (const row of rows) {
        const record: Record = row.record;
        if (row.removed || record.sessionId !== sessionId || record.state !== 'uncertain') continue;
        const receipt = await serverExecution.receipt(record.item.operationId ?? record.item.id).catch(() => undefined);
        check();
        const taskId = receipt?.status === 'accepted' ? receipt.task?.id : undefined;
        if (taskId) await journal.atomic(record.item.operationId ?? record.item.id, latest => ({ record: latest ? { ...latest, state: 'accepted', taskId } : latest, value: undefined }));
      }
      check();
      return (await table.where('id').startsWith(prefix).toArray())
        .filter(row => !row.removed && row.record.sessionId === sessionId && row.record.state !== 'accepted')
        .filter(row => sessionId !== 0 || row.record.item.draftOwner === draft)
        .sort((a,b) => (a.record.item.createdAt ?? 0) - (b.record.item.createdAt ?? 0) || a.id.localeCompare(b.id))
        .map(row => ({ ...row.record.item, state: row.record.state }));
    },
    async submit(sessionId: number, item: Item, input: object, explicitRetry = false) {
      check();
      const operationId = item.operationId ?? item.id;
      const execute = () => commands.execute(sessionId, { ...item, createdAt: item.createdAt ?? Date.now() }, { operationId, kind: 'chat', resource: `session:${sessionId}`, input: JSON.parse(JSON.stringify(input)) }, explicitRetry);
      if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(prefix + operationId, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('task_admission_uncertain');
        return execute();
      });
      if (explicitRetry) throw new Error('cross_tab_lock_required');
      return execute();
    },
    async retry(operationId: string): Promise<CloudTask | undefined> {
      check();
      const saved = await table.get(prefix + operationId);
      check();
      if (!saved || saved.removed) return;
      const receipt = await table.get(`task-command:${operationId}`);
      if (!receipt?.command) throw new Error('task_original_command_missing');
      if (typeof navigator === 'undefined' || !navigator.locks) throw new Error('cross_tab_lock_required');
      return navigator.locks.request(prefix + operationId, { ifAvailable: true }, lock => {
        if (!lock) throw new Error('task_admission_uncertain');
        const record: Record = saved.record;
        return commands.execute(record.sessionId, record.item, receipt.command, true);
      });
    },
    /** Queue deletion only releases truly unreferenced local blobs. Remote file
     * references can be shared with server history not cached on this device;
     * their lifetime belongs to the authenticated file store, never this queue. */
    async releaseAttachment(file: ChatAttachment) {
      check();
      await cloudTransaction(database, [table, database.chats, database.files], async () => {
        check();
        const rows = await table.where('id').startsWith('session-queue:').toArray();
        if (rows.some(row => !row.removed && row.record?.item.attachments?.some((other: ChatAttachment) => other.id === file.id))) return;
        if (await database.chats.filter(row => !!row.attachments?.some(other => other.id === file.id)).count()) return;
        if (!file.serverId) await database.files.delete(file.id);
      });
    },
  };
}

/** Integration point for the global task-recovery UI: undefined means this is
 * not an ordinary chat queue operation, so its existing recovery can handle it. */
export function retryQueuedChatOperation(operationId: string) {
  return browserChatQueue().retry(operationId);
}
