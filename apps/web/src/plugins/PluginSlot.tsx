import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useSearchParams } from 'react-router-dom';
import { parsePluginLayout, resolvePluginPlacements, type PluginHostContext, type PluginSurface } from '@wangke/contracts/plugins';
import { cloud } from '../cloud/state';
import { usePluginCatalog } from './catalog';
import { PluginHost } from './PluginHost';
import { PluginCreationHint } from './PluginCreationHint';
import './plugins.css';
import { pluginProject } from './scope';

export function PluginSlot({ name, materialId, projectId: requestedProject, projectFolderId, conversation, onlyInstance, manage = true }: { name: PluginSurface; materialId?: string; projectId?: string; projectFolderId?: number; conversation?: PluginHostContext['conversation']; onlyInstance?: string; manage?: boolean }) {
  const { i18n } = useTranslation('common');
  const { data, error } = usePluginCatalog();
  const [search, setSearch] = useSearchParams();
  const selectable = name === 'board.main' || name === 'app.page';
  const projectId = pluginProject(data, materialId, requestedProject ?? (selectable ? search.get('project') ?? undefined : undefined), projectFolderId);
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  useEffect(() => { if (!ref.current) return; const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width))); observer.observe(ref.current); return () => observer.disconnect(); }, []);
  const context = useMemo<PluginHostContext>(() => ({ surface: name, revision: JSON.stringify([name, projectId, materialId, conversation, width, i18n.language]), projectId, materialId, conversation, width, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', mode: name === 'board.main' ? 'compact' : name === 'app.page' ? 'full' : 'panel' }), [name, projectId, materialId, conversation?.kind, conversation?.id, width, i18n.language]);
  if (!cloud.enabled) return selectable && manage && data ? <div className="plugin-slot"><PluginCreationHint /></div> : null;
  const layout = data ? parsePluginLayout(JSON.parse(data.layout.content)) : undefined;
  const placements = layout ? resolvePluginPlacements(layout, name, context, data?.scopes?.unavailableInstances).filter(p => !onlyInstance || p.instanceId === onlyInstance) : [];
  return <div ref={ref} className={`plugin-slot plugin-slot--${name.replace('.', '-')}`} data-plugin-slot={name}>
    {selectable && data && !!data.scopes?.projects.length ? <label>正在查看<select aria-label="项目上下文" value={projectId ?? ''} onChange={e => { const next = new URLSearchParams(search); if (e.target.value) next.set('project', e.target.value); else next.delete('project'); setSearch(next); }}><option value="">所有地方</option>{data.scopes?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
    {manage && data ? <PluginCreationHint /> : null}
    {error ? <p role="alert">{error}</p> : null}
    {!data ? <p aria-busy="true">加载插件…</p> : null}
    <div className="plugin-slot__views">{placements.map(p => {
      const plugin = data?.plugins.find(pkg => pkg.id === p.pluginId && !pkg.error && pkg.manifest?.enabled);
      if (!plugin) return null;
      const instance = layout!.instances.find(i => i.id === p.instanceId)!;
      const pageView = plugin.manifest!.views[p.viewId]?.surfaces.includes('app.page') ? p.viewId : Object.entries(plugin.manifest!.views).find(([, v]) => v.surfaces.includes('app.page'))?.[0];
      return <section className="plugin-view" key={p.id} data-testid={`board-plugin-${plugin.id}`} data-plugin-instance={p.instanceId}><header><h2>{instance.title || plugin.manifest!.name}</h2>{pageView ? <Link to={`/plugins/${encodeURIComponent(p.instanceId)}?view=${encodeURIComponent(pageView)}`}>打开完整页</Link> : null}</header><PluginHost plugin={plugin} instance={instance} placement={p} context={context} /></section>;
    })}</div>
    {data && !placements.length ? <p className="text-sm text-muted">此处还没有功能。</p> : null}
  </div>;
}
