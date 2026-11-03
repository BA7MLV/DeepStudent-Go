import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuizData, QuizPick } from '@wangke/study-core/quiz';
import QuizCard from '../../components/QuizCard';
import type { BuiltinViewProps } from '../builtins';
import { pluginRpc, subscribePluginRead } from '../shared';
import { readPluginNumberDraft, writePluginNumberDraft } from '../drafts';
import './learning.css';

interface PracticeSummary { id: number; content: string; questions: number; answered: number }
interface PracticeRow { id: number; content: string; quiz: { data: QuizData; picks: QuizPick[] } }
interface PracticeResult { row: PracticeRow; submissions: { question_index: number; delivered_at: string | null; error: string | null }[] }
type Call = (method: string, args?: Record<string, unknown>) => Promise<unknown>;
export default function PracticeView({ plugin, instance, placement, context }: BuiltinViewProps) {
  const endpoint = `/plugins/${encodeURIComponent(plugin.id)}/instances/${encodeURIComponent(instance.id)}/rpc`;
  const call = useCallback<Call>((method, args = {}) => pluginRpc(endpoint, plugin.revision, method, args), [endpoint, plugin.revision]);
  const [materials, setMaterials] = useState<{ id: string; name: string }[]>([]), [chosen, setChosen] = useState(''), [error, setError] = useState('');
  const id = instance.scope.kind === 'material' ? instance.scope.id : context.materialId ?? chosen;
  useEffect(() => {
    let ignore = false;
    void call('learning.materials').then(value => { if (!ignore) setMaterials((value as { materials: typeof materials }).materials); }).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    return () => { ignore = true; };
  }, [call]);
  return <div className="learning-plugin" data-testid="plugin-practice">
    {instance.scope.kind === 'account' && !context.materialId ? <label>选择资料<select aria-label="练习资料" value={chosen} onChange={e => setChosen(e.target.value)}><option value="">请选择资料</option>{materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label> : <p>{materials.find(m => m.id === id)?.name ?? id}</p>}
    {error ? <p role="alert">{error}</p> : null}
    {id ? <MaterialPractice key={id} materialId={id} endpoint={`${endpoint}:${plugin.revision}`} draftScope={placement.id} call={call} /> : <p>选择资料生成 AI 练习，或从现有 Markdown 题库打开原题。</p>}
  </div>;
}
function MaterialPractice({ materialId, endpoint, draftScope, call }: { materialId: string; endpoint: string; draftScope: string; call: Call }) {
  const selectionKey = `plugin-draft:practice-selection:${endpoint}:${draftScope}:${materialId}`;
  const [practices, setPractices] = useState<PracticeSummary[]>([]), [tasks, setTasks] = useState<{ id: string; status: string; error?: string; deliveryError?: string; origin?: { actionId: string }; artifacts?: { kind?: string; count: number; coverage?: string } }[]>([]);
  const [selected, setSelected] = useState<number | undefined>(() => readPluginNumberDraft(selectionKey)), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const select = (rowId: number) => { setSelected(rowId); writePluginNumberDraft(selectionKey, rowId); };
  const read = useCallback(async () => {
    const [list, results] = await Promise.all([call('practice.list', { materialId }), call('learning.results', { materialId })]);
    return { ...(list as { practices: PracticeSummary[] }), ...(results as { tasks: typeof tasks }) };
  }, [call, materialId]);
  useEffect(() => {
    let ignore = false;
    const accept = (v: unknown) => { if (!ignore) { const s = v as Awaited<ReturnType<typeof read>>; setPractices(s.practices); setTasks(s.tasks); } };
    void read().then(accept).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    const off = subscribePluginRead(`learning:practice:${endpoint}:${materialId}`, read, accept);
    return () => { ignore = true; off(); };
  }, [read, endpoint, materialId]);
  const start = async (method: string, offset = 0) => {
    setBusy(true); setError('');
    try {
      const result = await call(method, { materialId, clientNonce: crypto.randomUUID(), ...(method === 'practice.present' ? { offset, limit: 5 } : method === 'practice.generate' ? { count: 5 } : {}) }) as { rowId?: number };
      const next = await read(); setPractices(next.practices); setTasks(next.tasks); if (result.rowId) select(result.rowId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const active = selected ?? practices[0]?.id;
  return <>
    <div className="learning-plugin__actions"><button type="button" disabled={busy || tasks.some(t => ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={() => void start('practice.generate')}>生成 AI 练习</button><button type="button" disabled={busy || tasks.some(t => t.origin?.actionId === 'practice.extract' && ['queued', 'running', 'waiting_user'].includes(t.status))} onClick={() => void start('practice.extract')}>提取原题为题库</button><button type="button" disabled={busy} onClick={() => void start('practice.present')}>打开原题题库</button></div>
    <p className="text-sm text-muted">原题提取复用原问答与题库编辑工具，需要在线的浏览器工作器及原读写授权；排队不代表后台已经提取。已保存部分可打开题库，完整覆盖范围请查看“插件原题提取”会话。</p>
    <p className="text-sm text-muted">AI 练习仅供参考，不冒充原题或已核验答案。原题按题库声明保留原文、已核验、AI 参考和缺失答案标记。</p>
    {error ? <p role="alert">{error}</p> : null}
    {tasks.map(t => <p key={t.id}>{t.artifacts ? t.artifacts.kind === 'question-bank' ? `题库现有 ${t.artifacts.count} 道原题 · ${t.artifacts.coverage}` : `已保存 ${t.artifacts.count} 道练习` : t.origin?.actionId === 'practice.extract' ? `原题提取：${t.status}（执行结束不代表题库保存成功）` : t.status}{t.error ? ` · ${t.error}` : ''}{t.deliveryError ? ` · 产物尚未确认：${t.deliveryError}` : ''}</p>)}
    {practices.length ? <label>练习记录<select aria-label="练习记录" value={active} onChange={e => select(Number(e.target.value))}>{practices.map(p => <option key={p.id} value={p.id}>{p.content} · {p.answered}/{p.questions}</option>)}</select></label> : <p>暂无练习记录。生成在服务器执行；作答保存在原会话快照中，关闭页面后可恢复。</p>}
    {active ? <PracticeSession key={active} rowId={active} endpoint={endpoint} draftScope={draftScope} call={call} onNext={offset => void start('practice.present', offset)} /> : null}
  </>;
}
export function PracticeSession({ rowId, endpoint, draftScope, call, onNext }: { rowId: number; endpoint: string; draftScope?: string; call: Call; onNext?: (offset: number) => void }) {
  const [snapshot, setSnapshot] = useState<PracticeResult>(), [error, setError] = useState('');
  const [pending, setPending] = useState<Record<number, { pick: QuizPick; durationSeconds: number }>>({});
  const inFlight = useRef(new Set<number>());
  const read = useCallback(() => call('practice.get', { rowId }), [call, rowId]);
  useEffect(() => {
    let ignore = false;
    const accept = (v: unknown) => { if (!ignore) setSnapshot(v as PracticeResult); };
    void read().then(accept).catch(e => { if (!ignore) setError(String(e.message ?? e)); });
    const off = subscribePluginRead(`learning:session:${endpoint}:${rowId}`, read, accept);
    return () => { ignore = true; off(); };
  }, [read, endpoint, rowId]);
  const submit = async (questionIndex: number, pick: QuizPick, durationSeconds: number) => {
    if (inFlight.current.has(questionIndex)) return;
    inFlight.current.add(questionIndex);
    setPending(p => ({ ...p, [questionIndex]: { pick, durationSeconds } }));
    try {
      await call('practice.submit', { rowId, questionIndex, pick, durationSeconds });
      setSnapshot(await read() as PracticeResult); setError('');
      setPending(p => { const next = { ...p }; delete next[questionIndex]; return next; });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { inFlight.current.delete(questionIndex); }
  };
  if (!snapshot) return error ? <p role="alert">{error}</p> : <p aria-busy="true">读取练习快照…</p>;
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
