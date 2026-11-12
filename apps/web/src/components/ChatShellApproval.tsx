import { memo, useEffect, useState } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useCourseChat } from '../store/courseChat';
import { cloud, cloudRequest } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { toast } from '../ui';

type Permission = { id: string; taskId: string; capability: string; arguments: string; status: string };

/** Only waiting-task membership is observed here, not streaming answer text.
 * The account permission model is shared with Settings; no polling loop. */
export default memo(function ChatShellApproval() {
  const waiting = useCourseChat(state => state.tasks.filter(task => task.kind === 'chat' && task.status === 'waiting_user').map(task => task.id).sort().join(','));
  return waiting ? <PendingShellApprovals key={waiting} taskIds={waiting} /> : null;
});

function PendingShellApprovals({ taskIds }: { taskIds: string }) {
  const { t } = useTranslation('common');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [error, setError] = useState('');
  const [resolving, setResolving] = useState<string>();
  useEffect(() => {
    let alive = true, off: (() => void) | undefined, release: (() => void) | undefined;
    const owner = cloud.userId, ids = new Set(taskIds.split(','));
    void serverRuntime(owner).then(runtime => {
      if (!alive || cloud.userId !== owner || !isCurrentServerRuntime(runtime)) return;
      const model = runtime.permissions();
      const refresh = () => {
        if (!alive || cloud.userId !== owner || !isCurrentServerRuntime(runtime)) return;
        const snapshot = model.getSnapshot();
        if (snapshot.status === 'ready') {
          const data = snapshot.data as unknown as { permissions: Permission[] };
          setPermissions(data.permissions.filter(p => p.capability === 'shell' && p.status === 'pending' && ids.has(p.taskId)));
          setError('');
        } else if (snapshot.status === 'error') setError(t('chatShell.loadFailed'));
      };
      off = model.subscribe(refresh); release = model.acquire(); refresh();
    }).catch(() => { if (alive) setError(t('chatShell.loadFailed')); });
    return () => { alive = false; off?.(); release?.(); };
  }, [taskIds, t]);

  const resolve = async (id: string, approved: boolean) => {
    setResolving(id);
    try {
      await cloudRequest(`/permissions/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ approved }) });
      setPermissions(current => current.filter(p => p.id !== id));
    } catch (error) { toast.error((error as Error).message); }
    finally { setResolving(undefined); }
  };

  if (error) return <p role="alert" className="text-sm text-danger">{error}</p>;
  return <>{permissions.map(permission => {
    let args: { description?: string; command?: string; network?: boolean; timeoutSeconds?: number };
    try { args = JSON.parse(permission.arguments); } catch { return null; }
    return <section key={permission.id} data-testid="chat-shell-approval" aria-label={t('chatShell.title')}
      className="relative flex max-h-72 flex-col gap-2 overflow-auto rounded-xl bg-background-secondary p-3">
      <p className="text-sm font-medium">{t('chatShell.title')}</p>
      <p className="text-sm">{args.description}</p>
      <p className="text-xs text-muted-foreground">{t('chatShell.scope', { network: t(args.network ? 'chatShell.networkOn' : 'chatShell.networkOff'), seconds: args.timeoutSeconds })}</p>
      <details><summary className="cursor-pointer text-xs">{t('chatShell.command')}</summary>
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs">{args.command}</pre>
      </details>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" isDisabled={resolving != null} data-testid="chat-shell-reject" onPress={() => void resolve(permission.id, false)}>{t('chatShell.reject')}</Button>
        <Button size="sm" variant="primary" isDisabled={resolving != null} data-testid="chat-shell-approve" onPress={() => void resolve(permission.id, true)}>{t('chatShell.approve')}</Button>
      </div>
    </section>;
  })}</>;
}
