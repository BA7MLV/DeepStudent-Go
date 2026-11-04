import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { BuiltinViewProps } from '../builtins';
import type { PluginProjectionHook } from '../../client/plugin-projection';
import './learning.css';
import { PracticeSession } from './PracticeView';
import { readPluginNumberDraft, writePluginNumberDraft } from '../drafts';

interface ReviewSnapshot {
  asOf: number;
  cards: { total: number; pending: number; kept: number }; due: number; completed: number;
  notebookMaterialId: string | null;
  questions: { id: string; stem: string; status: string; due: string; dueNow: boolean; attempts: number }[];
}
export default function ReviewView({ plugin, instance, placement, context, draftIdentity, call, useProjection }: BuiltinViewProps) {
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const [chosen, setChosen] = useState('');
  const id = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  const projection = useProjection([{ key: 'result', method: 'learning.materials', args: {} }]);
  const materials = (projection.data as unknown as { result: { materials: { id: string; name: string }[] } } | undefined)?.result.materials ?? [];
  return <div className="learning-plugin" data-testid="plugin-review">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="复习资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === id)?.name ?? id}</p>}
    {projection.error ? <p role="alert">{projection.error}</p> : null}
    {id ? <MaterialReview key={`${endpoint}:${plugin.revision}:${id}`} materialId={id} endpoint={endpoint} draftScope={draftIdentity ?? placement.id} revision={plugin.revision} call={call} useProjection={useProjection} /> : <p>选择资料查看原有卡片与 FSRS 错题复习进度。</p>}
  </div>;
}
function MaterialReview({ materialId, endpoint, draftScope, revision, call, useProjection }: { materialId: string; endpoint: string; draftScope: string; revision?: number; call: (method: string, args?: Record<string, unknown>) => Promise<unknown>; useProjection: PluginProjectionHook }) {
  const selectionKey = `plugin-draft:review-selection:${endpoint}:${revision}:${draftScope}:${materialId}`;
  const [error, setError] = useState('');
  const projection = useProjection([{ key: 'result', method: 'review.list', args: { materialId } }]);
  const snapshot = (projection.data as unknown as { result: ReviewSnapshot } | undefined)?.result;
  const [clock, setClock] = useState(0), receivedAt = useRef(0);
  const [rowId, setRowId] = useState<number | undefined>(() => readPluginNumberDraft(selectionKey));
  useEffect(() => {
    if (snapshot) { receivedAt.current = performance.now(); setClock(snapshot.asOf); }
  }, [snapshot]);
  // Due labels are a view clock over server-owned FSRS timestamps, not a reason
  // to restore a periodic business read. Only the next deadline owns a timer.
  useEffect(() => {
    if (!snapshot) return;
    const next = Math.min(...snapshot.questions.filter(q => q.status !== 'mastered').map(q => Date.parse(q.due)).filter(due => due > clock));
    if (!Number.isFinite(next)) return;
    const now = snapshot.asOf + performance.now() - receivedAt.current;
    const timer = setTimeout(() => setClock(snapshot.asOf + performance.now() - receivedAt.current), Math.min(2147483647, Math.max(0, next - now)));
    return () => clearTimeout(timer);
  }, [snapshot, clock]);
  const dueNow = (q: ReviewSnapshot['questions'][number]) => q.status !== 'mastered' && Date.parse(q.due) <= clock;
  const startReview = async (questionId: string) => {
    try { const result = await call('review.present', { materialId, questionId, clientNonce: crypto.randomUUID() }) as { rowId: number }; setRowId(result.rowId); writePluginNumberDraft(selectionKey, result.rowId); setError(''); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  return <>{error || projection.error ? <p role="alert">{error || projection.error}</p> : null}{snapshot ? <>
    <p>到期 {snapshot.questions.filter(dueNow).length} 题 · 已掌握 {snapshot.completed} 题 · 共 {snapshot.questions.length} 道错题</p>
    <p>卡片 {snapshot.cards.total} 张 · 待审核 {snapshot.cards.pending} 张 · 已保留 {snapshot.cards.kept} 张</p>
    <div className="learning-plugin__actions"><Link to={`/player/${encodeURIComponent(materialId)}`}>打开学习资料</Link>{snapshot.notebookMaterialId ? <Link to={`/player/${encodeURIComponent(snapshot.notebookMaterialId)}`}>打开原错题本</Link> : null}</div>
    <p className="text-sm text-muted">复习日期读取原错题本的 FSRS 记录；不会另建一份清单或将卡片审核冒充复习成绩。</p>
    {rowId ? <PracticeSession key={rowId} rowId={rowId} endpoint={`${endpoint}:${revision}`} draftScope={draftScope} call={call} useProjection={useProjection} /> : null}
    {snapshot.questions.length ? snapshot.questions.map(q => <article key={q.id} className="learning-plugin__card"><strong>{q.stem}</strong><p>{q.status === 'mastered' ? '已掌握' : dueNow(q) ? '已到期' : `下次复习：${new Date(q.due).toLocaleString()}`} · 已作答 {q.attempts} 次</p><button type="button" onClick={() => void startReview(q.id)}>开始复习</button></article>) : <p>这份资料还没有错题复习记录。</p>}
  </> : !error ? <p aria-busy="true">读取原学习记录…</p> : null}</>;
}
