import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cloud } from './state';
import { useCloudSync } from './sync';
import { reflectCloudTasks, refreshConversationIndex } from '../store/courseChat';
import { useLibraryRevision } from '../pipelines/folderPlan';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { useJobStore } from '../store/jobs';
import { useCloudActivity } from './activityStore';
import { usePendingTaskCommands, retryPendingTaskCommand } from './tasks';
import FileIntentRecovery from './FileIntentRecovery';
import PreferenceRecovery from './PreferenceRecovery';
import LearningRecovery from './LearningRecovery';
import ResourceSaveNotice from './ResourceSaveNotice';
import { useSustained } from './quiet';
import './activity.css';

export default function CloudActivity() {
  const { t } = useTranslation('settings', { keyPrefix: 'recovery' });
  const error = useCloudSync(s => s.error);
  const syncedAt = useCloudSync(s => s.syncedAt);
  const [online, setOnline] = useState(() => navigator.onLine);
  const commands = usePendingTaskCommands(s => s.commands);
  const [retrying, setRetrying] = useState<string>();
  const [retryError, setRetryError] = useState('');
  useEffect(() => {
    const changed = () => setOnline(navigator.onLine);
    window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { window.removeEventListener('online', changed); window.removeEventListener('offline', changed); };
  }, []);
  useEffect(() => {
    if (!cloud.enabled) return;
    const account = cloud.userId;
    let stopped = false, dirty = true, off: (() => void) | undefined, release: (() => void) | undefined;
    let refresh = () => {};
    const changed = () => { dirty = true; useLibraryRevision.getState().bump(); };
    void serverRuntime(account).then(runtime => {
      if (stopped || account !== cloud.userId || !isCurrentServerRuntime(runtime)) return;
      const model = runtime.tasks();
      let busy = false, pending = false;
      const current = () => !stopped && account === cloud.userId && isCurrentServerRuntime(runtime);
      refresh = () => {
        pending = true;
        if (busy || !current()) return;
        busy = true;
        void (async () => {
          while (pending && current()) {
            pending = false;
            const snapshot = model.getSnapshot();
            if (snapshot.status !== 'ready') {
              useCloudActivity.setState({ unavailable: snapshot.status === 'error' || snapshot.status === 'reconnecting' });
              continue;
            }
            const tasks = model.tasks();
            if (!tasks) continue;
            // Temporary adapters for existing chat/jobs consumers. The Model owns
            // task facts; cache invalidation can replay them without a server poll.
             const changedData = dirty; dirty = false;
            useCloudActivity.setState(state => ({ tasks, unavailable: false, dataRevision: state.dataRevision + (changedData ? 1 : 0) }));
            await reflectCloudTasks(tasks);
            if (!current()) return;
            const seen = new Set<string>();
            for (const task of tasks) {
              const id = task.input.videoId;
              if (typeof id !== 'string' || seen.has(id) || !['transcribe', 'material'].includes(task.kind)) continue;
              seen.add(id);
              useJobStore.getState().upsert(id, {
                ...(task.progress ?? {}), phase: task.status === 'completed' ? 'done' : task.status === 'failed' || task.status === 'interrupted' ? 'error' : task.status === 'cancelled' ? 'canceled' : (task.progress?.phase as any) ?? 'queued',
                message: task.error ?? String(task.progress?.message ?? task.status), error: task.error ?? undefined, resume: false,
              });
            }
          }
        })().catch(() => { if (current()) useCloudActivity.setState({ unavailable: true }); })
          .finally(() => { busy = false; if (pending && current()) refresh(); });
      };
      off = model.subscribe(refresh);
      release = model.acquire();
      refresh();
    }).catch(() => { if (!stopped) useCloudActivity.setState({ unavailable: true }); });
    const offCache = useCloudSync.subscribe((state, previous) => {
      if (state.recordsRevision !== previous.recordsRevision) changed();
      if (state.conversationsRevision !== previous.conversationsRevision) void refreshConversationIndex();
    });
    return () => {
      stopped = true;
      off?.(); release?.();
      offCache();
      useCloudActivity.setState({ tasks: null, unavailable: false });
    };
  }, []);
  const degraded = useCloudSync(s => s.degradedSince > 0);
  // Brief disconnects heal silently; only a lasting one is worth a glance.
  const showOffline = useSustained(!online, 3000);
  const showReconnecting = useSustained(online && degraded, 10000);
  if (!cloud.enabled) return null;
  // Fixed overlay, never in the page flow: a notice appearing or clearing must
  // not resize the chat viewport or move the composer under the user's finger.
  return <div className="cloud-activity" data-testid="cloud-activity">
    {showOffline || showReconnecting ? <p role="status" className="cloud-activity__status">
      <span className="cloud-activity__dot" aria-hidden="true" />
      {t(showOffline ? 'offline' : 'reconnecting')}{syncedAt ? ` ${t('lastConfirmed', { time: new Date(syncedAt).toLocaleString() })}` : ''}
    </p> : null}
    <FileIntentRecovery />
    <PreferenceRecovery />
    <LearningRecovery />
    <ResourceSaveNotice />
    {error ? <p role="alert" className="bg-surface p-3 text-danger">{error}</p> : null}
    {commands.map(({ command }) => <section key={command.operationId} role="alert" className="bg-surface p-3">
      <p>发送尚未确认。原命令已保留，未自动重复执行。</p>
      {typeof command.input.text === 'string' ? <p>{command.input.text.slice(0, 200)}</p> : null}
      <button type="button" disabled={!!retrying} onClick={() => {
        setRetrying(command.operationId); setRetryError('');
        void retryPendingTaskCommand(command.operationId).catch(error => setRetryError(error instanceof Error ? error.message : String(error)))
          .finally(() => setRetrying(undefined));
      }}>{retrying === command.operationId ? '正在核对…' : '核对收据并使用原命令重试'}</button>
    </section>)}
    {retryError ? <p role="alert" className="bg-surface p-3">{retryError}</p> : null}
  </div>;
}
