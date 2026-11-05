import { usePluginCatalogSnapshot } from '../client/plugin-renderer-hooks';
import type { PluginPackage, PluginScopes } from '@wangke/contracts/plugins';
import type { SystemDocument } from '@wangke/contracts/system';
import type { PluginCatalogModel } from '@wangke/client-core';
import { clearPluginReads } from './shared';
import { cloud } from '../cloud/state';
import { accountLifetime, accountLifecycle } from '../client/account-lifecycle';

export interface PluginCatalog { plugins: PluginPackage[]; layout: SystemDocument; scopes?: PluginScopes }
type CatalogSnapshot = { data?: PluginCatalog; error?: string; status: 'loading' | 'ready' | 'reconnecting' | 'error' };
let snapshot: CatalogSnapshot = { status: 'loading' };
const listeners = new Set<() => void>();
const refreshWaiters = new Set<() => void>();
let stop: (() => void) | undefined;
let model: PluginCatalogModel | undefined;
let incarnation = 0;
const getSnapshot = () => snapshot;
const notify = () => { for (const fn of listeners) fn(); for (const fn of refreshWaiters) fn(); };
export async function refreshPlugins() {
  clearPluginReads();
  if (!cloud.enabled || !cloud.userId) throw new Error('client_unauthenticated');
  const lifetime = accountLifetime(cloud.userId);
  // Server writes already invalidate the shared projection. An explicit refresh
  // only restarts that same logical stream; it never reintroduces a GET poll.
  if (!listeners.size) return;
  const before = incarnation;
  await new Promise<void>((resolve, reject) => {
    const done = (error?: Error) => { clearTimeout(timer); refreshWaiters.delete(updated); error ? reject(error) : resolve(); };
    const updated = () => {
      if (!lifetime.current() || before !== incarnation) done(new Error('plugin_session_changed'));
      else if (!listeners.size) done(new Error('plugin_refresh_cancelled'));
      else if (snapshot.status === 'error') done(new Error(snapshot.error));
      else if (snapshot.status === 'ready') done();
    };
    const timer = setTimeout(() => done(new Error('plugin_refresh_timeout')), 15000);
    refreshWaiters.add(updated);
    model?.refresh();
  });
}
const start = () => {
  if (stop) return;
  if (!cloud.enabled || !cloud.userId) { snapshot = { status: 'error', error: 'client_unauthenticated' }; notify(); return; }
  const lifetime = accountLifetime(cloud.userId);
  const before = ++incarnation;
  let active = true;
  let off: (() => void) | undefined, release: (() => void) | undefined;
  stop = () => { active = false; off?.(); release?.(); model = undefined; };
  const account = cloud.userId;
  // Construction and retain happen only after React commits a subscriber, not
  // during render. The core runtime owns account identity and stream recovery.
  void import('../client/bootstrap').then(async ({ serverRuntime, isCurrentServerRuntime }) => {
    if (!active || !lifetime.current() || before !== incarnation || cloud.userId !== account) return;
    const runtime = await serverRuntime(account);
    if (!active || !lifetime.current() || before !== incarnation || !isCurrentServerRuntime(runtime)) return;
    const owned = runtime.catalog(); model = owned;
    const update = () => {
      if (!active || !lifetime.current() || before !== incarnation || !isCurrentServerRuntime(runtime)) return;
      const next = owned.getSnapshot();
      snapshot = { status: next.status, error: next.error,
        data: next.data === undefined ? undefined : next.data as unknown as PluginCatalog };
      notify();
    };
    off = owned.subscribe(update);
    release = owned.acquire();
    update();
  }).catch(e => {
    if (!active || !lifetime.current() || before !== incarnation) return;
    snapshot = { status: 'error', error: e instanceof Error ? e.message : 'plugin_request_failed' }; notify();
  });
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  start();
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; snapshot = { status: 'loading' }; for (const fn of refreshWaiters) fn(); } };
};
const stopDisposal = accountLifecycle.onDisposed(() => {
  incarnation++; stop?.(); stop = undefined; snapshot = { status: 'loading' }; notify();
  // Reacquire for a same-account runtime rebuild only after the old root has
  // completely invalidated all of its owners. No retain happens during render.
  queueMicrotask(() => { if (listeners.size) start(); });
});
import.meta.hot?.dispose(() => { stopDisposal(); stop?.(); });
export function usePluginCatalog() { return usePluginCatalogSnapshot(); }
/** Bare source for the DSH renderer; subscribe retains only after commit. */
export const pluginCatalogSource = { subscribe, getSnapshot };
export const pluginCatalogDiagnostics = () => ({ listeners: listeners.size, refreshWaiters: refreshWaiters.size, retained: !!model, active: !!stop, incarnation, status: snapshot.status });
export function usePluginAvailable(id: string) { const { data } = usePluginCatalog(); return !!data?.plugins.some(p => p.id === id && !p.error && p.manifest?.enabled); }
