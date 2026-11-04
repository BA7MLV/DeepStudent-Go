import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MATERIAL_TASK_ACTIONS } from '@wangke/contracts/learning-plugins';
import type { BuiltinViewProps } from '../builtins';
import type { PluginProjectionHook } from '../../client/plugin-projection';
import { confirmDialog } from '../../ui';
import './learning.css';

interface Task { id: string; status: string; origin: { actionId: string }; progress?: { message?: string }; error?: string; deliveryError?: string }
export default function MaterialToolsView({ plugin, instance, context, call, useProjection }: BuiltinViewProps) {
  const [chosen, setChosen] = useState('');
  const materialId = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  const projection = useProjection([{ key: 'result', method: 'learning.materials', args: {} }]);
  const materials = (projection.data as unknown as { result: { materials: { id: string; name: string }[] } } | undefined)?.result.materials ?? [];
  return <div className="learning-plugin" data-testid="plugin-material-tools">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="处理资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === materialId)?.name ?? materialId}</p>}
    {projection.error ? <p role="alert">{projection.error}</p> : null}
    {materialId ? <MaterialTasks key={`${plugin.id}:${instance.id}:${plugin.revision}:${materialId}`} materialId={materialId} useProjection={useProjection} call={call} /> : <p>选择资料，使用原执行器生成或处理学习资源。</p>}
  </div>;
}
function MaterialTasks({ materialId, useProjection, call }: { materialId: string; useProjection: PluginProjectionHook; call: (method: string, args?: Record<string, unknown>) => Promise<unknown> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const projection = useProjection([{ key: 'result', method: 'learning.results', args: { materialId } }]);
  const tasks = (projection.data as unknown as { result: { tasks: Task[] } } | undefined)?.result.tasks ?? [];
  return <>
    <p className="text-sm text-muted">复用原讲义、评论、弹幕、字幕、解析与封面任务及数据。浏览器任务必须有已登录页面保持打开；排队不表示产物已保存。</p>
    <Link to={`/player/${encodeURIComponent(materialId)}`}>打开资料与原学习产物</Link>
    {error || projection.error ? <p role="alert">{error || projection.error}</p> : null}
    <div className="learning-plugin__actions">{MATERIAL_TASK_ACTIONS.map(action => <button type="button" key={action.id} disabled={busy || tasks.some(t => t.origin.actionId === `material.${action.id}` && ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={async () => {
      if (!await confirmDialog({ headline: action.title, description: `${action.note} 将操作当前资料，沿用原功能的覆盖语义。`, confirmText: '继续', cancelText: '取消' })) return;
      setBusy(true); setError('');
      try { await call(`material.${action.id}`, { materialId, clientNonce: crypto.randomUUID(), ...(action.id === 'cover' ? { force: true } : {}) }); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>{action.title}</button>)}</div>
    <ul>{tasks.map(task => <li key={task.id}>{MATERIAL_TASK_ACTIONS.find(a => `material.${a.id}` === task.origin.actionId)?.title ?? task.origin.actionId} · {task.status === 'completed' ? '执行结束，请查看原产物' : task.status}{task.progress?.message ? ` · ${task.progress.message}` : ''}{task.error || task.deliveryError ? <p role="alert">{task.error ?? task.deliveryError}</p> : null}</li>)}</ul>
  </>;
}
