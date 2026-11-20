import { useCallback, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { cloud } from './state';
import { db } from '../store/db';
import { confirmDialog, toast } from '../ui';
import { resolveLearningCommand, type LearningCommandRow } from '../client/learning';
import { cloudTransaction } from './transactions';

/**
 * 设置 → 数据 → 同步 → 冲突:把「去云端管理处理」换成一个真正的解决界面。
 *
 * 每条冲突命令给出两个方向:
 *   - 保留云端:丢弃本机这笔修改,原稿转入恢复证据(`learning-discarded:`),可随时导出;
 *   - 保留本机:按原始意图重新提交(云端已改回/故障已排除时生效)。
 * 导出 JSON 仍是兜底,不做任何自动取舍。
 */
export default function ConflictRecovery() {
  const { t } = useTranslation('settings');
  const [rows, setRows] = useState<LearningCommandRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const owner = cloud.userId, database = db;
    const conflictRows = await database.table<LearningCommandRow>('_learningCommands').where('state').equals('conflict').toArray();
    if (database !== db || owner !== cloud.userId) return;
    conflictRows.sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    setRows(conflictRows);
  }, []);

  useEffect(() => { void load().catch(() => {}); }, [load]);

  const resolve = async (operationId: string, action: 'retry' | 'discard') => {
    setBusy(operationId);
    try {
      if (action === 'discard' && !await confirmDialog({
        headline: t('conflictRecovery.discardTitle'),
        description: t('conflictRecovery.discardDescription'),
        confirmText: t('conflictRecovery.discardConfirm'), danger: true,
      })) return;
      await resolveLearningCommand(operationId, action);
      await load();
      toast.success(action === 'retry' ? t('conflictRecovery.retried') : t('conflictRecovery.discarded'));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const discardAll = async () => {
    if (!rows.length) return;
    if (!await confirmDialog({
      headline: t('conflictRecovery.discardAllTitle', { count: rows.length }),
      description: t('conflictRecovery.discardAllDescription'),
      confirmText: t('conflictRecovery.discardAllConfirm'), danger: true,
    })) return;
    setBusy('all');
    try {
      const database = db, owner = cloud.userId;
      await cloudTransaction(database, [database.table('_learningCommands'), database.table('_cloudMeta')], async () => {
        for (const row of rows) {
          await database.table('_learningCommands').where('operationId').equals(row.operationId).delete();
          await database.table('_cloudMeta').put({ id: `learning-discarded:${row.operationId}`, value: { request: row.request, entities: row.entities, discardedAt: Date.now() } });
        }
      });
      if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
      await load();
      toast.success(t('conflictRecovery.discarded'));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const retryAll = async () => {
    setBusy('all');
    try {
      for (const row of rows) await resolveLearningCommand(row.operationId, 'retry');
      await load();
      toast.success(t('conflictRecovery.retried'));
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportDrafts = async () => {
    setBusy('export');
    try {
      const { encodeRecoveryValue } = await import('./recovery-export');
      const encoded = await encodeRecoveryValue(rows);
      const url = URL.createObjectURL(new Blob([JSON.stringify(encoded, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = `wangke-conflict-${Date.now()}.json`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } finally { setBusy(null); }
  };

  if (!rows.length) return <p className="text-sm text-muted">{t('conflictRecovery.empty')}</p>;

  return (
    <div className="flex flex-col gap-3" data-testid="cloud-conflict-recovery">
      {rows.map(row => (
        <div key={row.operationId} className="flex flex-col gap-1 rounded-lg border border-default p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{row.entities.join('、') || row.operationId}</span>
            <span className="text-xs text-muted">{new Date(row.createdAt).toLocaleString()}</span>
          </div>
          <p className="text-xs text-muted" role="status">{row.error ?? 'sync conflict'}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void resolve(row.operationId, 'discard')}>{t('conflictRecovery.keepCloud')}</Button>
            <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void resolve(row.operationId, 'retry')}>{t('conflictRecovery.keepLocal')}</Button>
          </div>
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void retryAll()}>{t('conflictRecovery.keepAllLocal')}</Button>
        <Button size="sm" variant="secondary" isDisabled={busy !== null} onPress={() => void discardAll()}>{t('conflictRecovery.keepAllCloud')}</Button>
        <Button size="sm" variant="ghost" isDisabled={busy !== null} onPress={() => void exportDrafts()}>{t('conflictRecovery.exportDrafts')}</Button>
      </div>
    </div>
  );
}
