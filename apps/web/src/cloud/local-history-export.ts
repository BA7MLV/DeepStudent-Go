import Dexie from 'dexie';
import { encodeRecoveryValue } from './recovery-export';

const isHistoryDatabase = (name: string) => name === 'wangke' || name.startsWith('wangke-cloud-');

/** Local-device recovery only. No account runtime, schema upgrade or business
 * database import: this remains usable at the unauthenticated/offline gate. */
export async function listLocalHistoryDatabases(): Promise<string[]> {
  return (await Dexie.getDatabaseNames()).filter(isHistoryDatabase).sort();
}

export async function exportLocalHistoryDatabase(name: string) {
  if (!isHistoryDatabase(name) || !await Dexie.exists(name)) throw new Error('local_history_not_found');
  const source = new Dexie(name);
  try {
    await source.open();
    // One read-only snapshot includes every original table, journal and Blob.
    // Encoding happens after the IDB transaction, never holds it across hashes.
    const tables = await source.transaction('r', source.tables, async () => {
      const value: Record<string, unknown[]> = {};
      for (const table of source.tables) value[table.name] = await table.toArray();
      return value;
    });
    return await encodeRecoveryValue({ format: 'wangke-local-history-v1', database: name, tables });
  } finally { source.close(); }
}
