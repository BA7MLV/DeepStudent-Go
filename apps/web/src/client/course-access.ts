import { db, type VideoRow } from '../store/db';
import { cloud } from '../cloud/state';
import { accountLifetime } from './account-lifecycle';
import type { StoredBlob } from '../store/cloudBlob';

/** Capture before any await. These callbacks belong to the original player,
 * not whichever account happens to be selected when Vidstack calls back. */
export function captureCourseAccess() {
  const database = db, owner = cloud.userId, server = cloud.enabled;
  const lifetime = server ? accountLifetime(owner) : undefined;
  const current = () => database === db && owner === cloud.userId && server === cloud.enabled && (!lifetime || lifetime.current());
  const guard = () => { if (!current()) throw new Error('client_account_changed'); };
  return {
    current, lifetime,
    async colorFrame(id: string): Promise<StoredBlob | undefined> {
      guard();
      if (server) {
        const { serverRuntime } = await import('./bootstrap');
        guard(); const runtime = await serverRuntime(owner);
        guard(); const response = await runtime.read({ kind: 'courseColorFrame', videoId: id });
        guard(); return (response.value as { frame: { blob: StoredBlob } | null }).frame?.blob;
      }
      const frames = await database.frames.where('videoId').equals(id).toArray();
      guard(); frames.sort((a, b) => Number(b.kind === 'slide') - Number(a.kind === 'slide') || a.ts - b.ts);
      return frames[0]?.blob;
    },
    async read(id: string): Promise<VideoRow | undefined> {
      guard();
      let row: VideoRow | undefined;
      if (server) {
        const { readRecordKeys } = await import('../cloud/sync');
        guard(); row = (await readRecordKeys<VideoRow>('videos', [id]))[0];
      } else row = await database.videos.get(id);
      guard(); return row;
    },
    async recordPlayback(id: string, position: number, finished?: boolean) {
      guard();
      const resources = await import('./resources');
      guard();
      await resources.recordPlayback(id, position, finished);
      guard();
    },
  };
}
