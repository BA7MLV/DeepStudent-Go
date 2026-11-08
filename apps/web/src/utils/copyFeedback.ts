import i18n from '../i18n';
import { toast } from '../ui/toast';
import { copyText } from './clipboard';

export function copyFailed(): void {
  toast.error(i18n.t('clipboard.failed'));
}

/** 菜单关闭后用短 Toast 反馈；常驻复制按钮不传成功文案，只显示原位反馈。 */
export async function copyWithFeedback(text: string, successMessage?: string): Promise<boolean> {
  let ok = false;
  try { ok = await copyText(text); } catch { /* 剪贴板或 DOM 不可用时也必须提示失败。 */ }
  if (!ok) copyFailed();
  else if (successMessage) toast.success(successMessage, 2000);
  return ok;
}
