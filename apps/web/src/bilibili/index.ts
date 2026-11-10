import { resolveBiliTarget as resolveTarget } from '@wangke/study-core/bilibili/target';
import { fetchPlayStreams } from '@wangke/study-core/bilibili/api';
import { fetchBiliSubtitleList, fetchSubtitleCues } from '@wangke/study-core/bilibili/dmview';
import { buildBundle, pickPrimary, type SubtitleBundle } from '@wangke/study-core/bilibili/subtitle';
import { resolveSelectedPages, pageVideoTitle } from '@wangke/study-core/bilibili/pages';
import { biliVideoSource, type BiliVideoSource } from '@wangke/study-core/bilibili/source';
import { sanitizeFileName } from '@wangke/study-core/bilibili/parse';
import { biliLocalRequest, BILI_FILE_LIMIT } from './bridge';
import { biliText } from './text';
import type { BiliTarget } from '@wangke/study-core/bilibili/target';
import type { BiliSubtitleItem } from '@wangke/study-core/bilibili/dmview';
export type { BiliTarget } from '@wangke/study-core/bilibili/target';

/** All Bilibili traffic uses the user's browser network and login session. */
export async function resolveBiliTarget(raw: string): Promise<BiliTarget> {
  const target = await resolveTarget({ request: biliLocalRequest() }, raw);
  if (target.subtitleError) target.subtitleError = biliText('subtitleListFailed');
  return target;
}

export async function fetchPageSubtitles(target: BiliTarget, page: number, onError?: (message: string) => void): Promise<BiliSubtitleItem[]> {
  const info = target.pages.find(p => p.page === page);
  if (!info) return [];
  try {
    return await fetchBiliSubtitleList(biliLocalRequest(), info.aid ?? target.aid, info.cid);
  } catch (error) { onError?.(error instanceof Error ? error.message : String(error)); return []; }
}

export async function importBiliPages(target: BiliTarget, opts: {
  pages: number[]; langs: string[]; signal: AbortSignal;
  progress(message: string): void;
  save(file: File, subtitles: SubtitleBundle, source: BiliVideoSource): Promise<void>;
  imported(page: number): void;
}) {
  const request = biliLocalRequest(opts.signal);
  const warnings: string[] = [];
  for (const page of resolveSelectedPages(target.pages, opts.pages)) {
    opts.signal.throwIfAborted();
    const label = biliText('episode', { page: page.page });
    opts.progress(biliText('resolving', { label }));
    const streams = await fetchPlayStreams({ request }, page.bvid ?? target.bvid, page.cid);
    let bytes = 0;
    const download = async (url: string, kind: string) => {
      opts.progress(biliText('downloading', { label, kind }));
      const response = await biliLocalRequest(opts.signal, (loaded, total) => {
        opts.progress(biliText('downloadProgress', { label, kind, size: `${(loaded / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ''}` }));
      }, BILI_FILE_LIMIT - bytes)(url);
      if (!response.ok) throw new Error(biliText('downloadFailed', { kind, status: response.status }));
      const blob = await response.blob();
      if (!blob.size) throw new Error(biliText('emptyDownload', { kind }));
      bytes += blob.size;
      return blob;
    };
    const video = await download(streams.videoUrl, biliText('video'));
    const audio = streams.audioUrl ? await download(streams.audioUrl, biliText('audio')) : null;
    opts.progress(biliText('merging', { label }));
    const { remuxBiliMedia } = await import('./remux');
    const merged = await remuxBiliMedia(video, audio, opts.signal);
    if (merged.size > BILI_FILE_LIMIT) throw new Error(biliText('mergedLimit'));
    let bundle: SubtitleBundle = { primary: null, tracks: [] };
    if (opts.langs.length) {
      opts.progress(biliText('subtitles', { label }));
      try {
        const items = (await fetchBiliSubtitleList(request, page.aid ?? target.aid, page.cid)).filter(item => opts.langs.includes(item.lan));
        const fetched: Parameters<typeof buildBundle>[0] = [];
        for (const item of items) {
          try { fetched.push({ item, cues: await fetchSubtitleCues(request, item.url) }); }
          catch { opts.signal.throwIfAborted(); warnings.push(biliText('subtitleTrackFailed', { label, language: item.lanDoc })); }
        }
        const nonempty = fetched.filter(item => item.cues.length);
        bundle = buildBundle(nonempty, pickPrimary(nonempty.map(item => item.item)));
      } catch { opts.signal.throwIfAborted(); warnings.push(biliText('subtitleFallback', { label })); }
    }
    opts.signal.throwIfAborted();
    opts.progress(biliText('uploading', { label }));
    // Keep the stable per-page ID outside the truncated human title so long
    // multi-part titles cannot collapse onto the same upload path.
    const name = `${sanitizeFileName(pageVideoTitle(target.title, target.pages, page.page))}-${page.cid}.mp4`;
    // Only the merged file, stable source identifiers and subtitle text leave
    // this device. Never upload signed URLs or the browser's Bilibili cookies.
    await opts.save(new File([merged], name, { type: 'video/mp4' }), bundle, biliVideoSource(target, page));
    opts.imported(page.page);
  }
  return warnings;
}
