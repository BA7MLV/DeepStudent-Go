import { useEffect } from 'react';
import { liveQuery } from 'dexie';
import { db } from '../store/db';
import { cloud } from './state';
import { cloudTransaction } from './transactions';
import { drainLearning, type LearningCommandRow } from '../client/learning';

/** Draft reconciliation is invisible to users. Queued and uncertain commands
 * are already retried by the background sync loop; a conflict is resolved here
 * the same way the old explicit action did: the original draft is preserved
 * atomically into history recovery, the journal entry ends, and dependents are
 * rechecked on the next drain. Nothing is rendered. */
export default function LearningRecovery() {
  useEffect(() => {
    let active = true;
    const scope = { database: db, owner: cloud.userId };
    const current = () => active && scope.database === db && scope.owner === cloud.userId;
    const archive = async (row: LearningCommandRow) => {
      if (!current() || row.state !== 'conflict') return;
      const database = scope.database, id = `learning:${row.operationId}`;
      await cloudTransaction(database, [database.table('_learningCommands'), database.table('_historyTransactions'), database.table('_historyRecovery')], async () => {
        if (!current()) throw new Error('client_account_changed');
        const saved = await database.table<LearningCommandRow>('_learningCommands').get(row.sequence!);
        if (saved?.state !== 'conflict') return;
        await database.table('_historyTransactions').put({ id, transaction: row.operationId, command: saved });
        await database.table('_historyRecovery').put({ id, source: 'learning-command', transaction: row.operationId, count: 1, fingerprint: row.inputDigest ?? row.operationId, state: 'resolved', createdAt: Date.now() });
        await database.table('_learningCommands').delete(row.sequence!);
      });
      await drainLearning();
    };
    const subscription = liveQuery(() => scope.database.table<LearningCommandRow>('_learningCommands').orderBy('sequence').toArray()).subscribe({
      next: value => { if (current()) value.filter(row => row.state === 'conflict').forEach(row => { void archive(row).catch(() => {}); }); },
      error: () => {},
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, []);
  return null;
}
