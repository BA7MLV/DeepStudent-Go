import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPreviewSeeker } from '../apps/web/src/utils/previewSeeker.ts';

class PreviewVideo extends EventTarget {
  readyState = 2;
  seeking = false;
  seeks = [];
  time = 0;
  get currentTime() { return this.time; }
  set currentTime(time) { this.time = time; this.seeking = true; this.seeks.push(time); }
  finish() { this.seeking = false; this.dispatchEvent(new Event('seeked')); }
}

test('解码期间只保留最新目标，并将 seek 限制为最多每 125ms 一次', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const video = new PreviewVideo();
  let frames = 0;
  const seeker = createPreviewSeeker(video, () => frames++);
  seeker.request(10);
  for (let i = 11; i <= 60; i++) seeker.request(i);
  assert.deepEqual(video.seeks, [10]);
  t.mock.timers.tick(20);
  video.finish();
  assert.equal(frames, 1);
  assert.deepEqual(video.seeks, [10]);
  t.mock.timers.tick(104);
  assert.deepEqual(video.seeks, [10]);
  t.mock.timers.tick(1);
  assert.deepEqual(video.seeks, [10, 60]);
  video.finish();
  seeker.request(60.2);
  t.mock.timers.tick(500);
  assert.deepEqual(video.seeks, [10, 60], '近邻目标复用已解码的帧');
  seeker.dispose();
});

test('在当前帧请求不会等待不会到来的 seeked，也不阻塞之后的目标', () => {
  const video = new PreviewVideo();
  let frames = 0;
  const seeker = createPreviewSeeker(video, () => frames++);
  seeker.request(0);
  assert.equal(frames, 1);
  assert.deepEqual(video.seeks, []);
  seeker.request(20);
  assert.deepEqual(video.seeks, [20]);
  seeker.dispose();
});

test('元数据就绪前以及无效时间不发起 seek', () => {
  const video = new PreviewVideo();
  video.readyState = 0;
  const seeker = createPreviewSeeker(video, () => {});
  seeker.request(10);
  assert.deepEqual(video.seeks, []);
  video.readyState = 2;
  for (const time of [NaN, Infinity, -1]) seeker.request(time);
  assert.deepEqual(video.seeks, []);
  seeker.request(10);
  assert.deepEqual(video.seeks, [10]);
  seeker.dispose();
});

test('卸载清除延迟任务和事件监听，后续 request 也是空操作', t => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  const video = new PreviewVideo();
  let frames = 0;
  const seeker = createPreviewSeeker(video, () => frames++);
  seeker.request(10);
  seeker.request(30);
  video.finish();
  seeker.dispose();
  t.mock.timers.tick(1000);
  video.finish();
  seeker.request(40);
  assert.deepEqual(video.seeks, [10]);
  assert.equal(frames, 1);
});
