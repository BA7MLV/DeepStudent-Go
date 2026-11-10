import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePluginLayout, resolvePluginPlacements, type PluginHostContext, type PluginPlacement, type PluginSurface } from '@wangke/contracts/plugins';
import type { pluginCatalogSource } from './catalog';
import type { callPluginAction as CallAction } from '../client/plugins';
import { PluginHost } from './PluginHost';
import './plugins.css';
import { pluginProject } from './scope';
import { usePluginScope } from './usePluginScope';

/** Native contribution controls. Package code only runs after opening its view. */
export interface PluginActionsProps {
  surface: PluginSurface; materialId?: string; projectId?: string; projectFolderId?: number; selection?: PluginHostContext['selection']; conversation?: PluginHostContext['conversation'];
}
export function PluginActionsView({ surface, materialId, projectId: requestedProject, projectFolderId, selection, conversation, useCatalog, callAction, serverEnabled }: PluginActionsProps & {
  serverEnabled: boolean;
  useCatalog: <T>(select: (value: ReturnType<typeof pluginCatalogSource.getSnapshot>) => T) => T;
  callAction: typeof CallAction;
}) {
  const catalog = useCatalog(value => value), { i18n } = useTranslation('common');
  const [opened, setOpened] = useState<{ placement: PluginPlacement; context: PluginHostContext; packageRevision?: number }>();
  const anchor = useRef<HTMLDivElement>(null), [near, setNear] = useState(surface !== 'resource.actions');
  useEffect(() => {
    if (surface !== 'resource.actions' || !anchor.current) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '320px' });
    observer.observe(anchor.current); return () => observer.disconnect();
  }, [surface]);
  const scope = usePluginScope(catalog.data, materialId, projectFolderId, near || !!opened);
  const { data, error: scopeError } = scope;
  const projectId = pluginProject(data, materialId, requestedProject, projectFolderId);
  const [busy, setBusy] = useState<string>(), [message, setMessage] = useState('');
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0);
  const revision = JSON.stringify([surface, projectId, materialId, selection, conversation]);
  useEffect(() => { generation.current++; setOpened(undefined); setMessage(''); setBusy(undefined); return () => { generation.current++; }; }, [revision]);
  useEffect(() => { const element = dialog.current; if (opened && element && !element.open) element.showModal(); return () => { element?.close(); }; }, [opened]);
  const context = useMemo<PluginHostContext>(() => ({ surface, projectId, materialId, selection, conversation, revision, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', width: Math.min(window.innerWidth - 32, 720), mode: 'inline' }), [revision, i18n.language]);
  const layout = data ? parsePluginLayout(JSON.parse(data.layout.content)) : { apiVersion: 2 as const, instances: [], placements: [] };
  // A resource listing may index a new material after the first catalog read.
  // Do not open against an unresolved scope and then close the user's dialog
  // when the shared catalog discovers its project on the next update.
  const materialReady = !materialId || !data?.scopes?.materials || data.scopes.materials.some(material => material.id === materialId);
  const entries = (materialReady ? resolvePluginPlacements(layout, surface, context, data?.scopes?.unavailableInstances) : []).flatMap(placement => {
    const plugin = data?.plugins.find(p => p.id === placement.pluginId && !p.error && p.manifest?.enabled);
    const instance = layout.instances.find(i => i.id === placement.instanceId && i.pluginId === placement.pluginId);
    const contribution = plugin?.manifest?.contributions?.[placement.viewId];
    return plugin && instance && contribution?.surfaces.includes(surface) ? [{ placement, plugin, instance, contribution }] : [];
  });
  const active = entries.find(e => e.placement.id === opened?.placement.id);
  const available = useRef(new Set<string>());
  available.current = new Set(entries.map(entry => `${entry.placement.id}:${entry.plugin.revision}`));
  const activeRevision = active?.plugin.revision;
  useEffect(() => { if (opened && (!active || activeRevision !== opened.packageRevision)) setOpened(undefined); }, [activeRevision, !!active, opened]);
  if (!serverEnabled) return null;
  const failure = scopeError ? <p role="alert">{scopeError} <button type="button" onClick={scope.retry}>{i18n.t('common:board.retry')}</button></p> : null;
  if (!data || !entries.length) return surface === 'resource.actions' ? <div ref={anchor} className="plugin-actions" data-plugin-actions={surface}>{failure}</div> : failure;
  return <div ref={anchor} className="plugin-actions" data-plugin-actions={surface}>
    {!opened ? failure : null}
    {entries.map(entry => <button type="button" key={entry.placement.id} disabled={!!busy || !scope.ready} onClick={async () => {
      if (!scope.current()) return;
      const { contribution, placement, plugin } = entry;
      if (contribution.viewId) { setOpened({ placement: { ...placement, viewId: contribution.viewId }, context, packageRevision: plugin.revision }); return; }
      const captured = generation.current;
      const current = () => generation.current === captured && available.current.has(`${placement.id}:${plugin.revision}`);
      setBusy(placement.id); setMessage('');
      try {
        const args: Record<string, unknown> = { ...contribution.args };
        for (const [key, field] of Object.entries(contribution.contextArgs ?? {})) {
          const value = field === 'materialId' ? materialId : field === 'selectionText' ? selection?.text : crypto.randomUUID();
          if (value === undefined) throw new Error('plugin_context_required');
          args[key] = value;
        }
        const result = await callAction({ pluginId: plugin.id, instanceId: placement.instanceId, revision: plugin.revision }, contribution.actionId!, args);
        const id = result && typeof result === 'object' && !Array.isArray(result) ? result.id : undefined;
        if (current()) setMessage(typeof id === 'string' ? `已提交任务：${id}（尚未确认产物）` : '操作已保存');
      } catch (e) { if (current()) setMessage(e instanceof Error ? e.message : 'plugin_action_failed'); }
      finally { if (generation.current === captured) setBusy(undefined); }
    }}>{entry.contribution.title}</button>)}
    {message ? <p role="status">{message}</p> : null}
    {opened && active ? <dialog ref={dialog} className="plugin-action-dialog" aria-label={active.contribution.title} onClose={() => setOpened(undefined)}>
      <header><strong>{active.contribution.title}</strong><button type="button" onClick={() => setOpened(undefined)}>关闭</button></header>
      {failure}
      <PluginHost plugin={active.plugin} instance={active.instance} placement={opened.placement} context={opened.context} />
    </dialog> : null}
  </div>;
}
