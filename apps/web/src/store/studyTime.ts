import { create } from 'zustand';
import { db } from './db';
import { addStudyTime, captureStudyTimeWriter, clearStudyTime } from '../client/learning';
import { useSettings } from './settings';
import { accountLifecycle, type AccountLifetime } from '../client/account-lifecycle';
import { cloud } from '../cloud/state';
import { mergeSeconds, round1, splitByDay, type StudyDay } from '../utils/studyLog';

/**
 * 学习（在线）时长追踪器。
 *
 * 语义：**页面可见 + 人在场** 的时间才计入。两个判据分别对付两类「假在线」：
 *   - 切到别的标签页 / 锁屏 / 把 App 收到后台 → `visibilityState !== 'visible'`，不计；
 *   - 页面开着人走开了 → 超过空闲阈值没有操作，不计。
 *
 * 关键的一条例外：**正在播放视频时不做空闲判定**。这条不是优化，是必须的 ——
 * 看两小时网课本就全程不需要碰键盘鼠标，按「有操作才算」会把最核心的使用场景全记成 0。
 * 播放态由播放页上报（`setStudyMediaPlaying`），暂停/播完即恢复普通空闲判定。
 *
 * 记账精度：15 秒一次心跳，把这段时长按**本地零点**切开累加到对应日期（跨零点不记错账）。
 * 心跳不直接写库：一次心跳一次 IndexedDB 事务在长时间学习下纯属浪费，
 * 因此在内存里攒着，每 4 次心跳（1 分钟）落一次库，并在页面隐藏 / 卸载时补落一次。
 * 正常一分钟持久化一次；账号释放时也把已测秒数写入原账号的私有命令日志。
 */

/** 心跳间隔。15s 是「精度」与「写入次数」的折中：1 分钟一落库，一小时 60 次事务 */
const TICK_MS = 15_000;

/**
 * 单次心跳最多计入的秒数。
 *
 * 设备睡眠 / 系统挂起 / 浏览器节流时定时器根本不会触发，醒来后的第一次心跳
 * `now - lastTick` 可能是几个小时 —— 那几个小时人不在（或设备不在），不能算学习。
 * 截断到 2 个心跳周期：正常节流（1 分钟）不会被误伤，真睡过去的时间也不会被补记。
 */
const MAX_TICK_MS = TICK_MS * 2;

/** 攒够几次心跳落一次库（15s × 4 = 1 分钟） */
const FLUSH_EVERY_TICKS = 4;

/** 算「有操作」的输入事件。pointermove / wheel 只为覆盖「只在页面上滑动阅读」的情况 */
const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const;

interface StudyTimeState {
  /**
   * 尚未落库的秒数（日期 → 秒）。页面把它叠加到库里的值上，才能看到**此刻**的今日时长；
   * 平时只有今天一个键，跨零点的那一分钟里会短暂出现两个。
   */
  pending: Record<string, number>;
  /** 落库次数。页面订阅它，每次 +1 就重读一次库 */
  flushCount: number;
  /** 追踪器是否已启动 */
  running: boolean;
  /** 此刻是否在计时（可见且未判空闲）。页面用它显示呼吸点 */
  counting: boolean;
}

export const useStudyTime = create<StudyTimeState>()(() => ({
  pending: {},
  flushCount: 0,
  running: false,
  counting: false,
}));

// ── 追踪器的模块级状态（刻意不放进 store：它们每 15 秒变一次，进 store 会引发无谓重渲染）──
let started = false;
let timer: number | undefined;
/** 上一次心跳的时刻；计时的起点 */
let lastTick = 0;
/** 最后一次「有操作」的时刻 */
let lastActive = 0;
let ticksSinceFlush = 0;
/** 播放器是否正在播放（播放中不做空闲判定） */
let mediaPlaying = false;
let unsubscribeSettings: (() => void) | undefined;
interface StudyLedger {
  key: string;
  pending: Record<string, number>;
  chain: Promise<void>;
  flushing?: boolean;
  /** A failed/uncertain durability attempt always reuses this exact nonce. */
  batch?: { entries: [string, number][]; id: string };
  write: (entries: [string, number][], id: string) => Promise<void>;
}
// Only failed/unsubmitted ledgers survive detachment. They are never shown to
// another owner; returning to the same destination can retry without rebilling.
const ledgers = new Map<string, StudyLedger>();
let scope: { database: typeof db; lifetime: AccountLifetime; ledger: StudyLedger } | undefined;
let clearing: { current(): boolean; ledger?: StudyLedger } | undefined;
const scopeCurrent = () => !!scope && scope.database === db && scope.lifetime.current()
  && (!cloud.enabled || scope.lifetime.account === cloud.userId);

