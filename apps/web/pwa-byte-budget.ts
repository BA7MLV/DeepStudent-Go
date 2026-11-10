/**
 * Runtime cache total-byte gate. Workbox's built-in ExpirationPlugin only
 * bounds entry count and age; without a byte budget a long-lived profile can
 * still accumulate unbounded disk usage in `app-demand-assets` (large wasm /
 * feature chunks under the per-entry ceiling still add up).
 *
 * The plugin runs after each completed response. It sums stored entry sizes
 * (Content-Length when present, measured body otherwise) and evicts
 * least-recently-served entries first until the cache is back under budget.
 * Failures never break request handling: the gate is best-effort hygiene,
 * not a correctness invariant.
 *
 * IMPORTANT: these function bodies are serialized verbatim into the generated
 * service worker by workbox-build. They must stay fully self-contained — no
 * imports, no closure references. `caches` is the SW global.
 */
export const APP_DEMAND_CACHE = 'app-demand-assets';
export const APP_DEMAND_BYTE_BUDGET = 64 * 1024 * 1024;

export const appDemandByteBudget = {
  // Arrow-function property, NOT method shorthand: workbox-build serializes
  // function sources verbatim, and shorthand sources carry the property name.
  handlerDidComplete: async ({ response }: { response?: Response; error?: unknown }): Promise<void> => {
    if (!response || !response.ok) return;
    try {
      const cache = await caches.open('app-demand-assets');
      const requests = await cache.keys();
      const entries: Array<{ request: Request; bytes: number; at: number }> = [];
      let total = 0;
      for (const request of requests) {
        const cached = await cache.match(request);
        if (!cached) continue;
        let bytes = Number(cached.headers.get('content-length'));
        if (!Number.isFinite(bytes) || bytes <= 0) bytes = (await cached.clone().blob()).size;
        const servedAt = Date.parse(cached.headers.get('date') ?? '') || 0;
        entries.push({ request, bytes, at: servedAt });
        total += bytes;
      }
      const budget = 64 * 1024 * 1024;
      if (total <= budget) return;
      entries.sort((a, b) => a.at - b.at);
      for (const entry of entries) {
        if (total <= budget) break;
        await cache.delete(entry.request);
        total -= entry.bytes;
      }
    } catch {
      // A cache-maintenance failure must never fail the request itself.
    }
  },
};
