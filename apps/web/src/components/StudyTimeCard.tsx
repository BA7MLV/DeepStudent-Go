import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Switch, ToggleButton, ToggleButtonGroup } from '@heroui/react';
import { SectionCard, Field, confirmDialog, toast } from '../ui';
import { useSettings } from '../store/settings';
import { clearStudyDays, loadStudySnapshot, useStudyTime } from '../store/studyTime';
import { computeStats, dateKey, formatStudyDuration } from '../utils/studyLog';
import { NumberPop, Shimmer } from './motion';
import { db } from '../store/db';
import { accountLifecycle, type AccountLifetime } from '../client/account-lifecycle';

/** 空闲判定的候选档位（分钟）：播放视频时不做空闲判定，所以这几档只影响「没在播放」的时候 */
const IDLE_OPTIONS = [2, 5, 10, 15];

/** 设置页「学习时长」卡片：开关 / 空闲判定 / 清空记录 + 一眼看得到的总账 */
export default function StudyTimeCard() {
  const settings = useSettings();
  const flushCount = useStudyTime((s) => s.flushCount);
  const [summary, setSummary] = useState<{ days: number; total: number } | null>(null);
  const [snapshot, setSnapshot] = useState<{ date: string; seconds: number; updatedAt: number }[]>([]);
  const [clearing, setClearing] = useState(false);
  const [clearError, setClearError] = useState('');
  const snapshotScope = useRef<{ lifetime: AccountLifetime; database: typeof db } | undefined>(undefined);

  const reload = useCallback(async () => {
    const lifetime = accountLifecycle.current(), database = db;
    if (!lifetime?.current()) return;
    const days = await loadStudySnapshot();
    if (!lifetime.current() || database !== db) return;
    snapshotScope.current = { lifetime, database };
    setSnapshot(days);
    const stats = computeStats(days, dateKey(Date.now()));
    setSummary({ days: stats.activeDays, total: stats.totalSeconds });
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, flushCount]);

  const askClear = () => {
    const lifetime = accountLifecycle.current(), database = db;
    const current = () => !!lifetime?.current() && database === db;
    if (!current() || snapshotScope.current?.lifetime !== lifetime || snapshotScope.current?.database !== database) return;
    const expected = snapshot.map(row => ({ ...row }));
    void confirmDialog({
      headline: '清空学习时长记录？',
      description: '每日热力图数据会全部删除，不可恢复（课程、字幕、讲义等其它数据不受影响）',
      confirmText: '清空',
      danger: true,
    }).then(async (ok) => {
      if (!ok || !current()) return;
      setClearing(true); setClearError('');
      try {
        await clearStudyDays(expected);
        if (!current()) return;
        await reload();
        if (!current()) return;
        toast.success('学习时长记录已清空');
      } catch (error) {
        if (!current()) return;
        const message = `学习时长尚未清空：${error instanceof Error ? error.message : String(error)}。原计时和待提交操作已保留，请核对最新记录。`;
        setClearError(message); toast.error(message);
        await reload();
      } finally { if (current()) setClearing(false); }
    });
  };

  return (
    <SectionCard
      title="学习时长"
      testId="card-study-time"
    >
      <Field
        label="自动记录"
        layout="row"
        testId="field-study-tracking"
      >
        <Switch
          isSelected={settings.studyTrackingEnabled}
          onChange={(on) => settings.update({ studyTrackingEnabled: on })}
          data-testid="study-tracking"
          aria-label="自动记录学习时长"
        >
          <Switch.Content>
            <Switch.Control>
              <Switch.Thumb />
            </Switch.Control>
          </Switch.Content>
        </Switch>
      </Field>

      <Field
        label="多久没操作算离开"
        layout="row"
        testId="field-study-idle"
      >
        {/* mdui-segmented-button-group 的 selects="single" → ToggleButtonGroup 的
            selectionMode="single"；选中项用 selectedKeys 单选数组表达（值是字符串 key）。 */}
        <ToggleButtonGroup
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[String(settings.studyIdleMinutes)]}
          onSelectionChange={(keys) => {
            const next = Number([...keys][0]);
            if (Number.isFinite(next)) settings.update({ studyIdleMinutes: next });
          }}
          aria-label="多久没操作算离开"
          data-testid="study-idle"
        >
          {IDLE_OPTIONS.map((m) => (
            <ToggleButton key={m} id={String(m)}>
              {m} 分钟
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Field>

      <Field label="已有记录" layout="row" testId="field-study-summary">
        <div className="flex w-full flex-nowrap items-start justify-between gap-3">
          <span className="text-muted" data-testid="study-summary">
            {summary ? (
              <>
                活跃 <NumberPop text={summary.days} /> 天 · 累计{' '}
                <NumberPop text={formatStudyDuration(summary.total)} />
              </>
            ) : (
              /* shimmer-text：纯 CSS 的高亮扫过，占位文案因此「有生命」，
                 不用再叠一个转圈 */
              <Shimmer text="读取中…" />
            )}
          </span>
          <Button
            variant="tertiary"
            data-testid="study-clear"
            isDisabled={!summary || clearing}
            onPress={askClear}
          >
            清空记录
          </Button>
        </div>
      </Field>
      {clearError && <p role="alert" data-testid="study-clear-error">{clearError}</p>}
    </SectionCard>
  );
}
