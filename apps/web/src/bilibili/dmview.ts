import { biliRequest } from './transport';
import type { BiliApiOptions } from './api';
import { fetchBiliSubtitleList as list, fetchSubtitleCues as cues } from '@wangke/study-core/bilibili/dmview';
export { buildDmViewRequest, unframeGrpc, parseSubtitleList, cuesFromSubtitleJson, type BiliSubtitleItem } from '@wangke/study-core/bilibili/dmview';

const transport = (opts: BiliApiOptions): typeof fetch => (url, init) => {
  if (init?.method && !['GET', 'POST'].includes(init.method)) throw new Error('unsupported_bilibili_method');
  if (init?.body && !(init.body instanceof ArrayBuffer)) throw new Error('unsupported_bilibili_body');
  return biliRequest(opts, String(url), { method: init?.method as 'GET' | 'POST' | undefined, body: init?.body ? new Uint8Array(init.body as ArrayBuffer) : undefined, headers: Object.fromEntries(new Headers(init?.headers)) });
};
export const fetchBiliSubtitleList = (opts: BiliApiOptions, aid: number, cid: number) => list(transport(opts), aid, cid);
export const fetchSubtitleCues = (opts: BiliApiOptions, url: string) => cues(transport(opts), url);
