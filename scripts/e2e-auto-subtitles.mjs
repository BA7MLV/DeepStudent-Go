// Disposable account + real browser decoding/VAD/cover + mocked paid ASR.
// macOS can synthesize a fixture; elsewhere provide TEST_FILE with spoken audio.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { encodeMessage, fieldBytes, utf8 } from '../apps/web/src/bilibili/wire.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-auto-subtitles-'));
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
let calls = 0, mode = 'success';
const { buildServer } = await import('../apps/api/src/server.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.match(String(url), /audio\/transcriptions$/);
  calls++;
  assert.ok(init.body, 'browser supplies an audio file');
  if (mode === 'error') return new Response('fixture invalid API key', { status: 401 });
  // Delay enough to observe incremental persistence and cancellation.
  await new Promise(resolve => setTimeout(resolve, mode === 'slow' ? 6000 : 800));
  return Response.json({ text: '自动字幕测试成功。', segments: [{ start: 0, end: 1, text: '自动字幕测试成功。' }] });
} });
let vite, browser;
const errors = [];
try {
  let fixture = process.env.TEST_FILE;
  if (!fixture) {
    assert.equal(process.platform, 'darwin', 'provide TEST_FILE with spoken audio');
    const audio = path.join(directory, 'speech.aiff');
    execFileSync('say', ['-o', audio, 'This is a spoken lesson for automatic subtitles. We are testing browser audio extraction and saving subtitles. The video should remain available while subtitles are prepared.']);
    fixture = path.join(directory, 'speech.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-i', audio, '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', fixture]);
  }
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  let response = await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'auto-subtitles-password' } });
  assert.equal(response.statusCode, 201, response.body);
  response = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'auto-subtitles-password' } });
  const cookie = response.headers['set-cookie'].split(';')[0];
  const call = async (method, url, payload) => {
    const result = await api.inject({ method, url: `/api/v1${url}`, headers: { cookie }, ...(payload !== undefined ? { payload } : {}) });
    assert.ok(result.statusCode < 300, result.body); return result.json();
  };
  const config = await call('GET', '/cloud/config');
  await call('PUT', '/cloud/config', { ...config,
    providers: [{ id: 'fixture', name: 'Fixture', baseUrl: 'https://asr.invalid/v1', protocol: 'openai-chat', apiKey: 'test-only', catalogId: '', serves: ['chat', 'asr'] }],
    llmModel: { providerId: 'fixture', model: 'test' }, asrModel: { providerId: 'fixture', model: 'speech' },
  });
  await call('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table: 'preferences', key: 'uiLanguage', before: null, after: { id: 'uiLanguage', value: 'zh-CN' } }] });
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, server: { host: '127.0.0.1', port: 0, watch: { ignored: ['**/*'] } } });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const context = await browser.newContext({ locale: 'zh-CN', serviceWorkers: 'block' });
  await context.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
  await context.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  const page = await context.newPage();
  if (process.env.DEBUG_MEDIA) {
    page.on('console', message => console.log('BROWSER:', message.type(), message.text().slice(0, 1000)));
    page.on('requestfailed', request => console.log('REQUEST FAILED:', request.url(), request.failure()));
    page.on('response', response => { if (/\/ort\/|\/vad\//.test(response.url())) console.log('MEDIA ASSET:', response.status(), response.url()); });
  }
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/library`);
  await page.getByTestId('resource-list').waitFor({ timeout: 60000 });
  const until = async (fn, label) => {
    for (let i = 0; i < 180; i++) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 500)); }
    console.error(JSON.stringify(await call('GET', '/cloud/tasks')));
    throw new Error(`Timed out: ${label}`);
  };
  await until(() => page.locator('iframe[data-browser-worker]').count(), 'normal app hosts browser worker');
  await page.locator('input[type=file]').setInputFiles({ name: '自动字幕.mp4', mimeType: 'video/mp4', buffer: fs.readFileSync(fixture) });
  let videoId;
  await until(async () => {
    const listing = await call('GET', '/resources');
    videoId = listing.entries.find(e => e.name === '自动字幕.mp4')?.courseId;
    return videoId;
  }, 'upload persists a video');
  const tasks = async () => (await call('GET', '/cloud/tasks')).tasks.filter(t => t.input.videoId === videoId);
  await until(async () => (await tasks()).some(t => t.kind === 'transcribe' && t.status === 'completed'), 'automatic transcription finishes');
  await until(async () => (await tasks()).some(t => t.kind === 'cover' && t.status === 'completed'), 'browser cover finishes');
  assert.ok((await tasks()).every(t => t.executor === 'browser'));
  assert.equal((await tasks()).filter(t => t.kind === 'transcribe').length, 1);
  const record = async (table, id = videoId) => (await call('GET', `/cloud/record?table=${table}&key=${encodeURIComponent(JSON.stringify(id))}`)).value;
  assert.equal((await record('videos')).status, 'transcribed');
  await until(async () => page.evaluate(async id => {
    const { db } = await import('/src/store/db.ts');
    return (await db.segments.where('videoId').equals(id).toArray()).some(row => row.status === 1 && row.text.includes('自动字幕测试成功'));
  }, videoId), 'incremental subtitles reach the interactive app');
  assert.ok((await record('covers')).blob.$file);
  assert.ok(calls > 0);
  const beforeReload = calls;
  await page.reload();
  await page.getByTestId('resource-list').waitFor();
  await page.waitForTimeout(2000);
  assert.equal(calls, beforeReload, 'completed subtitles must not be retranscribed on reload');
  console.log('✓ Upload auto-starts actual browser decoding/VAD, mock ASR, persisted captions and real cover; reload does not repeat ASR');

  // Only the top frame gets the bridge, like user-script managers configured
  // without all-frames. The worker must reuse it and avoid ASR entirely.
  const message = encodeMessage([fieldBytes(3, encodeMessage(['ai-zh', 'ai-en'].map(lan => fieldBytes(3, encodeMessage([
    fieldBytes(3, utf8(lan)), fieldBytes(4, utf8(lan)), fieldBytes(5, utf8(`https://aisubtitle.hdslb.com/${lan}`)),
  ]))))) ]);
  const frame = new Uint8Array(message.length + 5);
  new DataView(frame.buffer).setUint32(1, message.length, false); frame.set(message, 5);
  await page.evaluate(bytes => {
    window.__wangkeBiliBridge = { version: 'test', fetch: async url => {
      const data = url.includes('/DmView') ? new Uint8Array(bytes) : new TextEncoder().encode(JSON.stringify({ body: [{ from: 0, to: 2, content: 'B站原始字幕' }] }));
      return { ok: true, status: 200, arrayBuffer: async () => data.buffer, text: async () => new TextDecoder().decode(data), json: async () => JSON.parse(new TextDecoder().decode(data)) };
    } };
  }, [...frame]);
  const previous = await record('videos');
  await call('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table: 'videos', key: videoId, before: previous,
    after: { ...previous, status: 'new', biliSource: { bvid: 'BV1GJ411x7h7', aid: 101, cid: 202, page: 1 } } }] });
  await call('POST', '/cloud/tasks', { nonce: crypto.randomUUID(), kind: 'transcribe', resource: `course:${videoId}`, input: { videoId } });
  await until(async () => (await tasks()).filter(t => t.kind === 'transcribe' && t.status === 'completed').length === 2, 'Bilibili original captions');
  assert.equal(calls, beforeReload, 'original subtitles skip ASR');
  await until(async () => page.evaluate(async id => {
    const { db } = await import('/src/store/db.ts');
    return await db.subtitleTracks.where('videoId').equals(id).count() === 2;
  }, videoId), 'both original subtitle language tracks persist');
  console.log('✓ Bilibili originals work in the automatic iframe via parent bridge, without ASR');

  mode = 'error';
  // Clear the source/completed marker to exercise ASR failure, keeping the video.
  const withSource = await record('videos');
  await call('POST', '/cloud/records', { mutations: [{ id: crypto.randomUUID(), table: 'videos', key: videoId, before: withSource,
    after: { ...withSource, status: 'new', biliSource: null } }] });
  await call('POST', '/cloud/tasks', { nonce: crypto.randomUUID(), kind: 'transcribe', resource: `course:${videoId}`, input: { videoId } });
  await until(async () => (await tasks()).some(t => t.kind === 'transcribe' && t.status === 'failed'), 'ASR error is visible, not empty success');
  await page.goto(`${origin}/#/player/${videoId}`);
  await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('subs-retry').waitFor();
  assert.equal(await page.getByTestId('subs-generate').count(), 0);
  assert.equal(await page.getByTestId('subs-fetch-bili').count(), 0);
  assert.deepEqual(errors, []);
  console.log('✓ ASR failure exposes retry; no manual generate/fetch controls or page errors');

  mode = 'slow';
  const beforeCancel = calls;
  await page.getByTestId('subs-retry').click();
  await until(() => calls > beforeCancel, 'retry starts ASR');
  await page.getByTestId('subs-cancel').click();
  await until(async () => (await record('videos')).transcriptionPaused === true, 'cancel is durably paused');
  const countAfterCancel = (await tasks()).filter(t => t.kind === 'transcribe').length;
  await page.reload();
  await page.getByTestId('study-assistant-toggle').waitFor();
  await page.waitForTimeout(2000);
  assert.equal((await tasks()).filter(t => t.kind === 'transcribe').length, countAfterCancel, 'reload must not restart deliberately canceled work');
  if (!await page.getByTestId('subs-retry').isVisible()) await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('subs-retry').waitFor();
  mode = 'success';
  await page.getByTestId('subs-retry').click();
  await until(async () => (await tasks()).filter(t => t.kind === 'transcribe' && t.status === 'completed').length === 3, 'explicit retry resumes canceled transcription');
  assert.equal((await record('videos')).transcriptionPaused, false);
  assert.deepEqual(errors, []);
  console.log('✓ Cancellation survives reload and explicit retry completes without marking partial subtitles as finished');
} finally {
  await browser?.close(); await vite?.close(); await api.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
