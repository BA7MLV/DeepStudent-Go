import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginScopes } from '@wangke/contracts/plugins';
import type { PluginCatalog } from './catalog';
import { cloud } from '../cloud/state';
import { db } from '../store/db';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { isCurrentServerRuntime, serverRuntime } from '../client/bootstrap';

/** The package/layout catalog is shared; current host ownership is observed by
 * exact context, never by enumerating every material in the account. */
export function usePluginScope(catalog: PluginCatalog | undefined, materialId?: string, projectFolderId?: number, active = true) {
  const owner = cloud.userId, database = db, enabled = active && cloud.enabled && (!!materialId || projectFolderId !== undefined);
  const scope = useRef<{ owner: string; database: typeof db; lifetime: AccountLifetime }>(undefined);
  if (cloud.enabled && (!scope.current || scope.current.owner !== owner || scope.current.database !== database)) {
    scope.current = { owner, database, lifetime: accountLifetime(owner) };
  }
  const lifetime = scope.current?.lifetime;
  const key = JSON.stringify([materialId, projectFolderId]);
  const [state, setState] = useState<{ key: string; lifetime: typeof lifetime; scopes?: PluginScopes; ready?: boolean; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const refresh = useRef<(() => void) | undefined>(undefined), ready = useRef(false);
  const retry = useCallback(() => { if (refresh.current) refresh.current(); else setAttempt(n => n + 1); }, []);
  useEffect(() => {
    if (!enabled || !lifetime?.current()) return;
    let active = true, cleanup: (() => void) | undefined;
    const current = () => active && lifetime.current() && database === db && owner === cloud.userId;
    const empty = { key, lifetime };
    ready.current = false;
    setState(empty);
    const unown = lifetime.own(() => { active = false; ready.current = false; cleanup?.(); refresh.current = undefined; setState(empty); });
    void serverRuntime(owner).then(runtime => {
      if (!current() || !isCurrentServerRuntime(runtime)) return;
      const projection = runtime.pluginScope(materialId, projectFolderId), model = projection.model;
      const observe = () => {
        if (!current()) return;
        const snapshot = model.getSnapshot();
        ready.current = snapshot.status === 'ready';
        // A failed/reconnecting read is not revocation. Keep the open host and
        // its unsaved work; disable new actions until a fresh scope is ready.
        setState(previous => ({ ...empty, scopes: snapshot.status === 'ready' ? snapshot.data as unknown as PluginScopes
          : previous?.key === key && previous.lifetime === lifetime ? previous.scopes : undefined, ready: ready.current, error: snapshot.error }));
      };
      const off = model.subscribe(observe), release = model.acquire();
      cleanup = () => { off(); release(); projection.dispose(); };
      refresh.current = () => model.refresh();
      observe();
    }).catch(error => { if (current()) setState({ ...empty, error: String(error) }); });
    return () => { active = false; ready.current = false; cleanup?.(); refresh.current = undefined; unown(); };
  }, [enabled, key, materialId, projectFolderId, owner, database, lifetime, attempt]);
  const isCurrent = () => active && database === db && owner === cloud.userId && (!lifetime || lifetime.current()) && (!enabled || ready.current);
  if (!active) return { data: undefined, error: undefined, ready: false, retry, current: isCurrent };
  if (!enabled) return { data: catalog, error: undefined, ready: true, retry, current: isCurrent };
  const current = state?.key === key && state.lifetime === lifetime && lifetime?.current();
  return { data: current && state.scopes && catalog ? { ...catalog, scopes: state.scopes } : undefined, error: current ? state.error : undefined,
    ready: !!current && !!state.ready, retry, current: isCurrent };
}
