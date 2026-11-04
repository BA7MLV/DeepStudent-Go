import { DM_VIEW_URL, fetchBiliSubtitleList, fetchSubtitleCues } from '@wangke/study-core/bilibili/dmview';
import { buildBundle, defaultSelectedLangs, pickPrimary, cuesToSegments } from '@wangke/study-core/bilibili/subtitle';
import { commitTask, recordMutation, newRecordId, type TaskContext } from '../src/cloud/execution.js';

/** Fixed API and exact CDN hosts only. No cookies, redirects or task URLs. */
export async function importBilibiliSubtitles(context: TaskContext, id: string, source: unknown): Promise<boolean> {
  const { aid, cid } = (source ?? {}) as { aid?: number; cid?: number };
  if (!Number.isSafeInteger(aid) || !Number.isSafeInteger(cid) || aid! <= 0 || cid! <= 0) return false;
  const request: typeof fetch = async (input, init) => {
    context.checkActive();
    const url = new URL(String(input));
    // Bilibili sometimes advertises HTTP CDN links; always upgrade to TLS.
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      !(url.href === DM_VIEW_URL || (['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'].includes(url.hostname) && url.pathname.startsWith('/bfs/')))) throw new Error('subtitle_url_rejected');
    const response = await context.fetch(url, { ...init, redirect: 'error', credentials: 'omit', signal: AbortSignal.any([context.signal, AbortSignal.timeout(15000)]) });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('subtitle_empty_response');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 4 * 1024 * 1024) throw new Error('subtitle_size_limit'); chunks.push(value); }
    } finally { await reader.cancel(); reader.releaseLock(); }
    return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
  };
  try {
    const list = await fetchBiliSubtitleList(request, aid!, cid!);
    const selected = defaultSelectedLangs(list), items = list.filter(item => selected.includes(item.lan));
    const fetched = [];
    for (const item of items) fetched.push({ item, cues: await fetchSubtitleCues(request, item.url) });
    const bundle = buildBundle(fetched, pickPrimary(fetched.filter(f => f.cues.length).map(f => f.item)));
    if (!bundle.primary) return false;
    context.checkActive();
    commitTask(context, [
      ...cuesToSegments(bundle.primary.cues).map(segment => { const key = newRecordId(); return recordMutation('segments', key, null, { ...segment, id: key, videoId: id }); }),
      ...bundle.tracks.map(track => { const key = newRecordId(); return recordMutation('subtitleTracks', key, null, { ...track, id: key, videoId: id }); }),
    ]);
    return true;
  } catch (error) {
    context.checkActive();
    context.report({ phase: 'subtitle', message: 'B站原字幕不可用，回退服务器音频转写。' });
    return false;
  }
}
