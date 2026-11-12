import { toast as heroToast } from '@heroui/react';
import { SerialFeedback } from './serialFeedback';

type Options = Parameters<typeof heroToast>[1];
let active: { id: string; key: string } | undefined;
const queue = heroToast.getQueue();
const serial = new SerialFeedback<{ message: string; options: Options }>((value, id) => {
  active = { id, key: heroToast(value.message, value.options) };
}, () => queue.visibleToasts.length > 0);
// onClose fires at the START of HeroUI's exit animation. Waiting for actual
// removal avoids overlapping announcements and timers during bursts.
queue.subscribe(() => queueMicrotask(() => serial.advance()));
const add = (message: string, options: Options) => serial.add({ message, options });

/** Immediate action feedback, FIFO, one at a time. HeroUI owns hover/focus and
 * hidden-tab timer pauses. Durable errors belong beside their affected item. */
export const toast = {
  info: (message: string, options?: Options) => add(message, { timeout: 3000, variant: 'accent', ...options }),
  success: (message: string, options: number | Options = 3000) => add(message, { timeout: 3000, variant: 'success', ...(typeof options === 'number' ? { timeout: options } : options) }),
  warning: (message: string) => add(message, { timeout: 5000, variant: 'warning' }),
  error: (message: string) => add(message, { timeout: 8000, variant: 'danger' }),
  close: (id: string) => { serial.remove(id); if (active?.id === id) heroToast.close(active.key); },
  clear: () => { serial.clear(); heroToast.clear(); },
};
