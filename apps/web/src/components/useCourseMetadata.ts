import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { CourseMetadata } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import type { StoredBlob } from '../store/cloudBlob';
import { accountLifetime, type AccountLifetime } from '../client/account-lifecycle';
import { isCurrentServerRuntime, serverRuntime } from '../client/bootstrap';

type CourseItem = Omit<CourseMetadata['items'][number], 'cover'> & {
  cover: { source: NonNullable<CourseMetadata['items'][number]['cover']>['source']; blob: StoredBlob } | null;
};

/** Display-only metadata. Never publish these partial values into business IDB
 * tables or reuse them as edit baselines. A view releases the entire snapshot. */
export function useCourseMetadata(ids: string[], covers: boolean, enabled = true) {
  const owner = cloud.userId, database = db;
  // Retain a terminal identity for this mounted account/database. A state
  // update caused by disposal must not silently acquire a fresh lifetime.
  const scope = useRef<{ owner: string; database: typeof db; server: boolean; lifetime?: AccountLifetime }>(undefined);
  if (!scope.current || scope.current.owner !== owner || scope.current.database !== database || scope.current.server !== cloud.enabled) {
    scope.current = { owner, database, server: cloud.enabled, lifetime: cloud.enabled ? accountLifetime(owner) : undefined };
  }
  const lifetime = scope.current.lifetime;
  const key = JSON.stringify([...new Set(ids)].sort());
  const [state, setState] = useState<{ key: string; owner: string; database: typeof db; lifetime: typeof lifetime;
    covers: boolean; items: CourseItem[]; ready: boolean; error?: string }>();
  const [attempt, setAttempt] = useState(0);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const retry = useCallback(() => { if (refresh.current) refresh.current(); else setAttempt(n => n + 1); }, []);
  const current = useCallback(() => database === db && (!lifetime || lifetime.current() && owner === cloud.userId), [database, lifetime, owner]);
  useEffect(() => {
    if (!enabled || lifetime && !lifetime.current()) return;
    const keys = JSON.parse(key) as string[];
    const empty = { key, owner, database, lifetime, covers, items: [], ready: false };
    let active = true, cleanup: (() => void) | undefined;
    const current = () => active && database === db && (!lifetime || lifetime.current() && owner === cloud.userId);
    setState(empty);
    const unown = lifetime?.own(() => { active = false; cleanup?.(); refresh.current = undefined; setState(empty); });
    if (!keys.length) setState({ ...empty, ready: true });
    else if (cloud.enabled) {
      void serverRuntime(owner).then(runtime => {
        if (!current() || !isCurrentServerRuntime(runtime)) return;
        const projection = runtime.courseMetadata(keys, covers), model = projection.model;
        const observe = () => {
          if (!current()) return;
          const snapshot = model.getSnapshot();
          const data = snapshot.data as unknown as CourseMetadata | undefined;
          setState(previous => ({ ...(previous ?? empty), ready: snapshot.status === 'ready', error: snapshot.error,
            ...(snapshot.status === 'ready' && data ? { items: data.items } : {}) }));
        };
        const off = model.subscribe(observe), release = model.acquire();
        cleanup = () => { off(); release(); projection.dispose(); };
        refresh.current = () => model.refresh();
        observe();
      }).catch(error => { if (current()) setState(previous => ({ ...(previous ?? empty), ready: false, error: String(error) })); });
    } else {
      const subscription = liveQuery(async () => {
        const [courses, rows] = await Promise.all([database.videos.bulkGet(keys), covers ? database.covers.bulkGet(keys) : []]);
        return keys.map((id, i) => ({ id, course: courses[i] ? { name: courses[i]!.name, kind: courses[i]!.kind === 'material' ? 'material' as const : 'video' as const } : null,
          cover: rows[i] ? { source: rows[i]!.source, blob: rows[i]!.blob } : null }));
      }).subscribe({ next: items => { if (current()) setState({ ...empty, items, ready: true }); },
        error: error => { if (current()) setState(previous => ({ ...(previous ?? empty), ready: false, error: String(error) })); } });
      cleanup = () => subscription.unsubscribe();
    }
    return () => { active = false; cleanup?.(); refresh.current = undefined; unown?.(); };
  }, [key, covers, enabled, owner, database, lifetime, attempt]);
  const scoped = enabled && state?.key === key && state.owner === owner && state.database === database
    && state.lifetime === lifetime && state.covers === covers && (!lifetime || lifetime.current());
  return { items: scoped ? state.items : [], ready: !!scoped && state.ready, error: scoped ? state.error : undefined, retry, current, lifetime };
}
