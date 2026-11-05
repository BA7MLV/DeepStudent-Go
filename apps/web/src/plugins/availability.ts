import { cloud } from '../cloud/state';
import { readRendererPluginCatalog } from '../client/plugin-renderer-commands';
import { accountLifetime } from '../client/account-lifecycle';

/** Admission only: do not re-check or abort an already accepted pipeline mid-write. */
export async function assertPluginAvailable(id: string) {
  if (!cloud.enabled || !cloud.userId) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(cloud.userId);
  const packages = (await readRendererPluginCatalog()).plugins;
  lifetime.assertCurrent();
  if (!packages.some(p => p.id === id && !p.error && p.manifest?.enabled)) throw new Error('plugin_unavailable');
}
export async function isPluginAvailable(id: string) { try { await assertPluginAvailable(id); return true; } catch { return false; } }
