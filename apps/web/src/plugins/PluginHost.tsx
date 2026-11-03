import { Suspense, useMemo } from 'react';
import type { BoardPlugin } from '@wangke/contracts/board';
import type { PluginHostContext, PluginInstance, PluginPackage, PluginPlacement } from '@wangke/contracts/plugins';
import { PluginFrame, type PluginFrameAdapter } from '../board/PluginFrame';
import { pluginRpc, subscribePluginRead } from './shared';
import { builtinView } from './builtins';

export function PluginHost({ plugin, instance, placement, context }: { plugin: PluginPackage; instance: PluginInstance; placement: PluginPlacement; context: PluginHostContext }) {
  const view = plugin.manifest?.views[placement.viewId];
  const adapter = useMemo<PluginFrameAdapter>(() => {
    const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(placement.instanceId)}/rpc`;
    const call = (method: string, args: Record<string, unknown>) => {
      return pluginRpc(endpoint, plugin.revision, method, args);
    };
    return {
      identity: `${plugin.id}:${placement.instanceId}:${placement.id}`,
      htmlPath: `/plugins/${encodeURIComponent(plugin.id)}/views/${encodeURIComponent(placement.viewId)}`,
      context, call,
      subscribe: plugin.manifest?.capabilities.includes('state') ? listener => subscribePluginRead(`state:${plugin.id}:${placement.instanceId}:${plugin.revision}`, () => call('state.read', {}), listener) : undefined,
    };
  }, [plugin.id, plugin.source, plugin.revision, placement.id, placement.instanceId, placement.viewId, context]);
  if (!plugin.manifest?.enabled || plugin.error || plugin.installation === 'uninstalled' || !view) return <p role="alert">插件视图不可用，历史数据已保留</p>;
  const Builtin = builtinView(plugin, placement.viewId);
   if (plugin.source === 'builtin') return Builtin ? <Suspense fallback={<p aria-busy="true">加载学习组件…</p>}><Builtin key={`${instance.id}:${context.projectId ?? ''}:${context.materialId ?? ''}`} plugin={plugin} instance={instance} placement={placement} context={context} /></Suspense> : <p role="alert">内置视图提供者不可用</p>;
  const compatibility: BoardPlugin = { id: plugin.id, path: plugin.path, revision: plugin.revision, manifest: { apiVersion: 1, id: plugin.id, name: plugin.manifest.name, version: plugin.manifest.version, enabled: plugin.manifest.enabled, entry: 'index.html', capabilities: [], height: view.height ?? 640 } };
  return <PluginFrame plugin={compatibility} adapter={adapter} />;
}
