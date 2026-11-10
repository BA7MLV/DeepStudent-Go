import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'web-server-adapters-'));
const root = process.cwd();
const virtual = modules => ({ name: 'adapter-fixture', setup(builder) {
  builder.onResolve({ filter: /.*/ }, args => {
    if (Object.hasOwn(modules, args.path)) return { path: args.path, namespace: 'fixture' };
  });
  builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: modules[args.path], loader: 'tsx', resolveDir: root }));
} });

// Production persistence adapter: the original editor baseline, receipt chain,
// no speculative IDB product write, and preservation of the latest failed draft.
const metadata = new Map();
const original = { id: 7, videoId: 'course', blob: new Blob(['original-docx']), sectionsJson: 'original-sections', outlineJson: 'original-outline' };
const calls = [];
let fail = false;
globalThis.adapterFixture = {
  cloud: { enabled: true, userId: 'alice' },
  database: {
    table(name) {
      assert.ok(['_cloudMeta', '_cloudBlobs'].includes(name), 'no product table writes');
      return {
        async get(key) { return name === '_cloudBlobs' ? { id: 'original-file' } : metadata.get(key); },
        async put(row) { metadata.set(row.id, structuredClone(row)); },
        async delete(key) { metadata.delete(key); },
        async update(key, patch) { const row = metadata.get(key); for (const [field, value] of Object.entries(patch)) row.value[field.slice(6)] = value; },
      };
    }, async transaction(_mode, _table, callback) { return callback(); },
  },
  async task(kind, resource, input) {
    calls.push(structuredClone({ kind, resource, input }));
    if (fail) throw new Error('client/record-conflict');
    return { handoutId: 7, fileId: `confirmed-${calls.length}`, sectionsJson: `sections-${calls.length}`, outlineJson: `outline-${calls.length}` };
  },
};
const adapterFile = path.join(directory, 'handout.mjs');
await build({ entryPoints: ['apps/web/src/pipelines/handoutEdit.ts'], outfile: adapterFile, bundle: true, format: 'esm', platform: 'node', plugins: [virtual({
  '../store/db': 'export const db = globalThis.adapterFixture.database;',
  '../cloud/state': 'export const cloud = globalThis.adapterFixture.cloud;',
  '../cloud/tasks': 'export const runCloudTask = (...args) => globalThis.adapterFixture.task(...args);',
  '../plugins/availability': 'export const assertPluginAvailable = async () => {};',
})] });
const { persistHandoutEdit } = await import(pathToFileURL(adapterFile));
const sections = [{ heading: 'A', blocks: [{ type: 'para', text: 'first' }] }];
await Promise.all([persistHandoutEdit(original, sections, 'first'), persistHandoutEdit(original, sections, 'second')]);
assert.deepEqual(calls[0].input.expected, { sectionsJson: original.sectionsJson, outlineJson: original.outlineJson, blob: { $file: 'original-file' } });
assert.deepEqual(calls[1].input.expected, { sectionsJson: 'sections-1', outlineJson: 'outline-1', blob: { $file: 'confirmed-1' } });
assert.equal(metadata.size, 0, 'only confirmed latest draft may retire');
fail = true;
await assert.rejects(persistHandoutEdit(original, sections, 'keep this draft'), /record-conflict/);
assert.equal(metadata.get('handout-edit-draft:7').value.summary, 'keep this draft');
const before = calls.length;
await assert.rejects(persistHandoutEdit(original, sections, 'newest blocked draft'), /record-conflict/);
assert.equal(calls.length, before, 'dependent edits do not bypass a conflicted baseline');
assert.equal(metadata.get('handout-edit-draft:7').value.summary, 'newest blocked draft');

