import { parsePluginLayout } from '@wangke/contracts/plugins';
import type { CloudTask } from '@wangke/contracts/cloud';
import { readRendererPluginCatalog, saveRendererPluginLayout, runRendererPluginAction } from '../client/plugin-renderer-commands';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { waitCloudTask } from '../cloud/tasks';

/** Remote legacy actions use the same plugin RPC. Local pipelines separately
 * admit against availability.ts; workers use the server's accepted task snapshot. */
export async function materialPluginInstance(pluginId: string, materialId: string) {
  const lifetime = accountLifetime(cloud.userId);
  lifetime.assertCurrent();
  for (let attempt = 0; attempt < 3; attempt++) {
    const { plugins, layout: document } = await readRendererPluginCatalog();
    lifetime.assertCurrent();
    const plugin = plugins.find(p => p.id === pluginId && !p.error && p.manifest?.enabled);
    if (!plugin) throw new Error('plugin_unavailable');
    const layout = parsePluginLayout(JSON.parse(document.content));
    const existing = layout.instances.find(i => i.pluginId === pluginId && i.scope.kind === 'material' && i.scope.id === materialId);
    if (existing) return { plugin, instance: existing };
    const instance = { id: `material-${crypto.randomUUID()}`, pluginId, scope: { kind: 'material' as const, id: materialId } };
    layout.instances.push(instance);
    try {
      await saveRendererPluginLayout(JSON.stringify(layout), document.content, document.revision);
      lifetime.assertCurrent();
      return { plugin, instance };
    } catch (e) { if (!(e instanceof Error && 'status' in e && e.status === 409) || attempt === 2) throw e; }
  }
  throw new Error('plugin_layout_conflict');
}
export async function runMaterialPluginTask<T>(actionId: string, materialId: string, onProgress?: (p: any) => void, signal?: AbortSignal, args: Record<string, unknown> = {}): Promise<T> {
  signal?.throwIfAborted();
  const { plugin, instance } = await materialPluginInstance('material-tools', materialId);
  signal?.throwIfAborted();
  const task = await runRendererPluginAction({ pluginId: plugin.id, instanceId: instance.id, revision: plugin.revision }, actionId, { ...args, materialId, clientNonce: crypto.randomUUID() }) as unknown as CloudTask;
  return waitCloudTask<T>(task, onProgress, signal);
}
export async function runCardsPluginTask(materialId: string, onProgress?: (p: any) => void): Promise<number> {
  const { plugin, instance } = await materialPluginInstance('flashcards', materialId);
  const identity = { pluginId: plugin.id, instanceId: instance.id, revision: plugin.revision };
  const snapshot = await runRendererPluginAction(identity, 'list', { materialId }) as unknown as { cards: unknown[]; revision: string };
  if (snapshot.cards.length) {
    const { confirmDialog } = await import('../ui');
    if (!await confirmDialog({ headline: '重新生成卡片', description: `将替换 ${snapshot.cards.length} 张原卡片及审核结果；其他位置共享同一记录。`, confirmText: '重新生成', cancelText: '取消', danger: true })) throw new Error('plugin_generation_cancelled');
  }
  const task = await runRendererPluginAction(identity, 'generate', { materialId, clientNonce: crypto.randomUUID(), ...(snapshot.cards.length ? { replaceRevision: snapshot.revision } : {}) }) as unknown as CloudTask;
  return waitCloudTask<number>(task, onProgress);
}
