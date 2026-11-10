import type { CollectionPage, CollectionVersion, RuntimeRead, RuntimeSnapshot } from '@wangke/contracts/client-runtime';
import type { SegmentRow, SubtitleTrackRow } from '../store/db';

const MAX_ROWS = 20100;
const MAX_BYTES = 16 * 1024 * 1024;
type Reader = { read(request: RuntimeRead): Promise<RuntimeSnapshot> };

/** Complete, explicit playback/export snapshot for ONE course. Each transport
 * page keeps the collection protocol's row/byte bounds. Never publish partial
 * pages or overwrite business IDB with a display-only subset. */
export async function readCourseSubtitles(reader: Reader, videoId: string, heads: [CollectionPage, CollectionPage], guard: () => void) {
  let count = 0, bytes = 0;
  const encoder = new TextEncoder();
  if (heads[0].epoch !== heads[1].epoch) throw new Error('subtitle_snapshot_changed');
  const collect = async (table: 'segments' | 'subtitleTracks', first: CollectionPage) => {
    const rows: Array<SegmentRow | SubtitleTrackRow> = [];
    const seen = new Set<string>();
    let page = first;
    for (;;) {
      guard();
      if (page.epoch !== first.epoch || page.version !== first.version) throw new Error('subtitle_snapshot_changed');
      for (const record of page.records) {
        if (!record.value || record.table !== table || record.value.videoId !== videoId) throw new Error('invalid_subtitle_projection');
        if (++count > MAX_ROWS || (bytes += encoder.encode(JSON.stringify(record)).byteLength) > MAX_BYTES) throw new Error('subtitle_snapshot_budget_exceeded');
        rows.push(record.value as unknown as SegmentRow | SubtitleTrackRow);
      }
      if (!page.next) return rows;
      if (seen.has(page.next)) throw new Error('subtitle_cursor_cycle');
      seen.add(page.next);
      guard();
      const response = await reader.read({ kind: 'collectionPage', table, parent: videoId, cursor: page.next });
      guard(); page = response.value as unknown as CollectionPage;
    }
  };
  const [segments, tracks] = await Promise.all([collect('segments', heads[0]), collect('subtitleTracks', heads[1])]);
  guard();
  // Detect a write even when its WS invalidation has not reached the browser yet.
  // Both collections were collected before this validation barrier.
  const verified = await Promise.all((['segments', 'subtitleTracks'] as const).map(table => reader.read({ kind: 'collectionPage', table, parent: videoId })));
  guard();
  const versions: CollectionVersion[] = verified.map((response, index) => {
    const page = response.value as unknown as CollectionPage;
    if (page.epoch !== heads[index].epoch || page.version !== heads[index].version) throw new Error('subtitle_snapshot_changed');
    return { table: index === 0 ? 'segments' : 'subtitleTracks', version: page.version, epoch: page.epoch };
  });
  return { segments: (segments as SegmentRow[]).filter(row => row.status === 1 && !!row.text).sort((a, b) => a.idx - b.idx),
    tracks: (tracks as SubtitleTrackRow[]).sort((a, b) => a.lang.localeCompare(b.lang)), versions };
}
