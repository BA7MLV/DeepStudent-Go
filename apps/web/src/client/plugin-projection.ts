import type { ModelSnapshot } from '@wangke/client-core';
import type { RuntimeRead } from '@wangke/contracts/client-runtime';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime, onServerRuntimeDisposed } from './bootstrap';
import type { PluginIdentity, PluginQuery } from './plugins';
import { accountLifetime } from './account-lifecycle';

export type PluginProjectionHook = (queries: PluginQuery[]) => ModelSnapshot;
const loading: ModelSnapshot = Object.freeze({ status: 'loading' });
type Source = { getSnapshot(): ModelSnapshot; subscribe(listener: () => void): () => void; listeners: Set<() => void>; reset(): void };
const sources = new Map<string, Source>();

export function pluginProjectionKey(identity: PluginIdentity, queries: PluginQuery[]) {
  return JSON.stringify({ account: cloud.userId, identity, queries });
}

/** Browser-only asynchronous acquisition adapter, not another business store.
 * Construction is pure; DSH's committed uSES subscription owns the Model retain.
 * Uncommitted concurrent renders can leave at most 256 inert source descriptors. */
export function pluginProjectionSource(key: string): Source {
  const cached = sources.get(key);
  if (cached) return cached;
  const { account, identity, queries } = JSON.parse(key) as { account: string; identity: PluginIdentity; queries: PluginQuery[] };
  let snapshot = loading, stop: (() => void) | undefined, incarnation = 0;
  const listeners = new Set<() => void>();
  const publish = (next: ModelSnapshot) => { if (snapshot === next) return; snapshot = next; for (const listener of listeners) listener(); };
  const source: Source = {
    listeners, getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      if (!stop) {
        if (!account || account !== cloud.userId) { publish({ status: 'error', error: 'plugin_session_changed' }); return () => { listeners.delete(listener); }; }
        const lifetime = accountLifetime(account);
        const generation = ++incarnation;
        let off: (() => void) | undefined, release: (() => void) | undefined;
        stop = () => { ++incarnation; off?.(); release?.(); stop = undefined; };
        void serverRuntime(account).then(runtime => {
          if (!lifetime.current() || generation !== incarnation || !isCurrentServerRuntime(runtime) || account !== cloud.userId) return;
          if (identity.revision === undefined) throw new Error('plugin_revision_required');
          const request = { kind: 'pluginQueries', ...identity, revision: identity.revision, queries } as Extract<RuntimeRead, { kind: 'pluginQueries' }>;
          const model = runtime.plugin(request);
          const update = () => { if (generation === incarnation && isCurrentServerRuntime(runtime)) publish(model.getSnapshot()); };
          off = model.subscribe(update); release = model.acquire(); update();
        }).catch(error => { if (generation === incarnation) publish({ status: 'error', error: error instanceof Error ? error.message : 'plugin_projection_failed' }); });
      }
      return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); snapshot = loading; } };
    },
    reset() { stop?.(); publish({ status: 'error', error: 'plugin_session_changed' }); },
  };
  if (sources.size >= 256) for (const [oldKey, old] of sources) {
    if (!old.listeners.size) { sources.delete(oldKey); break; }
  }
  sources.set(key, source);
  return source;
}
const stopDisposal = onServerRuntimeDisposed(() => { for (const source of sources.values()) source.reset(); sources.clear(); });
import.meta.hot?.dispose(stopDisposal);
