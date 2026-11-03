import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { pluginRpc, subscribePluginRead } from '../shared';
import type { BuiltinViewProps } from '../builtins';
import type { CardRow } from '../../store/db';
import { confirmDialog } from '../../ui';
import './learning.css';

interface ResultTask { id: string; status: string; error: string | null; progress?: { message?: string }; artifacts?: { count: number; cardIds: number[] }; deliveryError?: string }
interface Snapshot { cards: CardRow[]; revision: string; tasks: ResultTask[] }
export default function FlashcardsView(props: BuiltinViewProps) {
  const { plugin, instance, context } = props;
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const call = useCallback((method: string, args: Record<string, unknown> = {}) => pluginRpc(endpoint, plugin.revision, method, args), [endpoint, plugin.revision]);
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([]);
  const [chosen, setChosen] = useState('');
  const materialId = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  const [error, setError] = useState('');
  useEffect(() => {
    let ignore = false;
    void call('learning.materials').then(value => { if (!ignore) setMaterials((value as { materials: typeof materials }).materials); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    return () => { ignore = true; };
  }, [call]);
  return <div className="learning-plugin" data-testid="plugin-flashcards">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="卡片资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === materialId)?.name ?? materialId}</p>}
    {error ? <p role="alert">{error}</p> : null}
    {materialId ? <MaterialCards key={materialId} materialId={materialId} call={call} endpoint={endpoint} revision={plugin.revision} /> : <p>选择一份资料，或在阅读侧栏挂载此实例。</p>}
  </div>;
}

function MaterialCards({ materialId, call, endpoint, revision }: { materialId: string; call: (method: string, args?: Record<string, unknown>) => Promise<unknown>; endpoint: string; revision?: number }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const read = useCallback(async (): Promise<Snapshot> => {
    const [cards, results] = await Promise.all([call('cards.list', { materialId }), call('learning.results', { materialId })]);
    return { ...(cards as { cards: CardRow[]; revision: string }), ...(results as { tasks: ResultTask[] }) };
  }, [call, materialId]);
  useEffect(() => {
    setSnapshot(null); setError(''); setBusy(false);
    if (!materialId) return;
    let ignore = false;
    void read().then(value => { if (!ignore) setSnapshot(value); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    const off = subscribePluginRead(`learning:cards:${endpoint}:${revision}:${materialId}`, read, value => { if (!ignore) setSnapshot(value as Snapshot); });
    return () => { ignore = true; off(); };
  }, [read, endpoint, revision, materialId]);
  // A keyed host prevents in-flight actions for A from updating B's local view.
  const generate = async () => {
    if (!snapshot || busy) return;
    if (snapshot.cards.length && !await confirmDialog({ headline: '重新生成卡片', description: `将替换这份资料的 ${snapshot.cards.length} 张卡片及审核结果。其他位置引用的也是同一份卡片，确定继续？`, confirmText: '重新生成', cancelText: '取消', danger: true })) return;
    setBusy(true); setError('');
    try {
      await call('cards.generate', { materialId, clientNonce: crypto.randomUUID(), ...(snapshot.cards.length ? { replaceRevision: snapshot.revision } : {}) });
      setSnapshot(await read());
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const update = async (id: number, status: number) => {
    try { await call('cards.update', { materialId, id, status }); setSnapshot(await read()); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  const running = snapshot?.tasks.some(t => ['queued', 'running', 'waiting_user'].includes(t.status));
  return <>
    <p className="text-sm text-muted">卡片和审核结果复用原学习记录。生成由服务器执行，关闭此页面后仍会继续；服务器重启中断时可重试。</p>
    {error ? <p role="alert">{error}</p> : null}
    {materialId ? <><div className="learning-plugin__actions"><button type="button" disabled={!snapshot || busy || running} onClick={() => void generate()}>{busy || running ? '正在生成…' : snapshot?.cards.length ? '重新生成卡片' : '生成卡片'}</button><Link to={`/player/${encodeURIComponent(materialId)}`}>打开资料与导出</Link></div>
      {!snapshot ? <p aria-busy="true">读取学习记录…</p> : <><p>{snapshot.cards.length} 张卡片 · 已保留 {snapshot.cards.filter(c => c.status === 1).length} 张</p>
        <ul className="learning-plugin__tasks">{snapshot.tasks.slice(0, 5).map(t => <li key={t.id}><strong>{t.artifacts ? `已保存 ${t.artifacts.count} 张卡片` : t.status === 'completed' ? '执行已结束，等待产物收据' : t.status}</strong>{t.progress?.message ? <span> · {t.progress.message}</span> : null}{t.error || t.deliveryError ? <p role="alert">{t.error ?? t.deliveryError}</p> : null}</li>)}</ul>
        {!snapshot.cards.length ? <p>还没有卡片。从已解析资料或字幕生成，AI 内容需自行核对。</p> : snapshot.cards.map(c => <article className="learning-plugin__card" key={c.id}><strong>{c.q}</strong><details><summary>查看 AI 参考答案</summary><p>{c.a}</p></details><div className="learning-plugin__actions"><button type="button" aria-pressed={c.status === 1} onClick={() => void update(c.id!, c.status === 1 ? 0 : 1)}>保留</button><button type="button" aria-pressed={c.status === 2} onClick={() => void update(c.id!, c.status === 2 ? 0 : 2)}>丢弃</button></div></article>)}</>}
    </> : <p>选择一份资料，或在阅读侧栏挂载此实例。</p>}
  </>;
}
