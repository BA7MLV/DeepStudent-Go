import { useEffect } from 'react';

/**
 * 「按下就收起」：面板 / 触发按钮之外的任意一次 pointerdown 都要关掉面板。
 *
 * 为什么需要自己写：模型检索面板打了 `isNonModal`（理由见 SlotModelSelect 里的注释），
 * 而 react-aria 的「点外面关闭」挂在 `isDismissable` 上，`usePopover` 把后者写死成
 * `!isNonModal` —— 也就是说，非模态浮层在这一层上没有任何自动收起。
 * Esc 仍然有效（走 `isKeyboardDismissDisabled`，与 isNonModal 无关）。
 *
 * 为什么用 pointerdown 而不是 click：click 要等 mouseup，按下时目标可能已经变了；
 * 而且按下即关能给用户「点空了」的即时反馈，不用等一次完整的按下-抬起。
 *
 * 挂在冒泡阶段而不是捕获阶段：捕获阶段里把面板从 DOM 里摘掉，中途还在传播的这次
 * 点击有可能落空（尤其当目标正好在被移除的子树里）。
 */
export function DismissOnOutsidePress({
  triggerRef,
  onDismiss,
}: {
  triggerRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
}) {
  useEffect(() => {
    const handle = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      // 面板本体（data-model-picker）与触发按钮之外的按下都算「点外面」
      if (target instanceof Element && target.closest('[data-model-picker]')) return;
      if (triggerRef.current?.contains(target)) return;
      onDismiss();
    };
    document.addEventListener('pointerdown', handle);
    return () => document.removeEventListener('pointerdown', handle);
  }, [onDismiss, triggerRef]);
  return null;
}
