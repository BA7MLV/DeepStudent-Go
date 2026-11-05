import { useEffect, useRef, useState } from 'react';
import { cloud } from './state';
import { db } from '../store/db';
import ExecutorRecovery from './ExecutorRecovery';
import { preserveLegacyCloudData, reconcileLegacyReceipts } from './legacy-migration';

/** This module is loaded only after the user opens Settings → Data → History.
 * Preservation is local-only. Receipt checks/conversion need a separate action. */
export default function HistoryRecovery() {
  const [scope] = useState(() => ({ owner: cloud.userId, database: db }));
  const lifetime = useRef(0);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const generation = ++lifetime.current;
    const current = () => generation === lifetime.current && scope.owner === cloud.userId && scope.database === db;
    void preserveLegacyCloudData().catch(() => {
      if (current()) setMessage('部分历史证据未能复制；旧库未改变，仍可查看并完整导出。');
    }).finally(() => { if (current()) setReady(true); });
    return () => { ++lifetime.current; };
  }, [scope]);
  const reconcile = async () => {
    const generation = lifetime.current;
    const current = () => generation === lifetime.current && scope.owner === cloud.userId && scope.database === db;
    if (!current()) return;
    setBusy(true); setMessage('');
    try {
      // Refresh evidence first, so an old writer's new bytes cannot be mistaken
      // for a previously checked original operation.
      await preserveLegacyCloudData();
      if (!current()) return;
      const converted = await reconcileLegacyReceipts();
      if (current()) {
        setMessage(converted ? '已按原身份保存可验证的学习时长命令；其余历史原稿保留待核对。' : '原收据已核对，历史原稿保留。未将未知效果重新执行。');
        setRevision(value => value + 1);
      }
    } catch {
      if (current()) setMessage('服务器暂不可达或核对未完成；本地原稿仍可查看和完整导出。');
    } finally { if (current()) setBusy(false); }
  };
  return <div>
    <p>核对收据是独立的联网操作。仅原收据缺失、整笔可验证的纯学习时长增量会以原 operationId 转入待提交命令；不会恢复通用 records 写入。</p>
    <button type="button" disabled={!ready || busy} onClick={() => void reconcile()}>{busy ? '正在核对…' : '核对历史收据并恢复可验证时长命令'}</button>
    {message ? <p role="status">{message}</p> : null}
    {ready ? <ExecutorRecovery key={revision} /> : <p role="status">正在保全本地历史证据…</p>}
  </div>;
}
