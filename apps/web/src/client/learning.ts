import type { ClientLearningCommand, ClientLearningEdit, RuntimeRecordsReceipt } from '@wangke/contracts/client-runtime';
import { db, type CardRow, type HandoutRow, type ChatRow, type ChatSessionRow, type SkillRow, type SkillRefRow } from '../store/db';
import type { InkStroke } from '../materials/ink';
import { cloud } from '../cloud/state';
import { cloudTransaction } from '../cloud/transactions';
import { serverRuntime, isCurrentServerRuntime } from './bootstrap';
import type { DurableCommand } from '@wangke/client-core';
import { commandDigest } from './command-digest';
import { accountLifetime } from './account-lifecycle';
import Dexie from 'dexie';
import { cloudDatabaseName } from '../store/db';

export interface LearningCommandRow {
  sequence?: number;
  operationId: string;
  request: ClientLearningCommand;
  entities: string[];
  state: 'queued' | 'uncertain' | 'conflict' | 'confirmed';
  createdAt: number;
  wireRequest?: ClientLearningCommand;
  error?: string;
  receipt?: RuntimeRecordsReceipt;
  inputDigest?: string;
}
export const learningId = () => {
  const value = crypto.getRandomValues(new Uint32Array(2));
  return (value[0] & 0xfffff) * 0x100000000 + value[1] || 1;
};
type NewEdit<T = ClientLearningEdit> = T extends ClientLearningEdit ? Omit<T, 'mutationId'> : never;
export const learningEdit = (value: NewEdit): ClientLearningEdit => ({ ...value, mutationId: crypto.randomUUID() }) as ClientLearningEdit;
const flights = new WeakMap<typeof db, Map<string, { promise: Promise<void>; again: boolean }>>();

/** Exact domain intent is durable before a carrier or receipt request is opened.
 * Pending values stay in this journal, never in committed business tables. */
