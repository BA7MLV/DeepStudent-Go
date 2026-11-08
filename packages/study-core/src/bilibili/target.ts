import { fetchVideoView, resolveShortUrl, type BiliApiOptions, type BiliPageInfo } from './api.js';
import { fetchBiliSubtitleList, type BiliSubtitleItem } from './dmview.js';
import { parseBiliInput } from './parse.js';
import { defaultPagesFor } from './pages.js';

export interface BiliTarget {
  kind?: 'pages' | 'season';
  bvid: string;
  aid: number;
  title: string;
  pages: BiliPageInfo[];
  defaultPages: number[];
  subtitles: BiliSubtitleItem[];
  subtitleError?: string;
}

export async function resolveBiliTarget(opts: BiliApiOptions, raw: string): Promise<BiliTarget> {
  const parsed = parseBiliInput(raw);
  const bvid = parsed.isShort ? await resolveShortUrl(opts, parsed.shortUrl!) : parsed.bvid;
  const view = await fetchVideoView(opts, bvid);
  const explicitPage = /[?&]p=\d+/.test(raw) ? parsed.page : null;
  const pages = view.season?.pages ?? view.pages;
  const current = view.season?.pages.find(p => p.bvid === bvid && p.sourcePage === (explicitPage ?? 1));
  const defaultPages = view.season ? [current?.page ?? pages.find(p => p.bvid === bvid)!.page] : defaultPagesFor(pages, explicitPage);
  const target: BiliTarget = { kind: view.season ? 'season' : 'pages', bvid, aid: view.aid, title: view.season?.title ?? view.title, pages, defaultPages, subtitles: [] };
  const first = pages.find(p => p.page === defaultPages[0])!;
  try { target.subtitles = await fetchBiliSubtitleList(opts.request, first.aid ?? view.aid, first.cid); }
  catch { target.subtitleError = '服务器暂时无法获取 B 站字幕列表，可继续导入视频。'; }
  return target;
}
