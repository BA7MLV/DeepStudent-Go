import { toast as heroToast } from '@heroui/react';

/** 轻提示：成功/信息默认 3s，警告 5s，错误 8s。
 * 带操作的信息提示可单独配置按钮及停留时间；复制等高频操作可缩短成功提示。 */
export const toast = {
  info: (message: string, options?: Parameters<typeof heroToast.info>[1]) => heroToast.info(message, { timeout: 3000, ...options }),
  success: (message: string, timeout = 3000) => heroToast.success(message, { timeout }),
  warning: (message: string) => heroToast.warning(message, { timeout: 5000 }),
  error: (message: string) => heroToast.danger(message, { timeout: 8000 }),
};
