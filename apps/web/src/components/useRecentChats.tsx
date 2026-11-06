import { useEffect, useMemo, useState } from 'react';
import Dexie, { liveQuery } from 'dexie';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { useCourseChat } from '../store/courseChat';
import { popconfirm, promptDialog, Sym, toast } from '../ui';
import type { RecentItem } from '../ui/layout';
import { useTranslation } from 'react-i18next';

/** 由共享布局持有查询和操作，切页不重挂；只有对话页显示当前会话高亮。 */
export function useRecentChats(showActive = false) {
  const { t } = useTranslation('interface');
  const navigate = useNavigate();
  const sessions = useCourseChat((s) => s.sessions);
  const activeId = useCourseChat((s) => s.activeId);
  const runningIds = useCourseChat((s) => s.runningIds);
  const awaitingIds = useCourseChat((s) => s.awaitingIds);
  const ready = useCourseChat((s) => s.ready);
  const [activity, setActivity] = useState<Map<number, number> | null>(null);

  useEffect(() => {
    if (!ready) return;
    // 仅展示发送过消息的会话，后台回答和跨标签页更新也刷新排序。
    // 重试会删除再重建提问；两次读取必须来自同一快照，避免跨过中间的空态。
    const subscription = liveQuery(() => db.transaction('r', db.chats, async () => new Map(await Promise.all(
      sessions.filter((session) => session.id != null).map(async (session) => {
        const query = () => db.chats.where('[sessionId+createdAt+id]').between(
          [session.id!, Dexie.minKey, Dexie.minKey],
          [session.id!, Dexie.maxKey, Dexie.maxKey],
        ).reverse();
        const [user, latest] = await Promise.all([
          query().filter((message) => message.role === 'user').first(),
          query().first(),
        ]);
        return [session.id!, user ? (latest?.createdAt ?? user.createdAt) : 0] as const;
      }),
    )))).subscribe({
      next: setActivity,
      error: (error) => {
        console.error('[useRecentChats] 最近会话查询失败', error);
        toast.error(t('recent.loadFailed'));
      },
    });
    return () => subscription.unsubscribe();
  }, [sessions, ready, t]);

  // 不改变 store 顺序：bootstrap 和删除后的落脚点依赖原有顺序。
  const recentSessions = useMemo(() => {
    if (!activity && !(showActive && activeId != null)) return [];
    return sessions
    .filter((session) => (showActive && session.id === activeId) || (activity?.get(session.id!) ?? 0) > 0)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
      || (activity?.get(b.id!) || b.createdAt) - (activity?.get(a.id!) || a.createdAt)
      || b.createdAt - a.createdAt || b.id! - a.id!);
  }, [sessions, activity, showActive, activeId]);

  const remove = async (id: number, title: string) => {
    const ok = await popconfirm({
      headline: t('recent.deleteTitle', { title }),
      description: t('recent.deleteDescription'),
      confirmText: t('recent.delete'), danger: true, testId: 'recent-delete-popconfirm',
    });
    if (ok) await useCourseChat.getState().deleteSessionById(id);
  };
  const rename = async (id: number, title: string) => {
    const next = await promptDialog({
      headline: t('recent.renameTitle'),
      description: t('recent.renameDescription'),
      defaultValue: title, placeholder: t('recent.placeholder'), confirmText: t('recent.save'),
      validate: (value) => value.length > 60 ? t('recent.tooLong') : null,
    });
    if (next) await useCourseChat.getState().renameSession(id, next);
  };
  const archive = async (id: number, title: string) => {
    await useCourseChat.getState().setArchived(id, true);
    toast.info(t('recent.archived', { title }));
  };
  const fork = async (id: number) => {
    const newId = await useCourseChat.getState().forkSession(id);
    if (newId == null) toast.warning(t('recent.emptyFork'));
    else {
      toast.success(t('recent.forked'));
      if (!showActive) navigate('/');
    }
  };

  const items: RecentItem[] = recentSessions.map((session) => {
    const id = session.id!;
    const busy = runningIds.includes(id);
    const pin = () => void useCourseChat.getState().setPinned(id, !session.pinned);
    return {
      id: String(id), label: session.title,
      active: showActive && id === activeId,
      pendingReply: busy && !awaitingIds.includes(id),
      pinned: !!session.pinned,
      onUnpin: () => void useCourseChat.getState().setPinned(id, false),
      onClick: () => {
        void useCourseChat.getState().loadSession(id);
        if (!showActive) navigate('/');
      },
      testId: `chat-recent-${id}`,
      menu: [
        { key: 'rename', label: t('recent.rename'), icon: <Sym name="edit" />, onAction: () => void rename(id, session.title) },
        { key: 'pin', label: t(session.pinned ? 'recent.unpin' : 'recent.pin'), icon: <Sym name={session.pinned ? 'pin_off' : 'pin'} />, onAction: pin },
        { key: 'fork', label: t('recent.fork'), icon: <Sym name="fork" />, isDisabled: busy, onAction: () => void fork(id) },
        { key: 'archive', label: t('recent.archive'), icon: <Sym name="archive" />, isDisabled: busy, onAction: () => void archive(id, session.title) },
        { key: 'delete', label: t('recent.delete'), icon: <Sym name="delete" />, danger: true, isDisabled: busy, onAction: () => void remove(id, session.title) },
      ],
      onDelete: () => void remove(id, session.title),
      deleteLabel: t('recent.deleteLabel', { title: session.title }),
      deleteTestId: `chat-recent-delete-${id}`,
      deleteDisabled: busy,
    };
  });
  return { label: t('recent.label'), items, loading: !ready || activity === null };
}
