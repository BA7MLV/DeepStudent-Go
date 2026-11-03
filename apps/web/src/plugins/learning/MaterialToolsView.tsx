import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MATERIAL_TASK_ACTIONS } from '@wangke/contracts/learning-plugins';
import type { BuiltinViewProps } from '../builtins';
import { pluginRpc, subscribePluginRead } from '../shared';
import { confirmDialog } from '../../ui';
import './learning.css';

interface Task { id: string; status: string; origin: { actionId: string }; progress?: { message?: string }; error?: string; deliveryError?: string }
export default function MaterialToolsView({ plugin, instance, context }: BuiltinViewProps) {
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const call = useCallback((method: string, args: Record<string, unknown> = {}) => pluginRpc(endpoint, plugin.revision, method, args), [endpoint, plugin.revision]);
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([]), [chosen, setChosen] = useState(''), [error, setError] = useState('');
  const materialId = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  useEffect(() => {
    let ignore = false;
    void call('learning.materials').then(v => { if (!ignore) setMaterials((v as { materials: typeof materials }).materials); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    return () => { ignore = true; };
  }, [call]);
  return <div className="learning-plugin" data-testid="plugin-material-tools">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="处理资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === materialId)?.name ?? materialId}</p>}
    {error ? <p role="alert">{error}</p> : null}
    {materialId ? <MaterialTasks key={materialId} materialId={materialId} endpoint={endpoint} revision={plugin.revision} call={call} /> : <p>选择资料，使用原执行器生成或处理学习资源。</p>}
  </div>;
}
function MaterialTasks({ materialId, endpoint, revision, call }: { materialId: string; endpoint: string; revision?: number; call: (method: string, args?: Record<string, unknown>) => Promise<unknown> }) {
  const [tasks, setTasks] = useState<Task[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const read = useCallback(() => call('learning.results', { materialId }), [call, materialId]);
  useEffect(() => {
    let ignore = false;
    void read().then(value => { if (!ignore) setTasks((value as { tasks: Task[] }).tasks); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    const off = subscribePluginRead(`learning:material:${endpoint}:${revision}:${materialId}`, read, value => { if (!ignore) setTasks((value as { tasks: Task[] }).tasks); });
    return () => { ignore = true; off(); };
  }, [read, endpoint, revision, materialId]);
  return <>
    <p className="text-sm text-muted">复用原讲义、评论、弹幕、字幕、解析与封面任务及数据。浏览器任务必须有已登录页面保持打开；排队不表示产物已保存。</p>
    <Link to={`/player/${encodeURIComponent(materialId)}`}>打开资料与原学习产物</Link>
    {error ? <p role="alert">{error}</p> : null}
    <div className="learning-plugin__actions">{MATERIAL_TASK_ACTIONS.map(action => <button type="button" key={action.id} disabled={busy || tasks.some(t => t.origin.actionId === `material.${action.id}` && ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={async () => {
      if (!await confirmDialog({ headline: action.title, description: `${action.note} 将操作当前资料，沿用原功能的覆盖语义。`, confirmText: '继续', cancelText: '取消' })) return;
      setBusy(true); setError('');
      try { await call(`material.${action.id}`, { materialId, clientNonce: crypto.randomUUID(), ...(action.id === 'cover' ? { force: true } : {}) }); setTasks((await read() as { tasks: Task[] }).tasks); }
      catch (e) { setError(e instanceof Error ? e.message : String(e)); }
      finally { setBusy(false); }
    }}>{action.title}</button>)}</div>
    <ul>{tasks.map(task => <li key={task.id}>{MATERIAL_TASK_ACTIONS.find(a => `material.${a.id}` === task.origin.actionId)?.title ?? task.origin.actionId} · {task.status === 'completed' ? '执行结束，请查看原产物' : task.status}{task.progress?.message ? ` · ${task.progress.message}` : ''}{task.error || task.deliveryError ? <p role="alert">{task.error ?? task.deliveryError}</p> : null}</li>)}</ul>
  </>;
}
