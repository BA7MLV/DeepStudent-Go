import { useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import { useTranslation } from 'react-i18next';
import { cloud } from './state';
import { db } from '../store/db';
import { listExecutorRecovery, inspectExecutorRecovery, exportExecutorRecovery, markExecutorRecoveryHandled, type RecoveryEntry } from './executor-recovery';

/** Read-only inspection/export, never a new task or lease replay. */
export default function ExecutorRecovery({ pendingOnly = false }: { pendingOnly?: boolean }) {
  const { t } = useTranslation('settings', { keyPrefix: 'recovery' });
  const [entries, setEntries] = useState<RecoveryEntry[]>([]);
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof inspectExecutorRecovery>>>();
  const [error, setError] = useState<'' | 'readFailed' | 'actionFailed'>('');
  const [busy, setBusy] = useState(false);
  const [scope] = useState(() => ({ owner: cloud.userId, database: db }));
  const lifetime=useRef(0);
  useEffect(() => {
    const generation=++lifetime.current;
    const owner = scope.owner;
    const subscription = liveQuery(() => listExecutorRecovery(owner)).subscribe({ next: rows => {
      if (owner === cloud.userId&&scope.database===db&&generation===lifetime.current) setEntries(rows);
    }, error: () => { if (owner === cloud.userId&&scope.database===db&&generation===lifetime.current) setError('readFailed'); } });
    return () => {++lifetime.current;subscription.unsubscribe();};
  }, [scope]);
  const run = async (id: string, action: 'inspect' | 'export' | 'handled' | 'receipt') => {
    const owner = scope.owner;
    const generation=lifetime.current,current=()=>owner===cloud.userId&&scope.database===db&&generation===lifetime.current;
    if (!current()) return;
    setBusy(true); setError('');
    try {
      if (action === 'handled' && detail) {
        await markExecutorRecoveryHandled(detail);
        if (current()) { setEntries(await listExecutorRecovery(owner)); setDetail(undefined); }
      } else if (action === 'export' && detail) {
        const value = await exportExecutorRecovery(detail);
        if (!current()) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `${id}.json`; link.click(); URL.revokeObjectURL(url);
      } else {
        const value = await inspectExecutorRecovery(id, action === 'receipt');
        if (current()) setDetail(value);
      }
    } catch { if (current()) setError('actionFailed'); }
    finally { if (current()) setBusy(false); }
  };
  const visible = pendingOnly ? entries.filter(entry => entry.pending && !entry.handled) : entries;
  if (!visible.length && !detail && !error) return null;
  return <section className="bg-surface p-3" aria-label={t('title')}>
    {!pendingOnly ? <h3>{t('title')}</h3> : <p>{t('pending', { count: visible.length })}</p>}
    {visible.map(entry => <p key={entry.id}>{t(entry.id.endsWith('legacy-snapshot') ? 'legacyData' : entry.id === 'executor-legacy-outbox' || entry.id.startsWith('main:') ? 'legacyEdits' : entry.pending ? 'legacyPending' : 'legacyRecord')} · {t('items', { count: entry.count })}{entry.handled ? ` · ${t('handled')}` : ''} <button type="button" disabled={busy} onClick={() => void run(entry.id, 'inspect')}>{t('inspect')}</button></p>)}
    {detail ? <div>
      <p>{t('preserved')}</p>
      {detail.remoteError ? <p>{t('remoteUnavailable')}</p> : null}
      {detail.receipt ? <p>{t('serverStatus', { status: t(detail.receipt.status === 'completed' ? 'confirmed' : 'needsReview') })}</p> : null}
      <details><summary>{t('diagnostics')}</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap">{JSON.stringify({ id: detail.row.id, tables: detail.row.tables, receipt: detail.receipt }, null, 2)}</pre></details>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'receipt')}>{t('receipt')}</button>
      <button type="button" disabled={busy} onClick={() => void run(detail.row.id, 'export')}>{t('export')}</button>
      <button type="button" disabled={busy || detail.entry.dismissible === false} onClick={() => void run(detail.row.id, 'handled')}>{t('markHandled')}</button>
      {detail.entry.dismissible === false ? <p>{t('unverifiedAttachments')}</p> : null}
      <p>{t('handledHint')}</p>
      <button type="button" disabled={busy} onClick={() => setDetail(undefined)}>{t('close')}</button>
    </div> : null}
    {error ? <p role="alert">{t(error)}</p> : null}
  </section>;
}
