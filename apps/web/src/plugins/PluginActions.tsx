import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePluginLayout, resolvePluginPlacements, type PluginHostContext, type PluginPlacement, type PluginSurface } from '@wangke/contracts/plugins';
import { cloud } from '../cloud/state';
import { request } from '../api/serverClient';
import { usePluginCatalog, refreshPlugins } from './catalog';
import { PluginHost } from './PluginHost';
import './plugins.css';
import { pluginProject } from './scope';

/** Native contribution controls. Package code only runs after opening its view. */
export function PluginActions({ surface, materialId, projectId: requestedProject, projectFolderId, selection, conversation }: {
  surface: PluginSurface; materialId?: string; projectId?: string; projectFolderId?: number; selection?: PluginHostContext['selection']; conversation?: PluginHostContext['conversation'];
}) {
  const { data } = usePluginCatalog(), { i18n } = useTranslation('common');
  const projectId = pluginProject(data, materialId, requestedProject, projectFolderId);
  const [opened, setOpened] = useState<{ placement: PluginPlacement; context: PluginHostContext; packageRevision?: number }>();
  const [busy, setBusy] = useState<string>(), [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0);
  const revision = JSON.stringify([surface, projectId, materialId, selection, conversation]);
  useEffect(() => { generation.current++; setOpened(undefined); setMessage(''); setBusy(undefined); return () => { generation.current++; }; }, [revision]);
  useEffect(() => { const element = dialog.current; if (opened && element && !element.open) element.showModal(); return () => { element?.close(); }; }, [opened]);
  const context = useMemo<PluginHostContext>(() => ({ surface, projectId, materialId, selection, conversation, revision, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', width: Math.min(window.innerWidth - 32, 720), mode: 'inline' }), [revision, i18n.language]);
  const layout = data ? parsePluginLayout(JSON.parse(data.layout.content)) : { apiVersion: 2 as const, instances: [], placements: [] };
  const entries = resolvePluginPlacements(layout, surface, context, data?.scopes?.unavailableInstances).flatMap(placement => {
    const plugin = data?.plugins.find(p => p.id === placement.pluginId && !p.error && p.manifest?.enabled);
    const instance = layout.instances.find(i => i.id === placement.instanceId && i.pluginId === placement.pluginId);
    const contribution = plugin?.manifest?.contributions?.[placement.viewId];
    return plugin && instance && contribution?.surfaces.includes(surface) ? [{ placement, plugin, instance, contribution }] : [];
  });
  const active = entries.find(e => e.placement.id === opened?.placement.id);
  const activeRevision = active?.plugin.revision;
  useEffect(() => { if (opened && (!active || activeRevision !== opened.packageRevision)) setOpened(undefined); }, [activeRevision, !!active, opened]);
  if (!cloud.enabled || !data || !entries.length) return null;
  return <div className="plugin-actions" data-plugin-actions={surface}>
    {entries.map(entry => <button type="button" key={entry.placement.id} disabled={!!busy} onClick={async () => {
      const { contribution, placement, plugin } = entry;
      if (contribution.viewId) { setOpened({ placement: { ...placement, viewId: contribution.viewId }, context, packageRevision: plugin.revision }); return; }
      const captured = generation.current;
      setBusy(placement.id); setMessage('');
      try {
        const args: Record<string, unknown> = { ...contribution.args };
        for (const [key, field] of Object.entries(contribution.contextArgs ?? {})) {
          const value = field === 'materialId' ? materialId : field === 'selectionText' ? selection?.text : crypto.randomUUID();
          if (value === undefined) throw new Error('plugin_context_required');
          args[key] = value;
        }
        const result = await request<{ id?: string }>(`/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(placement.instanceId)}/actions/${encodeURIComponent(contribution.actionId!)}`, { method: 'POST', body: JSON.stringify({ revision: plugin.revision, args }) });
        if (generation.current === captured) setMessage(result.id ? `已提交任务：${result.id}（尚未确认产物）` : '操作已保存');
        await refreshPlugins();
      } catch (e) { if (generation.current === captured) setMessage(e instanceof Error ? e.message : 'plugin_action_failed'); }
      finally { if (generation.current === captured) setBusy(undefined); }
    }}>{entry.contribution.title}</button>)}
    {message ? <p role="status">{message}</p> : null}
    {opened && active ? <dialog ref={dialog} className="plugin-action-dialog" aria-label={active.contribution.title} onClose={() => setOpened(undefined)}>
      <header><strong>{active.contribution.title}</strong><button type="button" onClick={() => setOpened(undefined)}>关闭</button></header>
      <PluginHost plugin={active.plugin} instance={active.instance} placement={opened.placement} context={opened.context} />
    </dialog> : null}
  </div>;
}
