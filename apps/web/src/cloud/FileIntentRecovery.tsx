import { useEffect, useRef, useState } from 'react';
import type { RuntimeFileIntent } from '@wangke/contracts/client-runtime';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { cloud } from './state';
import { useSustained } from './quiet';

/** Recovery is explicit; mounting this UI never retries a filesystem effect. */
export default function FileIntentRecovery() {
  const [intents, setIntents] = useState<{ id: string; path: string }[]>([]);
  const [detail, setDetail] = useState<RuntimeFileIntent>();
  const [error, setError] = useState('');
  const [streamError, setStreamError] = useState('');
  const [busy, setBusy] = useState(false);
  const lifetime = useRef(0);
  useEffect(() => {
    ++lifetime.current;
    const account = cloud.userId;
    let stopped = false, off: (() => void) | undefined, release: (() => void) | undefined;
    void serverRuntime(account).then(runtime => {
      if (stopped || account !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
      const model = runtime.fileIntents();
      const refresh = () => {
        if (stopped || account !== cloud.userId || !isCurrentServerRuntime(runtime) || runtime.signal.aborted) return;
        const snapshot = model.getSnapshot();
        if (snapshot.status === 'error') { setStreamError(snapshot.error ?? '文件恢复收据暂不可用'); return; }
        if (snapshot.status === 'ready') { setIntents(model.intents() ?? []); setStreamError(''); }
      };
      off = model.subscribe(refresh); release = model.acquire(); refresh();
    }).catch(error => { if (!stopped && account === cloud.userId) setStreamError(String(error)); });
    return () => { ++lifetime.current; stopped = true; off?.(); release?.(); };
  }, []);

  const inspect = async (id: string) => {
    const account = cloud.userId, generation = lifetime.current;
    const current = () => account === cloud.userId && generation === lifetime.current;
    setBusy(true); setError('');
    try {
      const runtime = await serverRuntime(account);
      if (!current() || !isCurrentServerRuntime(runtime)) return;
      const receipt = await runtime.fileIntent(id);
      if (!current() || !isCurrentServerRuntime(runtime)) return;
      if (!receipt) throw new Error('文件意图收据不存在');
      setDetail(receipt);
    } catch (error) { if (current()) setError(String(error)); }
    finally { if (current()) setBusy(false); }
  };
  const resolve = async (action: 'retry' | 'discard') => {
    if (!detail) return;
    const account = cloud.userId, generation = lifetime.current;
    const current = () => account === cloud.userId && generation === lifetime.current;
    setBusy(true); setError('');
    try {
      const runtime = await serverRuntime(account);
      if (!current() || !isCurrentServerRuntime(runtime)) return;
      const receipt = await runtime.resolveFileIntent(detail.id, detail.current, action);
      if (!current() || !isCurrentServerRuntime(runtime)) return;
      setDetail(receipt);
    } catch (error) { if (current()) setError(`处理尚未确认，请重新核对原收据，不要提交新命令。${String(error)}`); }
    finally { if (current()) setBusy(false); }
  };
  // The stream reconnects by itself; a transient error is not a file conflict.
  const lastingStreamError = useSustained(!!streamError, 10000);
  if (!intents.length && !detail && !error && !lastingStreamError) return null;
  return <section className="bg-surface p-3" aria-label="文件意图恢复">
    {intents.map(intent => <p key={intent.id}>文件外部修改冲突：{intent.path} <button type="button" disabled={busy} onClick={() => void inspect(intent.id)}>核对文件意图</button></p>)}
    {detail ? <div>
      <p>{detail.path} · 收据 {detail.id} · {detail.status}</p>
      <p>待写入原稿（不会自动覆盖外部版本）</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{detail.content?.slice(0, 10000) ?? '（删除文件意图）'}</pre>
      <p>核对时的磁盘版本</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{detail.current?.slice(0, 10000) ?? '（文件不存在）'}</pre>
      <button type="button" disabled={busy} onClick={() => void inspect(detail.id)}>重新查询原收据</button>
      <button type="button" onClick={() => {
        const url = URL.createObjectURL(new Blob([JSON.stringify(detail, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `file-intent-${detail.id}.json`; link.click(); URL.revokeObjectURL(url);
      }}>导出完整原稿与收据</button>
      {detail.status === 'conflict' ? <>
        <button type="button" disabled={busy} onClick={() => void resolve('retry')}>按已核对版本恢复原稿</button>
        <button type="button" disabled={busy} onClick={() => void resolve('discard')}>保留外部版本并归档原稿</button>
      </> : null}
      {detail.successorId ? <button type="button" disabled={busy} onClick={() => void inspect(detail.successorId!)}>查询恢复收据</button> : null}
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>关闭核对</button>
    </div> : null}
    {error ? <p role="alert">{error}</p> : null}
    {lastingStreamError ? <p role="alert">{streamError}</p> : null}
  </section>;
}
