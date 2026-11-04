import type { LearningProduct, LearningProductCommand, LearningBlob, LearningCourseState } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from './state';
import { executorRuntime } from './executor-runtime';
import { cloudTransaction } from './transactions';
import { markCloudApply } from './cache';
import { apiUrl } from '../api/base';

type BrowserValue<T> = T extends LearningBlob ? Blob : T extends (infer U)[] ? BrowserValue<U>[] : T extends object ? { [K in keyof T]: BrowserValue<T[K]> } : T;
export type BrowserLearningProduct = BrowserValue<LearningProduct>;
const targets = { transcriptSegment: 'segments', subtitleTrack: 'subtitleTracks', materialBlock: 'materialBlocks', slideFrame: 'frames', courseCover: 'covers', handoutDocument: 'handouts', candidateCard: 'cards', courseComment: 'comments', courseDanmaku: 'danmakus', conversationMessage: 'chats', conversationSession: 'chatSessions' } as const;
export const learningId = () => { const n = crypto.getRandomValues(new Uint32Array(2)); return (n[0] & 0xfffff) * 0x100000000 + n[1] || 1; };

/** Producers choose a closed product kind before any storage operation. The
 * Server adapter journals those products directly; it never observes DB writes
 * or guesses a product from a table. Only the Local/cache adapter maps kinds. */
async function applyProducts(products: BrowserLearningProduct[]) {
  for (const product of products) {
    if (product.kind === 'courseDerivation') { await db.videos.update(product.courseId, product.value); continue; }
    const table = db.table(targets[product.kind]);
    const row = product.value ?? product.expected;
    if (!row) throw new Error('learning_product_identity_missing');
    const key = product.kind === 'courseCover' ? (row as any).videoId : (row as any).id;
    if (product.value) await table.put(product.value); else await table.delete(key);
  }
}

export async function publishLearningProducts(products: BrowserLearningProduct[]) {
  if (!products.length) return;
  if (!cloud.enabled) { await db.transaction('rw', db.tables, () => applyProducts(products)); return; }
  if (!cloud.worker || !cloud.taskId || !cloud.workerToken) throw new Error('executor_capability_missing');
  const taskId = cloud.taskId, token = cloud.workerToken, database = db;
  const credentialHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(n => n.toString(16).padStart(2, '0')).join('');
  if (database !== db || cloud.taskId !== taskId || cloud.workerToken !== token) throw new Error('executor_task_changed');
  const operationId = `products-${crypto.randomUUID()}`;
  const commands = products.map(product => ({ ...product, mutationId: crypto.randomUUID(), ...(cloud.permissionId ? { permissionId: cloud.permissionId } : {}) }));
  await database.table('_cloudMeta').put({ id: `executor-products:${operationId}`, value: { operationId, taskId, credentialHash, products: commands, state: 'queued' } });
  await flushLearningProducts();
}

