import { useState, type ReactNode } from 'react';
import { Tooltip } from '@heroui/react';

interface HintProps {
  /** 完整内容：截断的名称、状态解释或统计口径 */
  content: ReactNode;
  children: ReactNode;
  className?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** 首次出现稍慢，键盘 / 触屏立即反馈 */
  delay?: number;
  testId?: string;
}

/**
 * 纯文字说明气泡。
 *
 * 只用于「看见但读不全」的信息：截断名称、状态原因、统计口径。
 * 里面不放按钮或链接 —— 要操作就用 Popover / Dropdown。
 * 触发元素进入 Tab 序列，聚焦即可读；触屏点一下也能看到。
 */
export function Hint({ content, children, className, placement = 'top', delay = 500, testId }: HintProps) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip delay={delay} closeDelay={100} isOpen={open} onOpenChange={setOpen}>
      <Tooltip.Trigger<'span'>
        render={(props) => (
          <span {...props} className={className} tabIndex={0} data-testid={testId}
            onPointerUp={(event) => {
              props.onPointerUp?.(event);
              if (event.pointerType === 'touch') setOpen(value => !value);
            }}>
            {children}
          </span>
        )}
      />
      <Tooltip.Content placement={placement}>{content}</Tooltip.Content>
    </Tooltip>
  );
}
