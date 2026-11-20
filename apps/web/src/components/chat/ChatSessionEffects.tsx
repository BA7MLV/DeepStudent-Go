import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { liveQuery } from 'dexie';
import { db, type ChatSessionRow, type ChatToolCall } from '../../store/db';
import { appendConversationSession, readConversationSession } from '../../store/conversationProducts';
import { followServerSession } from '../../client/session';
import { serverRuntime } from '../../client/bootstrap';
import { cloud } from '../../cloud/state';
import { accountLifecycle } from '../../client/account-lifecycle';
import { materialBlocksSnapshotExist } from '../../client/material-blocks';
import { systemMaterialPath } from '../../materials/systemFiles';
import { responsePhase } from '../../utils/responseProcess';
import type { UnitKind } from '../../materials/units.ts';
import { displayChatError } from '../../utils/chatError';
import { useRecentSessionIndex } from '../useRecentSessionIndex';
import { isTaskUnfinished } from '@wangke/contracts/task-status';
import type { ResponseSegment, SessionIndexPage } from '@wangke/contracts/client-runtime';
import type { WidgetPayload } from '../../harness/widgetRuntime';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 会话侧的一切异步：本地会话列表、历史分页、服务端一轮问答的跟随。
 *
 * 这几段 effect 共享同一组 ref（本地请求标记 / 分页请求闸 / 跟随器）和同一份
 * `activeId`，并对「谁先订阅、谁后收尾」有顺序要求 —— 所以整块搬成一个组件，
 * 按原顺序声明、按原依赖触发：挂载与清理时序与内联在面板里时完全一致。
 * 组件本身不渲染任何东西，只把这些副作用接回面板。
 */

/** 面板与 effect 之间共用的可变句柄（调用方在渲染期同步更新，见 ChatPanelBody）。 */
export interface SessionEffectRefs {
  /** 本地发送（配合流式回调）进行中：跟随器此时不覆盖消息，避免本地与云端两份互相打架 */
  localRequest: React.RefObject<boolean>;
  /** 分页请求进行中：翻页按钮与触底加载共用同一个闸 */
  historyRequest: React.RefObject<boolean>;
  /** 当前会话 id 的镜像：异步回来后要先确认「用户没切走」才写状态 */
  historySession: React.RefObject<number | null>;
  /** 服务端跟随器的刷新句柄：一轮本地问答结束后拉一次最终投影 */
  qaFollower: React.RefObject<{ refresh: () => void } | undefined>;
}

