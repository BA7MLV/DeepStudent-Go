import { useState } from 'react';
import { PLUGIN_SURFACES, parsePluginLayout, pluginTargets, type PluginPackage, type PluginScope, type PluginSurface } from '@wangke/contracts/plugins';
import { request } from '../api/serverClient';
import { refreshPlugins, type PluginCatalog } from './catalog';
import { saveLocalPluginLayout } from './availability';

export function PluginManager({ catalog, surface, materialId, projectId }: { catalog: PluginCatalog; surface: PluginSurface; materialId?: string; projectId?: string }) {
  const [pluginId, setPluginId] = useState('');
  const [viewId, setViewId] = useState('');
  const [instanceId, setInstanceId] = useState('');
  const [target, setTarget] = useState<PluginSurface>(surface);
  const [scope, setScope] = useState<PluginScope>(() => projectId ? { kind: 'project', id: projectId } : { kind: 'account' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const layout = parsePluginLayout(JSON.parse(catalog.layout.content));
  const plugin = catalog.plugins.find(p => p.id === pluginId && !p.error && p.manifest?.enabled);
  const views = Object.entries(pluginTargets(plugin?.manifest)).filter(([, view]) => view.surfaces.includes(target));
  const selectedView = views.find(([id]) => id === viewId)?.[0] ?? views[0]?.[0];
  const save = async (next: typeof layout) => {
    setBusy(true); setError('');
    try { const content = JSON.stringify(next, null, 2) + '\n'; if (catalog.local) saveLocalPluginLayout(content, catalog.layout.content, catalog.layout.revision); else await request('/plugins/layout', { method: 'POST', body: JSON.stringify({ content, expected: catalog.layout.content, revision: catalog.layout.revision }) }); await refreshPlugins(); }
    catch (e) { setError(e instanceof Error ? e.message : 'plugin_save_failed'); await refreshPlugins(); }
    finally { setBusy(false); }
  };
  const add = async () => {
    if (!plugin || !selectedView) return;
    const id = instanceId || crypto.randomUUID();
    if (!instanceId) layout.instances.push({ id, pluginId, scope });
    layout.placements.push({ id: crypto.randomUUID(), pluginId, instanceId: id, viewId: selectedView, surface: target, scope, order: layout.placements.filter(p => p.surface === target).length });
    await save(layout);
  };
  const lifecycle = async (pkg: PluginPackage, status: 'enabled' | 'disabled' | 'uninstalled') => {
    if (catalog.local) { layout.installations = { ...layout.installations, [`${pkg.source}:${pkg.id}`]: status }; await save(layout); return; }
    setBusy(true); setError('');
    try {
      await request(`/plugins/${encodeURIComponent(pkg.id)}/lifecycle`, { method: 'POST', body: JSON.stringify({ source: pkg.source, status, expected: catalog.layout.content, revision: catalog.layout.revision }) });
      await refreshPlugins();
    } catch (e) { setError(e instanceof Error ? e.message : 'plugin_save_failed'); }
    finally { setBusy(false); }
  };
  return <details className="plugin-manager"><summary>添加组件 / 管理挂载</summary><div className="plugin-manager__form">
    {catalog.local ? <p>本地配置独立于云账户；原生管道按此配置接纳新任务。云插件视图与持久任务需登录后使用，本地历史仍可阅读。</p> : null}
    {catalog.plugins.filter(p => p.error === 'plugin_source_conflict' || p.error === 'plugin_source_not_selected').map(p => <div className="plugin-manager__row" key={`${p.id}:${p.source}`}><span>{p.id} · {p.source} · {p.error === 'plugin_source_conflict' ? '同 ID 来源冲突' : '未选中来源'}</span><button disabled={busy} onClick={() => { layout.sources = { ...layout.sources, [p.id]: p.source }; void save(layout); }}>选用此来源</button></div>)}
    <label>位置<select aria-label="位置" value={target} onChange={e => { setTarget(e.target.value as PluginSurface); setViewId(''); }}>{PLUGIN_SURFACES.map(s => <option key={s}>{s}</option>)}</select></label>
    <label>插件<select aria-label="插件" value={pluginId} onChange={e => { setPluginId(e.target.value); setInstanceId(''); setViewId(''); }}><option value="">选择插件</option>{catalog.plugins.map(p => <option key={`${p.source}:${p.id}`} value={p.id} disabled={!!p.error || !p.manifest?.enabled}>{p.manifest?.name ?? p.id}{p.error ? ` · ${p.error}` : ''}</option>)}</select></label>
    <label>视图<select aria-label="视图" value={selectedView ?? ''} onChange={e => setViewId(e.target.value)}>{views.map(([id]) => <option key={id}>{id}</option>)}</select></label>
    <label>数据实例<select aria-label="数据实例" value={instanceId} onChange={e => { setInstanceId(e.target.value); const selected = layout.instances.find(i => i.id === e.target.value); if (selected && selected.scope.kind !== 'account') setScope(selected.scope); }}><option value="">创建独立实例</option>{layout.instances.filter(i => i.pluginId === pluginId).map(i => <option key={i.id} value={i.id} disabled={catalog.scopes?.unavailableInstances.includes(i.id)}>{i.title ?? i.id} · {i.scope.kind === 'account' ? '账户' : `${i.scope.kind}:${i.scope.id}`} · 复用数据</option>)}</select></label>
    <label>挂载范围<select aria-label="挂载范围" value={scope.kind} onChange={e => { if (e.target.value === 'account') setScope({ kind: 'account' }); else if (e.target.value === 'material' && materialId) setScope({ kind: 'material', id: materialId }); else { const id = projectId ?? catalog.scopes?.projects[0]?.id; if (id) setScope({ kind: 'project', id }); } }}><option value="account">账户默认</option><option value="project" disabled={!catalog.scopes?.projects.length}>项目</option><option value="material" disabled={!materialId}>当前资料（覆盖项目）</option></select></label>
    {scope.kind === 'project' ? <label>范围项目<select aria-label="范围项目" value={scope.id} onChange={e => setScope({ kind: 'project', id: e.target.value })}>{catalog.scopes?.projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label> : null}
    {materialId ? <label><input type="checkbox" checked={scope.kind === 'material'} onChange={e => setScope(e.target.checked ? { kind: 'material', id: materialId } : projectId ? { kind: 'project', id: projectId } : { kind: 'account' })} /> 仅当前资料</label> : null}
    <button type="button" disabled={busy || !selectedView || catalog.local} onClick={() => void add()}>保存挂载</button>
    {layout.placements.filter(p => p.surface === target).sort((a, b) => a.order - b.order).map((p, index, placements) => <div className="plugin-manager__row" key={p.id}><span>{p.pluginId} · {p.instanceId}</span><button disabled={busy || index === 0} onClick={() => { const previous = placements[index - 1]; const order = p.order; p.order = previous.order; previous.order = order; void save(layout); }}>上移</button><label>移动到<select aria-label={`移动 ${p.id}`} value={p.surface} disabled={busy} onChange={e => { p.surface = e.target.value as PluginSurface; p.order = layout.placements.filter(row => row.surface === p.surface).length; void save(layout); }}>{pluginTargets(catalog.plugins.find(pkg => pkg.id === p.pluginId && !pkg.error)?.manifest)[p.viewId]?.surfaces.map(s => <option key={s}>{s}</option>)}</select></label><button disabled={busy} onClick={() => { layout.placements = layout.placements.filter(row => row.id !== p.id); void save(layout); }}>隐藏入口（保留数据）</button></div>)}
    <details><summary>插件包启用状态</summary><p>隐藏只移除当前挂载。停用或卸载撤销新调用和未来调度，保留学习历史、已受理任务、实例与挂载；恢复不重新生成。删除业务数据须在原资料管理中单独确认。</p>{catalog.plugins.filter(p => p.manifest).map(p => <div key={`${p.source}:${p.id}`} className="plugin-manager__row" data-plugin-package={`${p.source}:${p.id}`}><span>{p.manifest!.name} · {p.manifest!.version} · {p.source} · {p.installation === 'uninstalled' ? '已卸载（保留数据）' : p.manifest!.enabled ? '已启用' : '已停用'} · {p.provider === 'native' ? '受信原生提供者' : '隔离 HTML'}{p.error ? ` · ${p.error}` : ''}{p.dependencies?.required.length ? ` · 缺少依赖：${p.dependencies.required.join(', ')}` : ''}</span><button disabled={busy} onClick={() => void lifecycle(p, p.manifest!.enabled && p.installation !== 'uninstalled' ? 'disabled' : 'enabled')}>{p.installation === 'uninstalled' ? '重新安装并恢复' : p.manifest!.enabled ? '停用插件' : '启用插件'}</button>{p.installation !== 'uninstalled' ? <button disabled={busy} onClick={() => void lifecycle(p, 'uninstalled')}>卸载（保留数据）</button> : null}</div>)}</details>
    {error ? <p role="alert">{error}</p> : null}
  </div></details>;
}
