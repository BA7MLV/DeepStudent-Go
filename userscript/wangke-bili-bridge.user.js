// ==UserScript==
// @name         DeepStudent Go · B 站导入桥
// @namespace    https://wangke.local
// @version      3.0.0
// @description  使用本机网络和 B 站登录态下载音视频，再由应用合并上传；Cookie 不上传服务器。
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      www.bilibili.com
// @connect      b23.tv
// @connect      app.biliapi.net
// @connect      hdslb.com
// @connect      bilivideo.com
// @connect      bilivideo.cn
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';
  const VERSION = '3.0.0';
  const FILE_LIMIT = 512 * 1024 * 1024;
  const DM_PATH = '/bilibili.community.service.dm.v1.DM/DmView';

  function allowedUrl(raw, method) {
    const url = new URL(raw);
    if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw new Error('不允许的 B 站请求地址');
    const api = url.hostname === 'api.bilibili.com' && ['/x/web-interface/view', '/x/web-interface/nav', '/x/player/playurl'].includes(url.pathname);
    const dm = url.hostname === 'app.biliapi.net' && url.pathname === DM_PATH;
    const short = url.hostname === 'b23.tv';
    const landing = url.hostname === 'www.bilibili.com' && /^\/video\/BV[0-9A-Za-z]{10}\/?$/.test(url.pathname);
    const subtitle = ['aisubtitle.hdslb.com', 'i0.hdslb.com', 'i1.hdslb.com', 'i2.hdslb.com'].includes(url.hostname) && url.pathname.startsWith('/bfs/');
    const media = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.bilivideo\.(?:com|cn)$/.test(url.hostname);
    if (!(method === 'GET' && (api || short || landing || subtitle || media) || method === 'POST' && dm)) throw new Error('不允许的 B 站接口或请求方法');
    return url;
  }

  function parseHeaders(raw) {
    const headers = {};
    for (const line of String(raw || '').split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    return headers;
  }

  function gmFetch(raw, init = {}) {
    return new Promise((resolve, reject) => {
      let request, timer, settled = false;
      const signal = init.signal;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const stop = error => { finish(error); request?.abort(); };
      const abort = () => stop(new DOMException('本机导入已取消', 'AbortError'));
      try {
        if (signal?.aborted) { abort(); return; }
        const method = init.method || 'GET';
        const url = allowedUrl(raw, method);
        const maxBytes = Math.max(1, Math.min(FILE_LIMIT, Number(init.maxBytes) || 4 * 1024 * 1024));
        const short = url.hostname === 'b23.tv';
        const headers = { Referer: 'https://www.bilibili.com/', Accept: '*/*' };
        // Never accept caller-provided Cookie, Authorization or arbitrary headers.
        if (method === 'POST') {
          headers['Content-Type'] = 'application/grpc';
          headers['grpc-accept-encoding'] = 'identity,gzip';
        }
        signal?.addEventListener('abort', abort, { once: true });
        // A real timer also covers managers where anonymous/fetch ignores timeout.
        timer = setTimeout(() => stop(new Error('本机请求 B 站超时，请检查本机网络后重试')), init.onProgress ? 30 * 60 * 1000 : 60000);
        request = GM_xmlhttpRequest({
          method, url: url.href, headers,
          data: method === 'POST' && init.body ? new Blob([init.body], { type: 'application/grpc' }) : undefined,
          responseType: 'arraybuffer',
          // Only the official API uses the browser's existing Bilibili session.
          anonymous: url.hostname !== 'api.bilibili.com',
          redirect: short ? 'follow' : 'error',
          onreadystatechange(res) {
            const length = Number(parseHeaders(res.responseHeaders)['content-length']);
            if (length > maxBytes) stop(new Error('B 站文件超过本机导入大小限制'));
          },
          onprogress(event) {
            if (settled) return;
            if (event.loaded > maxBytes || event.lengthComputable && event.total > maxBytes) {
              stop(new Error('B 站文件超过本机导入大小限制')); return;
            }
            init.onProgress?.(event.loaded, event.lengthComputable ? event.total : 0);
          },
          onload(res) {
            if (settled) return;
            try {
              const final = allowedUrl(res.finalUrl || url.href, method);
              if (!short && final.href !== url.href) throw new Error('B 站请求发生了不允许的跳转');
              let buffer;
              if (short && final.hostname === 'www.bilibili.com') buffer = new TextEncoder().encode(final.href).buffer;
              else if (ArrayBuffer.isView(res.response)) buffer = new Uint8Array(res.response.buffer, res.response.byteOffset, res.response.byteLength).slice().buffer;
              else buffer = ArrayBuffer.prototype.slice.call(res.response, 0);
              if (buffer.byteLength > maxBytes) throw new Error('B 站文件超过本机导入大小限制');
              if ([412, 429].includes(res.status)) throw new Error(`本机请求触发 B 站风控（HTTP ${res.status}），请稍后重试，并在本浏览器确认 B 站可正常播放`);
              const parsedHeaders = parseHeaders(res.responseHeaders);
              const length = Number(parsedHeaders['content-length']);
              if (!short && res.status >= 200 && res.status < 300 && !parsedHeaders['content-encoding'] && length > 0 && length !== buffer.byteLength) throw new Error('B 站文件下载不完整，请重新下载');
              const responseHeaders = {};
              for (const key of ['content-type', 'grpc-status', 'grpc-message']) {
                if (parsedHeaders[key]) responseHeaders[key] = parsedHeaders[key];
              }
              finish(null, { status: res.status, headers: responseHeaders, arrayBuffer: () => Promise.resolve(buffer) });
            } catch (error) { finish(error); }
          },
          onabort: () => finish(new DOMException('本机导入已取消', 'AbortError')),
          onerror: () => finish(new Error('油猴请求失败，请检查本机网络、扩展权限及 B 站登录状态')),
          ontimeout: () => finish(new Error('本机请求 B 站超时')),
        });
      } catch (error) { finish(error); }
    });
  }

  function inject() {
    if (document.documentElement?.getAttribute('data-wangke') !== '1') return false;
    const api = Object.freeze({ version: VERSION, fetch: gmFetch });
    try { unsafeWindow.__wangkeBiliBridge = api; }
    catch { window.__wangkeBiliBridge = api; }
    window.__wangkeBiliBridge = api;
    return true;
  }
  if (inject()) return;
  const observer = new MutationObserver(() => { if (inject()) observer.disconnect(); });
  observer.observe(document.documentElement || document, { attributes: true, childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', () => { inject(); observer.disconnect(); }, { once: true });
})();