function selectLedger(): StudyLedger | undefined {
  if (scopeCurrent()) return scope!.ledger;
  const lifetime = accountLifecycle.current();
  if (!lifetime?.current() || cloud.enabled && lifetime.account !== cloud.userId) return;
  const key = JSON.stringify([db.name, lifetime.account]);
  let ledger = ledgers.get(key);
  const write = cloud.enabled ? captureStudyTimeWriter() : addStudyTime;
  if (!ledger) { ledger = { key, pending: {}, chain: Promise.resolve(), write }; ledgers.set(key, ledger); }
  else ledger.write = write;
  scope = { database: db, lifetime, ledger };
  ticksSinceFlush = 0; mediaPlaying = false;
  lastTick = lastActive = Date.now();
  return ledger;
}

accountLifecycle.onDisposed(() => {
  const old = scope?.ledger;
  scope = undefined;
  mediaPlaying = false; ticksSinceFlush = 0;
  lastTick = lastActive = Date.now();
  publish({ counting: false });
  // This writes ONLY the original account's journal, even if db has since been
  // closed/replaced. It has no transport permission for the new lifetime.
  if (old) void flush(old);
});

/** 记一次「人在场」（事件很密，这里只写一个变量，不做任何 DOM 操作） */
function markActive(): void {
  lastActive = Date.now();
}

/** 此刻该不该计时 */
function shouldCount(now: number): boolean {
  if (!scopeCurrent()) return false;
  const s = useSettings.getState();
  if (!s.studyTrackingEnabled) return false;
  // 隐藏/后台一律不计（含 PWA 切到后台、锁屏）
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return false;
  // 正在播放：人一定在（或至少媒体在放），不按空闲判
  if (mediaPlaying) return true;
  const idleMs = Math.max(1, s.studyIdleMinutes || 5) * 60_000;
  return now - lastActive < idleMs;
}

/** 把内存里攒的秒数写进库；写成功后才从 pending 里扣掉（写入期间的增量要留着） */
function flush(ledger = scopeCurrent() ? scope!.ledger : undefined): Promise<void> {
  if (!ledger) return Promise.resolve();
  if (ledger.flushing) return ledger.chain;
  if (clearing?.current() && clearing.ledger === ledger) return ledger.chain;
  if (!Object.keys(ledger.pending).length) return ledger.chain;
  const write = ledger.write;
  ledger.flushing = true;
  ledger.chain = ledger.chain
    .then(async () => {
      // Snapshot when this serialized flush actually starts. Capturing it before
      // joining the chain can bill one interval twice on back-to-back unloads.
      while (Object.keys(ledger.pending).length) {
        const batch = ledger.batch ??= { entries: Object.entries(ledger.pending).slice(0, 32), id: crypto.randomUUID() };
        await write(batch.entries, batch.id);
        for (const [date, seconds] of batch.entries) {
          const left = round1((ledger.pending[date] ?? 0) - seconds);
          if (left > 0) ledger.pending[date] = left;
          else delete ledger.pending[date];
        }
        ledger.batch = undefined;
      }
      if (scopeCurrent() && scope!.ledger === ledger) {
        ticksSinceFlush = 0;
        publish();
        useStudyTime.setState({ flushCount: useStudyTime.getState().flushCount + 1 });
      } else if (ledgers.get(ledger.key) === ledger) ledgers.delete(ledger.key);
    })
    .catch(() => {
      // 落库失败（配额满 / 库被关掉）：留着 pending 下次再试，绝不因为记时长把应用搞崩
    }).finally(() => { ledger.flushing = false; });
  return ledger.chain;
}

/** 发布状态。值没变就不 setState —— 心跳很密，别让无关的组件跟着重渲染 */
function publish(patch: Partial<StudyTimeState> = {}): void {
  const cur = useStudyTime.getState();
  const next: Partial<StudyTimeState> = { ...patch };
  if (!('pending' in patch)) {
    const pending = scopeCurrent() ? scope!.ledger.pending : {};
    const same =
      Object.keys(cur.pending).length === Object.keys(pending).length &&
      Object.entries(pending).every(([k, v]) => cur.pending[k] === v);
    if (!same) next.pending = { ...pending };
  }
  const changed = Object.entries(next).some(
    ([k, v]) => cur[k as keyof StudyTimeState] !== v,
  );
  if (changed) useStudyTime.setState(next);
}

