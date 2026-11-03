import assert from 'node:assert/strict';
import test from 'node:test';
import { preferOriginalSubtitles } from '../apps/web/src/pipelines/subtitleSource.ts';

const bundle = { primary: { lang: 'zh-CN', lanDoc: '中文', cues: [{ start: 0, end: 2, text: '原字幕' }] }, tracks: [] };
function fixture(overrides = {}) {
  const calls = [];
  return { calls, options: {
    completed: false, hasSource: true,
    load: async () => { calls.push('load'); return bundle; },
    save: async value => { assert.equal(value, bundle); calls.push('save'); },
    fallback: error => calls.push(error ? 'fallback:error' : 'fallback:empty'),
    checkActive: () => {}, ...overrides,
  } };
}
test('existing completed subtitles skip both Bilibili and ASR', async () => {
  const { options, calls } = fixture({ completed: true });
  assert.equal(await preferOriginalSubtitles(options), true);
  assert.deepEqual(calls, []);
});
test('ordinary uploads use browser transcription', async () => {
  const { options, calls } = fixture({ hasSource: false });
  assert.equal(await preferOriginalSubtitles(options), false);
  assert.deepEqual(calls, []);
});
test('Bilibili original subtitles are saved before any ASR is required', async () => {
  const { options, calls } = fixture();
  assert.equal(await preferOriginalSubtitles(options), true);
  assert.deepEqual(calls, ['load', 'save']);
});
test('missing original subtitles fall back without saving empty data', async () => {
  const { options, calls } = fixture({ load: async () => ({ primary: null, tracks: [] }) });
  assert.equal(await preferOriginalSubtitles(options), false);
  assert.deepEqual(calls, ['fallback:empty']);
});
test('Bilibili network failure falls back to browser ASR', async () => {
  const { options, calls } = fixture({ load: async () => { throw new Error('network'); } });
  assert.equal(await preferOriginalSubtitles(options), false);
  assert.deepEqual(calls, ['fallback:error']);
});
test('saving failure is not treated as missing subtitles (no paid fallback)', async () => {
  const { options, calls } = fixture({ save: async () => { throw new Error('storage'); } });
  await assert.rejects(preferOriginalSubtitles(options), /storage/);
  assert.deepEqual(calls, ['load']);
});
test('cancellation while loading must not save or fall back', async () => {
  let canceled = false;
  const { options, calls } = fixture({
    load: async () => { canceled = true; return bundle; },
    checkActive: () => { if (canceled) throw new Error('canceled'); },
  });
  await assert.rejects(preferOriginalSubtitles(options), /canceled/);
  assert.deepEqual(calls, []);
});
