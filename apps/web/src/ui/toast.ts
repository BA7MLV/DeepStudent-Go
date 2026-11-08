import { toast as heroToast } from '@heroui/react';

/** 轻提示：成功/信息 3s，警告 5s，错误 8s；常驻消息用页面内 Banner。
 * 复制等高频操作可显式缩短成功提示，不影响其他操作。 */
export const toast = {
  info: (message: string) => heroToast.info(message, { timeout: 3000 }),
  success: (message: string, timeout = 3000) => heroToast.success(message, { timeout }),
  warning: (message: string) => heroToast.warning(message, { timeout: 5000 }),
  error: (message: string) => heroToast.danger(message, { timeout: 8000 }),
};
