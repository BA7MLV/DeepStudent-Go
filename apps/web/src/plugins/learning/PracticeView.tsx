import { useRef, useState } from 'react';
import type { QuizData, QuizPick } from '@wangke/study-core/quiz';
import QuizCard from '../../components/QuizCard';
import type { BuiltinViewProps } from '../builtins';
import type { PluginProjectionHook } from '../../client/plugin-projection';
import { readPluginNumberDraft, writePluginNumberDraft } from '../drafts';
import './learning.css';

interface PracticeSummary { id: number; content: string; questions: number; answered: number }
interface PracticeRow { id: number; content: string; quiz: { data: QuizData; picks: QuizPick[] } }
interface PracticeResult { row: PracticeRow; submissions: { question_index: number; delivered_at: string | null; error: string | null }[] }
type Call = (method: string, args?: Record<string, unknown>) => Promise<unknown>;
export default function PracticeView({ plugin, instance, placement, context, draftIdentity, call, useProjection }: BuiltinViewProps) {
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const [chosen, setChosen] = useState('');
  const id = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  const projection = useProjection([{ key: 'result', method: 'learning.materials', args: {} }]);
  const materials = (projection.data as unknown as { result: { materials: { id: string; name: string }[] } } | undefined)?.result.materials ?? [];
  return <div className="learning-plugin" data-testid="plugin-practice">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="练习资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === id)?.name ?? id}</p>}
    {projection.error ? <p role="alert">{projection.error}</p> : null}
    {id ? <MaterialPractice key={`${endpoint}:${plugin.revision}:${id}`} materialId={id} endpoint={`${endpoint}:${plugin.revision}`} draftScope={draftIdentity ?? placement.id} call={call} useProjection={useProjection} /> : <p>选择资料生成 AI 练习，或从现有 Markdown 题库打开原题。</p>}
  </div>;
}
function MaterialPractice({ materialId, endpoint, draftScope, call, useProjection }: { materialId: string; endpoint: string; draftScope: string; call: Call; useProjection: PluginProjectionHook }) {
  const selectionKey = `plugin-draft:practice-selection:${endpoint}:${draftScope}:${materialId}`;
  type Task = { id: string; status: string; error?: string; deliveryError?: string; origin?: { actionId: string }; artifacts?: { kind?: string; count: number; coverage?: string } };
  const [selected, setSelected] = useState<number | undefined>(() => readPluginNumberDraft(selectionKey)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const select = (rowId: number) => { setSelected(rowId); writePluginNumberDraft(selectionKey, rowId); };
  const projection = useProjection([{ key: 'list', method: 'practice.list', args: { materialId } }, { key: 'results', method: 'learning.results', args: { materialId } }]);
  const next = projection.data as unknown as { list: { practices: PracticeSummary[] }; results: { tasks: Task[] } } | undefined;
  const practices = next?.list.practices ?? [], tasks = next?.results.tasks ?? [];
  const start = async (method: string, offset = 0) => {
    setBusy(true); setError('');
    try {
      const result = await call(method, { materialId, clientNonce: crypto.randomUUID(), ...(method === 'practice.present' ? { offset, limit: 5 } : method === 'practice.generate' ? { count: 5 } : {}) }) as { rowId?: number };
      if (result.rowId) select(result.rowId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const active = selected ?? practices[0]?.id;
  return <>
    <div className="learning-plugin__actions"><button type="button" disabled={busy || tasks.some(t => ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={() => void start('practice.generate')}>生成 AI 练习</button><button type="button" disabled={busy || tasks.some(t => t.origin?.actionId === 'practice.extract' && ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={() => void start('practice.extract')}>提取原题为题库</button><button type="button" disabled={busy} onClick={() => void start('practice.present')}>打开原题题库</button></div>
    <p className="text-sm text-muted">原题由服务器逐页提取，经原读写授权保存；关闭浏览器不影响任务，排队不代表已完成。已保存部分可打开题库，实际覆盖范围请查看“插件原题提取”会话。</p>
    <p className="text-sm text-muted">AI 练习仅供参考，不冒充原题或已核验答案。原题按题库声明保留原文、已核验、AI 参考和缺失答案标记。</p>
    {error || projection.error ? <p role="alert">{error || projection.error}</p> : null}
    {tasks.map(t => <p key={t.id}>{t.artifacts ? t.artifacts.kind === 'question-bank' ? `题库现有 ${t.artifacts.count} 道原题 · ${t.artifacts.coverage}` : `已保存 ${t.artifacts.count} 道练习` : t.origin?.actionId === 'practice.extract' ? `原题提取：${t.status}（执行结束不代表题库保存成功）` : t.status}{t.error ? ` · ${t.error}` : ''}{t.deliveryError ? ` · 产物尚未确认：${t.deliveryError}` : ''}</p>)}
    {practices.length ? <label>练习记录<select aria-label="练习记录" value={active} onChange={e => select(Number(e.target.value))}>{practices.map(p => <option key={p.id} value={p.id}>{p.content} · {p.answered}/{p.questions}</option>)}</select></label> : <p>暂无练习记录。生成在服务器执行；作答保存在原会话快照中，关闭页面后可恢复。</p>}
    {active ? <PracticeSession key={active} rowId={active} endpoint={endpoint} draftScope={draftScope} call={call} useProjection={useProjection} onNext={offset => void start('practice.present', offset)} /> : null}
  </>;
}
export function PracticeSession({ rowId, endpoint, draftScope, call, useProjection, onNext }: { rowId: number; endpoint: string; draftScope?: string; call: Call; useProjection: PluginProjectionHook; onNext?: (offset: number) => void }) {
  const [error, setError] = useState('');
  const [pending, setPending] = useState<Record<number, { pick: QuizPick; durationSeconds: number }>>({});
  const inFlight = useRef(new Set<number>());
  const projection = useProjection([{ key: 'result', method: 'practice.get', args: { rowId } }]);
  const snapshot = (projection.data as unknown as { result: PracticeResult } | undefined)?.result;
  const submit = async (questionIndex: number, pick: QuizPick, durationSeconds: number) => {
    if (inFlight.current.has(questionIndex)) return;
    inFlight.current.add(questionIndex);
    setPending(p => ({ ...p, [questionIndex]: { pick, durationSeconds } }));
    try {
      await call('practice.submit', { rowId, questionIndex, pick, durationSeconds });
      setError('');
      setPending(p => { const next = { ...p }; delete next[questionIndex]; return next; });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current.delete(questionIndex); }
  };
  if (!snapshot) return error || projection.error ? <p role="alert">{error || projection.error}</p> : <p aria-busy="true">读取练习快照…</p>;
  const bank = snapshot.row.quiz.data.bank, next = bank ? bank.offset + snapshot.row.quiz.data.questions.length : 0;
  return <>
    <QuizCard key={rowId} draftStorageKey={`plugin-draft:quiz:${endpoint}:${draftScope ?? 'default'}:${rowId}`} quiz={snapshot.row.quiz.data} picks={snapshot.row.quiz.picks} seekable={false} onAnswer={() => {}} onAttempt={(i, p, d) => void submit(i, p, d)} />
    {error ? <p role="alert">提交未保存：{error}</p> : null}
    {Object.entries(pending).map(([i, p]) => <button type="button" key={i} onClick={() => void submit(Number(i), p.pick, p.durationSeconds)}>重试保存第 {Number(i) + 1} 题</button>)}
    {snapshot.submissions.filter(s => s.question_index >= 0 && !s.delivered_at).map(s => <p key={s.question_index} role={s.error ? 'alert' : 'status'}>{s.error ? '作答已保存；原错题本登记失败，服务器会重试。' : '作答已保存，正在登记原错题本…'}</p>)}
    {bank ? <p>原题快照 · {bank.path} · 第 {bank.offset + 1}–{next} 题 / 共 {bank.total} 题（后续文件修改不会重算此快照）</p> : null}
    {bank && next < bank.total && onNext ? <button type="button" onClick={() => onNext(next)}>下一批原题</button> : null}
  </>;
}
