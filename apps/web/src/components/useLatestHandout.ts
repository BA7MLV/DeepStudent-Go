import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { LatestHandout } from '@wangke/contracts/client-runtime';
import { db, type HandoutRow } from '../store/db';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { isCurrentServerRuntime, serverRuntime } from '../client/bootstrap';

/** A view owns at most one complete document. Release also drops its Runtime
 * snapshot; walking through courses must not build an account-long body cache. */
export function useLatestHandout(videoId: string) {
  const owner = cloud.userId, database = db;
  const [state, setState] = useState<{ videoId: string; owner: string; database: typeof db; row: HandoutRow | null; media?: LatestHandout['media']; ready: boolean; error?: string }>(
    { videoId, owner, database, row: null, ready: false });
  const [attempt, setAttempt] = useState(0);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const retry = useCallback(() => { if (refresh.current) refresh.current(); else setAttempt(value => value + 1); }, []);
  useEffect(() => {
    const lifetime = cloud.enabled ? accountLifetime(owner) : undefined;
    let active = true, cleanup: (() => void) | undefined;
    const current = () => active && database === db && (!lifetime || lifetime.current());
    const empty = { videoId, owner, database, row: null, ready: false };
    setState(empty);
    const unown = lifetime?.own(() => { active = false; cleanup?.(); refresh.current = undefined; setState(empty); });
    if (cloud.enabled) {
      void serverRuntime(owner).then(runtime => {
        if (!current() || !isCurrentServerRuntime(runtime)) return;
        const projection = runtime.latestHandout(videoId), model = projection.model;
        const observe = () => {
          if (!current()) return;
          const snapshot = model.getSnapshot();
          const data = snapshot.data as unknown as LatestHandout | undefined;
          setState(previous => ({ ...previous, ready: snapshot.status === 'ready', error: snapshot.error,
            ...(snapshot.status === 'ready' && data ? { row: data.record?.value as unknown as HandoutRow ?? null, media: data.media } : {}) }));
        };
        const off = model.subscribe(observe), release = model.acquire();
        cleanup = () => { off(); release(); projection.dispose(); };
        refresh.current = () => model.refresh();
        observe();
      }).catch(error => { if (current()) setState(previous => ({ ...previous, ready: false, error: String(error) })); });
    } else {
      const subscription = liveQuery(async () => {
        const rows = await database.handouts.where('videoId').equals(videoId).toArray();
        return rows.sort((a, b) => b.createdAt - a.createdAt || b.id! - a.id!)[0] ?? null;
      }).subscribe({ next: row => { if (current()) setState({ ...empty, row, ready: true }); },
        error: error => { if (current()) setState(previous => ({ ...previous, ready: false, error: String(error) })); } });
      cleanup = () => subscription.unsubscribe();
    }
    return () => { active = false; cleanup?.(); refresh.current = undefined; unown?.(); };
  }, [videoId, owner, database, attempt]);
  const scoped = state.videoId === videoId && state.owner === owner && state.database === database;
  return { row: scoped ? state.row : null, media: scoped ? state.media : undefined, ready: scoped && state.ready, error: scoped ? state.error : undefined, retry };
}
