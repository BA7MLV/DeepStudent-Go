import { useEffect, useState } from 'react';
import type { TaskModelSelection } from '@wangke/contracts/cloud';
import ModelPicker from './ModelPicker';
import { useSettings } from '../store/settings';
import { taskModelKey, useTaskModel } from '../store/taskModel';
import { db } from '../store/db';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { toast } from '../ui';

export default function TaskModelPicker({ sessionId, onClose }: { sessionId: number | string | null; onClose?: () => void }) {
  const key = taskModelKey(sessionId), choice = useTaskModel(s => s.choices[key]), set = useTaskModel(s => s.set);
  const account = useSettings(s => s.llmModel);
  const [sessionDefault, setSessionDefault] = useState<TaskModelSelection | null>(null);
  useEffect(() => {
    let current = true;
    setSessionDefault(null);
    if (typeof sessionId === 'number') void db.chatSessions.get(sessionId).then(row => { if (current) setSessionDefault(row?.defaultModel ?? null); });
    else if (typeof sessionId === 'string' && cloud.userId) void serverRuntime(cloud.userId).then(r => r.delegation({ action: 'bot.read', threadId: sessionId })).then(value => { if (current) setSessionDefault((value as any).defaultModel ?? null); }).catch(() => {});
    return () => { current = false; };
  }, [key, sessionId]);
  const saveDefault = async () => {
    if (sessionId == null || !choice) return;
    const owner = cloud.userId, database = db;
    try {
      const runtime = await serverRuntime(owner);
      if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      await runtime.delegation(typeof sessionId === 'number' ? { action: 'session.default', sessionId, expected: sessionDefault, value: choice } : { action: 'bot.default', threadId: sessionId, expected: sessionDefault, value: choice });
      if (owner !== cloud.userId || database !== db || !isCurrentServerRuntime(runtime) || runtime.signal.aborted) return;
      setSessionDefault(choice); set(key); toast.success('已设为本会话默认，已受理任务不变');
    } catch { toast.error('会话默认模型保存失败，请刷新后重试'); }
  };
  return <div className="flex flex-wrap items-center gap-1" data-testid="task-model-selection">
    {choice && <span className="text-xs">本次模型</span>}
    <ModelPicker slot="chat" field="llmModel" variant="chip" showThinking onClose={onClose} value={choice?.modelRef ?? sessionDefault?.modelRef ?? account} onChange={modelRef => set(key, { modelRef })} />
    {choice && <button type="button" className="text-xs" onClick={() => set(key)}>继承会话默认</button>}
    {sessionId != null && choice ? <button type="button" className="text-xs" onClick={() => void saveDefault()}>设为本会话默认</button> : null}
  </div>;
}
