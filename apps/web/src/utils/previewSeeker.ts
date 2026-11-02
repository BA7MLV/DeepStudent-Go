/** 悬停预览共用一个解码任务，只保留最新目标，避免连续 seek 取消尚未完成的解码。 */
export function createPreviewSeeker(video: HTMLVideoElement, onFrame: () => void) {
  const MIN_INTERVAL = 125;
  const MIN_DELTA = 0.5;
  let target = Number.NaN;
  let lastTarget = Number.NaN;
  let lastIssuedAt = -Infinity;
  let pending = false;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    if (disposed || pending || video.seeking || video.readyState < 1 || !Number.isFinite(target)) return;
    if (Math.abs(target - lastTarget) < MIN_DELTA) return;
    const remaining = MIN_INTERVAL - (Date.now() - lastIssuedAt);
    if (remaining > 0) {
      timer ??= setTimeout(() => { timer = undefined; flush(); }, remaining);
      return;
    }
    // 已在目标帧上时不会触发 seeked，不应把队列永久锁住。
    if (Math.abs(video.currentTime - target) < 0.01 && video.readyState >= 2) {
      lastTarget = target;
      onFrame();
      return;
    }
    lastTarget = target;
    lastIssuedAt = Date.now();
    pending = true;
    video.currentTime = target;
  }

  const onSeeked = () => {
    pending = false;
    onFrame();
    flush();
  };
  video.addEventListener('seeked', onSeeked);

  return {
    request(time: number) {
      if (!Number.isFinite(time) || time < 0) return;
      target = time;
      flush();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
    },
  };
}
