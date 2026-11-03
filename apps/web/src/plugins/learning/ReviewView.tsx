import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuiltinViewProps } from '../builtins';
import { pluginRpc, subscribePluginRead } from '../shared';
import './learning.css';
import { PracticeSession } from './PracticeView';
import { readPluginNumberDraft, writePluginNumberDraft } from '../drafts';

interface ReviewSnapshot {
  cards: { total: number; pending: number; kept: number }; due: number; completed: number;
  notebookMaterialId: string | null;
  questions: { id: string; stem: string; status: string; due: string; dueNow: boolean; attempts: number }[];
}
export default function ReviewView({ plugin, instance, placement, context }: BuiltinViewProps) {
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const call = useCallback((method: string, args: Record<string, unknown> = {}) => pluginRpc(endpoint, plugin.revision, method, args), [endpoint, plugin.revision]);
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([]), [chosen, setChosen] = useState(''), [error, setError] = useState('');
  const id = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  useEffect(() => {
    let ignore = false;
    void call('learning.materials').then(value => { if (!ignore) setMaterials((value as { materials: typeof materials }).materials); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    return () => { ignore = true; };
  }, [call]);
  return <div className="learning-plugin" data-testid="plugin-review">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="复习资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === id)?.name ?? id}</p>}
    {error ? <p role="alert">{error}</p> : null}
    {id ? <MaterialReview key={id} materialId={id} endpoint={endpoint} draftScope={placement.id} revision={plugin.revision} call={call} /> : <p>选择资料查看原有卡片与 FSRS 错题复习进度。</p>}
  </div>;
}
function MaterialReview({ materialId, endpoint, draftScope, revision, call }: { materialId: string; endpoint: string; draftScope: string; revision?: number; call: (method: string, args?: Record<string, unknown>) => Promise<unknown> }) {
  const selectionKey = `plugin-draft:review-selection:${endpoint}:${revision}:${draftScope}:${materialId}`;
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null), [error, setError] = useState('');
  const [rowId, setRowId] = useState<number | undefined>(() => readPluginNumberDraft(selectionKey));
  const read = useCallback(() => call('review.list', { materialId }), [call, materialId]);
  useEffect(() => {
    let ignore = false;
    void read().then(v => { if (!ignore) setSnapshot(v as ReviewSnapshot); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    const off = subscribePluginRead(`learning:review:${endpoint}:${revision}:${materialId}`, read, value => { if (!ignore) setSnapshot(value as ReviewSnapshot); });
    return () => { ignore = true; off(); };
  }, [read, endpoint, revision, materialId]);
  const startReview = async (questionId: string) => {
    try { const result = await call('review.present', { materialId, questionId, clientNonce: crypto.randomUUID() }) as { rowId: number }; setRowId(result.rowId); writePluginNumberDraft(selectionKey, result.rowId); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <>{error ? <p role="alert">{error}</p> : null}{snapshot ? <>
    <p>到期 {snapshot.due} 题 · 已掌握 {snapshot.completed} 题 · 共 {snapshot.questions.length} 道错题</p>
    <p>卡片 {snapshot.cards.total} 张 · 待审核 {snapshot.cards.pending} 张 · 已保留 {snapshot.cards.kept} 张</p>
    <div className="learning-plugin__actions"><Link to={`/player/${encodeURIComponent(materialId)}`}>打开学习资料</Link>{snapshot.notebookMaterialId ? <Link to={`/player/${encodeURIComponent(snapshot.notebookMaterialId)}`}>打开原错题本</Link> : null}</div>
    <p className="text-sm text-muted">复习日期读取原错题本的 FSRS 记录；不会另建一份清单或将卡片审核冒充复习成绩。</p>
    {rowId ? <PracticeSession key={rowId} rowId={rowId} endpoint={`${endpoint}:${revision}`} draftScope={draftScope} call={call} /> : null}
    {snapshot.questions.length ? snapshot.questions.map(q => <article key={q.id} className="learning-plugin__card"><strong>{q.stem}</strong><p>{q.status === 'mastered' ? '已掌握' : q.dueNow ? '已到期' : `下次复习：${new Date(q.due).toLocaleString()}`} · 已作答 {q.attempts} 次</p><button type="button" onClick={() => void startReview(q.id)}>开始复习</button></article>) : <p>这份资料还没有错题复习记录。</p>}
  </> : !error ? <p aria-busy="true">读取原学习记录…</p> : null}</>;
}
