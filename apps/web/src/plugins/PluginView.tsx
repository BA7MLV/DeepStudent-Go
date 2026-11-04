import { Suspense, useMemo } from 'react';
import type { BoardPlugin } from '@wangke/contracts/board';
import { PluginFrame, type PluginFrameAdapter } from '../board/PluginFrame';
import type { callPlugin as CallPlugin, observePlugin as ObservePlugin } from '../client/plugins';
import type { PluginOccurrence } from '../client/plugin-renderer';
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots';

/** Receives capabilities from the renderer; no Context, registry or carrier. */
export function PluginView({ plugin, instance, placement, context, draftIdentity, callPlugin, observePlugin, renderSlot }: PluginOccurrence & { draftIdentity?: string; callPlugin: typeof CallPlugin; observePlugin: typeof ObservePlugin } & PropsRenderSlots<'wangke.plugin.native'>) {
  const view = plugin.manifest?.views[placement.viewId];
  const adapter = useMemo<PluginFrameAdapter>(() => {
    const identity = { pluginId: plugin.id, instanceId: placement.instanceId, revision: plugin.revision };
    return {
      identity: draftIdentity ?? `${plugin.id}:${placement.instanceId}:${placement.id}`,
      htmlPath: `/plugins/${encodeURIComponent(plugin.id)}/views/${encodeURIComponent(placement.viewId)}`,
      context, call: (method, args) => callPlugin(identity, method, args),
      subscribe: plugin.manifest?.capabilities.includes('state') ? (listener, failed) => observePlugin(identity, 'state.read', {}, listener, failed ?? console.error) : undefined,
      watchTask: plugin.manifest?.capabilities.includes('tasks') ? (id, listener, failed) => observePlugin(identity, 'tasks.get', { id }, listener, failed) : undefined,
      observeQuery: (method, args, listener, failed) => observePlugin(identity, method, args, listener, failed),
    };
  }, [draftIdentity, plugin.id, plugin.source, plugin.revision, placement.id, placement.instanceId, placement.viewId, context, callPlugin, observePlugin]);
  if (!plugin.manifest?.enabled || plugin.error || plugin.installation === 'uninstalled' || !view) return <p role="alert">插件视图不可用，历史数据已保留</p>;
  if (plugin.source === 'builtin') return <Suspense key={`${instance.id}:${context.projectId ?? ''}:${context.materialId ?? ''}`} fallback={<p aria-busy="true">加载学习组件…</p>}>{renderSlot('wangke.plugin.native', { plugin, instance, placement, context }, { entryKey: `${plugin.id}:${placement.viewId}`, fallback: <p role="alert">内置视图提供者不可用</p> })}</Suspense>;
  const compatibility: BoardPlugin = { id: plugin.id, path: plugin.path, revision: plugin.revision, manifest: { apiVersion: 1, id: plugin.id, name: plugin.manifest.name, version: plugin.manifest.version, enabled: plugin.manifest.enabled, entry: 'index.html', capabilities: [], height: view.height ?? 640 } };
  return <PluginFrame key={`${plugin.source}:${adapter.identity}:${placement.viewId}`} plugin={compatibility} adapter={adapter} />;
}
