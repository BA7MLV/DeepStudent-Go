type Entry = { failures: number; openUntil: number; expires: number; probing: boolean };
/** One process, bounded state. Replace through the injected interface for shared state. */
export interface CircuitState {
  enter(key: string): boolean;
  success(key: string): void;
  failure(key: string): void;
  release(key: string): void;
  snapshot?(): Array<{ key: string; failures: number; state: string; retryInMs: number }>;
}
export class ModelCircuitBreaker implements CircuitState {
  private entries = new Map<string, Entry>();
  constructor(readonly clock = Date.now, readonly maxEntries = 2000, readonly ttlMs = 300000, readonly cooldownMs = 30000, readonly threshold = 3) {}
  private prune() {
    const now = this.clock();
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value!);
  }
  enter(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return true;
    if (entry.expires <= this.clock()) { this.entries.delete(key); return true; }
    if (!entry.openUntil) return true;
    if (entry.openUntil > this.clock() || entry.probing) return false;
    entry.probing = true;
    return true;
  }
  success(key: string) { this.entries.delete(key); }
  release(key: string) { const entry = this.entries.get(key); if (entry) entry.probing = false; }
  failure(key: string) {
    const old = this.entries.get(key);
    this.prune();
    const failures = (old?.failures ?? 0) + 1, now = this.clock();
    this.entries.set(key, { failures, openUntil: failures >= this.threshold ? now + this.cooldownMs : 0, expires: now + this.ttlMs, probing: false });
  }
  snapshot() {
    const now = this.clock();
    return [...this.entries].filter(([, e]) => e.expires > now).map(([key, e]) => ({ key, failures: e.failures, state: e.openUntil > now ? 'open' : e.openUntil ? 'half_open' : 'closed', retryInMs: Math.max(0, e.openUntil - now) }));
  }
}
