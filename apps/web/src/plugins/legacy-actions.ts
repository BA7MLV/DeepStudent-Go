import { parsePluginLayout, type PluginPackage } from '@wangke/contracts/plugins';
import type { SystemDocument } from '@wangke/contracts/system';
import type { CloudTask } from '@wangke/contracts/cloud';
import { request, ServerApiError } from '../api/serverClient';
import { flushCloud } from '../cloud/sync';
import { waitCloudTask } from '../cloud/tasks';

/** Remote legacy actions use the same plugin RPC. Local pipelines separately
 * admit against availability.ts; workers use the server's accepted task snapshot. */
export async function materialPluginInstance(pluginId: string, materialId: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const { plugins, layout: document } = await request<{ plugins: PluginPackage[]; layout: SystemDocument }>('/plugins');
    const plugin = plugins.find(p => p.id === pluginId && !p.error && p.manifest?.enabled);
    if (!plugin) throw new Error('plugin_unavailable');
    const layout = parsePluginLayout(JSON.parse(document.content));
    const existing = layout.instances.find(i => i.pluginId === pluginId && i.scope.kind === 'material' && i.scope.id === materialId);
    if (existing) return { plugin, instance: existing };
    const instance = { id: `material-${crypto.randomUUID()}`, pluginId, scope: { kind: 'material' as const, id: materialId } };
    layout.instances.push(instance);
    try {
      await request('/plugins/layout', { method: 'POST', body: JSON.stringify({ content: JSON.stringify(layout), expected: document.content, revision: document.revision }) });
      window.dispatchEvent(new Event('system-files-changed'));
      return { plugin, instance };
    } catch (e) { if (!(e instanceof ServerApiError) || e.status !== 409 || attempt === 2) throw e; }
  }
  throw new Error('plugin_layout_conflict');
}
export async function runMaterialPluginTask<T>(actionId: string, materialId: string, onProgress?: (p: any) => void, signal?: AbortSignal, args: Record<string, unknown> = {}): Promise<T> {
  signal?.throwIfAborted();
  await flushCloud();
  const { plugin, instance } = await materialPluginInstance('material-tools', materialId);
  signal?.throwIfAborted();
  const task = await request<CloudTask>(`/plugins/${plugin.id}/instances/${instance.id}/actions/${encodeURIComponent(actionId)}`, { method: 'POST', body: JSON.stringify({ revision: plugin.revision, args: { ...args, materialId, clientNonce: crypto.randomUUID() } }) });
  return waitCloudTask<T>(task, onProgress, signal);
}
export async function runCardsPluginTask(materialId: string, onProgress?: (p: any) => void): Promise<number> {
  await flushCloud();
  const { plugin, instance } = await materialPluginInstance('flashcards', materialId);
  const endpoint = `/plugins/${plugin.id}/instances/${instance.id}/actions`;
  const snapshot = await request<{ cards: unknown[]; revision: string }>(`${endpoint}/list`, { method: 'POST', body: JSON.stringify({ revision: plugin.revision, args: { materialId } }) });
  if (snapshot.cards.length) {
    const { confirmDialog } = await import('../ui');
    if (!await confirmDialog({ headline: '重新生成卡片', description: `将替换 ${snapshot.cards.length} 张原卡片及审核结果；其他位置共享同一记录。`, confirmText: '重新生成', cancelText: '取消', danger: true })) throw new Error('plugin_generation_cancelled');
  }
  const task = await request<CloudTask>(`${endpoint}/generate`, { method: 'POST', body: JSON.stringify({ revision: plugin.revision, args: { materialId, clientNonce: crypto.randomUUID(), ...(snapshot.cards.length ? { replaceRevision: snapshot.revision } : {}) } }) });
  return waitCloudTask<number>(task, onProgress);
}
