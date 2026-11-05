import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuiltinViewProps } from '../builtins';
import type { CardRow } from '../../store/db';
import { confirmDialog } from '../../ui';
import './learning.css';
import { useSustained } from '../../utils/useSustained';

interface ResultTask { id: string; status: string; error: string | null; progress?: { message?: string }; artifacts?: { count: number; cardIds: number[] }; deliveryError?: string }
interface Snapshot { cards: CardRow[]; revision: string; tasks: ResultTask[] }
export default function FlashcardsView(props: BuiltinViewProps) {
  const { plugin, instance, context, call, useProjection } = props;
  const [chosen, setChosen] = useState('');
  const materialId = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  const projectionKey = JSON.stringify([plugin.id, instance.id, plugin.revision, materialId]);
  const projection = useProjection([
      { key: 'materials', method: 'learning.materials', args: {} },
      ...(materialId ? [
        { key: 'cards', method: 'cards.list', args: { materialId } },
        { key: 'results', method: 'learning.results', args: { materialId } },
      ] : []),
    ]);
  const next = projection.data as unknown as { materials: { materials: { id: string; name: string }[] }; cards?: Pick<Snapshot, 'cards' | 'revision'>; results?: Pick<Snapshot, 'tasks'> } | undefined;
  const materials = next?.materials.materials ?? [];
  const reconnecting = useSustained(projection.status === 'reconnecting', 10000);
  return <div className="learning-plugin" data-testid="plugin-flashcards">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="卡片资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === materialId)?.name ?? materialId}</p>}
    {projection.error ? <p role="alert">{projection.error}</p> : null}
    {reconnecting ? <p role="status">连接中断，正在恢复学习记录…</p> : null}
    {materialId ? <MaterialCards key={projectionKey} materialId={materialId} call={call} snapshot={next?.cards && next.results ? { ...next.cards, ...next.results } : null} /> : <p>选择一份资料，或在阅读侧栏挂载此实例。</p>}
  </div>;
}

function MaterialCards({ materialId, call, snapshot }: { materialId: string; call: (method: string, args?: Record<string, unknown>) => Promise<unknown>; snapshot: Snapshot | null }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // A keyed host prevents in-flight actions for A from updating B's local view.
  const generate = async () => {
    if (!snapshot || busy) return;
    if (snapshot.cards.length && !await confirmDialog({ headline: '重新生成卡片', description: `将替换这份资料的 ${snapshot.cards.length} 张卡片及审核结果。其他位置引用的也是同一份卡片，确定继续？`, confirmText: '重新生成', cancelText: '取消', danger: true })) return;
    setBusy(true); setError('');
    try {
      await call('cards.generate', { materialId, clientNonce: crypto.randomUUID(), ...(snapshot.cards.length ? { replaceRevision: snapshot.revision } : {}) });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const update = async (id: number, status: number) => {
    const card = snapshot?.cards.find(card => card.id === id);
    if (!card) return;
    try { await call('cards.update', { materialId, id, expected: card.status, status }); setError(''); }
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
