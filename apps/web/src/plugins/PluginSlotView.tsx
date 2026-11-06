import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { parsePluginLayout, resolvePluginPlacements, type PluginHostContext, type PluginSurface } from '@wangke/contracts/plugins';
import type { pluginCatalogSource } from './catalog';
import { PluginHost } from './PluginHost';
import { PluginCreationHint } from './PluginCreationHint';
import './plugins.css';
import { pluginProject } from './scope';
import { useSustained } from '../utils/useSustained';
import { AppSelect } from '../ui/AppSelect';
import { Sym } from '../ui/icons';

export interface PluginSlotProps { name: PluginSurface; materialId?: string; projectId?: string; projectFolderId?: number; conversation?: PluginHostContext['conversation']; onlyInstance?: string; manage?: boolean }
export function PluginSlotView({ name, materialId, projectId: requestedProject, projectFolderId, conversation, onlyInstance, manage = true, useCatalog, serverEnabled }: PluginSlotProps & { serverEnabled: boolean; useCatalog: <T>(select: (value: ReturnType<typeof pluginCatalogSource.getSnapshot>) => T) => T }) {
  const { i18n, t } = useTranslation('interface');
  const { data, error, status } = useCatalog(value => value);
  const [search, setSearch] = useSearchParams();
  const selectable = name === 'board.main' || name === 'app.page';
  const projectId = pluginProject(data, materialId, requestedProject ?? (selectable ? search.get('project') ?? undefined : undefined), projectFolderId);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width))); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  const context = useMemo<PluginHostContext>(() => ({ surface: name, revision: JSON.stringify([name, projectId, materialId, conversation, width, i18n.language]), projectId, materialId, conversation, width, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', mode: name === 'board.main' ? 'compact' : name === 'app.page' ? 'full' : 'panel' }), [name, projectId, materialId, conversation?.kind, conversation?.id, width, i18n.language]);
  // Last known components stay usable while the stream reconnects by itself.
  const reconnecting = useSustained(status === 'reconnecting', 10000);
  if (!serverEnabled) return selectable && manage && data ? <div className="plugin-slot"><PluginCreationHint /></div> : null;
  const layout = data ? parsePluginLayout(JSON.parse(data.layout.content)) : undefined;
  const placements = layout ? resolvePluginPlacements(layout, name, context, data?.scopes?.unavailableInstances).filter(p => !onlyInstance || p.instanceId === onlyInstance) : [];
  return <div ref={ref} className={`plugin-slot plugin-slot--${name.replace('.', '-')}`} data-plugin-slot={name}>
    {selectable && data && !!data.scopes?.projects.length ? <AppSelect label={t('plugins.context')} value={projectId ?? 'all'} options={[{ id: 'all', label: t('plugins.all') }, ...data.scopes.projects.map(p => ({ id: p.id, label: p.name }))]} onChange={value => { const next = new URLSearchParams(search); if (value !== 'all') next.set('project', value); else next.delete('project'); setSearch(next); }} /> : null}
    {manage && data ? <PluginCreationHint /> : null}
    {error ? <p role="alert">{error}</p> : null}
    {reconnecting ? <p role="status">{t('plugins.reconnecting')}</p> : null}
    {!data && !error ? <p aria-busy="true">{t('plugins.loading')}</p> : null}
    <div className="plugin-slot__views">{placements.map(p => {
      const plugin = data?.plugins.find(pkg => pkg.id === p.pluginId && !pkg.error && pkg.manifest?.enabled);
      if (!plugin) return null;
      const instance = layout!.instances.find(i => i.id === p.instanceId)!;
      const pageView = plugin.manifest!.views[p.viewId]?.surfaces.includes('app.page') ? p.viewId : Object.entries(plugin.manifest!.views).find(([, v]) => v.surfaces.includes('app.page'))?.[0];
      const title = instance.title || plugin.manifest!.name;
      return <section className="plugin-view" key={p.id} data-testid={`board-plugin-${plugin.id}`} data-plugin-instance={p.instanceId}><header><h2>{title}</h2>{pageView && name !== 'app.page' ? <Link className="plugin-view__expand" aria-label={t('plugins.openNamed', { name: title })} to={`/plugins/${encodeURIComponent(p.instanceId)}?view=${encodeURIComponent(pageView)}`}><Sym name="open_in_full" size={16} /><span>{t('plugins.open')}</span></Link> : null}</header><PluginHost plugin={plugin} instance={instance} placement={p} context={context} /></section>;
    })}</div>
    {data && !placements.length ? <p className="text-sm text-muted">{t('plugins.empty')}</p> : null}
  </div>;
}
