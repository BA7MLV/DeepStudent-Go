import { lookup } from 'node:dns';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';
import { DM_VIEW_URL } from '@wangke/study-core/bilibili/dmview';

const dispatcher = new Agent({ connections: 4, connect: { timeout: 10000,
  lookup(hostname, options, callback) {
    lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (error) { callback(error, '', 4); return; }
      if (!addresses.length || addresses.some(row => ipaddr.process(row.address).range() !== 'unicast')) { callback(new Error('bilibili_address_denied'), '', 4); return; }
      const filtered = options.family ? addresses.filter(row => row.family === options.family) : addresses;
      if (!filtered.length) { callback(new Error('bilibili_dns_failed'), '', 4); return; }
      if (options.all) callback(null, filtered);
      else callback(null, filtered[0].address, filtered[0].family);
    });
  },
} });

/** No general proxy: only server-authored API paths and platform CDN URLs. DNS
 * is checked at connection time. Credentials NEVER go to a CDN or short link. */
export function biliUrl(raw: string, media = false): URL {
  const url = new URL(raw);
  if (url.protocol === 'http:') url.protocol = 'https:';
  const api = url.hostname === 'api.bilibili.com' && ['/x/web-interface/view', '/x/web-interface/nav', '/x/player/playurl'].includes(url.pathname);
  const subtitle = ['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'].includes(url.hostname) && url.pathname.startsWith('/bfs/');
  const short = url.hostname === 'b23.tv' || url.hostname === 'www.bilibili.com' && /^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname);
  const cdn = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.bilivideo\.(?:com|cn)$/.test(url.hostname);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || !(media ? cdn : api || subtitle || url.href === DM_VIEW_URL || short)) throw new Error('B 站返回了不允许访问的地址。');
  return url;
}

export function biliNetwork(fetcher: typeof fetch, cookie: string, signal: AbortSignal): typeof fetch {
  return async (input, init) => {
    let url = biliUrl(String(input));
    for (let hop = 0; hop <= 4; hop++) {
      const headers = new Headers(init?.headers);
      headers.delete('cookie'); headers.delete('authorization');
      headers.set('referer', 'https://www.bilibili.com/');
      headers.set('user-agent', 'Mozilla/5.0 Wangke/1.0');
      if (cookie && url.hostname === 'api.bilibili.com') headers.set('cookie', cookie);
      const response = await fetcher(url, { ...init, headers, redirect: 'manual', credentials: 'omit', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]), dispatcher } as RequestInit);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || hop === 4 || !['b23.tv', 'www.bilibili.com'].includes(url.hostname)) throw new Error('B 站短链跳转失败。');
        url = biliUrl(new URL(location, url).href);
        if (!['b23.tv', 'www.bilibili.com'].includes(url.hostname)) throw new Error('B 站短链跳转地址无效。');
        // A video landing URL already contains the identifier; don't fetch HTML.
        if (url.hostname === 'www.bilibili.com') return new Response(url.href);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`B 站请求失败（HTTP ${response.status}），请检查服务器网络或稍后重试。`); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error('B 站返回空响应。');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length;
          if (size > 4 * 1024 * 1024) throw new Error('B 站响应超过大小限制。');
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      return new Response(Buffer.concat(chunks), { status: response.status, headers: response.headers });
    }
    throw new Error('B 站短链跳转次数过多。');
  };
}

export async function biliMediaResponse(fetcher: typeof fetch, raw: string, signal: AbortSignal) {
  const url = biliUrl(raw, true);
  const response = await fetcher(url, { redirect: 'error', credentials: 'omit', signal,
    headers: { referer: 'https://www.bilibili.com/', 'user-agent': 'Mozilla/5.0 Wangke/1.0' }, dispatcher } as RequestInit);
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`B 站视频下载失败（HTTP ${response.status}），请检查服务器网络、登录态或账号权限。`); }
  return response;
}
