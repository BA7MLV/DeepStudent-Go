export type DatabaseNotice = { database: string; state: 'blocked' | 'update-required' } | null;
let notice: DatabaseNotice = null;
const listeners = new Set<() => void>();
export const databaseNotice = () => notice;
export const subscribeDatabaseNotice = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function setDatabaseNotice(next: DatabaseNotice) {
  notice = next;
  for (const listener of listeners) listener();
}
