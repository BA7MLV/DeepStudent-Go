/** Real tracker + learning journal + browser IDB. Only settings and the network
 * carrier are fixtures; no API/production-performance or real-offline claim. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { build } from 'esbuild';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/study-tracker-');
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], errors: [] };
const root = process.cwd();
const modules = {
  '@wangke/client-core': `export { DurableCommands } from '${path.join(root, 'packages/client-core/src/durable-commands.ts')}';`,
  './settings': `import {create} from 'zustand'; export const useSettings=create(()=>({studyTrackingEnabled:true,studyIdleMinutes:1}));`,
  '../cloud/state': `export const cloud={enabled:true,userId:'A'};`,
  './bootstrap': `export async function serverRuntime(owner){ window.carriers.push(owner); throw new Error('fixture_carrier_offline'); } export const isCurrentServerRuntime=()=>false;`,
  '../cloud/sync': `export async function reconcileLearningProjection(){ throw new Error('unexpected_projection'); }`,
  '../skills/demand': `export async function readSkillReferenceSnapshot(){ throw new Error('unexpected_skill_read'); }`,
};
await build({ stdin: { loader: 'ts', resolveDir: root, contents: `
import Dexie from 'dexie';
import * as study from './apps/web/src/store/studyTime';
import { db, useCloudDatabase, cloudDatabaseName } from './apps/web/src/store/db';
import { cloud } from './apps/web/src/cloud/state';
import { accountLifecycle } from './apps/web/src/client/account-lifecycle';
import { captureStudyTimeWriter, queueLearning } from './apps/web/src/client/learning';
import { commandDigest } from './apps/web/src/client/command-digest';
import { useSettings } from './apps/web/src/store/settings';
window.carriers=[];
async function select(owner,replace=true){ cloud.userId=owner; if(replace)useCloudDatabase(owner); else accountLifecycle.invalidate(); await db.open(); accountLifecycle.acquire(owner); }
async function commands(owner){ const d=new Dexie(cloudDatabaseName(owner)); try {await d.open();return await d.table('_learningCommands').toArray();} finally {d.close();} }
window.probe={study,cloud,select,commands,settings:useSettings,life:accountLifecycle,writer:captureStudyTimeWriter,queue:queueLearning,
  db:()=>db, digest:commandDigest, async delete(owner){ const name=cloudDatabaseName(owner); if(db.name===name)db.close();await Dexie.delete(name); },
  exists:owner=>Dexie.exists(cloudDatabaseName(owner))};
await select('A'); document.body.dataset.ready='yes';` }, outfile: path.join(directory, 'tracker.js'), bundle: true, format: 'esm', platform: 'browser', target: 'es2022', plugins: [{ name: 'tracker-ports', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    if (Object.hasOwn(modules, args.path)) return { path: args.path, namespace: 'fixture' };
    if (args.path.endsWith('/store/settings')) return { path: './settings', namespace: 'fixture' };
    if (args.path.endsWith('/cloud/state')) return { path: '../cloud/state', namespace: 'fixture' };
  });
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'ts', resolveDir: root }));
} }] });
const server = http.createServer((req, res) => {
  if (req.url === '/tracker.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(path.join(directory, 'tracker.js'))); }
  else { res.setHeader('content-type', 'text/html'); res.end('<body><script type="module" src="/tracker.js"></script></body>'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('body[data-ready="yes"]').waitFor({ state: 'attached' });
  await page.clock.install({ time: new Date('2026-11-10T12:00:00') });
  const total = async owner => page.evaluate(async owner => (await probe.commands(owner)).reduce((sum, row) => sum + row.request.edits.reduce((s, edit) => s + edit.seconds, 0), 0), owner);
  // Hold real journal digesting BEFORE the first transaction; close/replace its
  // original DB and switch accounts while the old timer flush is still queued.
  await page.evaluate(() => {
    const originalDigest=crypto.subtle.digest.bind(crypto.subtle);
    window.digestGate=new Promise(resolve=>window.releaseDigest=resolve);
    crypto.subtle.digest=async(...args)=>{await window.digestGate;return originalDigest(...args);};
    probe.study.startStudyTracking(); window.oldReporter=probe.study.captureStudyMediaReporter(); oldReporter(true);
  });
  await page.clock.runFor(60_000);
  assert.equal(await page.evaluate(() => Object.values(probe.study.useStudyTime.getState().pending).reduce((a,b)=>a+b,0)), 60);
  await page.evaluate(async () => { await probe.select('B'); });
  assert.deepEqual(await page.evaluate(() => probe.study.useStudyTime.getState().pending), {});
  const countB = await page.evaluate(() => probe.study.useStudyTime.getState().flushCount);
  await page.evaluate(() => { window.releaseDigest(); window.digestGate=undefined; });
  await expect.poll(() => total('A')).toBe(60);
  assert.equal(await total('B'), 0);
  assert.equal(await page.evaluate(() => probe.study.useStudyTime.getState().flushCount), countB, 'old durability completion cannot publish into B');
  assert.equal(await page.evaluate(() => window.carriers.includes('B')), false, 'old A completion must never open B carrier');
  await page.clock.runFor(15_000); // Bind fresh B; no elapsed A interval is billed.
  await page.clock.runFor(30_000);
  assert.equal(await page.evaluate(() => Object.values(probe.study.useStudyTime.getState().pending).reduce((a,b)=>a+b,0)), 30);
  await page.evaluate(async () => { await probe.select('A'); });
  await expect.poll(() => total('B')).toBe(30);
  await page.clock.runFor(15_000);
  assert.deepEqual(await page.evaluate(() => probe.study.useStudyTime.getState().pending), {});
  assert.equal(await total('A'), 60);
  evidence.checks.push('real 60s timer flush held before digest survives original connection close A→B→A; original namespaces get exactly 60s/30s, no stale preview/flushCount/next-owner carrier');

  // A stale player cannot bypass idle in a newly acquired lifetime.
  await page.evaluate(() => window.oldReporter(true));
  await page.clock.runFor(90_000);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect.poll(() => total('A')).toBe(105); // 15,30,45 count; >=60 idle.
  assert.equal(await page.evaluate(() => probe.study.useStudyTime.getState().counting), false);
  evidence.checks.push('stale playback callback does not revive media or bypass new-lifetime idle timeout');

  // A real IDB quota exception rolls back the command; the next flush must
  // retain the old batch and nonce even when more time arrives meanwhile.
  await page.evaluate(async () => { probe.study.stopStudyTracking(); await probe.select('C');
    const originalAdd=IDBObjectStore.prototype.add; window.quotaErrors=0;
    IDBObjectStore.prototype.add=function(...args){if(this.name==='_learningCommands' && !window.quotaErrors++){throw new DOMException('Injected durable command quota','QuotaExceededError');}return originalAdd.apply(this,args);};
    probe.study.startStudyTracking(); probe.study.captureStudyMediaReporter()(true);
  });
  await page.clock.runFor(60_000);
  await expect.poll(() => page.evaluate(() => window.quotaErrors)).toBe(1);
  await expect.poll(() => total('C')).toBe(0);
  assert.equal(await page.evaluate(() => Object.values(probe.study.useStudyTime.getState().pending).reduce((a,b)=>a+b,0)), 60);
  await page.clock.runFor(15_000);
  await expect.poll(() => total('C')).toBe(75);
  const commandsC = await page.evaluate(() => probe.commands('C'));
  assert.equal(commandsC.length, 2, 'failed batch retried intact; next 15s gets a separate nonce');
  assert.deepEqual(commandsC.map(row => row.request.edits.reduce((sum, edit) => sum + edit.seconds, 0)), [60, 15]);
  await page.evaluate(async () => { const writer=probe.writer(), entries=[['2026-11-10', 7]]; await writer(entries,'uncertain-commit'); await writer(entries,'uncertain-commit'); });
  assert.equal(await total('C'), 82, 'duplicate durability acknowledgement never rebills');
  await page.evaluate(() => { probe.study.stopStudyTracking(); probe.study.startStudyTracking(); probe.study.stopStudyTracking(); window.dispatchEvent(new Event('pagehide')); });
  await expect.poll(() => total('C')).toBe(82);
  evidence.checks.push('real IDB quota exception preserves exact 60s batch/nonce plus new 15s; duplicate committed acknowledgement and StrictMode-style stop/start/pagehide never double charge');

  // Invalidating and reacquiring the SAME database and account string while a
  // generic command hashes must reject the old user action, not silently revive.
  await page.evaluate(() => { window.digestGate=new Promise(resolve=>window.releaseDigest=resolve);
    const originalDigest=crypto.subtle.digest.bind(crypto.subtle); crypto.subtle.digest=async(...args)=>{await window.digestGate;return originalDigest(...args);};
    window.staleQueue=probe.queue([{kind:'studyTime',date:'2026-11-10',seconds:999,updatedAt:1,mutationId:'stale'}],['study:all'],'never-revive').then(()=>null,error=>error.message);
  });
  await page.evaluate(async () => { await probe.select('C',false); window.releaseDigest();window.digestGate=undefined; });
  assert.equal(await page.evaluate(() => window.staleQueue), 'client_account_changed');
  assert.equal(await total('C'), 82);
  const writerResult = await page.evaluate(async () => { const write=probe.writer(); await probe.delete('C'); return write([['2026-11-10', 3]],'after-deletion').then(()=>null,error=>error.name); });
  assert.equal(writerResult, 'NoSuchDatabaseError');
  assert.equal(await page.evaluate(() => probe.exists('C')), false);
  evidence.checks.push('same-object same-owner incarnation rejects stale general queue; captured journal writer never recreates explicitly deleted database');
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  console.log(`PASS study tracker (${evidence.browser}): ${directory}`, evidence.checks);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