export function ChatSessionEffects({
  videoId,
  activeId,
  isMaterial,
  materialKind,
  indexAttempt,
  sessionIndex,
  refs,
  setSessions,
  setActiveId,
  setSkillIds,
  setMcpServerIds,
  setTurnSkillIds,
  setMsgs,
  setHasOlder,
  setLoadingOlder,
  setHistoryError,
  setLoading,
  setLoadedSessionId,
  setIndexReady,
  setIndexNote,
  setIndexFailure,
}: {
  videoId: string;
  activeId: number | null;
  isMaterial: boolean;
  materialKind: UnitKind | undefined;
  indexAttempt: number;
  /** 面板持有的会话索引订阅（与工具条共用，这里只读它投影出的列表） */
  sessionIndex: ReturnType<typeof useRecentSessionIndex>;
  refs: SessionEffectRefs;
  setSessions: (update: React.SetStateAction<ChatSessionRow[]>) => void;
  setActiveId: (id: number | null) => void;
  setSkillIds: (ids: number[] | undefined) => void;
  setMcpServerIds: (ids: string[] | undefined) => void;
  setTurnSkillIds: (ids: number[]) => void;
  setMsgs: (update: React.SetStateAction<ChatMsg[]>) => void;
  setHasOlder: (value: boolean) => void;
  setLoadingOlder: (value: boolean) => void;
  setHistoryError: (value: boolean) => void;
  setLoading: (value: boolean) => void;
  setLoadedSessionId: (id: number | null) => void;
  setIndexReady: (value: boolean) => void;
  setIndexNote: (note: string | null) => void;
  setIndexFailure: (value: boolean) => void;
}) {
  const { t: chatText } = useTranslation('common');
  const { localRequest, historyRequest, historySession, qaFollower } = refs;

  /**
   * 初始化会话列表 + 判断「能不能提问」。
   *
   * 2026-09-24：检索改为词法后，这里**不再有建索引这一步**。原来是一段
   * 「查向量计数 → 缺就建 → 建好才置 indexReady」的流程，也带来过一整类 bug
   * （索引过期后计数仍然达标，于是永远不重建）。没有索引就没有这些问题。
   * 现在只检查有没有可检索的正文以显示提示；没有字幕也允许提问。
   */
  useEffect(() => {
    let cancelled = false;
    const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
    const current = () => !cancelled && database === db && owner === cloud.userId && (!lifetime || lifetime.current());
    setIndexReady(false);
    setIndexFailure(false);
    setIndexNote(null);
    (async () => {
      let list: ChatSessionRow[];
      let readiness: { hasMaterialText: boolean; hasSubtitles: boolean } | undefined;
      if (cloud.enabled) {
        const runtime = await serverRuntime(owner);
        if (!current()) return;
        const [response, content] = await Promise.all([
          runtime.read({ kind: 'sessionIndex', videoId, archived: false, recentOnly: false }),
          systemMaterialPath(videoId) ? undefined : runtime.read({ kind: 'courseReadiness', videoId }),
        ]);
        if (!current()) return;
        readiness = content?.value as unknown as typeof readiness;
        const index = response.value as unknown as SessionIndexPage;
        list = index.sessions.map(row => ({ id: row.id, videoId: row.videoId, title: row.title, createdAt: row.createdAt }));
        if (index.latestId != null && !list.some(row => row.id === index.latestId)) {
          const latest = await readConversationSession(index.latestId);
          if (latest) list.push(latest);
        }
        list.sort((a, b) => a.createdAt - b.createdAt || a.id! - b.id!);
      } else list = await db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt');
      if (!current()) return;
      if (list.length === 0) {
        const now = Date.now();
        const id = await appendConversationSession({ videoId, title: '新会话', createdAt: now });
        list = [{ id, videoId, title: '新会话', createdAt: now }];
      }
      if (!current()) return;
      setSessions(list);
      setActiveId(list[list.length - 1].id!);

      if (systemMaterialPath(videoId)) {
        setIndexNote(null);
        setIndexReady(true);
        return;
      }
      if (readiness) {
        setIndexNote(isMaterial
          ? readiness.hasMaterialText ? null : chatText(materialKind === 'page' ? 'chatPanel.noSearchText' : 'chatPanel.noSearchBody')
          : readiness.hasSubtitles ? null : chatText('chatPanel.noSubtitlesYet'));
        setIndexReady(true);
        return;
      }
      // ── 阅读材料：检索的是文本块（materialBlocks）──
      if (isMaterial) {
        const hasBlocks = await materialBlocksSnapshotExist(videoId, () => { if (!current()) throw new Error('material_read_cancelled'); });
        if (!current()) return;
        // 没有可检索文字也能读取图片目录、展示原图或框选提问，不能把整个聊天锁死。
        if (!hasBlocks) {
          setIndexNote(
            materialKind === 'page'
              ? chatText('chatPanel.noSearchText')
              : chatText('chatPanel.noSearchBody'),
          );
          setIndexReady(true);
          return;
        }
        setIndexNote(null);
        setIndexReady(true);
        return;
      }

      const segCount = await db.segments
        .where('videoId')
        .equals(videoId)
        .filter((r) => r.status === 1 && !!r.text)
        .count();
      if (!current()) return;
      setIndexNote(segCount === 0
        ? chatText('chatPanel.noSubtitlesYet')
        : null);
      setIndexReady(true);
    })().catch(error => { if (current()) { setIndexNote(displayChatError(error instanceof Error ? error.message : String(error))); setIndexFailure(true); } });
    return () => {
      cancelled = true;
    };
  }, [videoId, isMaterial, indexAttempt]);

  // 切换会话时加载该会话的历史消息与技能范围
  useEffect(() => {
    if (activeId == null) {
      setMsgs([]);
      setSkillIds(undefined);
      setTurnSkillIds([]);
      setMcpServerIds(undefined);
      return;
    }
    let cancelled = false;
    setTurnSkillIds([]);
    setMsgs([]);
    setHasOlder(false);
    setLoadingOlder(false);
    setHistoryError(false);
    historyRequest.current = false;
    (async () => {
      // 技能范围从库里现查而不是读 sessions state：会话行可能刚被别处改过，
      // 且这样 effect 只依赖 activeId，不会因为 sessions 数组变化而重载整个历史。
      const row = await readConversationSession(activeId);
      if (!cancelled) setSkillIds(row?.skillIds);
      if (!cancelled) setMcpServerIds(row?.mcpServerIds);
      if (!cancelled && row) setSessions(previous => [...previous.filter(item => item.id !== row.id).slice(-50), row]);
    })().catch(() => { if (!cancelled) setHistoryError(true); });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // A server-owned QA turn may originate on another device, or outlive this panel.
  useEffect(() => {
    let cancelled = false;
    let requested = 0;
    const refresh = async (page: Parameters<Parameters<typeof followServerSession>[1]['changed']>[0]) => {
      if (localRequest.current) return;
      const task = page.tasks.find(t => t.kind === 'qa' && t.input.sessionId === activeId);
      const revision = ++requested;
      const current = () => !cancelled && revision === requested && !localRequest.current;
      if (activeId == null) return;
      const running = task && isTaskUnfinished(task.status);
      if (running && !await (await import('../../cloud/tasks')).syncTaskWidgets(task.progress)) return;
      const messages: ChatMsg[] = page.rows.filter(row => !running || row.taskId !== task.id || row.role !== 'assistant')
        .map(row => ({ ...row, key: `h-${row.id}`, rowId: row.id, role: row.role === 'user' ? 'user' : 'ai' }));
      if (running) messages.push({ key: `cloud-${task.id}`, taskId: task.id, role: 'ai', content: String(task.progress?.content ?? ''), reasoning: String(task.progress?.reasoning ?? ''),
        rowId: typeof task.progress?.rowId === 'number' ? task.progress.rowId : undefined,
        tools: Array.isArray(task.progress?.tools) ? task.progress.tools as unknown as ChatToolCall[] : undefined,
        responseSegments: task.progress?.responseSegments as ResponseSegment[] | undefined,
        processPhase: responsePhase(task.progress?.phase), processStartedAt: Date.parse(task.createdAt),
        widgets: Array.isArray(task.progress?.widgets) ? task.progress.widgets as unknown as WidgetPayload[] : undefined,
        widgetPreview: task.progress?.widgetPreview as { html: string } | undefined, streaming: true });
      else if (task && ['failed', 'interrupted', 'cancelled'].includes(task.status)) messages.push({ key: `cloud-${task.id}`, role: 'ai', content: task.error || chatText('chatPanel.taskStopped') });
      // Reconciliation must not remount an already opened iframe when the
      // in-flight message becomes a synced history row.
      setMsgs(current => messages.map(message => {
        const existing = current.find(item => item.role === message.role && (
          message.rowId != null && item.rowId === message.rowId || message.taskId && item.taskId === message.taskId));
        return existing ? { ...message, key: existing.key } : message;
      }));
      setHasOlder(page.hasOlder); setLoading(Boolean(running)); setLoadedSessionId(activeId);
    };
    // Metadata changes do not read/serialize message bodies. One shared journal
    // owns the loaded window, pagination fences, deletes and task checkpoints.
    const records = cloud.enabled ? undefined : liveQuery(() => db.chatSessions.where('videoId').equals(videoId).sortBy('createdAt')).subscribe({
      next: list => { if (!cancelled) setSessions(list); },
      error: () => { if (!cancelled) setHistoryError(true); },
    });
    const follower = activeId == null ? undefined : followServerSession(activeId, {
      changed: refresh,
      failed: () => { if (!cancelled) setHistoryError(true); },
    });
    qaFollower.current = follower;
    return () => { cancelled = true; follower?.(); if (qaFollower.current === follower) qaFollower.current = undefined; records?.unsubscribe(); };
  }, [activeId, videoId]);

  // 云端分页投影：会话下拉的页码来自这里
  useEffect(() => {
    if (!cloud.enabled || !sessionIndex.page) return;
    setSessions(previous => {
      const rows: ChatSessionRow[] = sessionIndex.page!.sessions.map(row => ({ id: row.id, videoId: row.videoId, title: row.title, createdAt: row.createdAt, pinned: row.pinned, archived: row.archived }));
      const active = previous.find(row => row.id === activeId);
      if (active && !rows.some(row => row.id === activeId)) rows.push(active);
      return rows.sort((a, b) => a.createdAt - b.createdAt || a.id! - b.id!);
    });
  }, [sessionIndex.page, activeId]);
  return null;
}
