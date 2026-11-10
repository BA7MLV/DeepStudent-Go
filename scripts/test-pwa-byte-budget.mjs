import assert from 'node:assert/strict';
import test from 'node:test';
import { appDemandByteBudget, APP_DEMAND_CACHE, APP_DEMAND_BYTE_BUDGET } from '../apps/web/pwa-byte-budget.ts';

/** Minimal Cache API mock: enough for cacheWillUpdate-free eviction semantics. */
function mockCache() {
  const entries = new Map();
  const api = {
    requests: entries,
    async open() { return api; },
    async keys() { return [...entries.keys()]; },
    async match(request) { return entries.get(String(request.url ?? request))?.response; },
    async delete(request) { return entries.delete(String(request.url ?? request)); },
  };
  return api;
}

function entry(name, bytes, date) {
  const request = { url: `https://app.local/assets/${name}` };
  const headers = new Map([['content-length', String(bytes)], ['date', new Date(date).toISOString()]]);
  return { request, response: { ok: true, headers: { get: key => headers.get(key) ?? null } } };
}

test('total byte budget evicts least-recently-served entries first, keeps newer ones', async () => {
  const api = mockCache();
  const day = 86400000;
  api.requests.set('https://app.local/assets/old.js', entry('old.js', 30 * 1024 * 1024, 1));
  api.requests.set('https://app.local/assets/mid.js', entry('mid.js', 30 * 1024 * 1024, 2 * day));
  api.requests.set('https://app.local/assets/new.js', entry('new.js', 30 * 1024 * 1024, 3 * day));
  globalThis.caches = api;
  await appDemandByteBudget.handlerDidComplete({ response: { ok: true } });
  const remaining = [...api.requests.keys()].map(key => key.split('/').pop());
  assert.deepEqual(remaining.sort(), ['mid.js', 'new.js']);
  assert.equal(remaining.length, 2);
});

test('cache under budget is left untouched', async () => {
  const api = mockCache();
  api.requests.set('https://app.local/assets/a.js', entry('a.js', 1024, 1));
  api.requests.set('https://app.local/assets/b.js', entry('b.js', 2048, 2));
  globalThis.caches = api;
  await appDemandByteBudget.handlerDidComplete({ response: { ok: true } });
  assert.equal(api.requests.size, 2);
});

test('entries missing content-length are measured from the body and still counted', async () => {
  const api = mockCache();
  const big = 70 * 1024 * 1024;
  const request = { url: 'https://app.local/assets/heavy.js' };
  api.requests.set('https://app.local/assets/heavy.js', {
    request,
    response: { ok: true, headers: { get: () => null }, clone() { return { blob: async () => ({ size: big }) }; } },
  });
  api.requests.set('https://app.local/assets/small.js', entry('small.js', 1024, 5));
  globalThis.caches = api;
  await appDemandByteBudget.handlerDidComplete({ response: { ok: true } });
  assert.equal(api.requests.has('https://app.local/assets/heavy.js'), false);
  assert.equal(api.requests.has('https://app.local/assets/small.js'), true);
});

test('failed or absent responses are ignored and maintenance errors never throw', async () => {
  globalThis.caches = { open: async () => { throw new Error('quota'); } };
  await appDemandByteBudget.handlerDidComplete({ response: { ok: false } });
  await appDemandByteBudget.handlerDidComplete({ response: undefined });
  await assert.doesNotReject(() => appDemandByteBudget.handlerDidComplete({ response: { ok: true } }));
});

test('budget constant covers the documented runtime cache scale', () => {
  assert.equal(APP_DEMAND_CACHE, 'app-demand-assets');
  assert.equal(APP_DEMAND_BYTE_BUDGET, 64 * 1024 * 1024);
});
