import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { inspectPreferenceCommand, resolvePreferenceCommand } from './preferences';
import { useClock, useHealthyAge } from './quiet';

export default function PreferenceRecovery() {
  const [pending, setPending] = useState<{ id: string; createdAt: number; conflict: boolean }[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectPreferenceCommand>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const database = db, account = cloud.userId, firstSeen = new Map<string, number>();
    const subscription = liveQuery(() => database.table('_cloudMeta').toArray()).subscribe({ next: rows => {
      if (database === db && account === cloud.userId) {
        // Queued/in-flight saves are normal slider interaction, not a recovery
        // incident. Showing them here makes the entire chat jump on every edit.
        setPending(rows.filter(row => row.id.startsWith('preferences-command:') && (row.value.state === 'conflict' || row.value.error)).map(row => ({
          id: row.value.operationId, conflict: row.value.state === 'conflict',
          // operationId = preferences-<epoch ms>-…; legacy ids age from first sight.
          createdAt: Number(/^preferences-(\d{13})-/.exec(row.value.operationId)?.[1]) || (firstSeen.get(row.value.operationId) ?? firstSeen.set(row.value.operationId, Date.now()).get(row.value.operationId)!),
        })));
        setError(rows.find(row => row.id === 'preferences-sync-error')?.value ?? '');
      }
    }, error: error => { if (database === db && account === cloud.userId) setError(String(error)); } });
    return () => subscription.unsubscribe();
  }, []);
  // An offline/transport error is retried by the next drain; only a conflict or
  // a failure that outlasts 15s of usable connection needs the user.
  const now = useClock(pending.length > 0);
  const age = useHealthyAge();
  const ids = pending.filter(row => row.conflict || age(row.createdAt, now) >= 15000).map(row => row.id);
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
