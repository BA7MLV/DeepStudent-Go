/** Real API/SQLite + browser module adapters, deliberately WITHOUT startCloud.
 * Not a production UI/performance acceptance; no model or external IM calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/skill-demand-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret'), CLOUD_WORKER_DISABLED: '1' });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
let web, browser, store;
const evidence = { browser: process.env.BROWSER ?? 'chromium', checks: [], errors: [], requests: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import InlineSkillInput from '/src/components/InlineSkillInput.tsx';
import SkillsCard from '/src/components/SkillsCard.tsx';
import { FeedbackHost } from '/src/ui/feedback.tsx';
import '/src/theme.css';
import '/src/i18n/index.ts';
import { cloud } from '/src/cloud/state.ts';
import { db, useCloudDatabase } from '/src/store/db.ts';
import { markCloudApply } from '/src/cloud/cache.ts';
import { loadEnabledSkillMeta, loadSkillBodies } from '/src/skills/store.ts';
import { observeSkillCatalog, readSkillIndex } from '/src/skills/demand.ts';
import { invalidateAccountLifetime } from '/src/client/account-lifecycle.ts';
import { saveSkillPackage } from '/src/client/learning.ts';
import { readRecordKeys } from '/src/cloud/sync.ts';
cloud.enabled = true; cloud.userId = window.owner;
useCloudDatabase(window.owner); await db.open();
let subscriptions = [];
let root;
function Composer() {
 const [value,setValue] = useState('@fixture-5 saved draft'), [skillIds,setIds] = useState([10006]);
 window.savedDraft = {value,skillIds};
 return React.createElement(InlineSkillInput,{value,skillIds,onChange:setValue,onSkillsChange:setIds,label:'Skill demand composer'});
}
window.probe = {
 meta: loadEnabledSkillMeta, bodies: loadSkillBodies, read: readSkillIndex,
 count: () => db.skills.count(),
 stale: () => db.transaction('rw',db.skills,async()=>{ markCloudApply(); await db.skills.put({id:10001,name:'stale',body:'stale cached body',description:'stale',enabled:1,builtin:0,updatedAt:1}); }),
 observe() { window.states = [null,null]; subscriptions = [0,1].map(i => observeSkillCatalog(snapshot => { window.states[i] = snapshot; })); },
 stop() { for (const off of subscriptions) off(); subscriptions=[]; },
 invalidate: invalidateAccountLifetime,
 async replaceReferences() {
   const row = (await readRecordKeys('skills',[10001]))[0];
   await db.transaction('rw',db.table('_cloudMeta'),async()=>{ markCloudApply(); await db.table('_cloudMeta').put({id:'revision:skillRefs:20001',value:999999}); });
   await saveSkillPackage(row,{...row,description:'updated package',updatedAt:Date.now()},[{path:'references/replacement.md',body:'new complete reference'}]);
 },
 commands: () => db.table('_learningCommands').count(),
  mount() { root = createRoot(document.getElementById('root')); root.render(React.createElement(Composer)); },
  mountSkills() { root = createRoot(document.getElementById('root')); root.render(React.createElement(React.Fragment,null,React.createElement(FeedbackHost),React.createElement(SkillsCard))); },
 unmount() { root?.unmount(); },
};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'skill-demand-fixture', resolveId: id => id === '/__skill-entry.js' ? '\0skill-demand' : undefined,
    load: id => id === '\0skill-demand' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__skill') return next(); res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__skill-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await (evidence.browser === 'webkit' ? webkit : chromium).launch({ headless: true }); const context = await browser.newContext();
  const password = 'skill-demand-password-123';
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  const skills = Array.from({ length: 64 }, (_, index) => ({ id: 10001 + index, name: `fixture-${index}`, description: 'metadata-only',
    body: `server-body-${index} ` + 'body-content '.repeat(1000), enabled: index === 63 ? 0 : 1, builtin: 0, updatedAt: index + 1 }));
  const references = Array.from({ length: 61 }, (_, index) => ({ id: 20001 + index, skillId: 10001, path: `references/original-${index}.md`, body: `original reference ${index}` }));
  records.apply(owner, [...skills.map(value => ({ id: crypto.randomUUID(), table: 'skills', key: value.id, before: null, after: value })),
    ...references.map(value => ({ id: crypto.randomUUID(), table: 'skillRefs', key: value.id, before: null, after: value })),
    { id: crypto.randomUUID(), table: 'skillRefs', key: 21000, before: null, after: { id: 21000, skillId: 10002, path: 'references/unrelated.md', body: 'unrelated reference body' } }]);
  const put = value => records.apply(owner, [{ id: crypto.randomUUID(), table: 'skills', key: value.id, before: records.get(owner, 'skills', value.id), after: value,
    baseRevision: store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='skills' AND record_key=?").get(owner, JSON.stringify(value.id))?.revision }]);
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  page.on('request', request => { if (request.url().includes('/api/')) evidence.requests.push({ path: new URL(request.url()).pathname, body: request.postData() }); });
  await page.goto(origin + '/__skill'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  assert.equal(await page.evaluate(() => probe.count()), 0);
  const meta = await page.evaluate(() => probe.meta());
  assert.equal(meta.filter(item => item.name.startsWith('fixture-')).length, 63);
  assert.ok(meta.every(item => !('body' in item)));
  assert.equal(await page.evaluate(() => probe.count()), 0, 'metadata never masquerades as complete IDB rows');
  assert.equal(evidence.requests.some(item => /recordsPage/.test(item.path) || /"kind":"records"/.test(item.body ?? '')), false);
  assert.equal(evidence.requests.some(item => /"kind":"recordKeys"/.test(item.body ?? '')), false);
  evidence.checks.push('empty IDB discovers all 63 enabled user skills across pages without any skill bodies or global records baseline');
  await page.evaluate(() => probe.stale());
  assert.equal(await page.evaluate(() => probe.bodies([10001,10001])), skills[0].body.slice(0,6000));
  assert.equal(await page.evaluate(() => probe.bodies([999999])), '');
  evidence.checks.push('selected body uses exact authoritative key despite stale IDB, de-duplicates IDs, preserves 6000-character prompt budget and handles missing keys');
  const isReferenceTail = request => /"kind":"collectionPage"/.test(request.postData() ?? '') && /"cursor":/.test(request.postData() ?? '');
  await page.route('**/api/clientRuntime/read', async route => { if (isReferenceTail(route.request())) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"injected_reference_page_failure"}' }); await route.continue(); });
  await assert.rejects(page.evaluate(() => probe.replaceReferences()), /503|injected|Domain request failed/);
  assert.equal(await page.evaluate(() => probe.commands()), 0, 'incomplete reference read cannot queue a destructive package replacement');
  const originalCount = () => store.db.prepare("SELECT count(*) AS n FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND value IS NOT NULL AND json_extract(value,'$.skillId')=? AND json_extract(value,'$.id') BETWEEN 20001 AND 20061").get(owner, 10001).n;
  assert.equal(originalCount(), 61);
  await page.unroute('**/api/clientRuntime/read');
  await page.evaluate(() => probe.replaceReferences());
  assert.equal(originalCount(), 0);
  const liveReferences = store.db.prepare("SELECT value FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND value IS NOT NULL AND json_extract(value,'$.skillId')=?").all(owner, 10001).map(row => JSON.parse(row.value));
  assert.equal(liveReferences.length, 1); assert.equal(liveReferences[0].body, 'new complete reference');
  assert.equal(records.get(owner, 'skillRefs', 21000).body, 'unrelated reference body');
  assert.equal(await page.evaluate(() => probe.commands()), 0);
  evidence.checks.push('61 references missing from IDB are read by scoped pages before atomic package replacement; later-page failure queues nothing, explicit server revisions override stale IDB versions, unrelated skill stays intact');
  const isTail = request => /"kind":"skillIndex"/.test(request.postData() ?? '') && /"cursor":/.test(request.postData() ?? '');
  let tails = 0;
  await page.route('**/api/clientRuntime/read', async route => { if (isTail(route.request())) tails++; await route.continue(); });
  await page.evaluate(() => probe.observe());
  await page.waitForFunction(() => states.every(state => state?.ready));
  assert.equal(tails, 1, 'two observers share one full traversal, not just one stream');
  assert.equal(await page.evaluate(() => states[0].rows.length), await page.evaluate(() => states[1].rows.length));
  evidence.checks.push('two retained observers share one first-page stream and one remaining-page traversal');
  const binding = store.db.prepare('SELECT slug FROM system_skill_bindings WHERE owner_id=? AND skill_id=?').get(owner, 10002);
  const externalPath = path.join(store.systemSkills.directory(owner), binding.slug, 'SKILL.md');
  fs.writeFileSync(externalPath, fs.readFileSync(externalPath, 'utf8').replace('fixture-1', 'external-name'));
  await page.waitForFunction(() => states.every(state => state?.ready && state.rows.some(row => row.name === 'external-name')));
  evidence.checks.push('external authoritative SKILL.md edit wakes discovery with no global records or system-document observation');
  await page.evaluate(() => probe.stop()); await page.unroute('**/api/clientRuntime/read');
  await page.route('**/api/clientRuntime/read', async route => { if (isTail(route.request())) return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"injected_skill_page_failure"}' }); await route.continue(); });
  await assert.rejects(page.evaluate(() => probe.read()), /503|injected|Domain request failed/);
  evidence.checks.push('503 on a later metadata page rejects the whole discovery instead of returning a successful partial enabled set');
  await page.evaluate(() => probe.mount());
  await page.getByTestId('composer-skills-error').waitFor();
  assert.deepEqual(await page.evaluate(() => savedDraft), { value: '@fixture-5 saved draft', skillIds: [10006] });
  await page.unroute('**/api/clientRuntime/read');
  await page.getByTestId('composer-skills-error').getByRole('button').click();
  await page.getByTestId('composer-skills-error').waitFor({ state: 'detached' });
  await page.locator('[data-skill-id="10006"]').waitFor();
  assert.deepEqual(await page.evaluate(() => savedDraft), { value: '@fixture-5 saved draft', skillIds: [10006] });
  await page.evaluate(() => probe.unmount());
  evidence.checks.push('real CodeMirror composer displays a retryable metadata failure; draft text and explicit skill selection survive failure and successful retry');
  let delayed, reached;
  const held = new Promise(resolve => { reached = resolve; });
  await page.route('**/api/clientRuntime/read', async route => {
    if (isTail(route.request()) && !delayed) {
      const response = await route.fetch();
      await new Promise(resolve => { delayed = resolve; reached(); });
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.evaluate(() => probe.observe());
  await held;
  put({ ...skills[0], name: 'remote-renamed' });
  await page.waitForFunction(() => states.every(state => state?.ready && state.rows.some(row => row.name === 'remote-renamed')));
  delayed(); await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => states.every(state => state.rows.some(row => row.name === 'remote-renamed'))), true);
  evidence.checks.push('new pushed head wins over an older successful delayed tail page; full catalogs are published atomically');
  await page.unroute('**/api/clientRuntime/read');
  const beforeSettings = evidence.requests.length;
  await page.evaluate(() => probe.mountSkills());
  const skillRows = page.getByTestId('skill-row');
  await skillRows.first().waitFor();
  assert.equal(await skillRows.count(), 50);
  await page.getByTestId('skills-next').click();
  assert.ok(await skillRows.count() > 0 && await skillRows.count() <= 50);
  await page.getByTestId('skills-previous').click();
  assert.equal(await skillRows.count(), 50);
  assert.equal(evidence.requests.slice(beforeSettings).some(item => /"kind":"recordKeys"|"kind":"collectionPage"/.test(item.body ?? '')), false);
  const editedRow = page.locator('[data-testid="skill-row"][data-skill-id="10001"]');
  assert.ok((await editedRow.innerText()).includes('1'));
  await editedRow.getByTestId('skill-edit').click();
  const bodyInput = page.getByTestId('skill-body').locator('textarea');
  await bodyInput.waitFor();
  assert.equal(await bodyInput.inputValue(), records.get(owner, 'skills', 10001).body);
  assert.ok((await page.getByTestId('skill-dialog').innerText()).includes('references/replacement.md'));
  await page.getByTestId('skill-desc').locator('input').fill('draft description remains');
  const referenceId = liveReferences[0].id;
  const currentRef = records.get(owner, 'skillRefs', referenceId);
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'skillRefs', key: referenceId, before: currentRef, after: { ...currentRef, body: 'remote reference changed after editor opened' },
    baseRevision: store.db.prepare("SELECT revision FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND record_key=?").get(owner, JSON.stringify(referenceId)).revision }]);
  await page.getByTestId('skill-save').click();
  await page.getByTestId('skill-dialog').getByRole('alert').waitFor();
  assert.equal(await page.getByTestId('skill-desc').locator('input').inputValue(), 'draft description remains');
  assert.equal(records.get(owner, 'skillRefs', referenceId).body, 'remote reference changed after editor opened');
  assert.equal(await page.evaluate(() => probe.commands()), 0, 'stale editor fails before queuing a destructive replacement');
  await page.screenshot({ path: path.join(directory, 'skills-conflict-desktop.png') });
  evidence.checks.push('real settings list has <=50 DOM rows, bidirectional metadata pages and no discovery body/reference reads; editor loads exact full body/references; concurrent reference change preserves remote data and local draft without queuing a command');
  await page.evaluate(() => probe.unmount());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => probe.mountSkills());
  await skillRows.first().waitFor();
  assert.ok(await skillRows.count() <= 50);
  const secondRow = page.locator('[data-testid="skill-row"][data-skill-id="10003"]');
  const secondBody = records.get(owner, 'skills', 10003).body;
  await secondRow.getByTestId('skill-toggle').click();
  await expect.poll(() => page.evaluate(async () => (await (await import('/src/store/db.ts')).db.skills.get(10003))?.enabled), { timeout: 30000 }).toBe(0);
  assert.equal(records.get(owner, 'skills', 10003).body, secondBody, 'toggle preserves full authoritative body');
  await secondRow.getByTestId('skill-edit').click();
  await bodyInput.waitFor();
  await page.getByTestId('skill-desc').locator('input').fill('saved via narrow settings editor');
  await page.getByTestId('skill-save').click();
  await page.getByTestId('skill-dialog').waitFor({ state: 'detached' });
  assert.equal(records.get(owner, 'skills', 10003).description, 'saved via narrow settings editor');
  assert.equal(records.get(owner, 'skills', 10003).body, secondBody);
  evidence.checks.push('390px settings toggle and successful edit preserve the complete authoritative body and commit through exact receipts without a global flush');
  await page.getByTestId('skills-next').click();
  await page.screenshot({ path: path.join(directory, 'skills-mobile.png') });
  await page.evaluate(() => probe.unmount());
  const definitionBeforeRace = records.get(owner, 'skills', 10001);
  const referenceBeforeRace = records.get(owner, 'skillRefs', referenceId);
  let injected = false;
  await page.route('**/api/clientRuntime/editLearning', async route => {
    if (!injected) {
      injected = true;
      records.apply(owner, [{ id: crypto.randomUUID(), table: 'skillRefs', key: 22000, before: null,
        after: { id: 22000, skillId: 10001, path: 'references/concurrent-new.md', body: 'concurrent membership original' } }]);
    }
    await route.continue();
  });
  await assert.rejects(page.evaluate(() => probe.replaceReferences()), /learning_receipt_projection_unavailable|conflict/);
  assert.ok(injected);
  assert.deepEqual(records.get(owner, 'skills', 10001), definitionBeforeRace);
  assert.deepEqual(records.get(owner, 'skillRefs', referenceId), referenceBeforeRace);
  assert.equal(records.get(owner, 'skillRefs', 22000).body, 'concurrent membership original');
  const pending = await page.evaluate(async () => (await import('/src/store/db.ts')).db.table('_learningCommands').toArray());
  assert.equal(pending.length, 1); assert.equal(pending[0].state, 'conflict');
  assert.ok(pending[0].request.edits.some(edit => edit.kind === 'skillDefinition' && edit.referencesSnapshot));
  assert.ok(pending[0].request.edits.some(edit => edit.kind === 'skillReference' && edit.value?.body === 'new complete reference'));
  evidence.checks.push('a new reference inserted after scoped read but before real command execution conflicts atomically on collection version; definition/all references and durable original intent remain intact');
  await page.evaluate(() => probe.invalidate());
  assert.equal(await page.evaluate(() => states.every(state => !state.ready && !state.rows && state.error === 'client_account_changed')), true);
  evidence.checks.push('terminal account invalidation immediately clears shared metadata and retires its observation');
  assert.deepEqual(evidence.errors, []);
  evidence.passed = true;
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS skill demand:', directory, evidence.checks);
} catch (error) {
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error), ...evidence }, null, 2));
  console.error('Skill demand evidence:', directory); throw error;
} finally { await browser?.close(); await web?.close(); await app.close(); store?.close(); }
