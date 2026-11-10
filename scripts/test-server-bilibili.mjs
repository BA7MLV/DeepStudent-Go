import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { encodeMessage, fieldBytes, utf8 } from '@wangke/study-core/bilibili/wire';
import { biliUrl, biliNetwork } from '../apps/api/src/bilibili/network.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { cleanBiliStaging } from '../apps/api/src/bilibili/staging.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'server-bilibili-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'config/secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const bvid = 'BV1xx411c7mD', second = 'BV1yy411c7mD', secretCookie = 'SESSDATA=fixture-secret-only; bili_jct=fixture';
const video = path.join(directory, 'video.m4s'), audio = path.join(directory, 'audio.m4s');
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', video]);
execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'aac', '-vn', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', audio]);
let mode = 'normal', blockStarted, season = false;
const calls = [];
const fetcher = async (input, init) => {
  const url = new URL(String(input)), headers = new Headers(init.headers);
  calls.push({ host: url.hostname, path: url.pathname, cookie: headers.get('cookie') });
  assert.ok(init.dispatcher, 'production public-DNS dispatcher supplied');
  assert.equal(headers.get('referer'), 'https://www.bilibili.com/');
  if (url.hostname === 'api.bilibili.com') {
    if (url.pathname.endsWith('/nav')) return Response.json({ code: 0, data: { isLogin: headers.get('cookie') === secretCookie, uname: 'Fixture' } });
    assert.equal(headers.get('cookie'), secretCookie);
    if (url.pathname.endsWith('/view') && mode === 'risk') return Response.json({ code: -352, message: secretCookie });
    if (url.pathname.endsWith('/view') && mode === 'expired') return Response.json({ code: -101, message: secretCookie });
    if (url.pathname.endsWith('/view') && mode === 'missing') return Response.json({ code: -404, message: secretCookie });
    if (url.pathname.endsWith('/view') && mode === 'http-risk') return new Response(secretCookie, { status: 412 });
    if (url.pathname.endsWith('/view') && mode === 'timeout') throw new DOMException(secretCookie, 'TimeoutError');
    if (url.pathname.endsWith('/view') && mode === 'network') throw new TypeError(secretCookie);
    if (url.pathname.endsWith('/view')) return Response.json({ code: 0, data: { aid: 10, title: '服务器课程', duration: 2, pages: [{ page: 1, cid: 100, part: '第一课', duration: 1 }, { page: 2, cid: 200, part: '第二课', duration: 1 }],
      ...(season ? { ugc_season: { title: '课程合集', sections: [{ episodes: [{ bvid, aid: 10, cid: 100, title: '第一集' }, { bvid: second, aid: 20, cid: 300, title: '第二集', arc: { duration: 1 } }] }] } } : {}) } });
    if (url.pathname.endsWith('/playurl')) return Response.json({ code: 0, data: { dash: { duration: 1, video: [{ id: 80, height: 180, codecid: 7, codecs: 'avc1', baseUrl: 'https://upos-fixture.bilivideo.com/video.m4s' }], audio: [{ codecs: 'mp4a', baseUrl: 'https://upos-fixture.bilivideo.com/audio.m4s' }] } } });
  }
  assert.equal(headers.get('cookie'), null, 'credentials never reach short links or CDNs');
  if (url.hostname === 'b23.tv') return new Response(null, { status: 302, headers: { location: `https://www.bilibili.com/video/${bvid}/?p=1` } });
  if (url.pathname.endsWith('/DmView')) {
    if (mode === 'subtitle-failed') return new Response('unavailable', { status: 503 });
    const item = encodeMessage([fieldBytes(3, utf8('zh-Hans')), fieldBytes(4, utf8('中文')), fieldBytes(5, utf8('https://aisubtitle.hdslb.com/bfs/fixture.json'))]);
    const message = encodeMessage([fieldBytes(3, encodeMessage([fieldBytes(3, item)]))]);
    const frame = Buffer.alloc(5 + message.length); frame.writeUInt32BE(message.length, 1); frame.set(message, 5);
    return new Response(frame);
  }
  if (url.hostname === 'aisubtitle.hdslb.com') return Response.json({ body: [{ from: 0, to: 1, content: '服务器导入的原始字幕' }] });
  if (url.hostname.endsWith('.bilivideo.com')) {
    if (mode === 'blocked') { blockStarted?.(); return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })); }
    if (mode === 'oversize') return new Response('large', { headers: { 'content-length': String(513 * 1024 * 1024) } });
    const bytes = fs.readFileSync(url.pathname.includes('audio') ? audio : video);
    return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
  }
  throw new Error(`unexpected fixture request ${url.hostname}${url.pathname}`);
};
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: fetcher });
let cookie;
async function raw(method, url, payload, headers = {}) {
  return api.inject({ method, url: `/api/v1${url}`, headers: { ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload }) });
}
async function call(method, url, payload) {
  const response = await raw(method, url, payload);
  assert.ok(response.statusCode < 300, `${response.statusCode} ${response.body}`);
  return response.json();
}
async function until(fn) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error('Bilibili test timed out');
}
const input = (pages = [{ bvid, cid: 100 }], extra = {}) => ({ bvid, pages, langs: ['zh-Hans'], ...extra });
const submit = data => call('POST', '/cloud/tasks', { kind: 'bilibiliImport', resource: crypto.randomUUID(), nonce: crypto.randomUUID(), input: data });
async function complete(task) {
  const result = await until(async () => { const taskNow = await call('GET', `/cloud/tasks/${task.id}`); return ['completed', 'failed', 'cancelled'].includes(taskNow.status) && taskNow; });
  assert.equal(result.status, 'completed', JSON.stringify(result)); return result;
}
try {
  for (const url of ['https://127.0.0.1/a', 'https://localhost/a', 'https://evil.test/b23.tv/a', 'https://api.bilibili.com/private', 'https://user:pass@api.bilibili.com/x/web-interface/nav', 'https://api.bilibili.com:444/x/web-interface/nav']) assert.throws(() => biliUrl(url));
  assert.throws(() => biliUrl('https://bilivideo.com.evil.test/video', true));
  let redirects = 0;
  await assert.rejects(biliNetwork(async () => { redirects++; return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }); }, secretCookie, new AbortController().signal)('https://b23.tv/test'));
  assert.equal(redirects, 1, 'redirect target rejected before connecting');
  await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await raw('POST', '/cloud/bilibili/resolve', { raw: bvid })).statusCode, 401);
  const bootstrap = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  const initialized = await raw('POST', '/bootstrap/initialize', { adminPassword: 'server-bilibili-fixture' }, { 'x-bootstrap-secret': bootstrap });
  assert.equal(initialized.statusCode, 201, initialized.body);
  const logged = await raw('POST', '/auth/password/login', { password: 'server-bilibili-fixture' });
  cookie = logged.headers['set-cookie'].split(';')[0];
  const owner = logged.json().user.id;
  assert.equal((await raw('PUT', '/cloud/bilibili/credentials', { cookie: secretCookie }, { origin: 'https://evil.invalid' })).statusCode, 403);
  await call('PUT', '/cloud/bilibili/credentials', { cookie: secretCookie });
  const status = await call('GET', '/cloud/bilibili/status');
  assert.deepEqual(status, { configured: true, login: { isLogin: true, uname: 'Fixture' } });
  assert.ok(!JSON.stringify(status).includes('fixture-secret-only'));
  assert.equal((await raw('PUT', '/cloud/bilibili/credentials', { cookie: 'SESSDATA=x\r\nInjected: yes' })).statusCode, 400);
  const target = await call('POST', '/cloud/bilibili/resolve', { raw: 'https://b23.tv/fixture' });
  assert.equal(target.pages.length, 2); assert.equal(target.subtitles[0].url, '');
  const share = await call('POST', '/cloud/bilibili/resolve', { raw: '【服务器课程-哔哩哔哩】\n（https://b23.tv/fixture）。复制后打开哔哩哔哩' });
  assert.equal(share.bvid, bvid);
  const sharedPage = await call('POST', '/cloud/bilibili/resolve', { raw: `https://example.com/?p=99 【课程】https://www.bilibili.com/video/${bvid}/?p=2。` });
  assert.deepEqual(sharedPage.defaultPages, [2]);
  const beforeInvalid = calls.length;
  assert.equal((await raw('POST', '/cloud/bilibili/resolve', { raw: '不是视频链接' })).statusCode, 400);
  assert.equal(calls.length, beforeInvalid, 'invalid input rejected without upstream requests');
  for (const [value, statusCode, message] of [
    ['risk', 502, /风控/], ['expired', 400, /Cookie/], ['missing', 400, /不存在/],
    ['http-risk', 502, /风控/], ['timeout', 504, /超时/], ['network', 502, /DNS/],
  ]) {
    mode = value;
    const failedResolve = await raw('POST', '/cloud/bilibili/resolve', { raw: bvid });
    assert.equal(failedResolve.statusCode, statusCode);
    assert.match(failedResolve.json().error, message);
    assert.ok(!failedResolve.body.includes('fixture-secret-only'), 'upstream errors never leak secrets');
  }
  mode = 'normal';
  season = true;
  const collection = await call('POST', '/cloud/bilibili/resolve', { raw: bvid });
  assert.equal(collection.kind, 'season'); assert.equal(collection.pages[2].bvid, second);
  season = false;
  const folder = await call('POST', '/resources/folders', { name: 'B站导入测试' });
  const operation = { kind: 'bilibiliImport', resource: 'fixture-import', nonce: crypto.randomUUID(), input: input([{ bvid, cid: 100 }, { bvid, cid: 200 }], { folderId: folder.folderId }) };
  const task = await call('POST', '/cloud/tasks', operation);
  assert.equal((await call('POST', '/cloud/tasks', operation)).id, task.id);
  assert.ok(!JSON.stringify(task).includes('fixture-secret-only'));
  const result = await complete(task);
  assert.equal(result.executor, 'node'); assert.equal(result.result.imported.length, 2);
  const listing = await call('GET', `/resources?projectId=${folder.id}`);
  assert.equal(listing.entries.filter(e => e.courseId).length, 2);
  for (const entry of listing.entries.filter(e => e.courseId)) {
    const filename = path.join(process.env.FILES_DIR, 'projects', folder.id, entry.path);
    const streams = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', filename])).streams;
    assert.ok(streams.some(s => s.codec_type === 'video')); assert.ok(streams.some(s => s.codec_type === 'audio'));
    assert.equal((await raw('GET', `/resources/courses/${entry.courseId}`)).statusCode, 200);
  }
  const db = new DatabaseStore(path.join(directory, 'db.sqlite'));
  try {
    assert.ok(!db.db.prepare('SELECT value FROM bilibili_credentials WHERE owner_id=?').get(owner).value.includes('fixture-secret-only'));
    const tracks = db.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='subtitleTracks' AND value IS NOT NULL").all(owner);
    assert.equal(tracks.length, 2);
    const other = crypto.randomUUID(); db.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, other, new Date().toISOString());
    const sessionToken = crypto.randomUUID(); db.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), other, crypto.createHash('sha256').update(sessionToken).digest('hex'), new Date().toISOString(), new Date(Date.now() + 60000).toISOString());
    const previous = cookie; cookie = `wangke_session=${sessionToken}`;
    assert.equal((await raw('GET', `/cloud/tasks/${task.id}`)).statusCode, 404);
    assert.equal((await call('GET', '/cloud/bilibili/status')).configured, false);
    assert.equal((await raw('POST', '/cloud/tasks', { ...operation, nonce: crypto.randomUUID() })).statusCode, 400);
    cookie = previous;
  } finally { db.close(); }
  assert.equal((await raw('POST', '/cloud/tasks', { ...operation, nonce: crypto.randomUUID(), input: { ...input(), cookie: secretCookie } })).statusCode, 400);
  for (const invalid of [input([]), input([{ bvid, cid: 100 }, { bvid, cid: 100 }]), input(undefined, { folderId: -1 }), input(undefined, { folderId: 999999 }), input([{ bvid, cid: '100' }])]) {
    assert.equal((await raw('POST', '/cloud/tasks', { ...operation, nonce: crypto.randomUUID(), input: invalid })).statusCode, 400);
  }
  const noSubs = await complete(await submit(input(undefined, { langs: [] })));
  const noSubsId = noSubs.result.imported[0].courseId;
  assert.equal((await call('GET', '/cloud/tasks')).tasks.find(t => t.kind === 'transcribe' && t.input.videoId === noSubsId).input.skipBiliSubtitles, true);
  mode = 'subtitle-failed';
  const fallback = await complete(await submit(input()));
  assert.ok(fallback.result.warnings.some(w => w.includes('字幕不可用')));
  mode = 'oversize';
  const oversized = await submit(input());
  const failed = await until(async () => { const t = await call('GET', `/cloud/tasks/${oversized.id}`); return t.status === 'failed' && t; });
  assert.match(failed.error, /大小限制/);
  mode = 'blocked';
  const started = new Promise(resolve => { blockStarted = resolve; });
  const blocked = await submit(input()); await started;
  const queued = [];
  for (let i = 0; i < 3; i++) queued.push(await call('POST', '/cloud/tasks', { ...operation, input: input(), nonce: crypto.randomUUID() }));
  assert.equal(new Set(queued.map(t => t.id)).size, 3, 'distinct selections are not deduplicated by the entry BV resource');
  assert.equal((await raw('POST', '/cloud/tasks', { ...operation, input: input(), nonce: crypto.randomUUID() })).statusCode, 400, 'four imports per account maximum');
  for (const task of queued) await call('POST', `/cloud/tasks/${task.id}/cancel`, {});
  await call('POST', `/cloud/tasks/${blocked.id}/cancel`, {});
  assert.equal((await call('GET', `/cloud/tasks/${blocked.id}`)).status, 'cancelled');
  await until(() => fs.readdirSync(path.join(process.env.FILES_DIR, '.bilibili-imports')).length === 0);
  await call('PUT', '/cloud/bilibili/credentials', { cookie: '' });
  assert.equal((await call('GET', '/cloud/bilibili/status')).configured, false);
  const terminalStaging = path.join(process.env.FILES_DIR, '.bilibili-imports', `${blocked.id}-Ab12cd`);
  const unknownStaging = path.join(process.env.FILES_DIR, '.bilibili-imports', 'unknown-owned-directory');
  fs.mkdirSync(terminalStaging); fs.writeFileSync(path.join(terminalStaging, 'partial.m4s'), 'incomplete');
  fs.mkdirSync(unknownStaging);
  const recoveredStore = new DatabaseStore(path.join(directory, 'db.sqlite'));
  try { cleanBiliStaging(recoveredStore, process.env.FILES_DIR); } finally { recoveredStore.close(); }
  assert.ok(!fs.existsSync(terminalStaging), 'terminal staging from an earlier process is cleaned');
  assert.ok(fs.existsSync(unknownStaging), 'unrecognized files are not swept');
  if (process.env.BILI_BROWSER === '1') {
    mode = 'normal';
    await call('PUT', '/cloud/bilibili/credentials', { cookie: secretCookie });
    const { verifyBiliBrowser } = await import('./fixtures/bilibili-browser.mjs');
    await verifyBiliBrowser({ api, cookie, bvid, secretCookie, folder, directory, call, setMode: value => { mode = value; }, localFetch: fetcher });
  }
  console.log('PASS server Bilibili resolve/short-link/season, encrypted owner credentials, two real FFmpeg MP4 imports, original subtitles, task idempotency, playback, origin/auth isolation, URL policy, oversize/cancellation and staging cleanup.');
} finally { await api.close(); fs.rmSync(directory, { recursive: true, force: true }); }
