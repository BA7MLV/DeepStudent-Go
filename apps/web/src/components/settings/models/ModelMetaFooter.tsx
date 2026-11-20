import { useTranslation } from 'react-i18next';
import { LoadingButton, Sym } from '../../../ui';

/** 面板底部的「能力数据来源 / 上次更新 / 手动刷新」 */
export function ModelMetaFooter({
  updatedAt,
  refreshing,
  error,
  onRefresh,
}: {
  updatedAt: number | null;
  refreshing: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <>
      <div className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-muted">
        <span>能力数据由 <a href="https://models.dev" target="_blank" rel="noreferrer" className="underline underline-offset-2">models.dev</a> 提供。</span>
        <LoadingButton
          variant="ghost"
          size="sm"
          isIconOnly
          className="size-7 min-w-7 text-muted"
          loading={refreshing}
          data-testid="btn-refresh-meta"
          aria-label={refreshing ? t('models.refreshingCaps') : t('models.refreshCaps')}
          onPress={onRefresh}
        ><Sym name="refresh" /></LoadingButton>
        <span className="tabular-nums" data-testid="model-meta-updated-at" aria-live="polite">
          {updatedAt ? <time dateTime={new Date(updatedAt).toISOString()} title={t('models.metaUpdatedTitle')}>{t('models.updatedAt')} {new Date(updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })} BJT</time> : t('models.notUpdated')}
        </span>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-pretty text-danger">{error}</p>}
    </>
  );
}
