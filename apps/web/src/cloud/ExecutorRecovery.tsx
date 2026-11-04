import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { cloud } from './state';
import { listExecutorRecovery, inspectExecutorRecovery, archiveExecutorRecovery, exportExecutorRecovery, reconcileExecutorInteraction } from './executor-recovery';

/** This view offers inspection/export/archive, not a new task or lease replay. */
export default function ExecutorRecovery() {
  const [ids, setIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectExecutorRecovery>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const owner = cloud.userId;
    const subscription = liveQuery(() => listExecutorRecovery(owner)).subscribe({ next: rows => {
      if (owner === cloud.userId) setIds(rows.map(row => row.id));
    }, error: error => { if (owner === cloud.userId) setError(String(error)); } });
    return () => subscription.unsubscribe();
  }, []);
  const run = async (id: string, action: 'inspect' | 'archive' | 'export' | 'settle' | 'resume' | 'hold') => {
    const owner = cloud.userId;
    setBusy(true); setError('');
    try {
      if ((action === 'settle' || action === 'resume' || action === 'hold') && detail) {
        await reconcileExecutorInteraction(detail, action);
        if (owner === cloud.userId) setDetail(await inspectExecutorRecovery(id));
      } else if (action === 'archive' && detail) await archiveExecutorRecovery(detail);
      else if (action === 'export' && detail) {
        const value = await exportExecutorRecovery(detail);
        if (owner !== cloud.userId) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `${id}.json`; link.click(); URL.revokeObjectURL(url);
      } else {
        const value = await inspectExecutorRecovery(id);
        if (owner === cloud.userId) setDetail(value);
      }
    } catch (error) { if (owner === cloud.userId) setError(String(error)); }
    finally { if (owner === cloud.userId) setBusy(false); }
  };
  if (!ids.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label="执行器恢复日志">
    {ids.map(id => <p key={id}>执行器结果待核对 <button type="button" disabled={busy} onClick={() => void run(id, 'inspect')}>核对原任务与收据 {id}</button></p>)}
    {detail ? <div>
      <p>原任务不会自动重跑，也不会借用新任务的 lease/permit。归档保留完整原稿与二进制附件。</p>
       <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify({ id: detail.row.id, receipt: detail.receipt, server: detail.server, observed: detail.observed }, null, 2)}</pre>
       {detail.row.value?.command ? <div>
         <p>先停止旧执行器并核对目标快照。已提交效果只结算，不再执行；仅未获准执行的原命令可续接。未知效果请导出核对后从会话另行继续，不会自动重放。</p>
         <button type="button" disabled={busy || (detail.observed as any)?.disposition !== 'applied'} onClick={() => void run(detail.row.id, 'settle')}>凭已提交效果收据结算</button>
         <button type="button" disabled={busy || (detail.observed as any)?.disposition !== 'resumable'} onClick={() => void run(detail.row.id, 'resume')}>冻结旧 lease 并按原 identity 续接</button>
         <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'hold')}>停止原任务，保留 uncertain 待人工核对</button>
       </div> : null}
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'inspect')}>重新查询原收据</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'export')}>导出完整原稿和附件字节</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'archive')}>确认核对并归档（不重放）</button>
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>关闭核对</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
