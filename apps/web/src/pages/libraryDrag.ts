/**
 * 拖拽手势的纯几何计算。
 *
 * 抽出来单独放，是因为指针命中检测最容易出错、也最值得单独读：拖拽用的是
 * Pointer Events + `setPointerCapture`，事件目标永远是**起拖那张卡片**，
 * 不能靠 `dragenter/dragover` 的 target 判断落在谁身上，只能自己量矩形。
 *
 * 这里不碰 React、不碰 DOM 之外的状态，输入坐标与元素，输出「命中了哪一块」。
 */

/** 拖拽的两种「卡片级」投放区（除文件夹组头之外） */
export type DragZone = 'pin' | 'delete';

/** 指针是否落在元素矩形内；元素不存在视为未命中 */
export function withinRect(element: Element | null, clientX: number, clientY: number): boolean {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

/** 坐标 → 组头 key。组头按 Map 的迭代顺序（渲染顺序）取第一个命中。 */
export function groupKeyAt(
  headers: ReadonlyMap<string, Element>,
  clientX: number,
  clientY: number,
): string | null {
  for (const [key, element] of headers) {
    if (withinRect(element, clientX, clientY)) return key;
  }
  return null;
}

/**
 * 顶栏投放区优先于组头：组头在它们下方的文档流里，两套矩形理论上不重叠，
 * 但把优先级写死更稳（将来组头滚到它们底下也不会误判）。
 */
export function zoneAt(
  zones: { pin: Element | null; remove: Element | null },
  clientX: number,
  clientY: number,
): DragZone | null {
  if (withinRect(zones.pin, clientX, clientY)) return 'pin';
  if (withinRect(zones.remove, clientX, clientY)) return 'delete';
  return null;
}

/** 起拖阈值（px）：超过即判定为拖拽而不是「点一下」 */
export const DRAG_THRESHOLD_PX = 5;
/** 贴近滚动容器边缘多少像素开始自动滚动 */
export const AUTO_SCROLL_EDGE_PX = 40;
/** 自动滚动每帧位移 */
export const AUTO_SCROLL_STEP_PX = 16;

/** 按指针在滚动容器内的位置，算出该往哪个方向滚；不在区域内返回 0 */
export function autoScrollDelta(rect: DOMRect, clientX: number, clientY: number): number {
  if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return 0;
  if (clientY < rect.top + AUTO_SCROLL_EDGE_PX) return -AUTO_SCROLL_STEP_PX;
  if (clientY > rect.bottom - AUTO_SCROLL_EDGE_PX) return AUTO_SCROLL_STEP_PX;
  return 0;
}

/**
 * 指针落点的「文件夹目标」。返回 null 表示不该接受这次投放
 * （落在系统目录/项目文件夹上它们不参与移动，或不在画布内）。
 *
 * `spring` 表示「悬停一会儿就会打开」——只对组头与路径栏成立，
 * 画布空白处（即当前文件夹本身）不触发悬停打开。
 */
export function dropTargetAt(
  clientX: number,
  clientY: number,
): { target: number | null; spring: boolean } | null {
  const element = document.elementFromPoint(clientX, clientY);
  if (!element || element.closest('[data-system-folder]')) return null;
  const path = element.closest<HTMLElement>('.finder-path-target');
  if (path) return { target: path.dataset.folderId ? Number(path.dataset.folderId) : null, spring: true };
  const canvas = element.closest<HTMLElement>('.finder-canvas');
  if (!canvas) return null;
  const folder = element.closest<HTMLElement>('[data-group-key]');
  if (folder) return { target: Number(folder.dataset.groupKey), spring: true };
  return { target: Number(canvas.getAttribute('data-folder-id')) || null, spring: false };
}
