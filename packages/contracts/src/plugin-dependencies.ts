import type { PluginPackage } from './plugins.js';

/** Pure manifest resolution: no activation, services, effects or server imports.
 * A cycle cannot bootstrap itself. Optional dependencies never gate availability. */
export function availablePluginPackages(packages: PluginPackage[]): Map<string, PluginPackage> {
  const available = new Map<string, PluginPackage>();
  const candidates = packages.filter(p => !p.error && p.manifest?.enabled);
  for (let pass = 0; pass < candidates.length; pass++) {
    let changed = false;
    for (const pkg of candidates) {
      if (available.has(pkg.id)) continue;
      if (Object.entries(pkg.manifest!.requires ?? {}).some(([id, version]) => pluginMajor(available.get(id)) < version)) continue;
      // A malformed released version cannot satisfy another package's dependency.
      available.set(pkg.id, pkg);
      changed = true;
    }
    if (!changed) break;
  }
  return available;
}

export function pluginMajor(pkg?: PluginPackage): number {
  const version = Number(/^([1-9]\d*)(?:\.|$)/.exec(pkg?.manifest?.version ?? '')?.[1] ?? 0);
  return Number.isSafeInteger(version) ? version : 0;
}
