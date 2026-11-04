import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginInstance, PluginPackage } from '@wangke/contracts/plugins';
import { usePluginCatalog, refreshPlugins } from './catalog';
import { materialPluginInstance } from './legacy-actions';
import { PluginHost } from './PluginHost';
import './plugins.css';

/** Legacy menus open a registered view, without navigating away from chat drafts.
 * No business view/provider is selected in this adapter. */
export function useMaterialPluginView(materialId: string) {
  const { i18n } = useTranslation('common'), { data } = usePluginCatalog();
  const [opened, setOpened] = useState<{ plugin: PluginPackage; instance: PluginInstance; viewId: string; materialId: string }>();
  const dialog = useRef<HTMLDialogElement>(null), generation = useRef(0);
  useEffect(() => { generation.current++; setOpened(undefined); return () => { generation.current++; }; }, [materialId]);
  const current = data?.plugins.find(p => p.id === opened?.plugin.id && p.revision === opened.plugin.revision && !p.error && p.manifest?.enabled);
  useEffect(() => { if (opened && !current) setOpened(undefined); }, [opened, current]);
  useEffect(() => { const element = dialog.current; if (opened && element) element.showModal(); return () => { element?.close(); }; }, [opened]);
  const open = async (pluginId: string, viewId = 'main') => {
    const ticket = ++generation.current;
    const result = await materialPluginInstance(pluginId, materialId);
    if (!result.plugin.manifest?.views[viewId]?.surfaces.includes('reader.sidepanel')) throw new Error('plugin_view_unavailable');
    await refreshPlugins();
    if (ticket === generation.current) setOpened({ ...result, viewId, materialId });
  };
  return { open, dialog: opened && current && opened.materialId === materialId ? <dialog ref={dialog} className="plugin-action-dialog" aria-label={current.manifest!.name} onClose={() => setOpened(undefined)}>
    <header><strong>{current.manifest!.name}</strong><button type="button" onClick={() => setOpened(undefined)}>关闭</button></header>
    <PluginHost plugin={current} instance={opened.instance} placement={{ id: `legacy-menu-${opened.instance.id}`, pluginId: current.id, instanceId: opened.instance.id, viewId: opened.viewId, surface: 'reader.sidepanel', scope: opened.instance.scope, order: 0 }} context={{ surface: 'reader.sidepanel', materialId, revision: materialId, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', width: Math.min(window.innerWidth - 32, 720), mode: 'inline' }} />
  </dialog> : null };
}
