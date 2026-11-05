import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { verifyExecutorRecovery } from './fixtures/executor-recovery.mjs';

// Dedicated source-only fixture: no API, no full build, no real user profile.
const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/history-demand-');
let web, browser;
try {
  const fixture = `
import React,{lazy,Suspense,useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/i18n';
import {cloud} from '/src/cloud/state.ts';
import * as store from '/src/store/db.ts';
const History=lazy(()=>import('/src/cloud/HistoryRecovery.tsx'));
cloud.enabled=true;cloud.userId='history-demand';store.useCloudDatabase(cloud.userId);
window.store=store;window.cloud=cloud;
function Probe(){const [open,setOpen]=useState(false);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>setOpen(!open)},'Open history'),open?React.createElement(Suspense,{fallback:null},React.createElement(History)):null)}
createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode,null,React.createElement(Probe)));
window.ready=true;
`;
  const coldFixture = `
import React,{lazy,Suspense,useState} from 'react';
import {createRoot} from 'react-dom/client';
const Export=lazy(()=>import('/src/cloud/LocalHistoryExport.tsx'));
function Cold(){const [open,setOpen]=useState(false);return React.createElement(React.Fragment,null,React.createElement('button',{onClick:()=>setOpen(!open)},'Open local export'),open?React.createElement(Suspense,{fallback:null},React.createElement(Export)):null)}
createRoot(document.getElementById('root')).render(React.createElement(Cold));
`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'cache'),
    plugins: [{ name: 'history-demand-fixture', resolveId: id => id === '/__history.tsx' ? '\0history.tsx' : id === '/__cold.js' ? '\0cold.js' : undefined,
      load: id => id === '\0history.tsx' ? fixture : id === '\0cold.js' ? coldFixture : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => { if (!['/__history', '/__cold'].includes(req.url)) return next(); res.setHeader('Content-Type', 'text/html'); res.end(`<div id="root"></div><script type="module" src="${req.url === '/__cold' ? '/__cold.js' : '/__history.tsx'}"></script>`); }); } }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } });
  await web.listen(); browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage(), modules = [], errors = [];
  let remoteRequests = 0;
  page.on('request', request => modules.push(request.url()));
  page.on('pageerror', error => errors.push(String(error)));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.route('**/api/**', route => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue();
    remoteRequests++; return route.abort();
  });
  await page.goto(`${web.resolvedUrls.local[0]}__history`);
  try { await page.waitForFunction(() => window.ready === true); }
  catch (error) { throw new Error(`${error.message}\n${errors.join('\n')}\n${await page.content()}`); }
  await page.evaluate(async () => {
    const { WangkeDB, legacyCloudDatabaseName } = store;
    const source = new WangkeDB(legacyCloudDatabaseName(cloud.userId));
    await source.table('_cloudOutbox').add({ id: 'original-change', transaction: 'original-operation', table: 'files', key: 'original-file', permissionId: 'original-permit', executorTaskId: 'original-task', before: null, after: { blob: new Blob(['original file bytes']) } });
    await source.table('_cloudMeta').put({ id: 'resource-command:original-resource-operation', value: { operationId: 'original-resource-operation', state: 'queued', blob: new Blob(['original journal bytes']) } });
    source.close();
    if (await store.db.table('_historyTransactions').count()) throw new Error('history scanned before explicit open');
  });
  assert.equal(modules.some(url => /\/(HistoryRecovery|ExecutorRecovery|legacy-migration|executor-recovery)\./.test(url)), false, 'lazy modules not loaded before open');
  await page.getByRole('button', { name: 'Open history', exact: true }).click();
  await page.getByRole('button', { name: '核对历史收据并恢复可验证时长命令', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => ![...document.querySelectorAll('button')].find(button => button.textContent === '核对历史收据并恢复可验证时长命令')?.disabled);
  const preserved = await page.evaluate(async () => {
    const history = await store.db.table('_historyTransactions').toArray();
    const original = history.find(row => row.transaction === 'original-operation');
    const journal = history.find(row => row.journal);
    if (original.rows[0].permissionId !== 'original-permit' || original.rows[0].executorTaskId !== 'original-task') throw new Error('lost execution identity');
    if (await original.rows[0].after.blob.text() !== 'original file bytes' || await journal.journal.value.blob.text() !== 'original journal bytes') throw new Error('lost bytes');
    if (await store.db.table('_cloudMeta').get(journal.journal.id)) throw new Error('opening history activated legacy command');
    if (await store.db.table('_learningCommands').count()) throw new Error('opening history converted legacy command');
    const recovery = await import('/src/cloud/executor-recovery.ts');
    const entry = (await recovery.listExecutorRecovery(cloud.userId)).find(row => row.id.endsWith(journal.id));
    const detail = await recovery.inspectExecutorRecovery(entry.id);
    const exported = await recovery.exportExecutorRecovery(detail);
    if (atob(exported.row.journal.value.blob.$blob) !== 'original journal bytes') throw new Error('journal export lost bytes');
    const source = new store.WangkeDB(store.legacyCloudDatabaseName(cloud.userId));
    if (await source.table('_cloudOutbox').count() !== 1 || await (await source.table('_cloudMeta').get(journal.journal.id)).value.blob.text() !== 'original journal bytes') throw new Error('source changed during preservation');
    // Explicit old-writer injection: same journal identity, different bytes.
    await store.db.table('_historyRecovery').update(journal.id, { receipt: { status: 'completed' } });
    await source.table('_cloudMeta').put({ ...journal.journal, value: { ...journal.journal.value, blob: new Blob(['changed journal bytes']) } });
    source.close();
    const { preserveLegacyCloudData } = await import('/src/cloud/legacy-migration.ts');
    await preserveLegacyCloudData(); await preserveLegacyCloudData();
    const versions = (await store.db.table('_historyTransactions').toArray()).filter(row => row.journal);
    if (versions.length !== 2 || await versions.find(row => row.id === journal.id).journal.value.blob.text() !== 'original journal bytes') throw new Error('journal evidence overwritten or duplicated');
    const changed = versions.find(row => row.id !== journal.id);
    await store.db.table('_historyRecovery').update(changed.id, { receipt: { status: 'completed' } });
    if (!(await recovery.listExecutorRecovery(cloud.userId)).find(row => row.id === 'main:' + changed.id)?.pending) throw new Error('identity-only receipt hid changed journal bytes');
    return { archives: history.length, journal: journal.journal.id };
  });
  assert.equal(remoteRequests, 0, 'local preservation/list/export never needs the API');
  // Existing byte-for-byte 8MiB+17 fixture also verifies readonly source,
  // metadata replacement, identity-only receipts, and A→B→A stale exports.
  const attachments = await verifyExecutorRecovery(page, 'history-demand');
  const cold = await page.context().newPage(), coldModules = [];
  cold.on('request', request => coldModules.push(request.url()));
  cold.on('pageerror', error => errors.push(String(error)));
  await cold.route('**/api/**', route => {
    if (!new URL(route.request().url()).pathname.startsWith('/api/')) return route.continue();
    remoteRequests++; return route.abort();
  });
  await cold.goto(`${web.resolvedUrls.local[0]}__cold`);
  await cold.getByRole('button', { name: 'Open local export', exact: true }).click();
  await cold.getByLabel('本机数据库', { exact: true }).fill('wangke-cloud-history-demand');
  const downloading = cold.waitForEvent('download');
  await cold.getByRole('button', { name: '完整导出本机原稿', exact: true }).click();
  const download = await downloading;
  await download.saveAs(path.join(directory, 'cold-original.json'));
  const original = JSON.parse(fs.readFileSync(path.join(directory, 'cold-original.json'), 'utf8'));
  assert.equal(original.database, 'wangke-cloud-history-demand');
  assert.equal(atob(original.tables._cloudOutbox[0].after.blob.$blob), 'original file bytes');
  assert.equal(atob(original.tables._cloudMeta[0].value.blob.$blob), 'changed journal bytes');
  assert.equal(coldModules.some(url => /\/src\/(store\/db|cloud\/(state|sync|legacy-migration)|client\/bootstrap)\./.test(url)), false, 'cold export must not load a business/account runtime');
  assert.equal(remoteRequests, 0, 'cold unauthenticated export must not need the API');
  await cold.close();
  assert.deepEqual(errors, []);
  const sync = fs.readFileSync('apps/web/src/cloud/sync.ts', 'utf8');
  assert.doesNotMatch(sync, /legacy-migration|preserveLegacyCloudData|reconcileLegacyReceipts/, 'normal sync must not load or run migration');
  assert.doesNotMatch(fs.readFileSync('apps/web/src/cloud/Activity.tsx', 'utf8'), /ExecutorRecovery|legacy-migration/, 'activity must not scan history');
  const evidence = { preserved, attachments, coldExport: { database: original.database, runtimeLoaded: false }, remoteRequests, errors };
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS explicit history loading; offline local preservation/export; no legacy journal activation; readonly original identities and 8MiB+17 bytes', directory);
} finally { await browser?.close(); await web?.close(); }
