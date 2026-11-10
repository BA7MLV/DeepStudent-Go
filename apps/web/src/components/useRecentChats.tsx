import { useEffect, useMemo, useRef, useState } from 'react';
import Dexie, { liveQuery } from 'dexie';
import { useNavigate } from 'react-router-dom';
import { db } from '../store/db';
import { databaseNotice } from '../store/database-lifecycle';
import { useCourseChat } from '../store/courseChat';
import { popconfirm, promptDialog, Sym, toast } from '../ui';
import type { RecentItem } from '../ui/layout';
import { useTranslation } from 'react-i18next';
import { cloud } from '../cloud/state';
import { useRecentSessionIndex } from './useRecentSessionIndex';

/** 由共享布局持有查询和操作，切页不重挂；只有对话页显示当前会话高亮。 */
export function useRecentChats(showActive = false) {
  const { t } = useTranslation('interface');
  const navigate = useNavigate();
  const sessions = useCourseChat((s) => s.sessions);
  const activeId = useCourseChat((s) => s.activeId);
  const runningIds = useCourseChat((s) => s.runningIds);
  const awaitingIds = useCourseChat((s) => s.awaitingIds);
  const ready = useCourseChat((s) => s.ready);
  const serverIndex = useRecentSessionIndex(ready && cloud.enabled);
  const [activity, setActivity] = useState<Map<number, number> | null>(null);
  const [retryTick, setRetryTick] = useState(0);
  const failures = useRef(0);

  useEffect(() => {
    if (!ready || cloud.enabled) return;
    // 仅展示发送过消息的会话，后台回答和跨标签页更新也刷新排序。
    // 重试会删除再重建提问；两次读取必须来自同一快照，避免跨过中间的空态。
    const readActivity = () => db.transaction('r', db.chats, async () => new Map(await Promise.all(
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
    )));
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const subscription = liveQuery(readActivity).subscribe({
      next: (value) => {
        failures.current = 0;
        setActivity(value);
      },
      // 这是侧栏的后台查询，失败没有用户能执行的动作，不要弹「请刷新重试」。
      // WebKit 休眠标签页后会丢掉读事务的底层连接（UnknownError），下一次读取
      // 通常就恢复；连接本身被关掉（切换账户 / 本机库重开）则先重开再订阅。
      // liveQuery 出错后订阅即结束，所以这里静默重建，而不是把错误抛给用户。
      error: (error) => {
        console.error('[useRecentChats] 最近会话查询失败，正在自动重试', error);
        if (disposed) return;
        const delay = Math.min(500 * 2 ** failures.current, 30_000);
        failures.current += 1;
        retryTimer = setTimeout(() => {
          if (disposed) return;
          const resume = () => { if (!disposed) setRetryTick((tick) => tick + 1); };
          // 版本升级（update-required）时由 DatabaseNotice 负责让用户更新，
          // 这里不要抢着重开旧连接，等提示消失后下一轮自然会接上。
          if (db.isOpen() || databaseNotice()) resume();
          else void db.open().then(resume, resume);
        }, delay);
      },
    });
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      subscription.unsubscribe();
    };
  }, [sessions, ready, retryTick]);

  // 不改变 store 顺序：bootstrap 和删除后的落脚点依赖原有顺序。
  const recentSessions = useMemo(() => {
    if (cloud.enabled) {
      const rows = serverIndex.page?.sessions ?? [];
      const active = showActive ? sessions.find(session => session.id === activeId) : undefined;
      return active && !rows.some(row => row.id === activeId) ? [active, ...rows] : rows;
    }
    if (!activity && !(showActive && activeId != null)) return [];
    return sessions
    .filter((session) => (showActive && session.id === activeId) || (activity?.get(session.id!) ?? 0) > 0)
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned)
      || (activity?.get(b.id!) || b.createdAt) - (activity?.get(a.id!) || a.createdAt)
      || b.createdAt - a.createdAt || b.id! - a.id!);
  }, [sessions, activity, showActive, activeId, serverIndex.page]);

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
  return { label: t('recent.label'), items, loading: !ready || (cloud.enabled ? !serverIndex.page && serverIndex.loading : activity === null),
    ...(cloud.enabled ? { pagination: {
      previous: serverIndex.page?.previous ? serverIndex.previous : undefined,
      next: serverIndex.page?.next ? serverIndex.next : undefined,
      previousLabel: t('recent.previousPage'), nextLabel: t('recent.nextPage'),
      busy: serverIndex.loading, error: serverIndex.error ? t('recent.loadFailed') : undefined,
      retry: serverIndex.retry, retryLabel: t('recent.retry'),
    } } : {}) };
}
