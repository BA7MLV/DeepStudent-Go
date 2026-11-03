import { type ComponentType } from 'react';
import type { PluginHostContext, PluginInstance, PluginPackage, PluginPlacement } from '@wangke/contracts/plugins';

export interface BuiltinViewProps { plugin: PluginPackage; instance: PluginInstance; placement: PluginPlacement; context: PluginHostContext }
/** Only this compile-time registry may load React code; directory packages stay sandboxed. */
export interface NativeViewProvider { id: string; views: Record<string, ComponentType<BuiltinViewProps>> }
const modules = import.meta.glob<{ default: NativeViewProvider }>('./providers/*.provider.ts', { eager: true });
const providers = new Map(Object.values(modules).map(module => [module.default.id, module.default]));
export function builtinView(plugin: PluginPackage, viewId: string) {
  return plugin.source === 'builtin' && plugin.manifest?.enabled && !plugin.error && plugin.installation !== 'uninstalled' ? providers.get(plugin.id)?.views[viewId] : undefined;
}
