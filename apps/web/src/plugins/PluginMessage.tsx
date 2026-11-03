import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { parsePluginLayout, parsePluginMessageReference, type PluginMessageReference } from '@wangke/contracts/plugins';
import { usePluginCatalog } from './catalog';
import { PluginHost } from './PluginHost';

/** The persisted summary is readable without the package. Only a validated,
 * revision-pinned, owner-visible instance may be activated, and only on demand. */
export default function PluginMessage({ source, closed }: { source: string; closed: boolean }) {
  const { data } = usePluginCatalog(), { i18n } = useTranslation('common');
  const identity = useId().replace(/:/g, '');
  const ref = useRef<HTMLElement>(null), [visible, setVisible] = useState(false), [activate, setActivate] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '100px' });
    observer.observe(ref.current); return () => observer.disconnect();
  }, [source, closed]);
  let reference: PluginMessageReference;
  try { reference = parsePluginMessageReference(JSON.parse(source)); }
  catch { return <p role="status">{closed ? '插件引用格式无效；未运行任何插件。' : '正在接收插件引用…'}</p>; }
  const layout = data ? parsePluginLayout(JSON.parse(data.layout.content)) : undefined;
  const instance = layout?.instances.find(i => i.id === reference.instanceId && i.pluginId === reference.pluginId && !data?.scopes?.unavailableInstances.includes(i.id));
  const plugin = data?.plugins.find(p => p.id === reference.pluginId && !p.error && p.manifest?.enabled && p.revision === reference.revision && p.manifest.views[reference.viewId]?.surfaces.includes('chat.message'));
  return <section ref={ref} className="plugin-message" data-plugin-reference={reference.instanceId}>
    <p>{reference.summary}</p>
    <Link to={`/plugins/${encodeURIComponent(reference.instanceId)}`}>打开当前实例</Link>
    {closed && plugin && instance ? <>
      <button type="button" onClick={() => setActivate(v => !v)}>{activate ? '收起插件视图' : '展开插件视图'}</button>
      {activate && visible ? <PluginHost plugin={plugin} instance={instance} placement={{ id: `message-${identity}`, pluginId: reference.pluginId, instanceId: reference.instanceId, viewId: reference.viewId, surface: 'chat.message', scope: instance.scope, order: 0 }} context={{ surface: 'chat.message', revision: `${reference.instanceId}:${reference.revision}`, locale: i18n.language, theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light', projectId: instance.scope.kind === 'project' ? instance.scope.id : instance.scope.kind === 'material' ? data?.scopes?.materialProjects[instance.scope.id] : undefined, materialId: instance.scope.kind === 'material' ? instance.scope.id : undefined, width: ref.current?.clientWidth ?? 320, mode: 'inline' }} /> : null}
    </> : <p className="text-sm text-muted">{!closed ? '正在接收引用…' : '插件已停用、卸载、更新或实例不可用；历史摘要保留。'}</p>}
  </section>;
}
