import type { MessageDto } from '@wangke/contracts';

/* ─────────────────────────── 消息分组（iMessage / Telegram 规则） ───────────────────────────
 * 同一发送方、相隔不到 GROUP_GAP_MS 的连续消息算一组：组内间距收紧，只有最后一条带尾巴。
 * 时间不再单独占一行，而是像 Telegram 一样放进气泡右下角；跨天时插一枚居中的日期胶囊。
 * 用户自己的消息带送达状态：发送中 → 已送达（服务器收下）→ 已读（Bot 开始处理或已经回复）。
 */
const GROUP_GAP_MS = 5 * 60_000;

export type DeliveryStatus = 'sending' | 'sent' | 'read';

export interface Row {
  key: string;
  message: MessageDto;
  /** 组内第一条 / 最后一条 */
  first: boolean;
  last: boolean;
  /** 跨天时在这一条之前显示的日期（没有则为 null） */
  stamp: string | null;
  /** 这一条所在的那一天，滚动时浮出的日期胶囊用它 */
  day: string;
  /** 气泡角落里的时刻 */
  time: string;
  /** 只有用户消息有 */
  status?: DeliveryStatus;
  /** 用户发出的最后一条：下面写「已读 / 已送达」 */
  lastMine?: boolean;
}

export const timeOf = (message: MessageDto) => {
  const value = Date.parse(message.createdAt);
  return Number.isFinite(value) ? value : 0;
};

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const yesterdayOf = (now: Date) => { const d = new Date(now); d.setDate(now.getDate() - 1); return d; };
/** 「今天 / 昨天」交给 Intl，不在代码里写死某一种语言。 */
const formatters = new Map<string, { relative: Intl.RelativeTimeFormat; clock: Intl.DateTimeFormat }>();
function formats(locale: string) {
  let value = formatters.get(locale);
  if (!value) {
    value = { relative: new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }), clock: new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }) };
    if (formatters.size >= 4) formatters.delete(formatters.keys().next().value!);
    formatters.set(locale, value);
  }
  return value;
}
const relativeDay = (locale: string, offset: 0 | -1) => formats(locale).relative.format(offset, 'day');
const clock = (date: Date, locale: string) => formats(locale).clock.format(date);

export function formatDay(time: number, locale: string, now = new Date()): string {
  const date = new Date(time);
  if (sameDay(date, now)) return relativeDay(locale, 0);
  if (sameDay(date, yesterdayOf(now))) return relativeDay(locale, -1);
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: 'long', day: 'numeric', weekday: 'short' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

/** 会话列表右上角的时间，和「信息」一样：今天给时刻，昨天给「昨天」，一周内给星期，再早给日期。 */
export function formatListTime(iso: string, locale = 'zh-CN', now = new Date()): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return '';
  const date = new Date(time);
  if (sameDay(date, now)) return clock(date, locale);
  if (sameDay(date, yesterdayOf(now))) return relativeDay(locale, -1);
  if (now.getTime() - time < 6 * 86_400_000) return date.toLocaleDateString(locale, { weekday: 'long' });
  return date.toLocaleDateString(locale, { year: '2-digit', month: 'numeric', day: 'numeric' });
}

const fromUser = (message: MessageDto) => message.role === 'user';

export function groupMessages(messages: MessageDto[], locale = 'zh-CN', options: { running?: boolean; now?: Date } = {}): Row[] {
  // 工具执行、命令和进度留在运行记录中，聊天只展示结果与必要的交互。
  messages = messages.filter(message => !(message.role === 'assistant' && message.kind === 'progress'));
  const now = options.now ?? new Date();
  // 已读：这一条之后对方有过任何动静（回复、进度、提问），或者 Bot 正在处理。
  let answeredUpTo = -1;
  messages.forEach((message, index) => { if (!fromUser(message)) answeredUpTo = index; });
  let lastMineIndex = -1;
  messages.forEach((message, index) => { if (fromUser(message)) lastMineIndex = index; });
  return messages.map((message, index) => {
    const previous = messages[index - 1];
    const next = messages[index + 1];
    const time = timeOf(message);
    const date = new Date(time);
    const dayBreak = !previous || !sameDay(new Date(timeOf(previous)), date);
    const day = formatDay(time, locale, now);
    const sameAsPrevious = Boolean(previous && !dayBreak && previous.role === message.role && time - timeOf(previous) <= GROUP_GAP_MS);
    const nextDayBreak = next ? !sameDay(new Date(timeOf(next)), date) : true;
    const sameAsNext = Boolean(next && !nextDayBreak && next.role === message.role && timeOf(next) - time <= GROUP_GAP_MS);
    let status: DeliveryStatus | undefined;
    if (fromUser(message)) {
      if (message.id.startsWith('pending-')) status = 'sending';
      else status = index < answeredUpTo || options.running ? 'read' : 'sent';
    }
    return {
      key: fromUser(message) && message.clientNonce ? `user-${message.clientNonce}` : message.id, message, first: !sameAsPrevious, last: !sameAsNext,
      stamp: dayBreak ? day : null, day, time: clock(date, locale), status,
      lastMine: index === lastMineIndex || undefined,
    };
  });
}

/** Stable rows let memoized bubbles skip work for draft typing, progress and
 * unaffected group members. Only changed messages/boundaries receive new rows. */
export function createMessageGrouper() {
  let previous = new Map<string, Row>();
  return (messages: MessageDto[], locale: string) => {
    const rows = groupMessages(messages, locale);
    const next = new Map<string, Row>();
    const result = rows.map(row => {
      const old = previous.get(row.key);
      const stable = old && old.message === row.message && old.first === row.first && old.last === row.last && old.stamp === row.stamp && old.day === row.day && old.time === row.time && old.status === row.status && old.lastMine === row.lastMine ? old : row;
      next.set(row.key, stable);
      return stable;
    });
    previous = next;
    return result;
  };
}
