/** Isolated API + real settings component/IDB. Source-module behavior test,
 * deliberately no startCloud, production-performance or offline-UI claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/study-demand-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
let web, browser, store;
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], requests: [], errors: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import StudyTimeCard from '/src/components/StudyTimeCard.tsx';
import { StudyDashboard } from '/src/components/StudyDashboard.tsx';
import { useStudyTime, startStudyTracking, stopStudyTracking, captureStudyMediaReporter } from '/src/store/studyTime.ts';
import { dateKey } from '/src/utils/studyLog.ts';
import { FeedbackHost } from '/src/ui/feedback.tsx';
import { cloud } from '/src/cloud/state.ts';
import { db, useCloudDatabase } from '/src/store/db.ts';
import { markCloudApply } from '/src/cloud/cache.ts';
import { invalidateAccountLifetime } from '/src/client/account-lifecycle.ts';
import { serverRuntime } from '/src/client/bootstrap.ts';
import '/src/theme.css';
import '/src/i18n/index.ts';
cloud.enabled=true; cloud.userId=window.owner; useCloudDatabase(window.owner); await db.open();
await db.transaction('rw',db.studyDays,async()=>{markCloudApply();await db.studyDays.put({date:'2026-01-01',seconds:1,updatedAt:1});});
const runtime=await serverRuntime(window.owner);
const summaryModel=runtime.studySummary();
const root=createRoot(document.getElementById('root'));
root.render(React.createElement(React.Fragment,null,React.createElement(FeedbackHost),React.createElement(StudyTimeCard),React.createElement(StudyDashboard)));
window.probe={count:()=>db.studyDays.count(),commands:()=>db.table('_learningCommands').toArray(),
 cursor:()=>db.table('_cloudMeta').get('cursor'), summary:async()=>(await runtime.read({kind:'studySummary'})).value,
 model:()=>summaryModel.diagnostics(), state:()=>summaryModel.getSnapshot(), preview:seconds=>useStudyTime.setState({pending:{[dateKey(Date.now())]:seconds}}),
  overview:async()=>(await runtime.read({kind:'studyOverview',today:dateKey(Date.now()),from:dateKey(Date.now()-370*86400000),preview:[]})).value,
  startTimer:()=>{startStudyTracking();captureStudyMediaReporter()(true);}, stopTimer:stopStudyTracking,
 invalidate:invalidateAccountLifetime, stop:()=>root.unmount()};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'study-demand-fixture', resolveId: id => id === '/__study-entry.js' ? '\0study-demand' : undefined,
    load: id => id === '\0study-demand' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__study') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__study-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1000, height: 900 } });
  const password = 'study-demand-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const add = (date, seconds) => records.apply(owner, [{ id: crypto.randomUUID(), table: 'studyDays', key: date, before: null, after: { date, seconds, updatedAt: Date.now() } }]);
  const days = Array.from({ length: 1001 }, (_, index) => ({ date: new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10), seconds: 60, updatedAt: index + 1 }));
  records.apply(owner, days.map(after => ({ id: crypto.randomUUID(), table: 'studyDays', key: after.date, before: null, after })));
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (new URL(request.url()).pathname.startsWith('/api/')) {
    const body = request.postData(); const args = body ? JSON.parse(body).payload?.args : undefined;
    evidence.requests.push({ path: new URL(request.url()).pathname, body, request: args?.request ?? args });
  } });
  await page.goto(origin + '/__study'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  const summaryText = page.getByTestId('study-summary');
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.activeDays === 1001);
  assert.equal(await page.evaluate(() => probe.count()), 1, 'aggregate never hydrates the stale/empty mirror');
  const summary = await page.evaluate(() => probe.summary());
  assert.deepEqual(Object.keys(summary).sort(), ['activeDays', 'snapshot', 'totalSeconds']);
  assert.equal(summary.totalSeconds, 60060); assert.equal(summary.activeDays, 1001);
  await expect(page.getByTestId('tile-total')).toContainText('1001');
  await expect(page.getByTestId('tile-streak')).toContainText('1001');
  const overview = await page.evaluate(() => probe.overview());
  assert.equal(overview.days.length, 0); assert.equal(overview.stats.totalSeconds, 60060);
  assert.equal(overview.stats.longestStreak, 1001);
  assert.ok(JSON.stringify(overview).length < 1024);
  assert.ok(JSON.stringify(summary).length < 1024);
  assert.equal(evidence.requests.some(item => /recordsPage/.test(item.path) || /"kind":"records"|"kind":"recordKeys"|"kind":"collectionPage"/.test(item.body ?? '')), false);
  const cursor = await page.evaluate(() => probe.cursor());
  add('2026-11-10', 30);
  await page.waitForFunction(() => probe.state().data?.activeDays === 1002);
  evidence.checks.push('1001-day history returns <1KiB aggregate, does not hydrate stale IDB or request global/collection records; external committed addition updates the retained summary');
  await page.getByTestId('study-clear').click(); await page.getByTestId('confirm-dialog-confirm').click();
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.activeDays === 0);
  await expect.poll(() => page.evaluate(async () => (await probe.commands()).length), { timeout: 30000 }).toBe(0);
  evidence.clearProbe = { browser: await page.evaluate(async () => ({ state: probe.state(), summary: await probe.summary(), commands: await probe.commands(), error: document.querySelector('[data-testid="study-clear-error"]')?.textContent })),
    transaction: store.db.inTransaction, rows: store.db.prepare("SELECT owner_id,count(*) n,sum(value IS NOT NULL) alive FROM cloud_records WHERE table_name='studyDays' GROUP BY owner_id").all() };
  assert.equal(records.studyDays(owner).length, 0);
  assert.deepEqual(await page.evaluate(() => probe.cursor()), cursor, 'clear exact receipt must not move global cursor');
  const clearRequest = evidence.requests.find(item => /editLearning/.test(item.path));
  assert.ok(clearRequest && clearRequest.request.edits[0].kind === 'clearStudySnapshot');
  assert.ok(clearRequest.body.length < 2048, 'clear command carries signed aggregate snapshot, not 1002 expected rows');
  assert.ok(evidence.requests.filter(item => item.request?.kind === 'recordKeys').every(item => item.request.keys.length <= 100));
  evidence.checks.push('real clear UI sends compact observed baseline, commits all 1002 dates atomically, retires through <=100 exact-key receipt batches without a global flush or cursor advancement');
  await page.clock.install();
  await page.evaluate(() => probe.startTimer());
  await page.clock.runFor(60_000);
  await page.evaluate(() => probe.stopTimer());
  await expect.poll(() => records.studyDays(owner).reduce((sum, row) => sum + row.seconds, 0), { timeout: 30000 }).toBe(60);
  await expect.poll(() => page.evaluate(async () => (await probe.commands()).length), { timeout: 30000 }).toBe(0);
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.totalSeconds === 60);
  await page.getByTestId('study-clear').click(); await page.getByTestId('confirm-dialog-confirm').click();
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.activeDays === 0);
  await expect.poll(() => page.evaluate(async () => (await probe.commands()).length), { timeout: 30000 }).toBe(0);
  assert.equal(records.studyDays(owner).length, 0);
  evidence.checks.push('actual 60s tracker writes original-namespace durable journal, drains through real API and exact receipt once; stop does not double charge and signed clear can remove the committed interval');
  add('2026-11-10', 40);
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.activeDays === 1);
  await page.getByTestId('study-clear').click();
  // The closure must keep the baseline shown when confirmation opened, even if
  // an authoritative new summary is pushed while the dialog is still open.
  add('2026-11-11', 50);
  await page.waitForFunction(() => probe.state().data?.activeDays === 2);
  await page.getByTestId('confirm-dialog-confirm').click();
  await page.getByTestId('study-clear-error').waitFor();
  assert.equal(records.studyDays(owner).length, 2);
  const pending = await page.evaluate(() => probe.commands());
  assert.equal(pending.length, 1); assert.equal(pending[0].state, 'conflict');
  assert.ok(pending[0].request.edits[0].snapshot, 'unconfirmed compact intent is preserved');
  await page.evaluate(() => probe.preview(120));
  await expect(page.getByTestId('tile-today')).toContainText('2 分');
  await expect(page.getByTestId('tile-total')).toContainText('3 分');
  assert.equal(records.studyDays(owner).reduce((sum, row) => sum + row.seconds, 0), 90, 'timer preview never persists');
  await page.getByTestId('study-range-3m').click();
  await expect(page.getByTestId('heat-cell')).toHaveCount(14 * 7);
  await page.getByTestId('study-range-1y').click();
  await expect(page.getByTestId('heat-cell')).toHaveCount(53 * 7);
  await expect(page.getByTestId('tile-total')).toContainText('3 分');
  evidence.checks.push('real dashboard derives all-time total/1001-day longest streak outside its calendar window; bounded pending preview updates totals without persisting, 14/53-week switching retains totals');
  const preservedSummary = await summaryText.innerText();
  const scalarIndex = store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='cloud_records_study_scalars'").get().sql;
  // A real SQL projection fault in this disposable DB, not a mocked empty read.
  store.db.exec('DROP INDEX cloud_records_study_scalars');
  add('2026-11-12', 10);
  await page.getByTestId('study-summary-load-error').waitFor();
  await page.getByTestId('btn-study-retry').waitFor();
  assert.equal(await page.getByTestId('study-clear').isDisabled(), true);
  assert.equal(await summaryText.innerText(), preservedSummary, 'failed projection keeps the previous committed summary');
  assert.equal(records.studyDays(owner).length, 3);
  assert.equal((await page.evaluate(() => probe.commands())).length, 1);
  store.db.exec(scalarIndex);
  await page.getByTestId('study-summary-load-error').getByRole('button').click();
  await page.getByTestId('btn-study-retry').click();
  await page.getByTestId('study-summary-load-error').waitFor({ state: 'detached' });
  await page.waitForFunction(() => probe.state().status === 'ready' && probe.state().data?.activeDays === 3);
  await expect(page.getByTestId('tile-total')).toContainText('3');
  await expect(page.getByTestId('study-clear')).toBeEnabled();
  evidence.checks.push('real SQL projection failure surfaces retries in both views, preserves prior summary/records/conflict intent and disables clear; explicit retry rebuilds both observations after repair');
  await page.screenshot({ path: path.join(directory, 'study-conflict-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(directory, 'study-conflict-mobile.png') });
  evidence.checks.push('concurrent new day during confirmation conflicts against the originally displayed snapshot despite a later pushed summary; both dates and durable failed intent survive');
  await expect(summaryText).toContainText('3');
  await page.evaluate(() => { probe.invalidate(); document.querySelector('[data-testid="study-clear"]').click(); });
  await expect(page.getByTestId('study-clear')).toBeDisabled();
  await expect(page.getByTestId('confirm-dialog-danger')).toHaveCount(0);
  assert.equal(await page.evaluate(() => probe.model().refs), 0);
  assert.equal((await page.evaluate(() => probe.commands())).length, 1);
  await page.evaluate(() => probe.stop());
  assert.deepEqual(evidence.errors, []);
  evidence.checks.push('account invalidation immediately rejects even a same-turn clear click, then renders disabled; releases observation and preserves conflict journal');
  evidence.passed = true;
  console.log('PASS study demand:', directory, evidence.checks);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); store?.close(); await app.close();
  if (!evidence.passed) console.error('Study demand evidence:', directory);
}
