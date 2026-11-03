/** Runtime-independent registration boundary. Ownership and effects are explicit. */
export type PluginDispose = () => void;
export interface PluginService<T = unknown> { version: number; value: T }
export interface PluginProvider {
  id: string; requires?: Record<string, number>; optional?: Record<string, number>;
  setup(ctx: { get<T>(id: string): T | undefined; provide<T>(id: string, service: PluginService<T>): void; effect(dispose: PluginDispose): void }): void;
}
export class PluginRegistry {
  private services = new Map<string, PluginService>();
  private providers = new Map<string, { provider: PluginProvider; active: boolean; disposers: PluginDispose[]; error?: string }>();
  private reconciling = false;
  get<T>(id: string): T | undefined { return this.services.get(id)?.value as T | undefined; }
  status(id: string) { const p = this.providers.get(id); return p ? { active: p.active, error: p.error } : undefined; }
  register(provider: PluginProvider): PluginDispose {
    if (this.providers.has(provider.id)) throw new Error('plugin_provider_conflict');
    this.providers.set(provider.id, { provider, active: false, disposers: [] });
    this.reconcile();
    let disposed = false;
    return () => { if (disposed) return; disposed = true; const p = this.providers.get(provider.id); if (p) this.stop(p); this.providers.delete(provider.id); this.reconcile(); };
  }
  private stop(p: { active: boolean; disposers: PluginDispose[] }) {
    p.active = false;
    for (const off of p.disposers.splice(0).reverse()) { try { off(); } catch { /* Release remaining effects even after one fails. */ } }
  }
  private reconcile() {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      // Stop invalid dependants to a fixed point before activating new providers.
      let changed = true;
      while (changed) {
        changed = false;
        for (const p of this.providers.values()) if (p.active && Object.entries(p.provider.requires ?? {}).some(([id, v]) => (this.services.get(id)?.version ?? 0) < v)) { this.stop(p); changed = true; }
      }
      for (let pass = 0; pass < this.providers.size; pass++) {
        let started = false;
        for (const p of this.providers.values()) {
          if (p.active) continue;
          const missing = Object.entries(p.provider.requires ?? {}).filter(([id, v]) => (this.services.get(id)?.version ?? 0) < v);
          if (missing.length) { p.error = `missing_dependencies:${missing.map(([id]) => id).join(',')}`; continue; }
          try {
            p.provider.setup({ get: <T>(id: string) => this.get<T>(id), effect: off => p.disposers.push(off), provide: (id, service) => {
              if (this.services.has(id)) throw new Error('plugin_service_conflict');
              if (!Number.isSafeInteger(service.version) || service.version < 1) throw new Error('invalid_service_version');
              this.services.set(id, service); p.disposers.push(() => this.services.delete(id));
            } });
            p.active = true; p.error = undefined; started = true;
          } catch (e) { this.stop(p); p.error = e instanceof Error ? e.message : 'plugin_setup_failed'; }
        }
        if (!started) break;
      }
    } finally { this.reconciling = false; }
  }
}
