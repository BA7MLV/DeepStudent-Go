import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';

/** main.tsx 在 SW `controllerchange`（非首次接管）时派发；横幅不占用 toast 串行队列。 */
export const UPDATE_READY_EVENT = 'wangke-update-ready';

/**
 * PWA 更新横幅：新 SW 已接管、旧页面仍在跑时给出持久但可关闭的入口。
 *
 * 之前用 `timeout: 0` 的 toast 承载，会把串行 toast 队列永久堵死（之后的
 * 成功/报错反馈全部排队不可见）。改为独立横幅后不打断操作反馈，也不强制刷新。
 */
export default function UpdateBanner() {
  const { t } = useTranslation('common');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onUpdateReady = () => setVisible(true);
    window.addEventListener(UPDATE_READY_EVENT, onUpdateReady);
    return () => window.removeEventListener(UPDATE_READY_EVENT, onUpdateReady);
  }, []);
  if (!visible) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 z-50 flex w-[min(28rem,calc(100vw-2rem))] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-surface p-3 shadow-lg"
    >
      <p className="min-w-0 flex-1 text-sm text-foreground">{t('newVersionReady')}</p>
      <Button size="sm" variant="primary" onPress={() => window.location.reload()}>{t('refreshNow')}</Button>
      <Button size="sm" variant="ghost" onPress={() => setVisible(false)}>{t('updateDismiss')}</Button>
    </div>
  );
}