export async function queueLearning(edits: ClientLearningEdit[], entities: string[], operationId: string = crypto.randomUUID()) {
  const database = db, owner = cloud.userId;
  if (!cloud.enabled || !owner) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(owner);
  const guard = () => { lifetime.assertCurrent(); if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  return persistLearning(database, edits, entities, operationId, guard);
}

async function persistLearning(database: Dexie, edits: ClientLearningEdit[], entities: string[], operationId: string, guard: () => void) {
  guard();
  // Transport mutation IDs and the study receipt timestamp are not user intent.
  // A duplicate intent retains the originally journaled request verbatim.
  const inputDigest = await commandDigest(edits.map(({ mutationId: _id, baseRevision: _revision, ...edit }) => {
    if (edit.kind !== 'studyTime') return edit;
    const { updatedAt: _time, ...delta } = edit;
    return delta;
  }));
  guard();
  await cloudTransaction(database, [database.table('_learningCommands'), database.table('_cloudMeta')], async () => {
    guard();
    const old = await database.table<LearningCommandRow>('_learningCommands').where('operationId').equals(operationId).first();
    const completed = await database.table('_cloudMeta').get(`learning-completed:${operationId}`);
    if (old || completed) {
      if ((old?.inputDigest ?? completed?.value?.inputDigest) !== inputDigest) throw new Error('learning_operation_id_reused');
      return;
    }
    const versioned: ClientLearningEdit[] = [];
    for (const edit of edits) {
      const tables = { conversationMessage: 'chats', conversationSession: 'chatSessions', skillDefinition: 'skills', skillReference: 'skillRefs', materialAnnotation: 'materialInk', handoutDocument: 'handouts' } as const;
      if (edit.kind in tables) {
        const document = edit as Extract<ClientLearningEdit, { value: unknown }>;
        const key = (document.value ?? document.expected)!.id;
        const revision = (await database.table('_cloudMeta').get(`revision:${tables[edit.kind as keyof typeof tables]}:${JSON.stringify(key)}`))?.value;
        // Scoped reads can carry their own authoritative version without first
        // publishing a partial collection into IDB. Never replace it with an
        // unrelated/stale mirror version.
        const baseRevision = edit.baseRevision ?? revision;
        versioned.push({ ...edit, ...(baseRevision === undefined ? {} : { baseRevision }) });
      } else versioned.push(edit);
    }
    guard();
    await database.table<LearningCommandRow>('_learningCommands').add({ operationId, request: { operationId, edits: versioned },
      entities, inputDigest, state: 'queued', createdAt: Date.now() });
  });
  guard();
  return operationId;
}

/** Conflicts block only subsequent commands touching the same entity. Receipt
 * lookup always precedes replay. SQL-only edits are replay-safe; skill/file
 * intents with an uncertain receipt are not treated as missing. */
export async function drainLearning(entities?: readonly string[]) {
  const database = db, owner = cloud.userId;
  let group = flights.get(database);
  if (!group) { group = new Map(); flights.set(database, group); }
  const key = entities ? [...entities].sort().join('|') : '*';
  const previous = group.get(key);
  if (previous) { previous.again = true; return previous.promise; }
  const entry = { promise: undefined as unknown as Promise<void>, again: false };
  const promise = (async () => {
    const runtime = await serverRuntime(owner);
    const { DurableCommands } = await import('@wangke/client-core');
    const guard = () => { if (database !== db || owner !== cloud.userId || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
    const table = database.table<LearningCommandRow>('_learningCommands');
    const update = async (operationId: string, patch: Partial<LearningCommandRow>) => { guard(); await table.where('operationId').equals(operationId).modify(patch); };
    const commands = new DurableCommands<ClientLearningCommand>({
      list: async () => (await table.orderBy('sequence').toArray()).filter(row => row.state !== 'confirmed'
        && (!entities || row.entities.some(entity => entities.includes(entity)))) as DurableCommand<ClientLearningCommand>[],
      save: command => update(command.operationId, { state: command.state, error: command.error }),
      remove: async operationId => { guard(); await table.where('operationId').equals(operationId).delete(); },
      acknowledge: (operationId, value) => update(operationId, { state: 'confirmed', receipt: value as RuntimeRecordsReceipt, error: undefined }),
    }, {
      current: () => database === db && owner === cloud.userId && isCurrentServerRuntime(runtime),
      replaySafe: true, isolateFailures: true, receipt: runtime.receipt,
      send: async request => {
        const command = await table.where('operationId').equals(request.operationId).first(); guard();
        if (!command) throw new Error('learning_command_missing');
        const wireRequest = command.wireRequest ?? await encodeLearning(request, database, guard) as ClientLearningCommand;
        await update(request.operationId, { wireRequest }); guard();
        return runtime.editLearning(wireRequest);
      },
    });
    const run = async () => {
      do {
        entry.again = false;
        await commands.drain();
        guard();
        const confirmed = (await table.orderBy('sequence').toArray()).filter(row => row.state === 'confirmed'
          && (!entities || row.entities.some(entity => entities.includes(entity))));
        for (const command of confirmed) { guard(); await (await import('../cloud/sync')).reconcileLearningProjection(command); }
      } while (entry.again);
    };
    if (navigator.locks) await navigator.locks.request(`learning:${owner}`, run); else await run();
  })().finally(() => { if (group.get(key) === entry) group.delete(key); });
  entry.promise = promise; group.set(key, entry);
  return promise;
}

async function encodeLearning(value: unknown, database: typeof db, guard: () => void): Promise<unknown> {
  if (value instanceof Blob) {
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer())), b => b.toString(16).padStart(2, '0')).join(''); guard();
    const known = await database.table('_cloudBlobs').get(hash);
    guard();
    if (known) return { $file: known.id, type: value.type };
    const { apiUrl } = await import('../api/base');
    guard();
    const response = await fetch(apiUrl('/api/v1/files'), { method: 'POST', credentials: 'include', headers: {
      'content-type': 'application/octet-stream', 'x-file-name': 'learning-attachment', 'x-file-mime': value.type || 'application/octet-stream',
    }, body: value });
    if (!response.ok) throw new Error(`附件上传尚未确认（${response.status}）`);
    const file = await response.json(); guard();
    await database.table('_cloudBlobs').put({ hash, id: file.id });
    return { $file: file.id, type: value.type };
  }
  if (Array.isArray(value)) return Promise.all(value.map(item => encodeLearning(item, database, guard)));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).filter(([, item]) => item !== undefined).map(async ([key, item]) => [key, await encodeLearning(item, database, guard)])));
  return value;
}

