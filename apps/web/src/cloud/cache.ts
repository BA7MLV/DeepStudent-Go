import Dexie, { type DBCoreTransaction } from 'dexie';
import { CLOUD_TABLES, type CloudMutation } from '@wangke/contracts/cloud';

const cloudApplyTransactions = new WeakSet<DBCoreTransaction>();
export interface OutboxRow extends CloudMutation { sequence?: number; transaction: string; executorTaskId?: string }

/** Business code cannot promote a draft into a committed server fact. Static
 * databases do not install this boundary. Only projection reducers opt in. */
export function installCloudCache(database: Dexie) {
  database.use({
    stack: 'dbcore', name: 'server-projection-only', level: -1,
    create: core => ({ ...core, table(name) {
      const table = core.table(name);
      if (!Object.hasOwn(CLOUD_TABLES, name)) return table;
      return { ...table, mutate(request) {
        if (!cloudApplyTransactions.has(request.trans)) throw new Error('cloud_projection_read_only');
        return table.mutate(request);
      } };
    } }),
  });
}
export function markCloudApply() {
  const transaction = Dexie.currentTransaction as unknown as { idbtrans: DBCoreTransaction };
  cloudApplyTransactions.add(transaction.idbtrans);
}
