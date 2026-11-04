import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { inspectPreferenceCommand, resolvePreferenceCommand } from './preferences';

export default function PreferenceRecovery() {
  const [ids, setIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectPreferenceCommand>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const database = db, account = cloud.userId;
    const subscription = liveQuery(() => database.table('_cloudMeta').toArray()).subscribe({ next: rows => {
      if (database === db && account === cloud.userId) {
        setIds(rows.filter(row => row.id.startsWith('preferences-command:')).map(row => row.value.operationId));
        setError(rows.find(row => row.id === 'preferences-sync-error')?.value ?? '');
      }
    }, error: error => { if (database === db && account === cloud.userId) setError(String(error)); } });
    return () => subscription.unsubscribe();
  }, []);
  const run = async (id: string, action?: 'retry' | 'discard') => {
    const database = db, account = cloud.userId;
    setBusy(true); setError('');
    try {
      if (action && detail) await resolvePreferenceCommand(id, detail, action);
      else {
        const next = await inspectPreferenceCommand(id);
        if (database === db && account === cloud.userId) setDetail(next);
      }
    } catch (error) { if (database === db && account === cloud.userId) setError(String(error)); }
    finally { if (database === db && account === cloud.userId) setBusy(false); }
  };
  if (!ids.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label="偏好命令恢复">
    {ids.map(id => <p key={id}>偏好修改待确认 <button type="button" disabled={busy} onClick={() => void run(id)}>核对原命令 {id}</button></p>)}
    {detail ? <div>
      <p>{detail.command.operationId} · {detail.command.state} · 服务端收据 {detail.receipt.status}</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(detail, null, 2).slice(0, 10000)}</pre>
      <button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `preferences-${detail.command.operationId}.json`; link.click(); URL.revokeObjectURL(url);
      }}>导出原稿、操作 ID 与收据</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.command.operationId)}>重新核对原收据</button>
      {!detail.command.legacy && detail.receipt.status === 'missing' ? <button type="button" disabled={busy} onClick={() => void run(detail.command.operationId, 'retry')}>按已核对服务端版本恢复草稿</button> : null}
      <button type="button" disabled={busy} onClick={() => void run(detail.command.operationId, 'discard')}>保留服务端版本并归档原稿</button>
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>关闭核对</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