export async function submitLearning(edits: ClientLearningEdit[], entities: string[], id?: string, waitProjection = true) {
  const database = db, owner = cloud.userId;
  const guard = () => { if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  const operationId = await queueLearning(edits, entities, id);
  guard();
  await drainLearning(waitProjection ? undefined : entities);
  guard();
  const command = await database.table<LearningCommandRow>('_learningCommands').where('operationId').equals(operationId).first();
  guard();
  if (command && command.state !== 'confirmed') throw new Error(command.error ?? '修改已保存在待提交操作中，连接恢复后将继续核对');
  // drainLearning already atomically publishes the receipt's exact keys. A
  // global records pull is neither necessary nor a valid domain barrier.
  if (waitProjection && command) throw new Error('learning_receipt_projection_unavailable');
}

export async function editMessage(expected: ChatRow | null, value: ChatRow | null) {
  await submitLearning([learningEdit({ kind: 'conversationMessage', expected, value } as any)], [`message:${(value ?? expected)!.id}`, `session:${(value ?? expected)!.sessionId}`]);
}
export async function editSession(expected: ChatSessionRow | null, value: ChatSessionRow | null) {
  await submitLearning([learningEdit({ kind: 'conversationSession', expected, value } as any)], [`session:${(value ?? expected)!.id}`]);
}
export async function reviewCard(cardId: number, status: 0 | 1 | 2, expected: 0 | 1 | 2) {
  const database = db;
  const row = cloud.enabled ? (await (await import('../cloud/sync')).readRecordKeys<CardRow>('cards', [cardId]))[0] : await database.cards.get(cardId);
  if (database !== db) throw new Error('client_account_changed');
  if (!row) throw new Error('卡片已删除');
  await submitLearning([learningEdit({ kind: 'reviewCard', courseId: row.videoId, cardId, expected, status })], [`card:${cardId}`]);
}
export async function saveHandoutReading(handoutId: number, position: { anchor: string; offset: number }) {
  const database = db;
  const row = cloud.enabled ? (await (await import('../cloud/sync')).readRecordKeys<HandoutRow>('handouts', [handoutId]))[0] : await database.handouts.get(handoutId);
  if (database !== db) throw new Error('client_account_changed');
  if (row) await submitLearning([learningEdit({ kind: 'handoutReading', courseId: row.videoId, handoutId, position })], [`handout:${handoutId}`]);
}
export async function addStudyTime(entries: [string, number][], operationId: string = crypto.randomUUID()) {
  const database = db, lifetime = accountLifetime(cloud.userId);
  const now = Date.now();
  const edits = entries.map(([date, seconds], index) => ({ kind: 'studyTime' as const, date, seconds, updatedAt: now, mutationId: `${operationId}:${index}` }));
  // Durability (not network completion) is the barrier before the counter drops
  // its memory delta. A failed carrier must never add the same delta a second time.
  await queueLearning(edits, ['study:all', ...entries.map(([date]) => `study:${date}`)], operationId);
  if (lifetime.current() && database === db) void drainLearning().catch(() => {});
}

/** Only the tracker can retain this narrow, immutable journal destination. It
 * may finish recording already measured seconds after logout, but can never
 * access the next account's connection or send a request as that account. Open
 * an EXISTING database without a schema: deletion must not recreate an old DB.
 * No committed records, general edits, or network capability are exposed. */
export function captureStudyTimeWriter(): (entries: [string, number][], operationId: string) => Promise<void> {
  const original = db, owner = cloud.userId;
  if (!cloud.enabled || !owner || original.name !== cloudDatabaseName(owner)) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(owner);
  lifetime.assertCurrent();
  const name = original.name;
  return async (entries, operationId) => {
    if (!entries.length || entries.length > 32 || entries.some(([date, seconds]) => !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(seconds) || seconds <= 0)) throw new Error('invalid_study_delta');
    const database = new Dexie(name);
    try {
      await database.open();
      const now = Date.now();
      const edits = entries.map(([date, seconds], index) => ({ kind: 'studyTime' as const, date, seconds, updatedAt: now, mutationId: `${operationId}:${index}` }));
      await persistLearning(database, edits, ['study:all', ...entries.map(([date]) => `study:${date}`)], operationId, () => {});
    } finally { database.close(); }
    if (lifetime.current() && original === db && owner === cloud.userId) void drainLearning().catch(() => {});
  };
}
export async function clearStudyTime(expected: { date: string; seconds: number; updatedAt: number }[] | string, operationId: string = crypto.randomUUID()) {
  const edit = typeof expected === 'string' ? { kind: 'clearStudySnapshot' as const, snapshot: expected, mutationId: `${operationId}:clear` }
    : { kind: 'clearStudyTime' as const, expected, mutationId: `${operationId}:clear` };
  await submitLearning([edit], ['study:all'], operationId);
}
export async function saveAnnotations(materialId: string, remove: InkStroke[], add: InkStroke[], operationId: string = crypto.randomUUID(), durableOnly = false) {
  const edits: ClientLearningEdit[] = [...remove.map(expected => ({ kind: 'materialAnnotation' as const, expected, value: null })),
    ...add.map(value => ({ kind: 'materialAnnotation' as const, expected: null, value }))].map((edit, index) => ({ ...edit, mutationId: `${operationId}:${index}` }));
  if (durableOnly) {
    const database = db;
    await queueLearning(edits, [`ink:${materialId}`], operationId);
    // UI input must not wait for the carrier before journaling the next stroke.
    void import('../cloud/sync').then(module => { if (database === db) return module.flushCloud(); }).catch(() => {});
  } else await submitLearning(edits, [`ink:${materialId}`], operationId);
}
export async function saveSkillPackage(expected: SkillRow | null, value: SkillRow | null, references: Omit<SkillRefRow, 'skillId'>[], expectedReferences?: SkillRefRow[]) {
  const database = db;
  const lifetime = cloud.enabled ? accountLifetime(cloud.userId) : undefined;
  lifetime?.assertCurrent();
  const skillId = (value ?? expected)!.id!;
  const snapshot = expected && cloud.enabled ? await (await import('../skills/demand')).readSkillReferenceSnapshot(skillId) : undefined;
  const old = !expected ? [] : snapshot
    ? snapshot.records.map(row => ({ value: row.value as unknown as SkillRefRow, revision: row.revision }))
    : (await database.skillRefs.where('skillId').equals(skillId).toArray()).map(value => ({ value, revision: undefined }));
  lifetime?.assertCurrent();
  if (database !== db) throw new Error('client_account_changed');
  if (expectedReferences) {
    const canonical = (refs: SkillRefRow[]) => JSON.stringify(refs.map(ref => [ref.id, ref.skillId, ref.path, ref.body]).sort((a, b) => Number(a[0]) - Number(b[0])));
    // Do not silently overwrite reference edits made after this editor opened.
    // Subsequent races on existing rows are still guarded by their revisions.
    if (canonical(expectedReferences) !== canonical(old.map(ref => ref.value))) throw new Error('skill_references_changed');
  }
  const definition = learningEdit({ kind: 'skillDefinition', expected, value, ...(snapshot ? { referencesSnapshot: { epoch: snapshot.epoch, version: snapshot.version } } : {}) } as any);
  const removed = old.map(ref => learningEdit({ kind: 'skillReference', expected: ref.value, value: null, ...(ref.revision === undefined ? {} : { baseRevision: ref.revision }) } as any));
  const added = references.map(ref => learningEdit({ kind: 'skillReference', expected: null, value: { ...ref, id: learningId(), skillId } } as any));
  await submitLearning(value ? [definition, ...removed, ...added] : [...removed, definition], [`skill:${skillId}`]);
}
