import { parsePluginLayout, type PluginInstance, type PluginLayout, type PluginPackage, type PluginPlacement, type PluginScope } from '@wangke/contracts/plugins';
import type { PluginCatalog } from './catalog';

export const readLayout = (catalog: PluginCatalog): PluginLayout => parsePluginLayout(JSON.parse(catalog.layout.content));
export const pluginName = (plugin?: PluginPackage) => plugin?.manifest?.name ?? '未命名功能';
export const contentName = (instance: PluginInstance, plugin?: PluginPackage) => instance.title || `我的${pluginName(plugin)}`;
export function scopeName(scope: PluginScope, catalog: PluginCatalog) {
  return scope.kind === 'account' ? '所有地方' : scope.kind === 'project' ? catalog.scopes?.projects.find(p => p.id === scope.id)?.name ?? '项目不可用' : catalog.scopes?.materials?.find(m => m.id === scope.id)?.name ?? '这份资料';
}
export function pageUrl(placement: PluginPlacement) {
  return `/plugins/${encodeURIComponent(placement.instanceId)}?view=${encodeURIComponent(placement.viewId)}&placement=${encodeURIComponent(placement.id)}`;
}
export function scopeAvailable(scope: PluginScope, catalog: PluginCatalog) {
  return scope.kind === 'account' || (scope.kind === 'project' ? !!catalog.scopes?.projects.some(p => p.id === scope.id) : !!catalog.scopes?.materials?.some(m => m.id === scope.id));
}
export function navigationEntries(catalog?: PluginCatalog) {
  if (!catalog) return [];
  const layout = readLayout(catalog);
  return (layout.navigation ?? []).slice().sort((a, b) => a.order - b.order).flatMap(entry => {
    const placement = layout.placements.find(p => p.id === entry.placementId && p.surface === 'app.page');
    const instance = layout.instances.find(i => i.id === placement?.instanceId);
    const plugin = catalog.plugins.find(p => p.id === instance?.pluginId && !p.error && p.manifest?.enabled);
    if (!placement || !instance || !plugin || catalog.scopes?.unavailableInstances.includes(instance.id) || !plugin.manifest?.views[placement.viewId]?.surfaces.includes('app.page')) return [];
    if (!scopeAvailable(placement.scope, catalog)) return [];
    return [{ entry, placement, instance, plugin, title: entry.title || contentName(instance, plugin), url: pageUrl(placement) }];
  });
}