let flight: Promise<void> | undefined;
export async function flushLearningProducts(): Promise<void> {
  if (!cloud.worker || !cloud.taskId || !cloud.workerToken) return;
  if (flight) { await flight; return flushLearningProducts(); }
  const pending = async () => {
    const database = db, taskId = cloud.taskId, token = cloud.workerToken;
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))].map(n => n.toString(16).padStart(2, '0')).join('');
    const current = () => { if (database !== db || taskId !== cloud.taskId || token !== cloud.workerToken) throw new Error('executor_task_changed'); };
    const runtime = await executorRuntime(); current();
    for (const stored of await database.table('_cloudMeta').filter(row => row.id.startsWith('executor-products:')).toArray()) {
      const draft = stored.value;
      if (stored.status === 'archived') continue;
      if (draft.taskId !== taskId || draft.credentialHash !== hash) {
        await database.transaction('rw', database.table('_cloudMeta'), async () => {
          await database.table('_cloudMeta').put({ ...stored, id: `executor-recovery:${draft.operationId}`, reason: 'expired-product-capability', status: 'requires-reconciliation' });
          await database.table('_cloudMeta').delete(stored.id);
        });
        continue;
      }
      const encode = async (value: any): Promise<any> => {
        if (value instanceof Blob) {
          const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await value.arrayBuffer()))].map(n => n.toString(16).padStart(2, '0')).join('');
          const known = await database.table('_cloudBlobs').get(digest);
          if (known && (known.origin === 'download' || known.taskId === taskId && known.credentialHash === hash)) return { $file: known.id, type: value.type };
          const blobKey = `executor-product-blob:${taskId}:${digest}`;
          const saved = await database.table('_cloudMeta').get(blobKey);
          if (saved) {
            // Old unadmitted uploads have no safe receipt identity. Never infer
            // success by hash or retransmit a pending/unknown binary effect.
            if (!saved.value.operationId || saved.value.credentialHash !== hash || saved.status === 'archived') throw new Error('executor_product_blob_uncertain');
            const receipt = await runtime.receipt(saved.value.operationId); current();
            if (receipt.status !== 'completed') throw new Error('executor_product_blob_uncertain');
            const file = (receipt.value as any).file;
            if (!file || file.sha256 !== digest || file.sizeBytes !== value.size) throw new Error('executor_product_blob_receipt_mismatch');
            await database.transaction('rw', database.table('_cloudBlobs'), database.table('_cloudMeta'), async () => {
              await database.table('_cloudBlobs').put({ hash: digest, id: file.id, taskId, credentialHash: hash });
              await database.table('_cloudMeta').put({ ...saved, id: `executor-blob-completed:${saved.value.operationId}`, value: { ...saved.value, receipt, state: 'completed' } });
              await database.table('_cloudMeta').delete(blobKey);
            });
            return { $file: file.id, type: value.type };
          }
          const operationId = `product-blob-${crypto.randomUUID()}`;
          const request = { operationId, sha256: digest, size: value.size, contentType: value.type };
          current(); await database.table('_cloudMeta').put({ id: blobKey, value: { operationId, taskId, credentialHash: hash, parentOperationId: draft.operationId, request, blob: value, state: 'uncertain' } });
          await runtime.admitBlob(request); current();
          const response = await fetch(apiUrl(`/api/v1/files?operationId=${encodeURIComponent(operationId)}`), { method: 'POST', credentials: 'omit', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', 'x-file-name': 'cache-blob', 'x-file-mime': value.type || 'application/octet-stream' }, body: value });
          if (!response.ok) throw new Error(`executor_product_blob_${response.status}`);
          const file = await response.json(); current();
          if (file.sha256 !== digest || file.sizeBytes !== value.size) throw new Error('executor_product_blob_receipt_mismatch');
          await database.transaction('rw', database.table('_cloudBlobs'), database.table('_cloudMeta'), async () => { await database.table('_cloudBlobs').put({ hash: digest, id: file.id, taskId, credentialHash: hash }); await database.table('_cloudMeta').delete(blobKey); });
          return { $file: file.id, type: value.type };
        }
        if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await encode(item)); return out; }
        if (value && typeof value === 'object') { const out: Record<string, any> = {}; for (const [key, item] of Object.entries(value)) if (item !== undefined) out[key] = await encode(item); return out; }
        return value;
      };
      if (!draft.request) { draft.request = await encode(draft.products); current(); await database.table('_cloudMeta').put({ id: stored.id, value: draft }); }
      current();
      const result = await runtime.commitArtifacts(draft.operationId, draft.request as LearningProductCommand[]); current();
      await cloudTransaction(database, database.tables, async () => {
        current(); markCloudApply(); await applyProducts(draft.products);
        await database.table('_cloudMeta').bulkPut(result.versions.map(row => ({ id: `revision:${row.table}:${JSON.stringify(row.key)}`, value: row.revision })));
        await database.table('_cloudMeta').delete(stored.id);
      });
    }
  };
  flight = pending();
  try { await flight; } finally { flight = undefined; }
}

export async function publishCourseDerivation(courseId: string, value: LearningCourseState) {
  const course = await db.videos.get(courseId);
  if (!course) throw new Error('course_not_found');
  const expected = Object.fromEntries(Object.keys(value).filter(key => (course as any)[key] !== undefined).map(key => [key, (course as any)[key]]));
  await publishLearningProducts([{ kind: 'courseDerivation', courseId, expected, value }]);
}
