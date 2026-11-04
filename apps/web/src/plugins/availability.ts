import { INSTALLED_LEARNING_PLUGINS } from '@wangke/contracts/learning-plugins';
import { parsePluginLayout, resolvePluginDependencies, type PluginPackage, type PluginLayout } from '@wangke/contracts/plugins';
import type { SystemDocument } from '@wangke/contracts/system';
import { cloud } from '../cloud/state';
import { readRendererPluginCatalog } from '../client/plugin-renderer-commands';

const LOCAL = 'wangke:local-plugin-layout:v2';
export function localPluginLayout(): SystemDocument {
  const content = localStorage.getItem(LOCAL) ?? '{"apiVersion":2,"instances":[],"placements":[]}';
  parsePluginLayout(JSON.parse(content));
  // Local CAS token, not a server authority or a cryptographic revision.
  let revision = 0; for (const char of content) revision = (revision * 31 + char.charCodeAt(0)) >>> 0;
  return { path: '/system/plugin-layout.json', name: 'plugin-layout.json', kind: 'board', content, revision, sha256: '', updatedAt: null };
}
export function localPluginPackages(layout: PluginLayout): PluginPackage[] {
  return resolvePluginDependencies(INSTALLED_LEARNING_PLUGINS.map(p => {
    const installation = layout.installations?.[`builtin:${p.id}`] ?? (layout.disabledBuiltins?.includes(p.id) ? 'disabled' : 'enabled');
    return { ...p, installation, provider: 'native', manifest: { ...p.manifest!, enabled: installation === 'enabled' }, ...(installation === 'uninstalled' ? { error: 'plugin_uninstalled' } : {}) };
  }));
}
export function saveLocalPluginLayout(content: string, expected: string, revision: number) {
  const current = localPluginLayout();
  if (current.content !== expected || current.revision !== revision) throw new Error('system_revision_conflict');
  parsePluginLayout(JSON.parse(content)); localStorage.setItem(LOCAL, content);
  window.dispatchEvent(new Event('system-files-changed'));
}
/** Admission only: do not re-check or abort an already accepted pipeline mid-write. */
export async function assertPluginAvailable(id: string) {
  const packages = cloud.enabled ? (await readRendererPluginCatalog()).plugins : localPluginPackages(JSON.parse(localPluginLayout().content));
  if (!packages.some(p => p.id === id && !p.error && p.manifest?.enabled)) throw new Error('plugin_unavailable');
}
export async function isPluginAvailable(id: string) { try { await assertPluginAvailable(id); return true; } catch { return false; } }
