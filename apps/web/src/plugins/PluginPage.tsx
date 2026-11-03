import { useParams } from 'react-router-dom';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { parsePluginLayout, type PluginHostContext } from '@wangke/contracts/plugins';
import { PageShell } from '../ui';
import { usePluginCatalog } from './catalog';
import { PluginHost } from './PluginHost';
import { PluginSlot } from './PluginSlot';

export default function PluginPage() {
  const { instanceId } = useParams();
  const { data, error } = usePluginCatalog();
  const { i18n } = useTranslation('common');
  const context = useMemo<PluginHostContext>(() => ({ surface: 'app.page', revision: `${instanceId}:${i18n.language}`, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', width: window.innerWidth, mode: 'full' }), [instanceId, i18n.language]);
  const instance = data ? parsePluginLayout(JSON.parse(data.layout.content)).instances.find(i => i.id === instanceId) : undefined;
  const plugin = !data?.scopes?.unavailableInstances.includes(instanceId ?? '') ? data?.plugins.find(p => p.id === instance?.pluginId && !p.error && p.manifest?.enabled) : undefined;
  const viewId = Object.entries(plugin?.manifest?.views ?? {}).find(([, view]) => view.surfaces.includes('app.page'))?.[0];
  return <PageShell title={plugin?.manifest?.name ?? '插件'}>{instanceId ? plugin && instance && viewId ? <PluginHost plugin={plugin} instance={instance} placement={{ id: `page-${instance.id}`, pluginId: plugin.id, instanceId: instance.id, viewId, surface: 'app.page', scope: instance.scope, order: 0 }} context={{ ...context, projectId: instance.scope.kind === 'project' ? instance.scope.id : instance.scope.kind === 'material' ? data?.scopes?.materialProjects[instance.scope.id] : undefined, materialId: instance.scope.kind === 'material' ? instance.scope.id : undefined }} /> : <p role="alert">{error ?? (data ? '实例已停用、卸载、项目不可用或没有完整页视图。原数据保留。' : '加载插件…')}</p> : <PluginSlot name="app.page" />}</PageShell>;
}
