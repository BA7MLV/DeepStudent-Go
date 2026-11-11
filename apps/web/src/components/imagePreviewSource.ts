let sourceEl: HTMLElement | null = null;
let sourceRect: DOMRect | null = null;

/** 打开大图前，在触发元素（缩略图）上调用：预览弹层会从它的位置长出来。 */
export function markImagePreviewSource(el: Element | EventTarget | null): void {
  sourceEl = el instanceof HTMLElement ? el : null;
  sourceRect = sourceEl?.getBoundingClientRect() ?? null;
}

/** ImagePreview 打开时取走源矩形（一次性，避免多次打开沿用旧位置）。 */
export function takeImagePreviewSourceRect(): DOMRect | null {
  const rect = sourceRect;
  sourceEl = null;
  return rect;
}

/** 关闭时反向缩回的锚点：保留最近一次的源矩形。 */
export function peekImagePreviewSourceRect(): DOMRect | null {
  return sourceRect;
}
