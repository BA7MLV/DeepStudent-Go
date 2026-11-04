import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { inspectResourceCommand, archiveResourceCommand, exportResourceCommand } from '../client/resources';

/** Mounting only observes local drafts. Inspection never replays a file effect. */
export default function ResourceRecovery() {
  const [ids, setIds] = useState<string[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectResourceCommand>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const database = db, owner = cloud.userId;
    const subscription = liveQuery(() => database.table('_cloudMeta').toArray()).subscribe({ next: rows => {
      if (database === db && owner === cloud.userId) setIds(rows.filter(row => row.id.startsWith('resource-command:')).map(row => row.value.request.operationId));
    }, error: error => { if (database === db && owner === cloud.userId) setError(String(error)); } });
    return () => subscription.unsubscribe();
  }, []);
  const run = async (id: string, archive = false) => {
    const database = db, owner = cloud.userId;
    setBusy(true); setError('');
    try {
      if (archive && detail) await archiveResourceCommand(detail);
      else {
        const value = await inspectResourceCommand(id);
        if (database === db && owner === cloud.userId) setDetail(value);
      }
    } catch (error) { if (database === db && owner === cloud.userId) setError(String(error)); }
    finally { if (database === db && owner === cloud.userId) setBusy(false); }
  };
  if (!ids.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label="资源命令恢复">
    {ids.map(id => <p key={id}><button type="button" disabled={busy} onClick={() => void run(id)}>核对资源原命令 {id}</button></p>)}
    {detail ? <div>
      <p>文件操作不会自动重放。请核对原稿、原 revision、收据与当前目录。</p>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(detail, null, 2).slice(0, 10000)}</pre>
      <button type="button" disabled={busy} onClick={() => void run(detail.stored.value.request.operationId)}>重新核对资源收据</button>
      <button type="button" disabled={busy} onClick={() => {
        const database = db, owner = cloud.userId;
        setBusy(true);
        void exportResourceCommand(detail).then(text => {
          if (database !== db || owner !== cloud.userId) return;
          const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
          const link = document.createElement('a'); link.href = url; link.download = `resource-${detail.stored.value.request.operationId}.json`; link.click(); URL.revokeObjectURL(url);
        }).catch(error => { if (database === db && owner === cloud.userId) setError(String(error)); })
          .finally(() => { if (database === db && owner === cloud.userId) setBusy(false); });
      }}>导出资源完整原稿</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.stored.value.request.operationId, true)}>确认核对并归档资源原稿（不重放）</button>
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>关闭资源核对</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>;
}
