import { cloudRequest } from '../cloud/state';
import { submitCloudTask } from '../cloud/tasks';
import type { BiliTarget } from '@wangke/study-core/bilibili/target';
import type { BiliSubtitleItem } from '@wangke/study-core/bilibili/dmview';
export type { BiliTarget } from '@wangke/study-core/bilibili/target';

/** Browser sends only stable identifiers. Downloads and credentials stay on the
 * server; neither a userscript nor a user-configured proxy is consulted. */
export function resolveBiliTarget(raw: string): Promise<BiliTarget> {
  return cloudRequest('/bilibili/resolve', { method: 'POST', body: JSON.stringify({ raw }) });
}

export async function fetchPageSubtitles(target: BiliTarget, page: number, onError?: (message: string) => void): Promise<BiliSubtitleItem[]> {
  const info = target.pages.find(p => p.page === page);
  if (!info) return [];
  try {
    const result = await cloudRequest<{ items: BiliSubtitleItem[] }>('/bilibili/subtitles', { method: 'POST', body: JSON.stringify({ bvid: info.bvid ?? target.bvid, cid: info.cid }) });
    return result.items;
  } catch (error) { onError?.(error instanceof Error ? error.message : String(error)); return []; }
}

export function importBiliPages(target: BiliTarget, opts: { pages: number[]; langs: string[]; folderId?: number }, operationId: string) {
  const selected = new Set(opts.pages);
  return submitCloudTask('bilibiliImport', `bilibili:${target.bvid}:${opts.folderId ?? 'root'}`, {
    bvid: target.bvid,
    pages: target.pages.filter(p => selected.has(p.page)).map(p => ({ bvid: p.bvid ?? target.bvid, cid: p.cid })),
    langs: opts.langs,
    ...(opts.folderId === undefined ? {} : { folderId: opts.folderId }),
  }, operationId);
}
