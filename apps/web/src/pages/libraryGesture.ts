/**
 * 资料库卡片的指针手势常量与拖拽状态类型。
 *
 * 单独放是因为两个文件都要用（卡片组件用长按阈值，主组件用状态类型），
 * 又不能互相 import —— 卡片组件被主组件导入，反向再导入会成环。
 */
import type { VideoRow } from '../store/db';
import type { DragZone } from './libraryDrag';

/** 整卡长按多久进入拖拽（毫秒）。与系统「长按呼出菜单」的常见时长同量级 */
export const LONG_PRESS_MS = 400;

/** 长按期间允许的抖动上限（px）：超过即判定为滚动/点按，取消长按 */
export const LONG_PRESS_SLOP = 8;

/** 一次整卡拖拽的完整状态；`zone` 与 `overKey` 互斥表达「落在顶栏投放区还是组头」 */
export interface DragState {
  video: VideoRow;
  x: number;
  y: number;
  /** 悬停到的文件夹组头 key（含 `UNCAT_KEY`），未悬停为 null */
  overKey: string | null;
  /** 悬停到的卡片级投放区，未悬停为 null */
  zone: DragZone | null;
}
