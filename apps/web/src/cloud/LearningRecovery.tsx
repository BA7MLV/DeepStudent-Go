import { useEffect, useState } from 'react';
import { liveQuery } from 'dexie';
import { useTranslation } from 'react-i18next';
import { db } from '../store/db';
import { cloud } from './state';
import { drainLearning, type LearningCommandRow } from '../client/learning';
import { encodeRecoveryValue } from './recovery-export';
import { confirmDialog } from '../ui/feedback';
import { useClock, useHealthyAge } from './quiet';

export default function LearningRecovery() {
  const { t } = useTranslation('settings', { keyPrefix: 'recovery' });
  const [rows, setRows] = useState<LearningCommandRow[]>([]);
  const [error, setError] = useState<'' | 'draftReadFailed' | 'exportFailed' | 'retryFailed' | 'archiveFailed'>('');
  const [scope] = useState(() => ({ database: db, owner: cloud.userId }));
  const current = () => scope.database === db && scope.owner === cloud.userId;
  useEffect(() => {
    let active = true;
    const subscription = liveQuery(() => scope.database.table<LearningCommandRow>('_learningCommands').orderBy('sequence').toArray()).subscribe({
      next: value => { if (active && current()) setRows(value); },
      error: () => { if (active && current()) setError('draftReadFailed'); },
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [scope]);
  // A queued/uncertain command is routine (offline edits, a dropped response).
  // Conflicts surface at once; anything else only after 15s of usable connection.
  const now = useClock(rows.length > 0);
  const age = useHealthyAge();
  const problems = rows.filter(row => row.state === 'conflict' || age(row.createdAt, now) >= 15000);
  if (!problems.length && !error) return null;
  const exportDraft = async (row: LearningCommandRow) => {
    if (!current()) return;
    const database = db, owner = cloud.userId;
    try {
      const value = await encodeRecoveryValue(row);
      if (database !== db || owner !== cloud.userId) return;
      const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = url; link.download = `wangke-draft-${row.operationId}.json`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch { if (current()) setError('exportFailed'); }
  };
  const archiveConflict = async (row: LearningCommandRow) => {
    if (!current() || row.state !== 'conflict' || !await confirmDialog({ headline: t('archiveTitle'), description: t('archiveDescription'), confirmText: t('archiveConfirm') })) return;
    if (!current()) return;
    const database = scope.database, id = `learning:${row.operationId}`;
    await database.transaction('rw', database.table('_learningCommands'), database.table('_historyTransactions'), database.table('_historyRecovery'), async () => {
      if (!current()) throw new Error('client_account_changed');
      const saved = await database.table<LearningCommandRow>('_learningCommands').get(row.sequence!);
      if (saved?.state !== 'conflict') return;
      await database.table('_historyTransactions').put({ id, transaction: row.operationId, command: saved });
      await database.table('_historyRecovery').put({ id, source: 'learning-command', transaction: row.operationId, count: 1, fingerprint: row.inputDigest ?? row.operationId, state: 'resolved', createdAt: Date.now() });
      await database.table('_learningCommands').delete(row.sequence!);
    });
    await drainLearning();
  };
  return <section className="bg-surface p-3" aria-label={t('drafts')}>
    <p>{t('draftCount', { count: problems.length })}</p>
    {problems.map(row => <details key={row.operationId}>
      <summary>{t(row.state === 'conflict' ? 'conflict' : row.state === 'confirmed' ? 'awaitProjection' : row.state === 'queued' ? 'queued' : 'uncertain')}</summary>
      <p>{new Date(row.createdAt).toLocaleString()}</p>
      <button type="button" onClick={() => void exportDraft(row)}>{t('exportDraft')}</button>
      <button type="button" onClick={() => { if (current()) void drainLearning().catch(() => { if (current()) setError('retryFailed'); }); }}>{t('retryReceipt')}</button>
      {row.state === 'conflict' ? <button type="button" onClick={() => void archiveConflict(row).catch(() => { if (current()) setError('archiveFailed'); })}>{t('archive')}</button> : null}
      <details><summary>{t('diagnostics')}</summary><p>{row.entities.join('、')}</p><p>{row.operationId}</p><p>{row.error}</p></details>
    </details>)}
    {error ? <p role="alert">{t(error)}</p> : null}
  </section>;
}
