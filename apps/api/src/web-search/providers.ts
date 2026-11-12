import { safeWebUrl, type SearchProvider, type SearchProviderKind, type WebSource } from '@wangke/contracts/web-search';
import { parseHTML } from 'linkedom';
import { WebSearchError } from './config.js';

export interface SearchAdapter {
  request(provider: SearchProvider, query: string, limit: number): { url: string; init: RequestInit };
  results(body: unknown): unknown[];
}
const rows = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new WebSearchError('web_invalid_response', 502);
  return value;
};
/** A provider only translates its API; policy, credentials, limits and UI are shared. */
export const searchAdapters: Record<SearchProviderKind, SearchAdapter> = {
  tavily: {
    request: (p, query, limit) => ({ url: 'https://api.tavily.com/search', init: { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify({ query, max_results: limit, search_depth: 'basic', include_answer: false, include_raw_content: false, include_published_date: true }) } }),
    results: body => rows((body as { results?: unknown })?.results),
  },
  brave: {
    request: (p, query, limit) => ({ url: `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: query, count: String(limit), text_decorations: 'false' })}`, init: { headers: { 'X-Subscription-Token': p.apiKey! } } }),
    results: body => { const value = body as { type?: string; web?: { results?: unknown } }; return value?.type === 'search' && !value.web ? [] : rows(value?.web?.results); },
  },
  searxng: {
    request: (p, query) => ({ url: `${p.baseUrl}/search?${new URLSearchParams({ q: query, format: 'json' })}`, init: { headers: p.apiKey ? { authorization: `Bearer ${p.apiKey}` } : undefined } }),
    results: body => rows((body as { results?: unknown })?.results),
  },
  yuanbao: {
    // Query alone works with all editions, including lite (which does not support Cnt).
    request: (p, query) => ({ url: 'https://api.wsa.cloud.tencent.com/SearchPro', init: { method: 'POST', headers: { authorization: `Bearer ${p.apiKey}`, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ Query: query }) } }),
    results: body => {
      const value = body as { Response?: { Pages?: unknown; Error?: { Code?: unknown } }; Error?: { Code?: unknown } };
      const error = value?.Response?.Error ?? value?.Error;
      // Tencent can return API errors in a successful HTTP response. Never expose its raw message.
      if (error) {
        const code = typeof error.Code === 'string' ? error.Code.split('.')[0] : '';
        switch (code) {
          case 'UnauthorizedOperation': case 'AuthFailure': throw new WebSearchError('web_auth_failed', 401);
          case 'RequestLimitExceeded': throw new WebSearchError('web_rate_limited', 429);
          case 'ResourceNotFound': throw new WebSearchError('web_service_not_enabled', 400);
          case 'ResourceUnavailable': throw new WebSearchError('web_service_unavailable', 400);
          case 'InvalidParameter': case 'InvalidParameterValue': throw new WebSearchError('web_invalid_arguments');
          default: throw new WebSearchError('web_provider_failed', 502);
        }
      }
      return rows(value?.Response?.Pages).slice(0, 100).map(raw => {
        let page: unknown;
        try { page = typeof raw === 'string' ? JSON.parse(raw) : null; } catch { throw new WebSearchError('web_invalid_response', 502); }
        if (!page || typeof page !== 'object' || Array.isArray(page)) throw new WebSearchError('web_invalid_response', 502);
        const row = page as Record<string, unknown>;
        return { url: row.url, title: row.title, content: typeof row.content === 'string' && row.content.trim() ? row.content : row.passage, published_date: row.date };
      });
    },
  },
};
function text(value: unknown, limit: number): string {
  if (typeof value !== 'string') return '';
  const { document } = parseHTML(`<html><body>${value.slice(0, 20000)}</body></html>`);
  for (const element of document.querySelectorAll('script,style')) element.remove();
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}
export function normalizeSources(values: unknown[], limit: number): WebSource[] {
  const seen = new Set<string>(), sources: WebSource[] = [];
  let budget = 9500;
  for (const raw of values.slice(0, 100)) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as Record<string, unknown>, href = safeWebUrl(row.url);
    if (!href) continue;
    const url = new URL(href); url.hash = '';
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const date = row.published_date ?? row.publishedDate ?? row.page_age;
    const source: WebSource = { url: url.href, title: text(row.title, 300) || url.hostname, snippet: text(row.content ?? row.description, 1000),
      ...(typeof date === 'string' && Number.isFinite(Date.parse(date)) ? { published: new Date(date).toISOString() } : {}) };
    const size = JSON.stringify(source).length;
    if (size > budget) continue;
    budget -= size; sources.push(source);
    if (sources.length >= limit) break;
  }
  return sources;
}
export async function boundedText(response: Response, maxBytes: number): Promise<string> {
  if (Number(response.headers.get('content-length')) > maxBytes) { await response.body?.cancel(); throw new WebSearchError('web_response_too_large', 502); }
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new WebSearchError('web_response_too_large', 502);
      chunks.push(next.value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
