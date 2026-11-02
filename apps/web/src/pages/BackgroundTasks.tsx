import { useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { CloudTask } from '@wangke/contracts/cloud';
import { cloud, cloudRequest } from '../cloud/state';
import { isActiveTask, useCloudActivity } from '../cloud/activityStore';
import { PageLoader, PageShell, SectionCard, toast } from '../ui';

function TaskRow({ task }: { task: CloudTask }) {
  const { t, i18n } = useTranslation('common');
  const [stopping, setStopping] = useState(false);
  const title = t(`backgroundTasks.kinds.${task.kind}`, { defaultValue: t('backgroundTasks.task') });
  const source = task.source?.kind === 'bot'
    ? task.source.name ? t('backgroundTasks.fromNamedBot', { name: task.source.name }) : t('backgroundTasks.fromBot')
    : task.source?.kind === 'app' ? t('backgroundTasks.fromApp') : t('backgroundTasks.unknownSource');
  const message = typeof task.progress?.message === 'string' ? task.progress.message : '';
  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await cloudRequest(`/tasks/${task.id}/cancel`, { method: 'POST' });
      // The shared poller remains authoritative; do not restore a stale snapshot.
      useCloudActivity.setState(state => ({ tasks: state.tasks?.map(row => row.id === task.id && isActiveTask(row) ? { ...row, status: 'cancelled' } : row) ?? null }));
    } catch {
      toast.error(t('backgroundTasks.stopFailed'));
    } finally {
      setStopping(false);
    }
  };
  return <li className="flex min-w-0 flex-wrap items-start gap-3 py-3" data-testid={`background-task-${task.id}`}>
    <div className="min-w-0 flex-1 basis-48 space-y-1">
      <p className="break-words font-medium">{title}{task.resourceName ? ` · ${task.resourceName}` : ''}</p>
      <p className="text-sm text-muted-foreground">{t(`backgroundTasks.status.${task.status}`)} · {source}</p>
      {message && message !== title ? <p className="break-words text-sm text-muted-foreground">{message}</p> : null}
      {task.error ? <p className="break-words text-sm text-danger">{task.error}</p> : null}
      <time className="block text-xs text-muted-foreground" dateTime={task.createdAt}>{new Date(task.createdAt).toLocaleString(i18n.language)}</time>
    </div>
    {isActiveTask(task) ? <Button size="sm" variant="secondary" isDisabled={stopping} aria-label={t('backgroundTasks.stopTask', { title })} onPress={() => void stop()}>{t(stopping ? 'backgroundTasks.stopping' : 'backgroundTasks.stop')}</Button> : null}
  </li>;
}

export default function BackgroundTasks() {
  const { t } = useTranslation('common');
  const tasks = useCloudActivity(s => s.tasks);
  const unavailable = useCloudActivity(s => s.unavailable);
  const active = tasks?.filter(isActiveTask) ?? [];
  const recent = tasks?.filter(task => !isActiveTask(task)) ?? [];
  return <PageShell title={t('backgroundTasks.title')} narrow>
    <div className="space-y-4" data-testid="background-tasks">
      <p className="text-sm text-muted-foreground">{t('backgroundTasks.description')}</p>
      {unavailable ? <p role="alert" className="text-sm text-danger">{t('backgroundTasks.unavailable')}</p> : null}
      {!cloud.enabled ? <p>{t('backgroundTasks.cloudOnly')}</p> : tasks === null ? unavailable ? null : <PageLoader label={t('backgroundTasks.loading')} /> : <>
        <SectionCard title={t('backgroundTasks.active')} testId="background-tasks-active">
          {active.length ? <ul className="divide-y divide-border">{active.map(task => <TaskRow key={task.id} task={task} />)}</ul> : <p className="text-sm text-muted-foreground">{t('backgroundTasks.empty')}</p>}
        </SectionCard>
        <SectionCard title={t('backgroundTasks.recent')} testId="background-tasks-recent">
          {recent.length ? <ul className="divide-y divide-border">{recent.map(task => <TaskRow key={task.id} task={task} />)}</ul> : <p className="text-sm text-muted-foreground">{t('backgroundTasks.noHistory')}</p>}
        </SectionCard>
      </>}
    </div>
  </PageShell>;
}
