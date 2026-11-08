import { useState } from 'react';
import { Button, Card, ProgressBar } from '@heroui/react';
import { isActiveTask, useCloudActivity } from '../cloud/activityStore';
import { cloudRequest } from '../cloud/state';
import { toast } from '../ui';

/** Reuses the account's shared task subscription; no per-page polling. */
export default function BiliImportTasks() {
  const tasks = useCloudActivity(state => state.tasks);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [stopping, setStopping] = useState<Set<string>>(new Set());
  const imports = tasks?.filter(task => task.kind === 'bilibiliImport' && !hidden.has(task.id)).slice(0, 8) ?? [];
  if (!imports.length) return null;

  async function stop(id: string) {
    setStopping(current => new Set(current).add(id));
    try { await cloudRequest(`/tasks/${id}/cancel`, { method: 'POST' }); }
    catch { toast.error('未能取消导入，请重试'); }
    finally { setStopping(current => { const next = new Set(current); next.delete(id); return next; }); }
  }

  return <Card.Root variant="secondary" className="my-3 flex flex-col gap-3 p-3" aria-label="B 站后台导入" data-testid="bili-server-tasks">
    <h2 className="text-sm font-medium">B 站后台导入</h2>
    {imports.map(task => {
      const active = isActiveTask(task);
      const done = Number(task.progress?.done) || 0;
      const total = Number(task.progress?.total) || (Array.isArray(task.input.pages) ? task.input.pages.length : 0);
      const status = task.status === 'completed' ? '导入完成' : task.status === 'cancelled' ? '已取消' : task.status === 'interrupted' ? '服务器重启，导入已中断' : task.status === 'failed' ? '导入失败' : task.status === 'queued' ? '排队中' : '正在导入';
      return <div key={task.id} className="flex min-w-0 flex-col gap-1" data-testid="bili-server-task" data-task-id={task.id} data-status={task.status}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">{String(task.input.bvid)} · {status} · 已保存 {done}/{total}</span>
          {active ? <Button size="sm" variant="ghost" isDisabled={stopping.has(task.id)} onPress={() => void stop(task.id)}>取消导入</Button>
            : <Button size="sm" variant="ghost" onPress={() => setHidden(current => new Set(current).add(task.id))}>收起</Button>}
        </div>
        {active ? <>
          <span className="text-xs text-muted">{String(task.progress?.message ?? '服务器任务已提交，关闭页面不影响下载')}</span>
          <ProgressBar aria-label="B 站导入进度" maxValue={Math.max(1, total)} value={done} isIndeterminate={!done}>
            <ProgressBar.Track><ProgressBar.Fill /></ProgressBar.Track>
          </ProgressBar>
        </> : null}
        {task.error ? <p role="alert" className="break-words text-xs text-danger">{task.error}。已保存的视频会保留，请核对后仅重新选择未导入的集数。</p> : null}
        {Array.isArray(task.progress?.warnings) ? task.progress.warnings.map((warning, index) => <p key={index} className="text-xs text-warning">{String(warning)}</p>) : null}
      </div>;
    })}
  </Card.Root>;
}