function tick(): void {
  const ledger = selectLedger();
  const now = Date.now();
  const counting = shouldCount(now);
  if (counting && ledger) {
    const from = Math.max(lastTick, now - MAX_TICK_MS);
    const slices: StudyDay[] = splitByDay(from, now);
    if (slices.length > 0) {
      const map = new Map<string, number>(Object.entries(ledger.pending));
      mergeSeconds(map, slices);
      ledger.pending = Object.fromEntries(map);
    }
    if (++ticksSinceFlush >= FLUSH_EVERY_TICKS) void flush();
  }
  // 无论计不计时都要推进：不推进的话「空闲一段后再回来」会把整段空闲补记进去
  lastTick = now;
  publish({ counting });
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    // 隐藏前补落一次：隐藏后定时器会被节流甚至停摆，别把最后这一分钟攥在内存里
    void flush();
    publish({ counting: false });
  } else {
    // 回到前台：以「现在」为新起点，避免把后台这段时间算进去
    lastTick = Date.now();
    markActive();
    publish({ counting: shouldCount(Date.now()) });
  }
}

/** 播放页上报播放态：播放中不做空闲判定（见文件头注释） */
function setStudyMediaPlaying(playing: boolean): void {
  selectLedger();
  if (!scopeCurrent()) return;
  mediaPlaying = playing;
  if (playing) markActive();
  publish({ counting: shouldCount(Date.now()) });
}

/** A late play/pause/unmount callback from an old player cannot affect the next
 * account, even when returning to the same account and course ID. */
export function captureStudyMediaReporter(): (playing: boolean) => void {
  const lifetime = accountLifecycle.current(), database = db;
  return playing => {
    if (!lifetime?.current() || database !== db) return;
    setStudyMediaPlaying(playing);
  };
}

/** 启动追踪（App 顶层挂一次）。返回停止函数（StrictMode 会立刻停一次再启，必须能真正停掉） */
export function startStudyTracking(): () => void {
  if (started) return stopStudyTracking;
  started = true;
  selectLedger();
  lastTick = Date.now();
  lastActive = Date.now();
  for (const ev of ACTIVITY_EVENTS) window.addEventListener(ev, markActive, { passive: true, capture: true });
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  timer = window.setInterval(tick, TICK_MS);
  // 关掉开关时把已攒的秒数落库，不留一笔「内存里的账」
  unsubscribeSettings = useSettings.subscribe((state, prev) => {
    if (prev.studyTrackingEnabled && !state.studyTrackingEnabled) void flush();
    if (!state.studyTrackingEnabled) publish({ counting: false });
  });
  useStudyTime.setState({ running: true, counting: shouldCount(Date.now()) });
  return stopStudyTracking;
}

function onPageHide(): void {
  void flush();
}

export function stopStudyTracking(): void {
  if (!started) return;
  started = false;
  void flush();
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  for (const ev of ACTIVITY_EVENTS) window.removeEventListener(ev, markActive, { capture: true });
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('pagehide', onPageHide);
  unsubscribeSettings?.();
  unsubscribeSettings = undefined;
  mediaPlaying = false;
  useStudyTime.setState({ running: false, counting: false });
}

/** Explicit local-history mode only. Server views use aggregate projections;
 * a partial mirror is never a complete historical ledger. */
export async function loadStudyDays(): Promise<StudyDay[]> {
  if (cloud.enabled) throw new Error('study_server_projection_required');
  const rows = await db.studyDays.toArray();
  return rows.map((r) => ({ date: r.date, seconds: r.seconds }));
}

/** 清空全部记录（设置页的「清空记录」用） */
export async function loadStudySnapshot(): Promise<{ date: string; seconds: number; updatedAt: number }[]> {
  if (cloud.enabled) throw new Error('study_server_projection_required');
  return db.studyDays.toArray();
}
export async function clearStudyDays(expected: { date: string; seconds: number; updatedAt: number }[] | string): Promise<void> {
  const lifetime = accountLifecycle.current(), database = db;
  const current = () => !!lifetime?.current() && database === db;
  const assertCurrent = () => { if (!current()) throw new Error('client_account_changed'); };
  assertCurrent();
  if (clearing?.current()) throw new Error('正在清空学习记录，请稍候。');
  const ledger = selectLedger();
  const operation = { current, ledger };
  clearing = operation;
  try {
    // Let already queued deltas settle, but never replace the displayed baseline.
    // Concurrent committed changes must conflict rather than silently disappear.
    await ledger?.chain;
    assertCurrent();
    await clearStudyTime(expected);
    assertCurrent();
    useStudyTime.setState({ flushCount: useStudyTime.getState().flushCount + 1 });
  } finally {
    // An invalidated operation must not release a newer account's clear lock.
    if (clearing === operation) clearing = undefined;
    // Unsubmitted seconds (including time spent in the confirmation dialog) were
    // never part of the server snapshot and must remain pending after clear.
    if (current()) {
      publish();
      void flush();
    }
  }
}
