import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { cloud } from './state';
import { listExecutorRecovery, inspectExecutorRecovery, exportExecutorRecovery } from './executor-recovery';

/** Read-only inspection/export, never a new task or lease replay. */
export default function ExecutorRecovery() {
  const [ids, setIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectExecutorRecovery>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const lifetime=useRef(0);
  useEffect(() => {
    const generation=++lifetime.current;
    const owner = cloud.userId;
    const subscription = liveQuery(() => listExecutorRecovery(owner)).subscribe({ next: rows => {
      if (owner === cloud.userId&&generation===lifetime.current) setIds(rows.map(row => row.id));
    }, error: error => { if (owner === cloud.userId&&generation===lifetime.current) setError(String(error)); } });
    return () => {++lifetime.current;subscription.unsubscribe();};
  }, []);
  const run = async (id: string, action: 'inspect' | 'export') => {
    const owner = cloud.userId;
    const generation=lifetime.current,current=()=>owner===cloud.userId&&generation===lifetime.current;
    setBusy(true); setError('');
    try {
      if (action === 'export' && detail) {
        const value = await exportExecutorRecovery(detail);
        if (!current()) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `${id}.json`; link.click(); URL.revokeObjectURL(url);
      } else {
        const value = await inspectExecutorRecovery(id);
        if (current()) setDetail(value);
      }
    } catch (error) { if (current()) setError(String(error)); }
    finally { if (current()) setBusy(false); }
  };
  if (!ids.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label="执行器恢复日志">
    {ids.map(id => <p key={id}>执行器结果待核对 <button type="button" disabled={busy} onClick={() => void run(id, 'inspect')}>核对原任务与收据 {id}</button></p>)}
    {detail ? <div>
      <p>旧云端浏览器执行器已退役。此处仅核对与导出历史原稿、收据和二进制附件，不会重跑或续接任务。</p>
       <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify({ id: detail.row.id, receipt: detail.receipt, server: detail.server, observed: detail.observed }, null, 2)}</pre>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'inspect')}>重新查询原收据</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'export')}>导出完整原稿和附件字节</button>
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>关闭核对</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