// Render the production clear button and store. Only transport, UI primitives,
// settings and the confirmed read table are fixtures; actual event handlers run.
const uiFile = path.join(directory, 'study.js');
const uiEntry = `import React from 'react'; import {createRoot} from 'react-dom/client';
import StudyTimeCard from './apps/web/src/components/StudyTimeCard';
import * as study from './apps/web/src/store/studyTime';
import {accountLifecycle} from './apps/web/src/client/account-lifecycle';
window.fixtureLifecycle=accountLifecycle; accountLifecycle.acquire('A');
window.fixtureStudy=study; createRoot(document.getElementById('root')).render(<StudyTimeCard/>);`;
await build({ stdin: { contents: uiEntry, loader: 'tsx', resolveDir: root }, outfile: uiFile, bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', plugins: [virtual({
  '../client/learning': `export async function addStudyTime(entries){ window.fixture.adds.push(entries); await window.fixture.addGate; }
    export const captureStudyTimeWriter=()=>addStudyTime;
    export async function clearStudyTime(expected){ window.fixture.clears.push(structuredClone(expected)); await window.fixture.clearGate; if(window.fixture.conflict) throw new Error('client/record-conflict'); window.fixture.rows=[]; }`,
  './db': `export const db=window.fixture.database;`,
  '../store/db': `export const db=window.fixture.database;`,
  './settings': `export const useSettings=Object.assign(()=>window.fixture.settings,{getState:()=>window.fixture.settings,subscribe:()=>()=>{}});`,
  '../store/settings': `export const useSettings=()=>window.fixture.settings;`,
  '../cloud/state': `export const cloud={enabled:false,userId:'A'};`,
  '../client/bootstrap': `export const serverRuntime=async()=>{throw new Error('unexpected_server_read')}; export const isCurrentServerRuntime=()=>false;`,
  'react-i18next': `export const useTranslation=()=>({t:key=>key});`,
  '@heroui/react': `import React from 'react'; export const Button=({onPress,isDisabled,children,...props})=><button {...props} disabled={isDisabled} onClick={onPress}>{children}</button>;
    export const ToggleButton=({children})=><span>{children}</span>;export const ToggleButtonGroup=ToggleButton;
    export const Switch=Object.assign(({children})=><span>{children}</span>,{Content:ToggleButton,Control:ToggleButton,Thumb:ToggleButton});`,
  '../ui': `import React from 'react'; export const SectionCard=({children})=><section>{children}</section>;export const Field=({children})=><div>{children}</div>;
    export const confirmDialog=async()=>{window.fixture.confirmCount=(window.fixture.confirmCount||0)+1; return window.fixture.confirmGate ? await window.fixture.confirmGate : true;}; export const toast={success:text=>window.fixture.success.push(text),error:text=>window.fixture.errors.push(text)};`,
  './motion': `import React from 'react'; export const NumberPop=({text})=><span>{text}</span>;export const Shimmer=NumberPop;`,
})] });
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => { window.fixture = { rows: [{date:'2026-11-05',seconds:30,updatedAt:17}], clears:[], adds:[], success:[], errors:[], conflict:false,
    settings:{studyTrackingEnabled:true,studyIdleMinutes:5,update(){}} };
    window.fixture.database={studyDays:{toArray:async()=>{const rows=structuredClone(window.fixture.rows); await window.fixture.readGate; return rows;}}};
    // about:blank is not a secure-context app origin. Supply only this missing
    // harness primitive; production timers use the browser's native nonce.
    crypto.randomUUID ??= () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b=>b.toString(16).padStart(2,'0')).join('');
  });
  await page.addScriptTag({ path: uiFile });
  await page.locator('[data-testid="study-clear"]').click();
  await page.waitForFunction(() => window.fixture.success.length === 1);
  assert.deepEqual(await page.evaluate(() => window.fixture.clears[0]), [{date:'2026-11-05',seconds:30,updatedAt:17}], 'UI sends its displayed complete baseline');
  await page.evaluate(() => { window.fixture.rows=[{date:'2026-11-06',seconds:2400,updatedAt:18}]; window.fixture.conflict=true; window.fixtureStudy.useStudyTime.setState({flushCount:2}); });
  await page.waitForFunction(() => document.querySelector('[data-testid="study-summary"]').textContent.includes('40'));
  await page.locator('[data-testid="study-clear"]').click();
  await page.locator('[data-testid="study-clear-error"]').waitFor();
  assert.match(await page.locator('[data-testid="study-clear-error"]').textContent(), /尚未清空.*record-conflict/);
  assert.equal(await page.evaluate(() => window.fixture.success.length), 1, 'conflict never reports success');
  assert.equal(await page.evaluate(() => window.fixture.rows[0].seconds), 2400, 'conflict preserves confirmed records');
  // Empty observed snapshots must still reach server CAS, not shortcut success.
  await page.evaluate(() => { window.fixture.rows=[]; window.fixtureStudy.useStudyTime.setState({flushCount:3}); });
  await page.waitForFunction(() => document.querySelector('[data-testid="study-summary"]').textContent.includes('0'));
  await page.locator('[data-testid="study-clear"]').click();
  await page.waitForFunction(() => window.fixture.clears.length === 3);
  assert.deepEqual(await page.evaluate(() => window.fixture.clears[2]), []);
  // Same DB object and same final account string: only terminal lifetime identity
  // can reject this confirmation. Repeat A->B as well as A->B->A.
  for (const returnToA of [false, true]) {
    await page.evaluate(() => {
      window.fixtureLifecycle.acquire('A'); window.fixture.conflict=false;
      window.fixtureStudy.useStudyTime.setState(state=>({flushCount:state.flushCount+1}));
    });
    await page.waitForTimeout(30);
    const before = await page.evaluate(() => ({clears:window.fixture.clears.length, success:window.fixture.success.length, errors:window.fixture.errors.length}));
    await page.evaluate(() => { window.fixture.confirmGate=new Promise(resolve=>window.fixture.confirmResolve=resolve); });
    await page.locator('[data-testid="study-clear"]').click();
    await page.evaluate(returnToA => {
      window.fixtureLifecycle.acquire('B'); if(returnToA) window.fixtureLifecycle.acquire('A');
      window.fixture.confirmResolve(true); window.fixture.confirmGate=undefined;
    }, returnToA);
    await page.waitForTimeout(30);
    assert.deepEqual(await page.evaluate(() => ({clears:window.fixture.clears.length, success:window.fixture.success.length, errors:window.fixture.errors.length})), before, 'old account confirmation has no transport or toast effects');
  }

  // A late read must not replace the visible snapshot, even after returning to A.
  const summaryBeforeRead = await page.locator('[data-testid="study-summary"]').textContent();
  await page.evaluate(() => {
    window.fixture.readGate=new Promise(resolve=>window.fixture.readResolve=resolve);
    window.fixture.rows=[{date:'2026-11-07',seconds:5400,updatedAt:19}];
    window.fixtureStudy.useStudyTime.setState(state=>({flushCount:state.flushCount+1}));
  });
  await page.waitForTimeout(30);
  await page.evaluate(() => {
    window.fixtureLifecycle.acquire('B'); window.fixtureLifecycle.acquire('A');
    window.fixture.readResolve(); window.fixture.readGate=undefined;
  });
  await page.waitForTimeout(30);
  assert.equal(await page.locator('[data-testid="study-summary"]').textContent(), summaryBeforeRead, 'invalidated read does not publish its result');

  // Hold a genuine tracker flush in flight, then clear and replace the lifetime.
  // Its completion cannot submit the old clear to the newly acquired A.
  await page.clock.install();
  await page.evaluate(() => {
    window.fixture.addGate=new Promise(resolve=>window.fixture.addResolve=resolve);
    window.fixtureStudy.startStudyTracking();
  });
  await page.clock.runFor(60_000);
  await page.waitForFunction(() => window.fixture.adds.length > 0);
  const clearCount = await page.evaluate(() => window.fixture.clears.length);
  await page.evaluate(() => {
    window.fixture.oldClear=window.fixtureStudy.clearStudyDays([]).then(()=> 'unexpected success',error=>error.message);
    window.fixtureLifecycle.acquire('B'); window.fixtureLifecycle.acquire('A');
    window.fixture.addResolve(); window.fixture.addGate=undefined;
    window.fixtureStudy.stopStudyTracking();
  });
  assert.equal(await page.evaluate(() => window.fixture.oldClear), 'client_account_changed');
  assert.equal(await page.evaluate(() => window.fixture.clears.length), clearCount, 'old flush completion cannot dispatch clear');
  // Stale lock neither blocks a new lifetime nor clears its newer lock.
  await page.evaluate(() => window.fixtureStudy.clearStudyDays([]));
  assert.equal(await page.evaluate(() => window.fixture.clears.length), clearCount+1);

  const countBeforeSubmit = await page.evaluate(() => window.fixtureStudy.useStudyTime.getState().flushCount);
  await page.evaluate(() => {
    window.fixture.clearGate=new Promise(resolve=>window.fixture.clearResolve=resolve);
    window.fixture.lateSubmit=window.fixtureStudy.clearStudyDays([]).then(()=> 'unexpected success',error=>error.message);
  });
  await page.waitForFunction(count => window.fixture.clears.length === count+2, clearCount);
  await page.evaluate(() => {
    window.fixtureLifecycle.acquire('B'); window.fixtureLifecycle.acquire('A');
    const oldResolve=window.fixture.clearResolve;
    window.fixture.clearGate=new Promise(resolve=>window.fixture.newClearResolve=resolve);
    window.fixture.newClear=window.fixtureStudy.clearStudyDays([]);
    oldResolve();
  });
  assert.equal(await page.evaluate(() => window.fixture.lateSubmit), 'client_account_changed');
  assert.equal(await page.evaluate(() => window.fixtureStudy.useStudyTime.getState().flushCount), countBeforeSubmit, 'late submitted clear cannot publish success for new lifetime');
  assert.match(await page.evaluate(() => window.fixtureStudy.clearStudyDays([]).then(()=> 'unexpected success',error=>error.message)), /正在清空/, 'old finally cannot release a newer account clear lock');
  await page.evaluate(async () => { window.fixture.newClearResolve(); await window.fixture.newClear; window.fixture.clearGate=undefined; });
  console.log('server-only Web adapters: receipt CAS/draft, clear UI success/conflict/empty snapshot, A->B/A->B->A confirmation, stale read/flush/submit lifetimes passed');
} finally { await browser.close(); }
