import type { DatabaseStore } from '../storage/database.js';

// A wakeup carries no business payload. Baselines are read from committed SQL.
const scopes = new WeakMap<DatabaseStore, Map<string, Set<() => void>>>();
export function watchInteractionWake(store: DatabaseStore, task: string, wake: () => void) {
  let tasks = scopes.get(store); if (!tasks) scopes.set(store, tasks = new Map());
  let listeners = tasks.get(task); if (!listeners) tasks.set(task, listeners = new Set());
  listeners.add(wake);
  return () => { listeners.delete(wake); if (!listeners.size) tasks.delete(task); };
}
export function wakeInteractions(store: DatabaseStore, task: string) {
  for (const wake of scopes.get(store)?.get(task) ?? []) wake();
}
