import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { inspectResourceCommand, archiveResourceCommand, exportResourceCommand, saveResourceConflict } from '../client/resources';
import { resourceOperationLabel, type ResourceDraft } from '../client/resource-commands';

/** Settings-only: mounting observes local drafts, never replays a file effect. */
export default function ResourceRecovery() {
  const [drafts, setDrafts] = useState<ResourceDraft[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectResourceCommand>>>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [merged, setMerged] = useState('');
  useEffect(() => {
    const database = db, owner = cloud.userId;
    const subscription = liveQuery(() => database.table('_cloudMeta').where('id').startsWith('resource-command:').toArray()).subscribe({ next: rows => {
      if (database === db && owner === cloud.userId) setDrafts(rows.map(row => row.value));
    }, error: error => { if (database === db && owner === cloud.userId) setError(String(error)); } });
    return () => subscription.unsubscribe();
  }, []);
  const run = async (id: string, archive = false) => {
    const database = db, owner = cloud.userId;
    setBusy(true); setError('');
    try {
      if (archive && detail) {
        await archiveResourceCommand(detail);
        if (database === db && owner === cloud.userId) setDetail(undefined);
      }
      else {
        const value = await inspectResourceCommand(id);
        if (database === db && owner === cloud.userId) {
          setDetail(value);
          const operation = value.stored.value.request.operation;
          setMerged('text' in operation ? operation.text : '');
        }
      }
    } catch (error) { if (database === db && owner === cloud.userId) setError(String(error)); }
    finally { if (database === db && owner === cloud.userId) setBusy(false); }
  };
  const saveMerge = async () => {
    if (!detail?.document || detail.stored.value.state !== 'conflict') return;
    const database = db, owner = cloud.userId;
    setBusy(true); setError('');
    try {
      await saveResourceConflict(detail, merged);
      if (database === db && owner === cloud.userId) setDetail(undefined);
    } catch (error) { if (database === db && owner === cloud.userId) setError(error instanceof Error ? error.message : '保存未完成，原稿仍已保留。'); }
    finally { if (database === db && owner === cloud.userId) setBusy(false); }
  };
  if (!drafts.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label="资源命令恢复">
    <h3>尚未完成的资料改动</h3>
    <p>系统会自动确认可恢复的保存。旧记录或无法确认的文件操作不会盲目重试，原稿和附件会保留。</p>
    <div className="max-h-64 overflow-auto">
      {drafts.map(draft => <div key={draft.request.operationId} className="py-2">
        <p>{resourceOperationLabel(draft.request.operation)} · {draft.state === 'conflict' ? '存在冲突' : draft.state === 'failed' ? '未完成' : draft.state === 'review' ? '结果待确认' : '等待确认'}</p>
        {draft.lastError ? <p className="text-sm text-muted">{draft.protocol === 1 ? draft.lastError : '历史记录已保留，不会自动重复执行。'}</p> : null}
        <button type="button" disabled={busy} data-operation-id={draft.request.operationId} onClick={() => void run(draft.request.operationId)}>查看保存详情</button>
      </div>)}
    </div>
    {detail ? <div>
      <p>未确认的原稿已保留。归档不会重新执行操作，也不会覆盖服务器文件。</p>
      {'text' in detail.stored.value.request.operation ? <div className="grid gap-3 py-3 md:grid-cols-2">
        {detail.document ? <label>服务器当前内容<textarea readOnly value={detail.document.text} className="h-48 w-full bg-surface p-2" /></label> : <p>目前无法读取服务器内容；你的原稿仍可导出。</p>}
        <label>你的未保存内容（可编辑合并）<textarea value={merged} onChange={event => setMerged(event.target.value)} className="h-48 w-full bg-surface p-2" /></label>
        {detail.document && detail.stored.value.state === 'conflict' ? <button type="button" disabled={busy} onClick={() => void saveMerge()}>保存合并后的内容</button> : null}
        <button type="button" disabled={busy} onClick={() => {
          const url = URL.createObjectURL(new Blob([merged], { type: 'text/plain;charset=utf-8' }));
          const link = document.createElement('a'); link.href = url; link.download = '未保存的资料.txt'; link.click(); URL.revokeObjectURL(url);
        }}>下载未保存内容</button>
      </div> : null}
      <details><summary>技术诊断信息</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify(detail, null, 2).slice(0, 10000)}</pre></details>
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
