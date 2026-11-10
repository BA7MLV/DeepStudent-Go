import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { CollectionPage, RuntimeRecord, CollectionVersion } from '@wangke/contracts/client-runtime';
import { db, type SegmentRow, type SubtitleTrackRow, type VideoRow } from '../store/db';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { readCourseSubtitles } from '../client/course-subtitles';
import { formatCaughtError } from '../utils/errorText';

/** Retain the last complete display snapshot on read failure, never translate
 * unavailable/reconnecting into an authoritative empty subtitle collection. */
export function useCourseSubtitles(videoId: string) {
  const owner = cloud.userId, database = db, server = cloud.enabled;
  const empty = { videoId, owner, database, segments: [] as SegmentRow[], tracks: [] as SubtitleTrackRow[], ready: false, retryable: false, error: null as string | null };
  const [state, setState] = useState(empty);
  const refresh = useRef<(() => void) | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => { if (refresh.current) refresh.current(); else setAttempt(value => value + 1); }, []);
  useEffect(() => {
    let active = true, cleanup: (() => void) | undefined;
    const lifetime = server ? accountLifetime(owner) : undefined;
    const current = () => active && database === db && owner === cloud.userId && (!lifetime || lifetime.current());
    setState(empty);
    const unown = lifetime?.own(() => { active = false; cleanup?.(); refresh.current = undefined; setState(empty); });
    if (!server) {
      const subscription = liveQuery(async () => {
        const [segments, tracks, course] = await Promise.all([database.segments.where('videoId').equals(videoId).sortBy('idx'),
          database.subtitleTracks.where('videoId').equals(videoId).toArray(), database.videos.get(videoId)]);
        return { segments: segments.filter(row => row.status === 1 && !!row.text), tracks: tracks.sort((a, b) => a.lang.localeCompare(b.lang)),
          retryable: course?.status === 'error' || !!course?.transcriptionPaused };
      }).subscribe({ next: value => { if (current()) setState({ ...empty, ...value, ready: true }); },
        error: error => { if (current()) setState(previous => ({ ...previous, ready: false, error: formatCaughtError(error) })); } });
      cleanup = () => subscription.unsubscribe();
    } else {
      void serverRuntime(owner).then(runtime => {
        if (!current() || !isCurrentServerRuntime(runtime)) return;
        const projection = runtime.courseSubtitlePages(videoId);
        const models = [projection.segments, projection.tracks, projection.course];
        const head = () => models.slice(0, 2).map(model => model.getSnapshot().data as unknown as CollectionPage | undefined);
        let dirty = false, running = false, stopped = false;
        // A completed read is only published while its collected versions still
        // match the observed heads; otherwise the loop reads again. A callback
        // counter would discard a valid result and could strand the view stale.
        const unchanged = (versions: CollectionVersion[]) => versions.every((version, index) => {
          const page = head()[index];
          return !!page && page.epoch === version.epoch && page.version === version.version;
        });
        const pump = () => {
          if (stopped || running || !dirty || !current()) return;
          const snapshots = models.map(model => model.getSnapshot());
          // Not ready yet: the model publish that makes it ready calls observe again.
          if (snapshots.some(snapshot => snapshot.status !== 'ready' || !snapshot.data)) return;
          dirty = false; running = true;
          const guard = () => { if (!current() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed'); };
          const heads = snapshots.slice(0, 2).map(snapshot => snapshot.data as unknown as CollectionPage) as [CollectionPage, CollectionPage];
          const course = (snapshots[2].data as unknown as { records: RuntimeRecord[] }).records[0]?.value as unknown as VideoRow | null;
          void readCourseSubtitles(runtime, videoId, heads, guard).then(value => {
            guard();
            if (!unchanged(value.versions)) {
              // A write landed between collection and verification. Read again
              // rather than publishing a mixed snapshot or giving up silently.
              dirty = true; return;
            }
            setState({ ...empty, segments: value.segments, tracks: value.tracks, ready: true,
              retryable: course?.status === 'error' || !!course?.transcriptionPaused, error: null });
          }).catch(error => {
            if (!current() || !isCurrentServerRuntime(runtime)) return;
            if (error instanceof Error && error.message === 'subtitle_snapshot_changed') { dirty = true; return; }
            // Keep the previous complete document visible, but never call it ready:
            // an unreadable collection is unknown, not empty or deleted.
            setState(previous => ({ ...previous, ready: false, error: formatCaughtError(error) }));
          }).finally(() => { running = false; if (dirty) pump(); });
        };
        const observe = () => {
          if (!current()) return;
          dirty = true;
          const error = models.map(model => model.getSnapshot()).find(snapshot => snapshot.status === 'error')?.error;
          if (error) setState(previous => ({ ...previous, ready: false, error }));
          pump();
        };
        const offs = models.map(model => model.subscribe(observe));
        const releases = models.map(model => model.acquire());
        refresh.current = () => {
          const error = models.map(model => model.getSnapshot()).find(snapshot => snapshot.status === 'error')?.error;
          if (error) for (const model of models) model.refresh();
          observe();
        };
        cleanup = () => { stopped = true; dirty = false; offs.forEach(off => off()); releases.forEach(release => release()); projection.dispose(); };
        observe();
      }).catch(error => { if (current()) setState(previous => ({ ...previous, ready: false, error: formatCaughtError(error) })); });
    }
    return () => { active = false; cleanup?.(); refresh.current = undefined; unown?.(); };
  }, [videoId, owner, database, server, attempt]);
  const scoped = state.videoId === videoId && state.owner === owner && state.database === database;
  return { ...(scoped ? state : empty), retry };
}
