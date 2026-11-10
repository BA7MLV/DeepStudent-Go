import type { RuntimeRead, StudyOverview } from '@wangke/contracts/client-runtime';
import type { DatabaseStore } from '../storage/database.js';

const DAY = 86400000;
function civil(date: string) {
  const time = Date.parse(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) throw new Error('invalid_study_date');
  return time;
}

/** Aggregate on the server, with constant history memory. Only scalar date and
 * seconds columns enter JS, not complete records or future large fields. The
 * preview is a bounded read-only calculation, NEVER written as a committed fact. */
export function studyOverview(store: DatabaseStore, owner: string, request: Extract<RuntimeRead, { kind: 'studyOverview' }>): StudyOverview {
  const today = civil(request.today), from = civil(request.from);
  if (from > today || today - from > 370 * DAY || request.preview.length > 32) throw new Error('study_overview_budget');
  const preview = new Map<string, number>();
  for (const row of request.preview) {
    civil(row.date);
    if (!Number.isFinite(row.seconds) || row.seconds < 0 || row.seconds > 86400 || preview.has(row.date)) throw new Error('invalid_study_preview');
    preview.set(row.date, row.seconds);
  }
  const extra = [...preview].sort(([a], [b]) => a.localeCompare(b));
  return store.db.transaction(() => {
    const result: StudyOverview = { days: [], stats: { totalSeconds: 0, activeDays: 0, todaySeconds: 0, weekSeconds: 0,
      weekActiveDays: 0, currentStreak: 0, longestStreak: 0, best: null, averageSeconds: 0 } };
    const stats = result.stats;
    let previous = -Infinity, run = 0, yesterdayRun = 0, extraIndex = 0;
    const consume = (date: string, seconds: number) => {
      const time = civil(date);
      if (!Number.isFinite(seconds) || seconds < 0) throw new Error('invalid_study_record');
      if (time >= from && time <= today) result.days.push({ date, seconds });
      if (!(seconds > 0)) return;
      stats.totalSeconds += seconds; stats.activeDays++;
      if (!stats.best || seconds > stats.best.seconds) stats.best = { date, seconds };
      run = time - previous === DAY ? run + 1 : 1;
      stats.longestStreak = Math.max(stats.longestStreak, run); previous = time;
      if (time === today - DAY) yesterdayRun = run;
      if (time === today) { stats.todaySeconds = seconds; stats.currentStreak = run; }
      if (time >= today - 6 * DAY && time <= today) { stats.weekSeconds += seconds; stats.weekActiveDays++; }
    };
    // A study day is keyed by its fixed-width civil date. The account/table/key
    // primary index supplies order without a sort or an unbounded .all() array.
    for (const row of store.db.prepare(`SELECT json_extract(record_key,'$') AS date,json_extract(value,'$.seconds') AS seconds
      FROM cloud_records INDEXED BY cloud_records_study_scalars WHERE owner_id=? AND table_name='studyDays' AND value IS NOT NULL ORDER BY record_key`).iterate(owner) as Iterable<{ date: string; seconds: number }>) {
      while (extraIndex < extra.length && extra[extraIndex][0] < row.date) { const [date, seconds] = extra[extraIndex++]; consume(date, seconds); }
      const addition = extra[extraIndex]?.[0] === row.date ? extra[extraIndex++][1] : 0;
      consume(row.date, addition ? Math.round((row.seconds + addition) * 10) / 10 : row.seconds);
    }
    while (extraIndex < extra.length) { const [date, seconds] = extra[extraIndex++]; consume(date, seconds); }
    if (!stats.todaySeconds) stats.currentStreak = yesterdayRun;
    stats.averageSeconds = stats.activeDays ? stats.totalSeconds / stats.activeDays : 0;
    return result;
  })();
}
