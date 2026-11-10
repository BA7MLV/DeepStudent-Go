/** Isolated SQLite scalar aggregation; not browser/production performance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { studyOverview } from '../apps/api/src/realtime/study-overview.ts';
import { computeStats, mergeSeconds, toSecondsMap } from '../apps/web/src/utils/studyLog.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/study-overview-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system'));
const owner = 'study-owner', other = 'study-other';
const evidence = { checks: [], plans: [], timezones: ['UTC', 'America/New_York', 'Asia/Shanghai'] };
try {
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
  const rows = Array.from({ length: 4000 }, (_, index) => ({ date: new Date(Date.UTC(2015, 0, 1 + index)).toISOString().slice(0, 10), seconds: index % 17 === 0 ? 0 : (index % 8000) + 0.1 }));
  const insert = store.db.prepare("INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'studyDays',?,?)");
  store.db.transaction(() => {
    for (const row of rows) insert.run(owner, JSON.stringify(row.date), JSON.stringify({ ...row, updatedAt: 1 }));
    insert.run(other, JSON.stringify('2026-11-10'), JSON.stringify({ date: '2026-11-10', seconds: 999999, updatedAt: 1 }));
  })();
  const verify = (today, from, preview) => {
    const actual = studyOverview(store, owner, { kind: 'studyOverview', today, from, preview });
    const complete = toSecondsMap(rows); mergeSeconds(complete, preview);
    assert.deepEqual(actual.stats, computeStats([...complete].map(([date, seconds]) => ({ date, seconds })), today));
    assert.deepEqual(actual.days, [...complete].sort(([a], [b]) => a.localeCompare(b)).filter(([date]) => date >= from && date <= today).map(([date, seconds]) => ({ date, seconds })));
    assert.ok(actual.days.length <= 371);
    assert.ok(Buffer.byteLength(JSON.stringify(actual)) < 32 * 1024);
  };
  for (const timezone of evidence.timezones) {
    process.env.TZ = timezone;
    verify('2026-11-10', '2025-11-05', [{ date: '2026-11-10', seconds: 45.5 }]);
    verify('2025-03-10', '2024-03-05', [{ date: '2025-03-09', seconds: 15 }, { date: '2025-03-10', seconds: 0.2 }]);
    verify('2025-11-03', '2025-08-01', [{ date: '2025-11-02', seconds: 30 }]);
    verify('2024-02-29', '2024-02-01', [{ date: '2024-02-29', seconds: 0.2 }]);
    verify('2025-12-15', '2025-10-01', [{ date: '2025-12-15', seconds: 1 }, { date: '2025-12-14', seconds: 2 }]);
  }
  evidence.checks.push('4000 historical days match original full-history computation for all stats, empty/tail calendars, zeros, preview merges and leap/DST days across 3 host timezones; returned days <=371 and bytes <32KiB');
  const request = { kind: 'studyOverview', today: '2026-11-10', from: '2025-11-05', preview: [] };
  const before = studyOverview(store, owner, request);
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.futureLargeField',?) WHERE owner_id=? AND table_name='studyDays' AND record_key=?")
    .run('x'.repeat(2 * 1024 * 1024), owner, JSON.stringify(rows[0].date));
  assert.deepEqual(studyOverview(store, owner, request), before, 'unknown large fields never enter response/stats');
  assert.deepEqual(studyOverview(store, 'missing', request).stats, computeStats([], request.today));
  for (const bad of [
    { today: '2026-02-30' }, { from: '2024-01-01' }, { from: '2026-11-11' },
    { preview: Array.from({ length: 33 }, () => ({ date: '2026-11-10', seconds: 1 })) },
    { preview: [{ date: '2026-11-10', seconds: -1 }] }, { preview: [{ date: '2026-11-10', seconds: 86401 }] },
    { preview: [{ date: '2026-11-10', seconds: 1 }, { date: '2026-11-10', seconds: 2 }] },
  ]) assert.throws(() => studyOverview(store, owner, { ...request, ...bad }), /study/);
  evidence.checks.push('owner isolation, empty account, large future fields, invalid dates, >371-day range and >32/invalid/duplicate previews');
  const queries = [
    "SELECT json_extract(record_key,'$') AS date,json_extract(value,'$.seconds') AS seconds FROM cloud_records INDEXED BY cloud_records_study_scalars WHERE owner_id=? AND table_name='studyDays' AND value IS NOT NULL ORDER BY record_key",
    "SELECT coalesce(sum(json_extract(value,'$.seconds')),0) AS totalSeconds,count(*) AS activeDays FROM cloud_records INDEXED BY cloud_records_study_scalars WHERE owner_id=? AND table_name='studyDays' AND value IS NOT NULL AND json_extract(value,'$.seconds')>0",
  ];
  for (const query of queries) {
    const plan = store.db.prepare('EXPLAIN QUERY PLAN ' + query).all(owner); evidence.plans.push(plan);
    assert.ok(plan.some(row => row.detail.includes('cloud_records_study_scalars')), JSON.stringify(plan));
    assert.equal(plan.some(row => row.detail.includes('TEMP B-TREE')), false);
  }
  evidence.checks.push('real query plans select account-scoped scalar partial index, no temporary sort; plan evidence is not an actual scan counter');
  evidence.passed = true;
  console.log('PASS study overview:', directory, evidence.checks);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); store.close();
}
