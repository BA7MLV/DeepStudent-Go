import { useParams, useSearchParams } from 'react-router-dom';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { PluginHostContext, PluginPlacement } from '@wangke/contracts/plugins';
import { PageShell } from '../ui';
import type { pluginCatalogSource } from './catalog';
import { PluginHost } from './PluginHost';
import { PluginSlot } from './PluginSlot';
import { PluginCreationHint } from './PluginCreationHint';
import { contentName, readLayout, scopeAvailable, scopeName } from './layout';

export function PluginPageView({ useCatalog }: { useCatalog: <T>(select: (value: ReturnType<typeof pluginCatalogSource.getSnapshot>) => T) => T }) {
  const { instanceId } = useParams();
  const [search] = useSearchParams();
  const { data, error } = useCatalog(value => value);
  const { i18n } = useTranslation('common');
  const layout = data ? readLayout(data) : undefined;
  const instance = layout?.instances.find(i => i.id === instanceId);
  const plugin = !data?.scopes?.unavailableInstances.includes(instanceId ?? '') ? data?.plugins.find(p => p.id === instance?.pluginId && !p.error && p.manifest?.enabled) : undefined;
  const requested = search.get('view');
  const viewId = requested ?? Object.entries(plugin?.manifest?.views ?? {}).find(([, view]) => view.surfaces.includes('app.page'))?.[0];
  const savedPlacement = layout?.placements.find(p => p.id === search.get('placement') && p.instanceId === instanceId && p.viewId === viewId && p.surface === 'app.page');
  const valid = !!plugin?.manifest?.views[viewId ?? '']?.surfaces.includes('app.page') && (!search.has('placement') || !!savedPlacement && !!data && scopeAvailable(savedPlacement.scope, data));
  const placement: PluginPlacement | undefined = instance && plugin && viewId ? savedPlacement ?? { id: `page-${instance.id}-${viewId}`, pluginId: plugin.id, instanceId: instance.id, viewId, surface: 'app.page', scope: instance.scope, order: 0 } : undefined;
  const pinned = layout?.navigation?.find(n => search.has('placement') ? n.placementId === savedPlacement?.id : layout.placements.some(p => p.id === n.placementId && p.instanceId === instanceId && p.viewId === viewId && p.surface === 'app.page'));
  const projectId = instance?.scope.kind === 'project' ? instance.scope.id : instance?.scope.kind === 'material' ? data?.scopes?.materialProjects[instance.scope.id] : undefined;
  const materialId = instance?.scope.kind === 'material' ? instance.scope.id : savedPlacement?.scope.kind === 'material' ? savedPlacement.scope.id : undefined;
  const fixedProject = projectId ?? (savedPlacement?.scope.kind === 'project' ? savedPlacement.scope.id : materialId ? data?.scopes?.materialProjects[materialId] : undefined);
  const pageScope = instance?.scope.kind === 'account' && savedPlacement ? savedPlacement.scope : instance?.scope;
  const context = useMemo<PluginHostContext>(() => ({ surface: 'app.page', revision: JSON.stringify([instanceId, viewId, fixedProject, materialId, i18n.language]), projectId: fixedProject, materialId, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', width: window.innerWidth, mode: 'full' }), [instanceId, viewId, fixedProject, materialId, i18n.language]);
  return <PageShell title={pinned?.title || (instance ? contentName(instance, plugin) : '功能')} subtitle={pageScope && data && pageScope.kind !== 'account' ? `仅用于 · ${scopeName(pageScope, data)}` : undefined}>
    {data && instance ? <PluginCreationHint /> : null}
    {instanceId ? plugin && instance && valid && placement ? <PluginHost plugin={plugin} instance={instance} placement={placement} context={context} /> : <p role="alert">{data ? '功能已停用、卸载，或这份内容暂不可用。原数据保留，可在聊天中使用创造模式恢复。' : error ? '无法加载，请检查网络后重试。' : '正在加载…'}</p> : <PluginSlot name="app.page" />}
  </PageShell>;
}
