import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import * as storage from '../apps/web/src/store/db.ts';
import { cloud } from '../apps/web/src/cloud/state.ts';
import { accountLifecycle } from '../apps/web/src/client/account-lifecycle.ts';
import { resolveCloudBlob, cloudBlobUrl } from '../apps/web/src/store/cloudBlob.ts';

const originalFetch = globalThis.fetch;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await tick(); }
  throw new Error('fixture did not settle');
}
test('demand-only file loading, bounded caching and account fences', async t => {
  const databases = new Set();
  async function account() {
    const owner = `blob-test-${crypto.randomUUID()}`;
    cloud.enabled = true; cloud.userId = owner;
    storage.useCloudDatabase(owner); await storage.db.open();
    databases.add(storage.db);
    return storage.db;
  }
  try {
    await t.test('local Blobs and lazy image URLs do not download anything', async () => {
      await account();
      globalThis.fetch = () => { throw new Error('unexpected download'); };
      const local = new Blob(['local']);
      assert.equal(await resolveCloudBlob(local), local);
      assert.match(cloudBlobUrl({ $file: 'image id', type: 'image/png' }), /\/api\/v1\/files\/image%20id$/);
      assert.equal(cloudBlobUrl(local), undefined);
    });
    await t.test('concurrent readers share one GET; disk bytes require authenticated 304 after lifetime replacement', async () => {
      const db = await account(); let calls = 0;
      globalThis.fetch = async (_url, init) => {
        calls++;
        assert.equal(init.credentials, 'include'); assert.equal(init.cache, 'no-store');
        if (calls === 1) return new Response('bytes', { headers: { etag: '"immutable-hash"' } });
        assert.equal(init.headers['If-None-Match'], '"immutable-hash"');
        return new Response(null, { status: 304 });
      };
      const ref = { $file: 'immutable', type: 'image/png' };
      const blobs = await Promise.all(Array.from({ length: 12 }, () => resolveCloudBlob(ref)));
      assert.equal(calls, 1);
      assert.ok(blobs.every(blob => blob.type === 'image/png'));
      assert.equal(await blobs[0].text(), 'bytes');
      assert.equal(await db.table('_fileCache').count(), 1);
      accountLifecycle.invalidate();
      assert.equal(await (await resolveCloudBlob(ref)).text(), 'bytes');
      assert.equal(calls, 2, 'persistent bytes are reused only after current server authorization');
      assert.equal(await db.table('_fileCache').count(), 1);
    });
    await t.test('cached files cannot bypass same-account revocation or offline authorization checks', async () => {
      const db = await account();
      for (const status of [401, 403, 404]) {
        const id = `revoked-${status}`;
        globalThis.fetch = async () => new Response('secret', { headers: { etag: '"hash"' } });
        assert.equal(await (await resolveCloudBlob({ $file: id })).text(), 'secret');
        globalThis.fetch = async (_url, init) => {
          assert.equal(init.headers['If-None-Match'], '"hash"');
          return new Response('', { status });
        };
        await assert.rejects(resolveCloudBlob({ $file: id }), new RegExp(String(status)));
        assert.equal(await db.table('_fileCache').get(id), undefined);
        assert.equal(await db.table('_fileCacheMeta').get(id), undefined);
        globalThis.fetch = async () => { throw new TypeError('offline'); };
        await assert.rejects(resolveCloudBlob({ $file: id }), /offline/);
      }
      globalThis.fetch = async () => new Response('cached', { headers: { etag: '"hash"' } });
      await resolveCloudBlob({ $file: 'offline-warm' });
      globalThis.fetch = async () => { throw new TypeError('offline'); };
      await assert.rejects(resolveCloudBlob({ $file: 'offline-warm' }), /offline/, 'offline does not imply authorization');
    });
    await t.test('legacy cache rows without ETag are revalidated with a full response', async () => {
      const db = await account();
      await db.table('_fileCache').put({ id: 'legacy', blob: new Blob(['old']) });
      await db.table('_fileCacheMeta').put({ id: 'legacy', size: 3, usedAt: 1 });
      globalThis.fetch = async (_url, init) => {
        assert.equal(init.headers, undefined);
        return new Response('current', { headers: { etag: '"new"' } });
      };
      assert.equal(await (await resolveCloudBlob({ $file: 'legacy' })).text(), 'current');
      assert.equal((await db.table('_fileCache').get('legacy')).etag, '"new"');
    });
    await t.test('at most four downloads; cancelling a waiter does not cancel another reader', async () => {
      await account(); let active = 0, peak = 0, calls = 0;
      const releases = [];
      globalThis.fetch = async () => {
        calls++; peak = Math.max(peak, ++active);
        await new Promise(resolve => releases.push(() => { active--; resolve(); }));
        return new Response('bounded');
      };
      const controller = new AbortController();
      const cancelled = resolveCloudBlob({ $file: '0' }, controller.signal);
      const rejected = assert.rejects(cancelled, /view closed/);
      const pending = Promise.all(Array.from({ length: 9 }, (_, i) => resolveCloudBlob({ $file: String(i) })));
      await until(() => releases.length === 4);
      controller.abort(new Error('view closed')); await rejected;
      assert.equal(calls, 4);
      while (calls < 9 || active) {
        for (const release of releases.splice(0)) release();
        await tick();
      }
      assert.equal((await pending).length, 9);
      assert.equal(peak, 4);
    });
    await t.test('a failed GET can be retried; disposable-cache quota failures do not break reads', async () => {
      const db = await account(); let calls = 0;
      globalThis.fetch = async () => ++calls === 1 ? new Response('', { status: 503 }) : new Response('recovered');
      await assert.rejects(resolveCloudBlob({ $file: 'retry' }), /503/);
      const table = db.table('_fileCache'), put = table.put;
      table.put = async () => { throw new DOMException('quota', 'QuotaExceededError'); };
      try { assert.equal(await (await resolveCloudBlob({ $file: 'retry' })).text(), 'recovered'); }
      finally { table.put = put; }
      assert.equal(await db.table('_fileCache').count(), 0);
      assert.equal(await (await resolveCloudBlob({ $file: 'retry' })).text(), 'recovered');
      assert.equal(calls, 3);
    });
    await t.test('late old-account bytes are rejected and never cached in either account', async () => {
      const old = await account(); let respond;
      globalThis.fetch = async () => new Promise(resolve => { respond = () => resolve(new Response('old account')); });
      const pending = resolveCloudBlob({ $file: 'private' });
      const rejected = assert.rejects(pending, /client_account_changed/);
      await until(() => respond);
      const next = await account(); respond(); await rejected;
      await old.open();
      assert.equal(await old.table('_fileCache').count(), 0);
      assert.equal(await next.table('_fileCache').count(), 0);
      globalThis.fetch = async () => new Response('new account');
      assert.equal(await (await resolveCloudBlob({ $file: 'private' })).text(), 'new account');
    });
    await t.test('LRU bounds both entry count and byte budget without scanning Blob payloads', async () => {
      const db = await account();
      const rows = Array.from({ length: 128 }, (_, i) => ({ id: `old-${i}`, blob: new Blob(['x']) }));
      await db.table('_fileCache').bulkPut(rows);
      await db.table('_fileCacheMeta').bulkPut(rows.map((row, i) => ({ id: row.id, size: 1, usedAt: i })));
      globalThis.fetch = async () => new Response('new');
      await resolveCloudBlob({ $file: 'new' });
      assert.equal(await db.table('_fileCache').count(), 128);
      assert.equal(await db.table('_fileCache').get('old-0'), undefined);
      // Exercise the byte limit independently with an actual >32MiB download:
      // large user files are usable, but must not evict every small preview.
      globalThis.fetch = async () => new Response(new Blob([new Uint8Array(33 * 1024 * 1024)]));
      assert.equal((await resolveCloudBlob({ $file: 'large' })).size, 33 * 1024 * 1024);
      assert.equal(await db.table('_fileCache').get('large'), undefined);
      assert.equal(await db.table('_fileCache').count(), 128);
      globalThis.fetch = async () => new Response(new Blob([new Uint8Array(17 * 1024 * 1024)]));
      await resolveCloudBlob({ $file: 'medium-1' });
      await resolveCloudBlob({ $file: 'medium-2' });
      const metadata = await db.table('_fileCacheMeta').toArray();
      assert.ok(metadata.reduce((total, row) => total + row.size, 0) <= 32 * 1024 * 1024);
      assert.equal(await db.table('_fileCache').get('medium-1'), undefined);
      assert.ok(await db.table('_fileCache').get('medium-2'));
    });
  } finally {
    globalThis.fetch = originalFetch;
    accountLifecycle.invalidate();
    for (const db of databases) await db.delete();
  }
});
