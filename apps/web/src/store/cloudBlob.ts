import { apiUrl } from '../api/base';
import { cloud } from '../cloud/state';
import { cloudRetry, cloudTransaction } from '../cloud/transactions';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { db } from './db';
import i18n from '../i18n';

/** Committed projections retain immutable server file references, not bytes.
 * Historical local rows/drafts can still contain real Blobs. */
export interface CloudBlobReference { $file: string; type?: string }
export type StoredBlob = Blob | CloudBlobReference;
export const isCloudBlob = (value: StoredBlob): value is CloudBlobReference => !(value instanceof Blob) && typeof value?.$file === 'string';

const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 128;
const MAX_CONCURRENT = 4;
interface CacheRow { id: string; blob: Blob; etag?: string }
interface CacheMeta { id: string; size: number; usedAt: number }
interface Downloads { lifetime: AccountLifetime; pending: Map<string, Promise<Blob>>; active: number; waiting: (() => void)[] }
let downloads: Downloads | undefined;

function accountDownloads() {
  const lifetime = accountLifetime(cloud.userId);
  if (downloads?.lifetime === lifetime) return downloads;
  const state: Downloads = { lifetime, pending: new Map(), active: 0, waiting: [] };
  downloads = state;
  lifetime.own(() => {
    if (downloads === state) downloads = undefined;
    for (const wake of state.waiting.splice(0)) wake();
    state.pending.clear();
  });
  return state;
}

/** Demand-only, account-scoped, deduplicated and concurrency-bounded. Cancelling
 * a view stops its waiter, not another view's shared immutable-file download. */
export async function resolveCloudBlob(value: StoredBlob, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  if (value instanceof Blob) return value;
  if (!isCloudBlob(value) || !cloud.enabled) throw new Error('invalid_cloud_file');
  const state = accountDownloads(), database = db;
  state.lifetime.assertCurrent();
  let pending = state.pending.get(value.$file);
  if (!pending) {
    const id = value.$file;
    pending = (async () => {
      const cached = await cloudRetry(database, () => database.table<CacheRow>('_fileCache').get(id));
      state.lifetime.assertCurrent();
      while (state.active >= MAX_CONCURRENT) {
        await new Promise<void>(resolve => state.waiting.push(resolve));
        state.lifetime.assertCurrent();
      }
      state.lifetime.assertCurrent();
      state.active++;
      try {
        const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(id)}`), {
          credentials: 'include', signal: AbortSignal.any([state.lifetime.signal, AbortSignal.timeout(30_000)]),
          // Bytes are immutable, authorization is not. Bypass the browser's
          // freshness cache and let the authenticated route validate before 304.
          cache: 'no-store', headers: cached?.etag ? { 'If-None-Match': cached.etag } : undefined,
        });
        state.lifetime.assertCurrent();
        if (response.status === 304 && cached?.etag) {
          await cloudTransaction(database, [database.table('_fileCacheMeta')], async () => {
            state.lifetime.assertCurrent();
            await database.table('_fileCacheMeta').update(id, { usedAt: Date.now() });
          }).catch(() => {});
          state.lifetime.assertCurrent();
          return cached.blob;
        }
        if ([401, 403, 404].includes(response.status)) {
          await cloudTransaction(database, [database.table('_fileCache'), database.table('_fileCacheMeta')], async () => {
            state.lifetime.assertCurrent();
            await database.table('_fileCache').delete(id);
            await database.table('_fileCacheMeta').delete(id);
          }).catch(() => {});
          state.lifetime.assertCurrent();
        }
        if (!response.ok) throw new Error(i18n.t('fileLoadFailed', { ns: 'common', status: response.status }));
        const blob = await response.blob();
        state.lifetime.assertCurrent();
        // This disposable cache must never prevent a usable download on quota
        // errors. Private drafts and the confirmed projection remain untouched.
        if (blob.size <= MAX_BYTES) await cloudTransaction(database, [database.table('_fileCache'), database.table('_fileCacheMeta')], async () => {
          state.lifetime.assertCurrent();
          const table = database.table<CacheRow>('_fileCache');
          const metadata = database.table<CacheMeta>('_fileCacheMeta');
          await table.put({ id, blob, etag: response.headers.get('etag') ?? undefined });
          await metadata.put({ id, size: blob.size, usedAt: Date.now() });
          const rows = await metadata.orderBy('usedAt').toArray();
          let bytes = rows.reduce((total, row) => total + row.size, 0), count = rows.length;
          const evict: string[] = [];
          for (const row of rows) {
            if (count <= MAX_ENTRIES && bytes <= MAX_BYTES) break;
            evict.push(row.id); bytes -= row.size; count--;
          }
          await table.bulkDelete(evict);
          await metadata.bulkDelete(evict);
          state.lifetime.assertCurrent();
        }).catch(() => {});
        state.lifetime.assertCurrent();
        return blob;
      } finally { state.active--; state.waiting.shift()?.(); }
    })().finally(() => { state.pending.delete(id); });
    state.pending.set(id, pending);
  }
  let abort: (() => void) | undefined;
  try {
    const blob = signal ? await Promise.race([pending, new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]) : await pending;
    state.lifetime.assertCurrent();
    signal?.throwIfAborted();
    return value.type && value.type !== blob.type ? new Blob([blob], { type: value.type }) : blob;
  } finally { if (abort) signal?.removeEventListener('abort', abort); }
}

/** Let the browser load images only near the viewport; no eager JS fetch/hash. */
export function cloudBlobUrl(value: StoredBlob): string | undefined {
  return isCloudBlob(value) ? apiUrl(`/api/v1/files/${encodeURIComponent(value.$file)}`) : undefined;
}
