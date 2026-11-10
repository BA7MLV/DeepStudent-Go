import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveBiliTarget, importBiliPages } from '../apps/web/src/bilibili/index.ts';
import { biliLocalRequest, hasBiliBridge } from '../apps/web/src/bilibili/bridge.ts';
import { remuxBiliMedia } from '../apps/web/src/bilibili/remux.ts';
import { Input, BlobSource, MP4 } from 'mediabunny';

const script = await fs.readFile(new URL('../userscript/wangke-bili-bridge.user.js', import.meta.url), 'utf8');
const api = 'https://api.bilibili.com/x/web-interface/view?bvid=BV1xx411c7mD';
const cdn = 'https://upos-test.bilivideo.com/video.m4s';
const dm = 'https://app.biliapi.net/bilibili.community.service.dm.v1.DM/DmView';
const bytes = value => new TextEncoder().encode(value).buffer;

function bridge(handler, marked = true) {
  const requests = [];
  let aborted = 0;
  const window = {};
  vm.runInNewContext(script, {
    window, unsafeWindow: window, URL, Blob, TextEncoder, DOMException, setTimeout, clearTimeout,
    document: { documentElement: { getAttribute: () => marked ? '1' : null }, addEventListener() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    GM_xmlhttpRequest(details) {
      requests.push(details);
      queueMicrotask(() => handler?.(details));
      return { abort() { aborted++; details.onabort(); } };
    },
  });
  return { window, requests, get aborted() { return aborted; } };
}

test('published userscript is identical, scoped to Bilibili, and only injects on app pages', async () => {
  assert.equal(script, await fs.readFile(new URL('../apps/web/public/wangke-bili-bridge.user.js', import.meta.url), 'utf8'));
  assert.doesNotMatch(script, /@connect\s+\*|GM_cookie|headers\.Cookie|getCookie/);
  assert.equal(bridge(undefined, false).window.__wangkeBiliBridge, undefined);
});

test('bridge restricts requests and does not send caller credentials or expose response cookies', async () => {
  const host = bridge(details => details.onload({ status: 200, response: bytes('{}'), finalUrl: details.url, responseHeaders: 'Content-Type: application/json\r\nSet-Cookie: secret=private' }));
  const fetch = host.window.__wangkeBiliBridge.fetch;
  const response = await fetch(api, { headers: { Cookie: 'secret', Authorization: 'private' } });
  assert.equal(host.requests[0].anonymous, false);
  assert.equal(host.requests[0].headers.Cookie, undefined);
  assert.equal(host.requests[0].headers.Authorization, undefined);
  assert.equal(response.headers['set-cookie'], undefined);
  await fetch(cdn);
  assert.equal(host.requests[1].anonymous, true);
  await fetch(dm, { method: 'POST', body: bytes('grpc') });
  assert.equal(host.requests[2].anonymous, true);
  assert.equal(host.requests[2].headers['Content-Type'], 'application/grpc');
  for (const url of ['https://evil.test/', 'https://api.bilibili.com.evil.test/', 'http://127.0.0.1/', 'https://user:pass@api.bilibili.com/x/web-interface/nav', 'https://api.bilibili.com/x/relation/modify']) {
    await assert.rejects(fetch(url), /不允许/);
  }
  await assert.rejects(fetch(api, { method: 'POST' }), /不允许/);
  assert.equal(host.requests.length, 3);
});

test('bridge handles b23 redirects using the resolved video identifier, not landing HTML', async () => {
  const host = bridge(details => details.onload({ status: 200, response: bytes('<html>irrelevant</html>'), finalUrl: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2' }));
  const response = await host.window.__wangkeBiliBridge.fetch('https://b23.tv/example');
  assert.equal(new TextDecoder().decode(await response.arrayBuffer()), 'https://www.bilibili.com/video/BV1xx411c7mD?p=2');
});

test('bridge cancels requests and enforces response/progress limits', async () => {
  const host = bridge();
  const controller = new AbortController();
  const flight = host.window.__wangkeBiliBridge.fetch(cdn, { signal: controller.signal });
  controller.abort();
  await assert.rejects(flight, error => error.name === 'AbortError');
  assert.equal(host.aborted, 1);
  const progress = bridge(details => details.onprogress({ loaded: 10, total: 10, lengthComputable: true }));
  await assert.rejects(progress.window.__wangkeBiliBridge.fetch(cdn, { maxBytes: 5 }), /大小限制/);
  assert.equal(progress.aborted, 1);
  const loaded = bridge(details => details.onload({ status: 200, response: bytes('too large'), finalUrl: details.url }));
  await assert.rejects(loaded.window.__wangkeBiliBridge.fetch(cdn, { maxBytes: 5 }), /大小限制/);
  const rateLimited = bridge(details => details.onload({ status: 412, response: bytes('blocked'), finalUrl: details.url }));
  await assert.rejects(rateLimited.window.__wangkeBiliBridge.fetch(api), /本机请求触发 B 站风控/);
});

test('fetch adapter accepts sandbox responses, with no missing/old bridge fallback to the server', async () => {
  globalThis.window = {};
  assert.equal(hasBiliBridge(), false);
  await assert.rejects(biliLocalRequest()(api), /安装或更新/);
  window.__wangkeBiliBridge = { version: '2.1.2', fetch() { throw new Error('old bridge used'); } };
  await assert.rejects(biliLocalRequest()(api), /安装或更新/);
  const host = bridge(details => details.onload({ status: 200, response: bytes('{"code":0}'), finalUrl: details.url }));
  globalThis.window = host.window;
  assert.equal(hasBiliBridge(), true);
  assert.deepEqual(await (await biliLocalRequest()(api)).json(), { code: 0 });
});

test('local remux preserves separate video/audio tracks; imports save only files and stable metadata', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-local-'));
  try {
    const videoFile = path.join(directory, 'video.mp4'), audioFile = path.join(directory, 'audio.mp4');
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=12:d=1', '-an', '-c:v', 'libx264', '-movflags', 'frag_keyframe+empty_moov', videoFile]);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-vn', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', audioFile]);
    const video = await fs.readFile(videoFile), audio = await fs.readFile(audioFile);
    const merged = await remuxBiliMedia(new Blob([video]), new Blob([audio]), new AbortController().signal);
    const input = new Input({ source: new BlobSource(merged), formats: [MP4] });
    try {
      assert.equal(await (await input.getPrimaryVideoTrack()).getCodec(), 'avc');
      assert.equal(await (await input.getPrimaryAudioTrack()).getCodec(), 'aac');
      assert.ok(await input.computeDuration() > 0.9);
    } finally { input.dispose(); }
    const silent = await remuxBiliMedia(new Blob([video]), null, new AbortController().signal);
    assert.ok(silent.size > 0);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(remuxBiliMedia(new Blob([video]), null, aborted.signal), error => error.name === 'AbortError');

    const requests = [], saved = [], imported = [], progress = [];
    globalThis.window = { __wangkeBiliBridge: { version: '3.0.0', async fetch(url, init) {
      requests.push(url);
      let body;
      if (url.includes('/view?')) body = bytes(JSON.stringify({ code: 0, data: { aid: 1, title: '课程', pages: [1, 2].map(page => ({ page, cid: page, part: `测试${page}`, duration: 1 })) } }));
      else if (url === dm) body = new Uint8Array([0, 0, 0, 0, 0]).buffer;
      else if (url.includes('/playurl?')) body = bytes(JSON.stringify({ code: 0, data: { dash: { duration: 1, video: [{ id: 80, height: 1080, codecid: 7, baseUrl: cdn }], audio: [{ codecs: 'mp4a.40.2', baseUrl: cdn.replace('/video.m4s', '/audio.m4s') }] } } }));
      else body = Uint8Array.from(url.includes('audio.m4s') ? audio : video).buffer;
      init.onProgress?.(body.byteLength, body.byteLength);
      return { status: 200, headers: {}, arrayBuffer: async () => body };
    } } };
    const target = await resolveBiliTarget('BV1xx411c7mD');
    assert.equal(target.pages.length, 2);
    await importBiliPages(target, { pages: [1, 2], langs: [], signal: new AbortController().signal,
      progress: message => progress.push(message), imported: page => imported.push(page),
      save: async (file, bundle, source) => {
        assert.equal(file.type, 'video/mp4'); assert.ok(file.size > 0);
        assert.equal(bundle.primary, null);
        assert.equal(source.bvid, target.bvid);
        assert.doesNotMatch(JSON.stringify(source), /https:|cookie|auth_key/i);
        saved.push(file.name);
      },
    });
    assert.equal(saved.length, 2);
    assert.notEqual(saved[0], saved[1]);
    assert.deepEqual(imported, [1, 2]);
    assert.ok(progress.some(message => message.includes('本机合并')));
    assert.ok(progress.some(message => message.includes('上传')));
    assert.ok(requests.every(url => url.startsWith('https://')));
    assert.ok(requests.every(url => !url.includes('/api/v1/cloud')));

    const partial = [];
    await assert.rejects(importBiliPages(target, { pages: [1, 2], langs: [], signal: new AbortController().signal,
      progress() {}, imported: page => partial.push(page), save: async () => { if (partial.length) throw new Error('upload_failed'); },
    }), /upload_failed/);
    assert.deepEqual(partial, [1]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
